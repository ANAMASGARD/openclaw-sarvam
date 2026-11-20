import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Codec } from "./models.js";

export const AUDIO_LIMIT = 32 * 1024 * 1024;
export type AudioSource = { audioStream: ReadableStream<Uint8Array>; release(): Promise<void> };

export function decodeAudio(value: unknown, limit = AUDIO_LIMIT): Buffer {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > Math.ceil(limit / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+=*$/.test(value) ||
    value.endsWith("===")
  ) {
    throw new Error("Bulbul returned invalid base64 audio");
  }
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || decoded.length > limit)
    throw new Error("Bulbul audio exceeds the size limit");
  return decoded;
}

export function isWave(b: Buffer): boolean {
  return b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE";
}
export function isOpus(b: Buffer): boolean {
  return b.toString("ascii", 0, 4) === "OggS" && b.indexOf("OpusHead", 0, "ascii") >= 0;
}

export function isVoiceNote(b: Buffer): boolean {
  const i = b.indexOf("OpusHead", 0, "ascii");
  return isOpus(b) && b[i + 9] === 1;
}

export function checkPrefix(b: Buffer, codec: Codec): void {
  const header = b.subarray(0, 96);
  let valid: boolean;
  switch (codec) {
    case "opus":
      valid = isOpus(header);
      break;
    case "wav":
      valid = isWave(header);
      break;
    case "flac":
      valid = header.toString("ascii", 0, 4) === "fLaC";
      break;
    case "mp3":
      valid =
        header.toString("ascii", 0, 3) === "ID3" ||
        (header[0] === 255 && (header[1] & 0xe0) === 0xe0);
      break;
    case "aac":
      valid =
        (header[0] === 255 && (header[1] & 0xf6) === 0xf0) ||
        header.toString("ascii", 4, 8) === "ftyp";
      break;
    default:
      valid = b.length > 0 && !isWave(header) && !isOpus(header);
  }
  if (!valid) throw new Error(`Bulbul returned bytes incompatible with ${codec}`);
}

/** Own the upstream reader until EOF, cancellation, or the first failure. */
export function ownedStream(
  stream: ReadableStream<Uint8Array>,
  close: () => Promise<void>,
  signal?: AbortSignal,
): AudioSource {
  const reader = stream.getReader();
  let total = 0;
  let cleanup: Promise<void> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    if (!cleanup) {
      signal?.removeEventListener("abort", abort);
      cleanup = (async () => {
        try {
          await reader.cancel();
        } catch {
          /* Already aborted upstream. */
        } finally {
          reader.releaseLock();
          await close();
        }
      })();
    }
    return cleanup;
  };
  const abort = () => {
    controller.error(signal?.reason ?? new Error("Bulbul synthesis was cancelled"));
    void finish().catch(() => {});
  };
  const audioStream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      async pull(c) {
        try {
          const { value, done } = await reader.read();
          if (cleanup) return;
          if (done) {
            if (!total) throw new Error("Bulbul returned empty audio");
            c.close();
            await finish();
            return;
          }
          total += value.byteLength;
          if (total > AUDIO_LIMIT) throw new Error("Bulbul audio exceeds the size limit");
          c.enqueue(value);
        } catch (error) {
          c.error(error);
          await finish();
        }
      },
      cancel: finish,
    },
    { highWaterMark: 0 },
  );
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    audioStream,
    async release() {
      if (!cleanup) controller.error(new Error("Bulbul synthesis was released"));
      await finish();
    },
  };
}

export function bufferSource(buffer: Buffer): AudioSource {
  return {
    audioStream: new ReadableStream({
      start(c) {
        c.enqueue(buffer);
        c.close();
      },
    }),
    release: async () => {},
  };
}

/** Peek without consuming any of the bytes that the channel will play. */
export async function peek(
  source: AudioSource,
  minBytes = 64,
): Promise<{ head: Buffer; source: AudioSource }> {
  const reader = source.audioStream.getReader();
  const initial: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < minBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      initial.push(value);
    }
    if (!size) throw new Error("Bulbul returned empty audio");
    const head = Buffer.concat(
      initial.map((v) => v.subarray(0, minBytes)),
      Math.min(minBytes, size),
    );
    const replay = new ReadableStream<Uint8Array>(
      {
        start(c) {
          for (const chunk of initial) c.enqueue(chunk);
        },
        async pull(c) {
          const { value, done } = await reader.read();
          if (done) c.close();
          else c.enqueue(value);
        },
        cancel: () => reader.cancel(),
      },
      { highWaterMark: 0 },
    );
    return {
      head,
      source: ownedStream(replay, async () => {
        reader.releaseLock();
        await source.release();
      }),
    };
  } catch (error) {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await source.release();
    throw error;
  }
}

/** Re-encode a WAV stream as one mono 48 kHz Ogg/Opus stream. */
export function encodeVoiceNote(
  source: AudioSource,
  signal: AbortSignal,
  inputFormat: "wav" | "ogg" = "wav",
): AudioSource {
  const proc = spawn(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-protocol_whitelist",
      "pipe",
      "-f",
      inputFormat,
      "-i",
      "pipe:0",
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      "-f",
      "ogg",
      "-page_duration",
      "20000",
      "-flush_packets",
      "1",
      "pipe:1",
    ],
    {
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        PATH: process.env.PATH,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
    },
  );
  const exited = new Promise<void>((resolve, reject) => {
    proc.on("error", () =>
      reject(
        new Error("Bulbul voice-note conversion requires FFmpeg with the libopus encoder on PATH"),
      ),
    );
    proc.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("FFmpeg could not convert Bulbul WAV to Ogg/Opus")),
    );
  });
  const reader = source.audioStream.getReader();
  async function* input() {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  const stop = () => {
    if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
  };
  const pump = pipeline(Readable.from(input()), proc.stdin, { signal }).catch((error) => {
    stop();
    throw error;
  });
  const finished = Promise.all([exited, pump]);
  void finished.catch(() => {});
  const iterator = proc.stdout[Symbol.asyncIterator]();
  const output = new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        const { done, value } = await iterator.next();
        if (done) {
          await finished;
          c.close();
        } else c.enqueue(value as Buffer);
      },
      cancel: stop,
    },
    { highWaterMark: 0 },
  );
  return ownedStream(
    output,
    async () => {
      stop();
      await source.release();
      await Promise.allSettled([exited, pump]);
    },
    signal,
  );
}
