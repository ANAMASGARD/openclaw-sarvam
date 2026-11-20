import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawPluginApi, MediaUnderstandingProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { requireKey, resolveCapabilityKey, unboundEnvironmentKey } from "../auth.js";
import type { Transport } from "../http.js";
import { inspectAudio, MAX_FILE_BYTES, type Recording } from "./audio.js";
import { SaarasBatch } from "./batch.js";
import { realtimeProvider } from "./realtime.js";
import { transcribeShort } from "./rest.js";

function recovery(id: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : "request interrupted";
  return new Error(
    "Saaras Batch job " + id + ". " + reason + ". Check it with openclaw sarvam batch status " + id,
  );
}

export function registerStt(api: OpenClawPluginApi) {
  const directory = () => join(api.runtime.state.resolveStateDir(), "sarvam", "batch");
  const media: MediaUnderstandingProviderPlugin = {
    id: "sarvam",
    capabilities: ["audio"],
    defaultModels: { audio: "saaras:v4" },
    resolveAuth({ config }) {
      const apiKey = unboundEnvironmentKey(config);
      return apiKey ? { kind: "api-key", apiKey, source: "env: SARVAM_API_KEY" } : undefined;
    },
    async transcribeAudio(req) {
      if (req.auth?.kind === "none") throw new Error("Saaras requires an API key");
      const apiKey = requireKey(req.auth?.apiKey ?? req.apiKey);
      const signal = AbortSignal.any([
        AbortSignal.timeout(req.timeoutMs),
        ...(req.signal ? [req.signal] : []),
      ]);
      const file = await inspectAudio(req.buffer, req.fileName, req.mime, signal);
      const settings = {
        ...req.query,
        model: req.model ?? "saaras:v4",
        language_code: req.language ?? req.query?.language_code,
      };
      const transport: Transport = {
        apiKey,
        signal,
        timeoutMs: req.timeoutMs,
        fetchFn: req.fetchFn,
        guard: fetchWithSsrFGuard,
      };
      if (file.seconds <= 30) return transcribeShort(file, settings, transport);
      const jobs = new SaarasBatch(directory(), transport);
      const id = await jobs.prepare([file], settings);
      try {
        await jobs.resume(id);
        const [fileResult] = await jobs.results(id, req.timeoutMs);
        if (fileResult?.state !== "success") throw new Error("Sarvam Batch could not process the recording");
        return { text: String(fileResult.result.transcript), model: settings.model };
      } catch (error) {
        throw recovery(id, error);
      }
    },
  };
  api.registerMediaUnderstandingProvider(media);
  api.registerRealtimeTranscriptionProvider(realtimeProvider);
  api.registerCli(
    ({ program, config, workspaceDir }) => {
      async function client() {
        const key = await resolveCapabilityKey(
          {
            resolveApiKeyForProvider: (args) =>
              api.runtime.modelAuth.resolveApiKeyForProvider({ ...args, workspaceDir }),
          },
          config,
        );
        return new SaarasBatch(directory(), { apiKey: key, guard: fetchWithSsrFGuard });
      }
      const group = program
        .command("sarvam")
        .description("Manage Sarvam speech transcription jobs")
        .command("batch");
      group
        .command("submit <files...>")
        .option("--model <id>", "Saaras model", "saaras:v4")
        .option("--language <code>", "Spoken language", "unknown")
        .option("--mode <mode>", "Transcript mode", "transcribe")
        .option("--keyterms <terms...>", "Domain terms for Saaras v4")
        .option("--timestamps", "Return segment timestamps")
        .option("--speakers <count>", "Number of speakers for diarization")
        .option("--diarize", "Return speaker labels")
        .action(
          async (
            paths: string[],
            opts: {
              model: string;
              language: string;
              mode: string;
              diarize?: boolean;
              keyterms?: string[];
              timestamps?: boolean;
              speakers?: string;
            },
          ) => {
            if (!paths.length || paths.length > 20) throw new Error("Choose 1 to 20 files");
            const files: Recording[] = [];
            let totalSize = 0;
            for (const path of paths) {
              const info = await stat(path);
              totalSize += info.size;
              if (!info.isFile() || info.size > MAX_FILE_BYTES || totalSize > 256 * 1024 * 1024)
                throw new Error("Saaras Batch input exceeds file or job limits");
              files.push(await inspectAudio(await readFile(path), path));
            }
            const jobs = await client();
            const id = await jobs.prepare(files, {
              model: opts.model,
              language_code: opts.language,
              mode: opts.mode,
              with_diarization: opts.diarize,
              keyterms: opts.keyterms,
              with_timestamps: opts.timestamps,
              num_speakers: opts.speakers === undefined ? undefined : Number(opts.speakers),
            });
            try {
              await jobs.resume(id);
            } catch (error) {
              throw recovery(id, error);
            }
            console.log(id);
          },
        );
      group.command("status <id>").action(async (id: string) => {
        console.log(JSON.stringify(await (await client()).status(id)));
      });
      group
        .command("resume <id>")
        .option("--retry-start", "Retry a previously uncertain start while the upstream state is Accepted")
        .action(async (id: string, opts: { retryStart?: boolean }) => {
          await (await client()).resume(id, opts.retryStart);
          console.log(id);
        });
      group.command("results <id>").action(async (id: string) => {
        console.log(JSON.stringify(await (await client()).results(id)));
      });
      group.command("list").action(async () => {
        console.log(JSON.stringify(await (await client()).list()));
      });
    },
    {
      descriptors: [
        { name: "sarvam", description: "Manage Sarvam speech transcription jobs", hasSubcommands: true },
      ],
    },
  );
}
