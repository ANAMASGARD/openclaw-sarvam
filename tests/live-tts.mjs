// Uses the compiled plugin's production adapters. Run serially to bound usage to 12 utterances.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bufferedBulbul, streamedBulbul } from "../dist/tts/provider.js";

if (process.env.SARVAM_LIVE_TEST !== "1" || !process.env.SARVAM_API_KEY) {
  throw new Error("Set SARVAM_LIVE_TEST=1 and supply SARVAM_API_KEY to run billed Bulbul tests.");
}
const key = process.env.SARVAM_API_KEY;
const cases = [
  {
    lang: "en-IN",
    text: "The yellow train leaves the station at seven in the morning. Please wait on the platform.",
    words: ["yellow", "train", "station", "platform"],
  },
  {
    lang: "hi-IN",
    text: "आज सुबह नीली बस समय पर स्टेशन पहुँची। कृपया अपना टिकट तैयार रखें।",
    words: ["नीली", "बस", "स्टेशन", "टिकट"],
  },
];
const directory = await mkdtemp(join(tmpdir(), "sarvam-bulbul-live-"));
let failed = 0;
let attempted = 0;
try {
  for (const model of ["bulbul:v3", "bulbul:v4-flash"]) {
    for (const delivery of ["rest", "http", "websocket"]) {
      for (const { lang, text, words } of cases) {
        attempted += 1;
        try {
          const voice = lang === "en-IN";
          const target = voice ? "voice-note" : "audio-file";
          const speaker =
            model === "bulbul:v3" ? "shubh" : voice ? "simran_en_customer" : "aparna_hi_customer";
          const settings = {
            modelId: model,
            language: lang,
            speaker,
            codec: delivery === "rest" ? "wav" : "mp3",
            sampleRate: 24000,
            streamTransport: delivery,
          };
          const transport = { apiKey: key, timeoutMs: 45_000 };
          const start = performance.now();
          let buffer, ext, firstMs, count;
          if (delivery === "rest") {
            const result = await bufferedBulbul(text, settings, target, transport);
            buffer = result.audioBuffer;
            ext = result.fileExtension;
            count = 1;
          } else {
            const result = await streamedBulbul(text, settings, target, transport);
            ext = result.fileExtension;
            const reader = result.audioStream.getReader();
            const chunks = [];
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!chunks.length) firstMs = performance.now() - start;
                chunks.push(value);
              }
            } finally {
              reader.releaseLock();
              await result.release();
            }
            count = chunks.length;
            buffer = Buffer.concat(chunks);
            assert.ok(count >= 2, "Expected multiple streamed audio chunks");
          }
          const ms = performance.now() - start;
          const name = "test" + ext;
          await writeFile(join(directory, name), buffer);
          const metadata = JSON.parse(
            execFileSync(
              "ffprobe",
              [
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                join(directory, name),
              ],
              { encoding: "utf8" },
            ),
          );
          const stream = metadata.streams.find((x) => x.codec_type === "audio");
          const duration = Number(metadata.format.duration);
          assert.ok(duration > 1 && duration < 30);
          assert.equal(stream.channels, 1);
          assert.equal(stream.sample_rate, voice ? "48000" : "24000");
          assert.equal(
            stream.codec_name,
            voice ? "opus" : delivery === "rest" ? "pcm_s16le" : "mp3",
          );
          const mime = ext === ".ogg" ? "audio/ogg" : ext === ".wav" ? "audio/wav" : "audio/mpeg";
          const form = new FormData();
          form.append("file", new Blob([buffer], { type: mime }), name);
          form.append("model", "saaras:v4");
          form.append("mode", "transcribe");
          form.append("language_code", lang);
          const response = await fetch("https://api.sarvam.ai/speech-to-text", {
            method: "POST",
            headers: { "api-subscription-key": key },
            body: form,
            redirect: "error",
            signal: AbortSignal.timeout(40_000),
          });
          assert.ok(response.ok, "Content verification STT returned HTTP " + response.status);
          const answer = await response.json();
          const normalized = String(answer.transcript).normalize("NFKC").toLowerCase();
          const hits = words.filter((w) => normalized.includes(w)).length;
          assert.ok(hits >= 3, "Insufficient spoken reference words (" + hits + "/4)");
          console.log(
            JSON.stringify({
              status: "PASS",
              model,
              delivery,
              lang,
              speaker,
              codec: stream.codec_name,
              hz: Number(stream.sample_rate),
              channels: stream.channels,
              seconds: Math.round(duration * 100) / 100,
              bytes: buffer.length,
              chunks: count,
              firstMs: Math.round(firstMs ?? ms),
              totalMs: Math.round(ms),
              anchors: hits + "/4",
            }),
          );
        } catch (error) {
          failed += 1;
          const safe = String(error.message).replaceAll(key, "[redacted]").slice(0, 230);
          console.log(JSON.stringify({ status: "FAIL", model, delivery, lang, error: safe }));
        }
      }
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ attempted, passed: attempted - failed, failed }));
if (failed) process.exitCode = 1;
