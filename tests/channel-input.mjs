import { randomUUID } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { execute } from "./host.mjs";

const fail = (value, message) => {
  if (!value) throw new Error(message);
};

export async function verifySpokenLookup({ expected, recognizedColors, ingress, file, mismatchFile }) {
  if (recognizedColors.includes(expected)) return;
  if (ingress !== "gateway") throw new Error("The voice recording did not match the spoken lookup answer");
  // This branch handles generated test audio only. The harness validates its private evidence directory.
  await writeFile(mismatchFile, await readFile(file), { mode: 0o600, flag: "wx" });
  throw new Error(`Voice content mismatch. Expected "${expected}", heard color words "${recognizedColors}".`);
}

export async function submitAudio(host, port, p, channel, ingress, utterance) {
  const wav = join(host.dir, "test-question.wav"),
    ogg = join(host.dir, "test-question.ogg");
  await execute("espeak-ng", ["-v", "en-us", "-s", "142", "-w", wav, utterance]);
  await execute("ffmpeg", [
    "-nostdin",
    "-y",
    "-v",
    "error",
    "-i",
    wav,
    "-ac",
    "1",
    "-ar",
    "48000",
    "-c:a",
    "libopus",
    "-b:a",
    "16k",
    ogg,
  ]);
  const audio = await readFile(ogg);
  fail(
    audio.length > 0 && audio.length < 75000,
    "Expected a short test recording below CLI argument limits",
  );
  const id = randomUUID(),
    at = Date.now();
  if (ingress === "whatsapp-self") {
    const sent = await host.rpc(
      port,
      "send",
      {
        to: p.recipient,
        channel,
        accountId: p.account,
        asVoice: true,
        buffer: audio.toString("base64"),
        filename: "test-question.ogg",
        contentType: "audio/ogg",
        idempotencyKey: id,
      },
      60000,
    );
    fail(
      typeof sent.messageId === "string" && sent.messageId.length > 0,
      "WhatsApp did not acknowledge the seeded self-chat voice note",
    );
    return { id: sent.messageId, at };
  }
  const sessionKey = "agent:main:sarvam-" + channel + "-" + id;
  const prepared = await host.rpc(
    port,
    "chat.send",
    {
      sessionKey,
      message: "",
      attachments: [
        {
          type: "audio",
          mimeType: "audio/ogg",
          fileName: "question.ogg",
          origin: "file",
          sizeBytes: audio.length,
          content: audio.toString("base64"),
        },
      ],
      deliver: false,
      idempotencyKey: id,
    },
    80000,
  );
  fail(
    typeof prepared.runId === "string" && prepared.runId.length > 0,
    "Gateway did not acknowledge the attached audio",
  );
  return { id: prepared.runId, at, sessionKey };
}

export async function deliverGatewayReply(host, port, p, channel, model, input, matches) {
  const expires = Date.now() + Math.min(120, p.timeoutSeconds) * 1000;
  let spoken;
  while (Date.now() < expires) {
    const history = await host.rpc(port, "chat.history", {
      sessionKey: input.sessionKey,
      limit: 20,
    });
    for (const message of [...(history.messages ?? [])].reverse()) {
      if (message.role !== "assistant") continue;
      const content =
        typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text)
              .join(" ");
      if (matches(content)) {
        spoken = content;
        break;
      }
    }
    if (spoken) break;
    await sleep(650);
  }
  fail(
    spoken && spoken.length <= 2500,
    "The Gateway agent did not return the expected spoken lookup answer",
  );
  const tts = await host.rpc(
    port,
    "tts.convert",
    {
      text: spoken,
      provider: "sarvam",
      modelId: model,
      voiceId: model === "bulbul:v3" ? "shubh" : "shubh_enhi_ads",
      channel,
    },
    65000,
  );
  fail(
    tts.provider === "sarvam" && tts.outputFormat === "opus" && tts.voiceCompatible === true,
    "Gateway TTS did not return a Sarvam voice note",
  );
  const file = await realpath(tts.audioPath),
    allowed = await realpath(join(host.dir, "media", "tool-speech-synthesis"));
  const meta = await stat(file);
  fail(
    dirname(file) === allowed && meta.isFile() && meta.size > 0 && meta.size <= 8 * 1024 * 1024,
    "Expected an OpenClaw-generated short voice note",
  );
  const sent = await host.rpc(
    port,
    "send",
    {
      channel,
      accountId: p.account,
      to: p.recipient,
      mediaUrl: file,
      asVoice: true,
      idempotencyKey: randomUUID(),
    },
    65000,
  );
  fail(
    typeof sent.messageId === "string" && sent.messageId.length > 0,
    "The approved channel did not acknowledge the voice send",
  );
  return { id: sent.messageId, at: Date.now(), file };
}
