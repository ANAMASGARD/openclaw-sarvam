import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const MAX_FILE_BYTES = 128 * 1024 * 1024;
const formats: Record<string, [string, string]> = {
  wav: ["wav", "audio/wav"],
  mp3: ["mp3", "audio/mpeg"],
  ogg: ["ogg", "audio/ogg"],
  flac: ["flac", "audio/flac"],
  aac: ["aac", "audio/aac"],
  m4a: ["mov", "audio/mp4"],
  aiff: ["aiff", "audio/aiff"],
  amr: ["amr", "audio/amr"],
  wma: ["asf", "audio/x-ms-wma"],
  webm: ["matroska", "audio/webm"],
  pcm: ["s16le", "audio/pcm"],
};
const extensions: Record<string, string> = {
  oga: "ogg",
  opus: "ogg",
  mp4: "m4a",
  aif: "aiff",
  wave: "wav",
  s16le: "pcm",
};
const mimeTypes: Record<string, string> = {
  "audio/x-wav": "wav",
  "audio/x-m4a": "m4a",
  "audio/opus": "ogg",
  "application/ogg": "ogg",
  "video/webm": "webm",
  "audio/x-aiff": "aiff",
};
export type Recording = { buffer: Buffer; extension: string; mime: string; seconds: number };

export async function inspectAudio(
  buffer: Buffer,
  name: string,
  mime?: string,
  signal?: AbortSignal,
): Promise<Recording> {
  signal?.throwIfAborted();
  if (!buffer.length || buffer.length > MAX_FILE_BYTES)
    throw new Error("Saaras recording must be nonempty and at most 128 MiB");
  const suffix = extname(name).slice(1).toLowerCase();
  const type = mime?.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension =
    extensions[suffix] ??
    (Object.hasOwn(formats, suffix) ? suffix : undefined) ??
    mimeTypes[type] ??
    Object.keys(formats).find((key) => formats[key]![1] === type);
  if (!extension || !Object.hasOwn(formats, extension))
    throw new Error("Unsupported Saaras recording format");
  const [demuxer, contentType] = formats[extension]!;
  const dir = await mkdtemp(join(tmpdir(), "sarvam-probe-"));
  let seconds: number;
  try {
    if (extension === "pcm") {
      if (buffer.length % 2) throw new Error("Invalid PCM recording");
      seconds = buffer.length / 32000;
    } else {
      const path = join(dir, "audio." + extension);
      await writeFile(path, buffer, { mode: 0o600, signal });
      const { stdout } = await run(
        "ffprobe",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file",
          "-f",
          demuxer,
          "-select_streams",
          "a:0",
          "-show_entries",
          "format=duration:stream=codec_type",
          "-of",
          "json",
          path,
        ],
        { timeout: 15000, maxBuffer: 16384, signal },
      );
      const result = JSON.parse(stdout);
      if (result.streams?.[0]?.codec_type !== "audio") throw new Error("Missing audio stream");
      seconds = Number(result.format?.duration);
      // Browser MediaRecorder WebM files often omit container duration. Read
      // the audio packet timeline without decoding or following external URLs.
      if (!Number.isFinite(seconds) || seconds <= 0) {
        const { stdout: progress } = await run(
          "ffmpeg",
          [
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-f",
            demuxer,
            "-i",
            path,
            "-map",
            "0:a:0",
            "-c:a",
            "copy",
            "-t",
            "7201",
            "-nostats",
            "-stats_period",
            "5",
            "-progress",
            "pipe:1",
            "-f",
            "null",
            "-",
          ],
          { timeout: 15000, maxBuffer: 16384, signal },
        );
        const times = [...progress.matchAll(/^out_time_us=(\d+)$/gm)];
        seconds = Number(times.at(-1)?.[1]) / 1_000_000;
      }
    }
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Unknown audio duration");
  } catch (error) {
    signal?.throwIfAborted();
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      throw new Error("Install FFmpeg and put ffprobe and ffmpeg on PATH for Saaras transcription");
    throw new Error("Saaras could not read the recording's audio duration");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (seconds > 7200) throw new Error("Saaras Batch accepts at most two hours per recording");
  return { buffer, seconds, extension, mime: contentType };
}
