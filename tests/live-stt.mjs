import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { inspectAudio } from "../dist/stt/audio.js";
import { SaarasBatch } from "../dist/stt/batch.js";
import { createSaarasSession } from "../dist/stt/realtime.js";
import { transcribeShort } from "../dist/stt/rest.js";

if (process.env.SARVAM_LIVE_TEST !== "1") {
  console.log("SKIP: Set SARVAM_LIVE_TEST=1 to use Sarvam credits.");
  process.exit(0);
}
assert.ok(process.env.SARVAM_API_KEY, "SARVAM_API_KEY is required");
assert.ok(
  process.env.SARVAM_STT_FIXTURES,
  "Set SARVAM_STT_FIXTURES to a directory containing en_us.wav, hi_in.wav and references.json",
);
const fixtureDir = process.env.SARVAM_STT_FIXTURES;
const refs = await readFile(join(fixtureDir, "references.json"), "utf8").then(JSON.parse);
const files = {};
for (const name of ["english", "hindi"]) {
  const ref = refs.find((row) => row.name === name);
  assert.ok(ref && ref.text && ref.expect && ref.file && ref.language);
  const buffer = await readFile(join(fixtureDir, ref.file));
  files[name] = { ...ref, clip: await inspectAudio(buffer, ref.file) };
}
const dir = await mkdtemp(join(tmpdir(), "saaras-test-"));
const apiKey = process.env.SARVAM_API_KEY;
const rows = [];
let billedSeconds = 0;
const maximum = Number(process.env.SARVAM_STT_BUDGET_SECONDS ?? 230);
assert.ok(Number.isFinite(maximum) && maximum > 0 && maximum <= 600);
const filter = process.env.SARVAM_STT_CASES?.split(",");
function reserve(seconds) {
  if (billedSeconds + seconds > maximum) throw new Error("STT test audio budget reached");
  billedSeconds += seconds;
}
async function run(name, fn) {
  if (filter && !filter.includes(name)) return;
  const start = performance.now();
  try {
    const evidence = await fn();
    rows.push({ name, status: "PASS", ...evidence, elapsedMs: Math.round(performance.now() - start) });
  } catch (err) {
    rows.push({
      name,
      status: "FAIL",
      error: String(err?.message ?? err)
        .replaceAll(apiKey, "[redacted]")
        .replace(/https?:\/\/\S+/g, "[url]")
        .slice(0, 250),
    });
    process.exitCode = 1;
  }
  console.log(JSON.stringify(rows.at(-1)));
}
function words(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/25/g, "twenty five")
    .replace(/30/g, "thirty")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}
function distance(a, b) {
  let row = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length];
}
function accuracy(ref, text) {
  assert.match(text, new RegExp(ref.expect, "iu"), "Expected words absent from transcription");
  const expected = words(ref.text),
    actual = words(text);
  const characters = expected.join(" "),
    transcript = actual.join(" ");
  const wer = distance(expected, actual) / expected.length,
    cer = distance([...characters], [...transcript]) / [...characters].length;
  assert.ok(
    wer <= 0.4 || cer <= 0.2,
    "Transcription outside error tolerance (WER " + wer.toFixed(2) + ", CER " + cer.toFixed(2) + ")",
  );
  return {
    words: actual.length,
    wer: +wer.toFixed(3),
    cer: +cer.toFixed(3),
    transcriptHash: createHash("sha256").update(text).digest("hex").slice(0, 12),
  };
}
function media(bytes, args) {
  return execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", ...args, "pipe:1"], {
    input: bytes,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15000,
  });
}
function pcm(file) {
  return media(file.clip.buffer, ["-ar", "16000", "-ac", "1", "-f", "s16le"]);
}
function wave(bytes) {
  const b = Buffer.alloc(44 + bytes.length);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(bytes.length, 40);
  bytes.copy(b, 44);
  return b;
}
// Drives the product's provider hooks against a real network socket. Gateway tests exercise OpenClaw's own factory separately.
function socketHost(events) {
  return (options) => {
    let ws,
      ready = false,
      stopTimer,
      complete,
      rejectConnect;
    function terminate() {
      ready = false;
      clearTimeout(stopTimer);
      if (ws) ws.terminate();
    }
    const t = {
      callbacks: options.callbacks,
      isOpen: () => ws?.readyState === WebSocket.OPEN,
      isReady: () => ready,
      markReady: () => {
        ready = true;
        complete?.();
      },
      closeNow: terminate,
      failConnect: (error) => {
        rejectConnect?.(error);
        terminate();
      },
      sendJson(value) {
        if (!t.isOpen()) return false;
        ws.send(JSON.stringify(value));
        return true;
      },
    };
    return {
      async connect() {
        const headers = await options.headers();
        ws = new WebSocket(typeof options.url === "function" ? await options.url() : options.url, {
          headers,
          handshakeTimeout: 10000,
          maxPayload: 1024 * 1024,
        });
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(Error("Saaras connection readiness timeout"));
            terminate();
          }, 14000);
          complete = () => {
            clearTimeout(timeout);
            resolve();
          };
          rejectConnect = (error) => {
            clearTimeout(timeout);
            reject(error);
          };
          ws.on("open", () => options.onOpen(t));
          ws.on("message", (raw) => {
            let event;
            try {
              event = JSON.parse(raw.toString());
            } catch {
              return t.failConnect(Error("Invalid JSON"));
            }
            events.push(String(event.event ?? event.type));
            options.onMessage(event, t);
          });
          ws.on("error", (error) => (ready ? options.callbacks.onError?.(error) : rejectConnect(error)));
          ws.on("close", () => {
            if (!ready) rejectConnect(Error("Saaras closed before ready"));
            ready = false;
          });
        });
      },
      isConnected: () => ready,
      sendAudio: (b) => options.sendAudio(b, t),
      close() {
        options.onClose?.(t);
        terminate();
      },
    };
  };
}
async function stream(model, protocol, ref) {
  reserve(ref.clip.seconds + 1);
  const events = [],
    segments = [],
    partials = [],
    errors = [];
  const session = createSaarasSession(
    {
      providerConfig: {
        model,
        protocol,
        language_code: ref.language,
        sampleRate: 16000,
        encoding: "pcm16le",
      },
      onTranscript: (text) => segments.push(text),
      onPartial: (text) => partials.push(text),
      onError: (error) => errors.push(error.message),
    },
    socketHost(events),
    async () => apiKey,
  );
  try {
    await session.connect();
    if (protocol === "realtime" && model === "saaras:v4")
      await session.update({ keyterms: ["communication channels"] });
    const audio = Buffer.concat([pcm(ref), Buffer.alloc(32000)]);
    for (let i = 0; i < audio.length; i += 6400) {
      session.sendAudio(audio.subarray(i, i + 6400));
      await delay(200);
    }
    await session.finish();
    assert.equal(errors.length, 0, errors.join(" "));
    assert.ok(segments.length, "Expected a completed transcript");
    if (protocol === "realtime") {
      assert.ok(partials.length, "Expected real partials");
      assert.ok(events.includes("session.end"));
    } else assert.equal(partials.length, 0);
    return {
      seconds: ref.clip.seconds,
      partials: partials.length,
      finals: segments.length,
      ...accuracy(ref, segments.join(" ")),
    };
  } catch (error) {
    throw new Error(
      error.message +
        " (events=" +
        JSON.stringify(
          Object.fromEntries(
            [...new Set(events)].map((kind) => [kind, events.filter((e) => e === kind).length]),
          ),
        ) +
        ", segments=" +
        segments.length +
        ", errors=" +
        errors.join(",") +
        ")",
    );
  } finally {
    session.close();
  }
}
try {
  for (const model of ["saaras:v3", "saaras:v4"]) {
    for (const name of ["english", "hindi"]) {
      const ref = files[name];
      await run(model + "/rest/" + name, async () => {
        reserve(ref.clip.seconds);
        const { text } = await transcribeShort(
          ref.clip,
          { model, language_code: ref.language },
          { apiKey, timeoutMs: 40000 },
        );
        return { seconds: ref.clip.seconds, ...accuracy(ref, text) };
      });
    }
    await run(model + "/rest/30-seconds", async () => {
      const ref = files.english;
      const voiced = pcm(ref);
      const clip = await inspectAudio(
        wave(Buffer.concat([voiced, Buffer.alloc(30 * 32000 - voiced.length)])),
        "boundary.wav",
      );
      assert.equal(clip.seconds, 30);
      reserve(clip.seconds);
      const { text } = await transcribeShort(
        clip,
        { model, language_code: ref.language },
        { apiKey, timeoutMs: 45000 },
      );
      return { seconds: clip.seconds, ...accuracy(ref, text) };
    });
    await run(model + "/batch", async () => {
      const ref = model.endsWith("v3") ? files.english : files.hindi;
      const voiced = pcm(ref),
        duration = 31;
      const recording = await inspectAudio(
        wave(Buffer.concat([voiced, Buffer.alloc(duration * 32000 - voiced.length)])),
        "test.wav",
      );
      reserve(recording.seconds);
      const jobs = new SaarasBatch(dir, { apiKey, timeoutMs: 40000, signal: AbortSignal.timeout(120000) });
      const id = await jobs.prepare([recording], {
        model,
        language_code: ref.language,
        with_timestamps: true,
        with_diarization: true,
        num_speakers: 1,
      });
      await jobs.resume(id);
      const [result] = await new SaarasBatch(dir, {
        apiKey,
        timeoutMs: 20000,
        signal: AbortSignal.timeout(120000),
      }).results(id, 110000);
      assert.equal(result.state, "success");
      const timed = result.result.timestamps;
      const speakers = result.result.diarized_transcript?.entries;
      // The guide uses "chunks"; live v3/v4 responses use "words" for the labels.
      const labels = timed?.chunks ?? timed?.words;
      assert.ok(Array.isArray(labels) && labels.length > 0, "Missing Batch timing labels");
      assert.equal(timed.start_time_seconds.length, labels.length);
      assert.equal(timed.end_time_seconds.length, labels.length);
      assert.ok(
        timed.end_time_seconds.every((end, i) => Number.isFinite(end) && end >= timed.start_time_seconds[i]),
      );
      assert.ok(
        Array.isArray(speakers) &&
          speakers.some(
            (row) =>
              row.speaker_id !== undefined &&
              row.transcript?.trim() &&
              row.end_time_seconds >= row.start_time_seconds,
          ),
        "Missing diarized speech segments",
      );
      return {
        seconds: recording.seconds,
        reopenedJob: true,
        timingLabels: labels.length,
        speakerSegments: speakers.length,
        ...accuracy(ref, result.result.transcript),
      };
    });
    await run(model + "/legacy", () =>
      stream(model, "legacy", model.endsWith("v3") ? files.english : files.hindi),
    );
    const rt = model.endsWith("v3") ? "saaras:v3-realtime" : model;
    await run(rt + "/realtime", () =>
      stream(rt, "realtime", model.endsWith("v3") ? files.hindi : files.english),
    );
  }
  await run("saaras:v4/rest/codemix", async () => {
    const buffer = wave(Buffer.concat([pcm(files.hindi), Buffer.alloc(4800), pcm(files.english)]));
    const clip = await inspectAudio(buffer, "mixed.wav");
    reserve(clip.seconds);
    const { text } = await transcribeShort(
      clip,
      { model: "saaras:v4", mode: "codemix" },
      { apiKey, timeoutMs: 45000 },
    );
    return {
      seconds: clip.seconds,
      ...accuracy({ text: files.hindi.text + " " + files.english.text, expect: files.english.expect }, text),
    };
  });
  assert.ok(rows.length, "No matching live test cases");
  console.log(
    JSON.stringify({ suite: "Saaras", cases: rows.length, secondsReserved: +billedSeconds.toFixed(2) }),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
