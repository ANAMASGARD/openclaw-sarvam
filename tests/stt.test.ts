import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { modelSettings } from "../src/stt/settings.js";
import { inspectAudio } from "../src/stt/audio.js";

function silentWav(seconds: number) {
  const size = seconds * 16_000 * 2;
  const b = Buffer.alloc(44 + size);
  b.write("RIFF");
  b.writeUInt32LE(size + 36, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(size, 40);
  return b;
}

describe("recorded speech", () => {
  it("keeps v3 explicit and accepts keyterms only for v4", () => {
    expect(modelSettings({ model: "saaras:v3" }, "rest")).toMatchObject({
      model: "saaras:v3",
      mode: "transcribe",
    });
    expect(() => modelSettings({ model: "saaras:v3", keyterms: ["Delhi"] }, "rest")).toThrow(/v4/);
    expect(modelSettings({ keyterms: ["New Delhi"] }, "batch")).toMatchObject({
      model: "saaras:v4",
      keyterms: ["New Delhi"],
    });
  });
  it("measures a complete streamed WebM with no duration in its headers", async () => {
    const webm = execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", "pipe:0", "-c:a", "libopus", "-f", "webm", "pipe:1"],
      { input: silentWav(2), maxBuffer: 1024 * 1024 },
    );
    expect((await inspectAudio(webm, "voice.webm")).seconds).toBeCloseTo(2, 1);
  });
  it("measures the recording and rejects invalid files before upload", async () => {
    expect((await inspectAudio(silentWav(32), "voice.wav")).seconds).toBe(32);
    await expect(inspectAudio(Buffer.from("hello"), "voice.wav")).rejects.toThrow(/recording|audio/);
  });
});

import { transcribeShort } from "../src/stt/rest.js";
describe("Saaras REST multipart", () => {
  it("sends the chosen model, language and a single JSON keyterms field", async () => {
    const file = await inspectAudio(silentWav(2), "test.wav");
    const result = await transcribeShort(
      file,
      { model: "saaras:v4", mode: "codemix", language_code: "hi-IN", keyterms: ["New Delhi"] },
      {
        apiKey: "test-key",
        fetchFn: async (url, init) => {
          expect(new URL(String(url)).pathname).toBe("/speech-to-text");
          const data = init!.body as FormData;
          expect(data.get("file")).toBeInstanceOf(Blob);
          expect(data.get("model")).toBe("saaras:v4");
          expect(data.get("keyterms")).toBe('["New Delhi"]');
          expect(data.get("language_code")).toBe("hi-IN");
          return Response.json({ transcript: "hello" });
        },
      },
    );
    expect(result).toEqual({ text: "hello", model: "saaras:v4" });
  });
  it("refuses long, empty or incomplete speech results", async () => {
    const file = await inspectAudio(silentWav(1), "test.wav");
    await expect(
      transcribeShort({ ...file, seconds: 30.001 }, { model: "saaras:v3" }, { apiKey: "x" }),
    ).rejects.toThrow(/Batch/);
    await expect(
      transcribeShort(file, {}, { apiKey: "x", fetchFn: async () => Response.json({ transcript: "  " }) }),
    ).rejects.toThrow(/empty/);
  });
});
