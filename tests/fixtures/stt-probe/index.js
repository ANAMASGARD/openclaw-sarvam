import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startMeetingAgentRealtimeEngine } from "openclaw/plugin-sdk/meeting-runtime";

// Test-only microphone and consult observer. OpenClaw resolves, connects, and
// stops the installed transcription provider using its production meeting engine.
export default {
  id: "sarvam-stt-probe",
  register(api) {
    api.registerGatewayMethod("sarvamtest.transcribeMeeting", async ({ params, respond }) => {
      const model = params.model;
      if (!["saaras:v3-realtime", "saaras:v4"].includes(model)) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "Invalid test model" });
        return;
      }
      let receive;
      let disposed = false;
      let transcript = "";
      let engine;
      try {
        engine = await startMeetingAgentRealtimeEngine({
          config: {
            chrome: { audioFormat: "g711-ulaw-8khz" },
            realtime: {
              strategy: "agent",
              transcriptionProvider: "sarvam",
              providers: { sarvam: { model, language_code: "en-IN" } },
            },
          },
          fullConfig: api.config,
          runtime: api.runtime,
          logger: api.logger,
          platform: {
            displayName: "Local fixture",
            logScope: "sarvam-stt-test",
            sessionIdPrefix: "sarvam-stt-test",
          },
          meetingSessionId: "local-" + model,
          transport: {
            inputAudioIsolated: true,
            onFatal() {},
            startInput(push) {
              receive = push;
            },
            async stop() {},
            async clearOutput() {},
            async writeOutput() {},
            async dispose() {
              disposed = true;
            },
          },
          async consultAgent({ transcript: turns }) {
            transcript = turns
              .filter((row) => row.role === "user")
              .map((row) => row.text)
              .join(" ");
            return { text: "" };
          },
        });
        if (typeof receive !== "function" || !engine.getHealth().providerConnected)
          throw Error("Meeting engine did not connect");
        const bytes = await readFile(join(process.env.OPENCLAW_STATE_DIR, "input.ulaw"));
        const input = params.cancel === true ? bytes.subarray(0, 1600) : bytes;
        for (let pos = 0; pos < input.length; pos += 800) {
          receive(input.subarray(pos, pos + 800));
          await sleep(100);
        }
        if (!params.cancel) {
          const deadline = Date.now() + 15_000;
          while (!/communication|channels|lag behind/i.test(transcript) && Date.now() < deadline)
            await sleep(100);
        }
        await engine.stop();
        // A late microphone callback must be harmless after the host revokes
        // the session. Observe the engine's real ownership and disposal state.
        receive(Buffer.alloc(800, 255));
        respond(true, {
          provider: engine.providerId,
          model,
          recognized: /communication|channels|lag behind/i.test(transcript),
          words: transcript.split(/\s+/).filter(Boolean).length,
          closed: engine.getHealth().bridgeClosed,
          disposed,
          bytes: input.length,
        });
      } catch (e) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: String(e?.message ?? e)
            .replace(/https?:\/\/\S+/g, "[URL]")
            .slice(0, 300),
        });
      } finally {
        await engine?.stop();
      }
    });
  },
};
