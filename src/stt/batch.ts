import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  SarvamHttpError,
  jsonBody,
  object,
  readJson,
  request,
  type JsonObject,
  type Transport,
} from "../http.js";
import { requireKey } from "../auth.js";
import { MAX_FILE_BYTES, type Recording } from "./audio.js";
import { modelSettings, type SttSettings } from "./settings.js";

const ROOT = "/speech-to-text/job/v1";
const MAX_JOB_BYTES = 256 * 1024 * 1024;
const jobStates = new Set(["Accepted", "Pending", "Running", "Completed", "Failed"]);
type Phase = "prepared" | "creating" | "uploading" | "starting" | "started";
type StoredFile = { name: string; mime: string };
type BatchResult = { file: string; state: "success"; result: JsonObject } | { file: string; state: "failed" };
type Receipt = {
  id: string;
  upstreamId?: string;
  phase: Phase;
  parameters: SttSettings;
  files: StoredFile[];
};

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function safeSignedUrl(value: unknown): string {
  const url = typeof value === "string" ? URL.parse(value) : null;
  const host = url?.hostname ?? "";
  const allowed =
    host === "storage.googleapis.com" ||
    host.endsWith(".storage.googleapis.com") ||
    host.endsWith(".blob.core.windows.net") ||
    /(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/.test(host);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port || !allowed) {
    throw new Error("Sarvam returned an unsupported signed storage URL");
  }
  return url.href;
}

async function control(path: string, init: RequestInit, t: Transport, retries = 0) {
  const { response, release } = await request(ROOT + path, init, t, retries);
  try {
    return await readJson(response);
  } finally {
    await release();
  }
}

async function fileLink(jobId: string, names: string[], kind: "upload" | "download", t: Transport) {
  const data = await control("/" + kind + "-files", jsonBody({ job_id: jobId, files: names }), t, 2);
  const urls = object(data[kind + "_urls"], "Sarvam Batch signed links");
  return names.map((name) => safeSignedUrl(object(urls[name], "Sarvam Batch file link").file_url));
}

async function storage(url: string, body: Buffer | undefined, mime: string, t: Transport) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(t.timeoutMs ?? 60000),
    ...(t.signal ? [t.signal] : []),
  ]);
  // Signed storage requests carry only their own authorization. Never forward model-host headers or client certificates.
  const headers = new Headers();
  if (body) {
    headers.set("content-type", mime);
    if (new URL(url).hostname.endsWith(".blob.core.windows.net")) headers.set("x-ms-blob-type", "BlockBlob");
  }
  try {
    const lease = await (t.guard ?? fetchWithSsrFGuard)({
      url,
      init: {
        method: body ? "PUT" : "GET",
        headers,
        body: body && Uint8Array.from(body),
        redirect: "error",
        signal,
      },
      signal,
      fetchImpl: t.fetchFn,
      mode: "trusted_env_proxy",
      maxRedirects: 0,
      requireHttps: true,
      capture: false,
      beforeRequest: () => signal.throwIfAborted(),
      auditContext: "Sarvam Batch signed object",
    });
    try {
      if (!lease.response.ok) throw new Error("Signed storage HTTP " + lease.response.status);
      if (!body) return await readJson(lease.response, 16 * 1024 * 1024);
      await lease.response.body?.cancel();
    } finally {
      await lease.release();
    }
  } catch (error) {
    signal.throwIfAborted();
    // Networking exceptions can include the entire signed query.
    if (error instanceof Error && /^Signed storage HTTP \d{3}$/.test(error.message)) throw error;
    throw new Error("Could not transfer a Sarvam Batch signed object");
  }
}

function remoteState(status: JsonObject) {
  if (typeof status.job_state !== "string" || !jobStates.has(status.job_state))
    throw new Error("Invalid Sarvam Batch job state");
  return status.job_state;
}

export class SaarasBatch {
  private readonly directory: string;
  private readonly spoolKey: Buffer;
  private readonly transport: Transport;

  constructor(root: string, transport: Transport) {
    const key = requireKey(transport.apiKey);
    const scope = createHmac("sha256", key).update("openclaw/sarvam/batch/scope/v1").digest("hex");
    this.spoolKey = createHmac("sha256", key).update("openclaw/sarvam/batch/storage/v1").digest();
    this.directory = join(root, scope);
    // One credential owns every operation on this job, even across environment changes.
    this.transport = { ...transport, apiKey: key };
  }

  private seal(label: string, bytes: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.spoolKey, nonce);
    cipher.setAAD(Buffer.from(label));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }

  private open(label: string, bytes: Buffer): Buffer {
    try {
      const cipher = createDecipheriv("aes-256-gcm", this.spoolKey, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(label));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    } catch {
      throw new Error("Could not authenticate local Saaras job data");
    }
  }

  private dir(id: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) throw new Error("Invalid local Saaras job ID");
    return join(this.directory, id);
  }

  private async read(id: string): Promise<Receipt> {
    const encrypted = await readFile(join(this.dir(id), "job.receipt"));
    const record = JSON.parse(this.open(id + "/receipt", encrypted).toString("utf8")) as Receipt;
    if (
      record.id !== id ||
      !Array.isArray(record.files) ||
      !record.files.length ||
      record.files.some((f) => !/^input-\d+\.[a-z0-9]+$/.test(f.name)) ||
      (record.upstreamId !== undefined && !validId(record.upstreamId))
    )
      throw new Error("Invalid local Saaras job receipt");
    return record;
  }

  private async save(record: Receipt, dir = this.dir(record.id)) {
    const target = join(dir, "job.receipt");
    const tmp = target + "." + randomUUID();
    await writeFile(tmp, this.seal(record.id + "/receipt", Buffer.from(JSON.stringify(record))), {
      mode: 0o600,
      flush: true,
    });
    await rename(tmp, target);
  }

  async list(): Promise<string[]> {
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return [];
        throw e;
      },
    );
    return entries
      .filter((e) => e.isDirectory() && /^[a-f0-9-]{36}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  }

  async prepare(files: readonly Recording[], settings: SttSettings): Promise<string> {
    if (
      !files.length ||
      files.length > 20 ||
      files.some(
        (f) =>
          f.seconds <= 0 ||
          f.seconds > 7200 ||
          !f.buffer.length ||
          f.buffer.length > MAX_FILE_BYTES ||
          !/^[a-z0-9]{1,5}$/.test(f.extension),
      ) ||
      files.reduce((total, f) => total + f.buffer.length, 0) > MAX_JOB_BYTES
    )
      throw new Error("Invalid Saaras Batch file count, duration or size");
    const parameters = modelSettings(settings, "batch");
    if (files.some((f) => f.extension === "pcm")) {
      if (files.some((f) => f.extension !== "pcm"))
        throw new Error("Use separate jobs for raw PCM and container audio");
      parameters.input_audio_codec = "pcm_s16le";
    }
    const id = randomUUID();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const staging = join(this.directory, ".preparing-" + id);
    await mkdir(staging, { mode: 0o700 });
    try {
      const entries = files.map((file, i) => ({
        name: "input-" + i + "." + file.extension,
        mime: file.mime,
      }));
      for (const [i, file] of files.entries()) {
        const name = entries[i]!.name;
        await writeFile(join(staging, name), this.seal(id + "/" + name, file.buffer), {
          mode: 0o600,
          signal: this.transport.signal,
        });
      }
      await this.save({ id, files: entries, phase: "prepared", parameters }, staging);
      await rename(staging, this.dir(id));
      return id;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private async statusRemote(record: Receipt) {
    if (!record.upstreamId) throw new Error("Saaras job has no upstream ID");
    const status = await control("/" + record.upstreamId + "/status", {}, this.transport, 2);
    remoteState(status);
    return status;
  }

  async status(id: string): Promise<{ phase: Phase; upstreamId?: string; state?: string }> {
    const receipt = await this.read(id);
    return {
      phase: receipt.phase,
      upstreamId: receipt.upstreamId,
      state: receipt.upstreamId ? remoteState(await this.statusRemote(receipt)) : undefined,
    };
  }

  async resume(id: string, retryStart = false): Promise<void> {
    // SQLite's OS file lock is released even if this process dies during remote I/O.
    const { DatabaseSync } = await import("node:sqlite");
    const lock = new DatabaseSync(join(this.dir(id), ".lock.sqlite"));
    try {
      try {
        lock.exec("BEGIN EXCLUSIVE");
      } catch {
        throw new Error("Saaras job is already being submitted");
      }
      const record = await this.read(id);
      if (record.phase === "creating")
        throw new Error("Previous create outcome is unknown. Check Sarvam before creating another job.");
      if (record.phase === "prepared") {
        this.transport.signal?.throwIfAborted();
        record.phase = "creating";
        await this.save(record);
        let data: JsonObject;
        try {
          data = await control("", jsonBody({ job_parameters: record.parameters }), this.transport);
        } catch (error) {
          if (
            error instanceof SarvamHttpError &&
            [400, 401, 402, 403, 404, 413, 422, 429].includes(error.status)
          ) {
            record.phase = "prepared";
            await this.save(record);
          }
          throw error;
        }
        if (!validId(data.job_id)) throw new Error("Invalid Sarvam Batch job ID");
        record.upstreamId = data.job_id;
        record.phase = "uploading";
        await this.save(record);
      }
      if (!record.upstreamId) throw new Error("Saaras job has no upstream ID");
      if (record.phase === "starting") {
        const remote = remoteState(await this.statusRemote(record));
        if (remote !== "Accepted") record.phase = "started";
        else if (!retryStart)
          throw new Error(
            "Upstream start outcome is uncertain. Check status, then resume with --retry-start if it is still Accepted.",
          );
      }
      if (record.phase === "uploading") {
        const urls = await fileLink(
          record.upstreamId,
          record.files.map((f) => f.name),
          "upload",
          this.transport,
        );
        for (const [i, file] of record.files.entries()) {
          const bytes = await readFile(join(this.dir(id), file.name), { signal: this.transport.signal });
          await storage(urls[i]!, this.open(id + "/" + file.name, bytes), file.mime, this.transport);
        }
        record.phase = "starting";
        await this.save(record);
      }
      if (record.phase === "starting") {
        await control("/" + record.upstreamId + "/start", { method: "POST" }, this.transport);
        record.phase = "started";
      }
      await this.save(record);
      for (const file of record.files) await rm(join(this.dir(id), file.name), { force: true });
    } finally {
      lock.close();
    }
  }

  async results(id: string, waitMs = 0): Promise<BatchResult[]> {
    const record = await this.read(id);
    if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 7_200_000)
      throw new Error("Invalid Saaras Batch wait budget");
    let interval = 1000;
    const deadline = Date.now() + waitMs;
    let job = await this.statusRemote(record);
    while (!["Completed", "Failed"].includes(remoteState(job))) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(
          "Sarvam job is " +
            job.job_state +
            ". Retrieve results later with openclaw sarvam batch results " +
            id,
        );
      await delay(Math.min(interval, remaining), undefined, { signal: this.transport.signal });
      interval = Math.min(8000, interval * 1.5);
      job = await this.statusRemote(record);
    }
    if (!Array.isArray(job.job_details)) {
      if (job.job_state === "Failed")
        return record.files.map((file) => ({ file: file.name, state: "failed" }));
      throw new Error("Missing Sarvam per-file results");
    }
    const outputs = new Map<string, string | null>();
    for (const item of job.job_details) {
      const detail = object(item, "Sarvam Batch file");
      const input = Array.isArray(detail.inputs) && detail.inputs[0]?.file_name;
      if (typeof input !== "string" || outputs.has(input))
        throw new Error("Invalid Sarvam per-file input mapping");
      if (detail.state === "Failed") {
        outputs.set(input, null);
        continue;
      }
      const output = Array.isArray(detail.outputs) && detail.outputs[0]?.file_name;
      if (detail.state !== "Success" || typeof output !== "string")
        throw new Error("Invalid Sarvam per-file output mapping");
      outputs.set(input, output);
    }
    const names = [...outputs.values()].filter((name): name is string => name !== null);
    const links = names.length ? await fileLink(record.upstreamId!, names, "download", this.transport) : [];
    const byOutput = new Map(names.map((name, i) => [name, links[i]!]));
    const results: BatchResult[] = [];
    for (const file of record.files) {
      const name = outputs.get(file.name);
      if (name === undefined && job.job_state !== "Failed")
        throw new Error("Sarvam Batch omitted an input file");
      if (!name) {
        results.push({ file: file.name, state: "failed" });
        continue;
      }
      const result = await storage(byOutput.get(name)!, undefined, "", this.transport);
      if (!result || typeof result.transcript !== "string" || !result.transcript.trim())
        throw new Error("Saaras returned an empty Batch transcript");
      results.push({ file: file.name, state: "success", result });
    }
    return results;
  }
}
