import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export default {
  id: "sarvam-tts-probe",
  register(api) {
    api.registerGatewayMethod(
      "sarvamtest.stream",
      async ({ params, respond }) => {
        const { model, transport, cancel } = params;
        if (
          !["bulbul:v3", "bulbul:v4-flash"].includes(model) ||
          !["http", "websocket"].includes(transport)
        ) {
          respond(false, undefined, { code: "INVALID_REQUEST", message: "Unknown test case" });
          return;
        }
        const speaker = model === "bulbul:v3" ? "shubh" : "simran_en_customer";
        const result = await api.runtime.tts.textToSpeechStream({
          cfg: api.config,
          text: "The yellow train leaves the station at seven in the morning. Please wait on the platform.",
          channel: "telegram",
          disableFallback: true,
          timeoutMs: 45_000,
          overrides: {
            provider: "sarvam",
            providerOverrides: { sarvam: { modelId: model, speaker, streamTransport: transport } },
          },
        });
        if (!result.success || result.provider !== "sarvam" || !result.audioStream) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: "Host speech stream failed. " + (result.error ?? "No audio"),
          });
          return;
        }
        const reader = result.audioStream.getReader();
        const chunks = [];
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            chunks.push(value);
            if (cancel) {
              await reader.cancel();
              break;
            }
          }
        } finally {
          reader.releaseLock();
          await result.release?.();
        }
        if (!cancel)
          await writeFile(
            join(process.env.OPENCLAW_STATE_DIR, "bulbul-stream.ogg"),
            Buffer.concat(chunks),
            { mode: 0o600 },
          );
        respond(true, {
          provider: result.provider,
          outputFormat: result.outputFormat,
          compatible: result.voiceCompatible,
          chunks: chunks.length,
          bytes: chunks.reduce((n, c) => n + c.length, 0),
          cancelled: Boolean(cancel),
        });
      },
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      "sarvamtest.telephony",
      async ({ params, respond }) => {
        const { model } = params;
        if (!["bulbul:v3", "bulbul:v4-flash"].includes(model)) {
          respond(false, undefined, { code: "INVALID_REQUEST", message: "Unknown test model" });
          return;
        }
        const result = await api.runtime.tts.textToSpeechTelephony({
          cfg: api.config,
          text: "The blue bus is at the station.",
          overrides: { provider: "sarvam", providerOverrides: { sarvam: { modelId: model } } },
          timeoutMs: 45_000,
        });
        const pcm = result.audioBuffer;
        if (!result.success || result.provider !== "sarvam" || !pcm?.length || pcm.length % 2) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: "Host telephony synthesis failed",
          });
          return;
        }
        let peak = 0;
        for (let offset = 0; offset < pcm.length; offset += 2) {
          peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
        }
        respond(true, {
          provider: result.provider,
          outputFormat: result.outputFormat,
          hz: result.sampleRate,
          peak,
          seconds: pcm.length / (2 * result.sampleRate),
        });
      },
      { scope: "operator.admin" },
    );
  },
};
