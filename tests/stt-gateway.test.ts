import { copyFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { expect, it } from "vitest";
import { execute, freePort, isolatedHost, jsonOutput } from "./host.mjs";

const live = process.env.SARVAM_LIVE_TEST === "1" && process.env.SARVAM_STT_GATEWAY_TEST === "1";
it.skipIf(!live)(
  "recovers Batch across OpenClaw CLI processes and drives the installed realtime provider from the host meeting engine",
  async () => {
    if (!process.env.SARVAM_API_KEY && process.env.SARVAM_TEST_KEY_FILE) {
      process.env.SARVAM_API_KEY = parseEnv(
        await readFile(process.env.SARVAM_TEST_KEY_FILE, "utf8"),
      ).SARVAM_API_KEY;
    }
    if (!process.env.SARVAM_API_KEY || !process.env.SARVAM_STT_FIXTURES)
      throw Error("Set the live Sarvam key and STT fixture directory");
    const host = await isolatedHost({ live: true, archive: process.env.SARVAM_TEST_ARCHIVE });
    try {
      // The OpenClaw subprocess must use production discovery, independent of Vitest.
      for (const k of Object.keys(host.env))
        if (k === "NODE_ENV" || k.startsWith("VITEST")) delete host.env[k];
      const installed = await host.read();
      await host.write({
        ...installed,
        plugins: { ...installed.plugins, allow: ["sarvam"] },
        tools: {
          media: {
            audio: { enabled: true, language: "en-IN" },
            models: [{ provider: "sarvam", model: "saaras:v3", capabilities: ["audio"] }],
          },
        },
      });
      const english = join(host.dir, "workspace", "en_us.wav");
      await copyFile(join(process.env.SARVAM_STT_FIXTURES, "en_us.wav"), english);
      const cold = jsonOutput(
        await host.cmd([
          "infer",
          "audio",
          "transcribe",
          "--file",
          english,
          "--model",
          "sarvam/saaras:v3",
          "--language",
          "en-IN",
          "--json",
        ]),
      );
      expect(JSON.stringify(cold)).toMatch(/communication|channels|lag behind/i);
      console.log(
        JSON.stringify({
          native: "OpenClaw cold CLI media",
          model: "saaras:v3",
          auth: "environment",
          recognized: true,
        }),
      );
      await host.storeSarvamKey();
      const long = join(host.dir, "long.wav");
      await execute("ffmpeg", [
        "-v",
        "error",
        "-i",
        english,
        "-af",
        "apad",
        "-t",
        "31",
        "-ac",
        "1",
        "-ar",
        "16000",
        long,
      ]);
      const response = await host.cmd([
        "sarvam",
        "batch",
        "submit",
        long,
        "--model",
        "saaras:v4",
        "--language",
        "en-IN",
      ]);
      const id = /(?:^|\n)([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})(?:\n|$)/i.exec(response)?.[1];
      expect(id, "Batch CLI receipt ID").toBeTruthy();
      expect(jsonOutput(await host.cmd(["sarvam", "batch", "list"]))).toContain(id);
      await host.cmd(["sarvam", "batch", "resume", id]);
      expect(jsonOutput(await host.cmd(["sarvam", "batch", "status", id])).upstreamId).toBeTruthy();
      // The CLI results command is deliberately non-blocking. Poll the persisted job.
      let state;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        state = jsonOutput(await host.cmd(["sarvam", "batch", "status", id])).state;
        if (state === "Completed") break;
        if (state === "Failed") throw Error("Upstream Batch job failed");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(state).toBe("Completed");
      const results = jsonOutput(await host.cmd(["sarvam", "batch", "results", id]));
      expect(results[0].state).toBe("success");
      expect(results[0].result.transcript).toMatch(/communication|channels|lag behind/i);
      console.log(
        JSON.stringify({
          native: "Saaras Batch CLI",
          model: "saaras:v4",
          seconds: 31,
          recovered: true,
          state,
          words: results[0].result.transcript.split(/\s+/).length,
        }),
      );
      const config = await host.read();
      const port = await freePort();
      const probe = "sarvam-stt-probe";
      await host.write({
        ...config,
        gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token" } },
        plugins: {
          ...config.plugins,
          allow: ["sarvam", probe],
          load: { paths: [resolve("tests/fixtures/stt-probe")] },
          entries: { ...config.plugins?.entries, [probe]: { enabled: true } },
        },
      });
      await execute("ffmpeg", [
        "-v",
        "error",
        "-i",
        english,
        "-af",
        "apad=pad_dur=1.5",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "mulaw",
        join(host.dir, "input.ulaw"),
      ]);
      await host.start(port);
      for (const [model, cancel] of [
        ["saaras:v3-realtime", false],
        ["saaras:v4", false],
        ["saaras:v4", true],
      ]) {
        const result = await host.rpc(port, "sarvamtest.transcribeMeeting", { model, cancel }, 60000);
        expect(result).toMatchObject({
          provider: "sarvam",
          model,
          recognized: !cancel,
          closed: true,
          disposed: true,
        });
        expect(result.bytes).toBeGreaterThan(1000);
        console.log(JSON.stringify({ native: "OpenClaw meeting engine", ...result, cancel }));
      }
    } finally {
      await host.close();
    }
  },
  420000,
);
