import assert from "node:assert/strict";
import { telegramFixture } from "./telegram-fixture.mjs";
import { join, resolve } from "node:path";
import { freePort, isolatedHost, execute } from "./host.mjs";

if (process.env.SARVAM_LIVE_TEST !== "1" || !process.env.SARVAM_API_KEY)
  throw new Error("Set SARVAM_LIVE_TEST=1 and supply SARVAM_API_KEY for live Gateway tests");
const host = await isolatedHost({ live: true, archive: process.env.SARVAM_TEST_ARCHIVE });
const fixture = await telegramFixture();
let failures = 0;
try {
  const port = await freePort();
  const cfg = await host.read();
  cfg.gateway = { mode: "local", bind: "loopback", port, auth: { mode: "token" } };
  cfg.plugins = {
    ...cfg.plugins,
    allow: [...new Set([...(cfg.plugins.allow ?? []), "sarvam", "sarvam-tts-probe", "telegram"])],
    load: { paths: [...(cfg.plugins.load?.paths ?? []), resolve("tests/fixtures/tts-probe")] },
    entries: {
      ...cfg.plugins.entries,
      sarvam: { enabled: true, config: { stt: false, tts: true, tokenFactory: false } },
      "sarvam-tts-probe": { enabled: true },
      telegram: { enabled: true },
    },
  };
  cfg.channels = { telegram: fixture.settings };
  cfg.tts = {
    provider: "sarvam",
    providers: {
      sarvam: { modelId: "bulbul:v4-flash", speaker: "simran_en_customer", language: "en-IN" },
    },
  };
  await host.write(cfg);
  await host.start(port);
  if (host.logs().includes("channel autostart suppressed"))
    await host.rpc(port, "channels.start", { channel: "telegram" });
  for (const model of ["bulbul:v3", "bulbul:v4-flash"]) {
    for (const transport of ["rest", "http", "websocket"]) {
      try {
        const response =
          transport === "rest"
            ? await host.rpc(
                port,
                "tts.convert",
                {
                  provider: "sarvam",
                  modelId: model,
                  voiceId: model === "bulbul:v3" ? "shubh" : "simran_en_customer",
                  text: "The yellow train leaves the station at seven in the morning.",
                  channel: "telegram",
                },
                65_000,
              )
            : await host.rpc(port, "sarvamtest.stream", { model, transport }, 65_000);
        assert.equal(response.provider, "sarvam");
        assert.equal(response.outputFormat, "opus");
        assert.equal(response.voiceCompatible ?? response.compatible, true);
        if (transport !== "rest") assert.ok(response.chunks > 1, "Expected streaming audio chunks");
        const file = response.audioPath ?? join(host.dir, "bulbul-stream.ogg");
        const { stdout } = await execute("ffprobe", [
          "-v",
          "error",
          "-select_streams",
          "a:0",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          file,
        ]);
        const info = JSON.parse(stdout),
          stream = info.streams[0];
        assert.equal(stream.codec_name, "opus");
        assert.equal(stream.channels, 1);
        assert.equal(stream.sample_rate, "48000");
        const seconds = Number(info.format.duration);
        assert.ok(seconds > 1 && seconds < 30);
        console.log(
          JSON.stringify({
            status: "PASS",
            model,
            transport,
            provider: response.provider,
            codec: stream.codec_name,
            hz: Number(stream.sample_rate),
            seconds,
            chunks: response.chunks ?? 1,
          }),
        );
      } catch (error) {
        failures++;
        console.log(
          JSON.stringify({ status: "FAIL", model, transport, error: error.message.slice(-900) }),
        );
      }
    }
    try {
      const sample = await host.rpc(port, "sarvamtest.telephony", { model }, 65_000);
      assert.equal(sample.provider, "sarvam");
      assert.equal(sample.outputFormat, "pcm");
      assert.equal(sample.hz, 8000);
      assert.ok(sample.seconds > 0.5 && sample.seconds < 30);
      assert.ok(sample.peak > 500, "Expected audible samples in signed 16-bit PCM");
      console.log(JSON.stringify({ status: "PASS", model, feature: "telephony PCM", ...sample }));
    } catch (error) {
      failures++;
      console.log(
        JSON.stringify({
          status: "FAIL",
          model,
          feature: "telephony PCM",
          error: error.message.slice(-900),
        }),
      );
    }
  }
  const cancelled = await host.rpc(
    port,
    "sarvamtest.stream",
    { model: "bulbul:v4-flash", transport: "websocket", cancel: true },
    65_000,
  );
  assert.ok(cancelled.cancelled && cancelled.chunks === 1);
  console.log(
    JSON.stringify({
      status: "PASS",
      feature: "cancel live Gateway WebSocket synthesis after first audio chunk",
    }),
  );
} finally {
  await host.close();
  await fixture.close();
}
if (failures) process.exitCode = 1;
