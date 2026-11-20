import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Transport } from "../src/http.js";
import { SaarasBatch } from "../src/stt/batch.js";

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), "saaras-offline-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const source = { buffer: Buffer.from("offline bytes"), extension: "wav", mime: "audio/wav", seconds: 32 };

function upstream() {
  const actions: string[] = [];
  const apiKey = "test-key";
  let state = "Accepted";
  const options = {
    uploadFailure: false,
    createError: 0,
    partialFailure: false,
    host: "upload.blob.core.windows.net",
    startAmbiguous: false,
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const u = new URL(input.toString()),
      headers = new Headers(init?.headers);
    if (u.hostname !== "api.sarvam.ai") {
      expect(headers.has("api-subscription-key")).toBe(false);
      expect(headers.has("authorization")).toBe(false);
      expect(init?.redirect).toBe("error");
      if (init?.method === "PUT") {
        actions.push("put");
        expect(headers.get("x-ms-blob-type")).toBe("BlockBlob");
        return new Response(null, { status: options.uploadFailure ? 503 : 201 });
      }
      actions.push("download");
      return Response.json({
        transcript: "Known phrase",
        diarized_transcript: { entries: [{ speaker_id: "SPEAKER_00" }] },
      });
    }
    expect(headers.get("api-subscription-key")).toBe(apiKey);
    const path = u.pathname.slice("/speech-to-text/job/v1".length);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (!path) {
      actions.push("create");
      expect(body.job_parameters.model).toBe("saaras:v3");
      if (options.createError)
        return Response.json({ error: "deliberate test" }, { status: options.createError });
      return Response.json({ job_id: "job-123" });
    }
    if (path === "/job-123/status") {
      actions.push("status");
      return Response.json({
        job_state: state,
        job_details: [
          { inputs: [{ file_name: "input-0.wav" }], outputs: [{ file_name: "0.json" }], state: "Success" },
          ...(options.partialFailure
            ? [
                {
                  inputs: [{ file_name: "input-1.wav" }],
                  outputs: [],
                  state: "Failed",
                  error_message: "private upstream detail",
                },
              ]
            : []),
        ],
      });
    }
    if (path === "/job-123/start") {
      actions.push("start");
      state = "Completed";
      if (options.startAmbiguous) throw Error("upstream closed");
      return Response.json({ job_state: "Pending" });
    }
    const kind = path === "/upload-files" ? "upload" : "download";
    actions.push(kind + "-links");
    expect(body.job_id).toBe("job-123");
    return Response.json({
      [kind + "_urls"]: Object.fromEntries(
        body.files.map((f: string) => [
          f,
          { file_url: "https://" + options.host + "/" + f + "?sig=PRIVATE" },
        ]),
      ),
    });
  };
  const transport: Transport = {
    apiKey,
    fetchFn,
    guard: async (args) => ({
      response: await fetchFn(args.url, args.init),
      finalUrl: args.url,
      release: async () => {},
    }),
  };
  return { actions, options, transport };
}

describe("Saaras Batch submission and recovery", () => {
  it("resumes a lost upload from disk, preserves per-file diarization and removes the staged audio", async () => {
    const dir = await root(),
      { actions, options, transport } = upstream();
    const first = new SaarasBatch(dir, transport);
    const id = await first.prepare([source], { model: "saaras:v3", with_diarization: true, num_speakers: 2 });
    options.uploadFailure = true;
    await expect(first.resume(id)).rejects.toThrow("503");
    options.uploadFailure = false;
    const second = new SaarasBatch(dir, transport);
    await second.resume(id);
    const [scope] = await readdir(dir);
    expect(await readdir(join(dir, scope, id))).not.toContain("input-0.wav");
    expect(await second.results(id)).toMatchObject([
      {
        file: "input-0.wav",
        result: {
          transcript: "Known phrase",
          diarized_transcript: { entries: [{ speaker_id: "SPEAKER_00" }] },
        },
      },
    ]);
    expect(actions.filter((a) => a === "create")).toHaveLength(1);
    expect(actions.filter((a) => a === "start")).toHaveLength(1);
  });
  it("recovers a lost start acknowledgement by checking status without starting again", async () => {
    const dir = await root(),
      { actions, options, transport } = upstream();
    const jobs = new SaarasBatch(dir, transport),
      id = await jobs.prepare([source], { model: "saaras:v3" });
    options.startAmbiguous = true;
    await expect(jobs.resume(id)).rejects.toThrow();
    options.startAmbiguous = false;
    await new SaarasBatch(dir, transport).resume(id);
    expect(actions.filter((a) => a === "start")).toHaveLength(1);
  });
  it("keeps a definitively rejected create retryable under the same credential", async () => {
    const dir = await root(),
      { options, transport } = upstream();
    const jobs = new SaarasBatch(dir, transport),
      id = await jobs.prepare([source], { model: "saaras:v3" });
    options.createError = 401;
    await expect(jobs.resume(id)).rejects.toThrow(/401/);
    expect(await jobs.status(id)).toEqual({ phase: "prepared", state: undefined, upstreamId: undefined });
  });
  it("does not replay a create with an ambiguous outcome", async () => {
    const dir = await root(),
      { actions, options, transport } = upstream();
    const jobs = new SaarasBatch(dir, transport),
      id = await jobs.prepare([source], { model: "saaras:v3" });
    options.createError = 503;
    await expect(jobs.resume(id)).rejects.toThrow(/503/);
    await expect(jobs.resume(id)).rejects.toThrow(/unknown/);
    expect(actions.filter((a) => a === "create")).toHaveLength(1);
  });
  it("rejects an untrusted signed transfer destination before sending bytes", async () => {
    const dir = await root(),
      { actions, options, transport } = upstream();
    options.host = "127.0.0.1";
    const jobs = new SaarasBatch(dir, transport),
      id = await jobs.prepare([source], { model: "saaras:v3" });
    await expect(jobs.resume(id)).rejects.toThrow(/unsupported signed/);
    expect(actions).not.toContain("put");
  });
  it("isolates jobs across credentials and encrypts temporary audio and private keyterms", async () => {
    const dir = await root();
    const { transport, actions } = upstream();
    const jobs = new SaarasBatch(dir, transport);
    const id = await jobs.prepare([source], { model: "saaras:v4", keyterms: ["private name"] });
    const other = new SaarasBatch(dir, { ...transport, apiKey: "another-account" });
    expect(await jobs.list()).toEqual([id]);
    expect(await other.list()).toEqual([]);
    await expect(other.resume(id)).rejects.toThrow();
    await expect(other.results(id)).rejects.toThrow();
    expect(actions).toEqual([]);
    const [scope] = await readdir(dir);
    const base = join(dir, scope, id);
    const encrypted = await readFile(join(base, "input-0.wav"));
    expect(encrypted.includes(source.buffer)).toBe(false);
    const receiptPath = join(base, "job.receipt");
    const receipt = await readFile(receiptPath);
    expect(receipt.includes(Buffer.from("private name"))).toBe(false);
    receipt[receipt.length - 1] ^= 1;
    await writeFile(receiptPath, receipt);
    await expect(jobs.resume(id)).rejects.toThrow(/authenticate/);
    expect(actions).toEqual([]);
  });

  it("returns successful files when another file fails", async () => {
    const dir = await root(),
      { options, transport } = upstream();
    options.partialFailure = true;
    const jobs = new SaarasBatch(dir, transport),
      id = await jobs.prepare([source, source], { model: "saaras:v3" });
    await jobs.resume(id);
    expect(await jobs.results(id)).toMatchObject([
      { file: "input-0.wav", state: "success", result: { transcript: "Known phrase" } },
      { file: "input-1.wav", state: "failed" },
    ]);
  });
});
