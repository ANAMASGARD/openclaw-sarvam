import { appendFile, copyFile, lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export function sameRecipient(channel, value, expected) {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const id = String(value)
    .trim()
    .replace(new RegExp("^" + channel + ":", "i"), "");
  if (channel === "telegram") return /^\d+$/.test(id) && id === expected;
  const match = /^\+?(\d{7,15})(?::\d+)?(?:@(?:s\.whatsapp\.net|c\.us))?$/.exec(id);
  return Boolean(channel === "whatsapp" && match && "+" + match[1] === expected);
}

export default {
  id: "sarvam-channel-receipt",
  register(api) {
    const root = process.env.OPENCLAW_STATE_DIR;
    const settings = async () =>
      JSON.parse(await readFile(join(root, "channel-acceptance.json"), "utf8"));
    async function authorized(ctx, peer) {
      const { channel, recipient, account } = await settings();
      return (
        ctx.channelId === channel &&
        (ctx.accountId ?? "default") === account &&
        sameRecipient(channel, peer ?? ctx.conversationId, recipient)
      );
    }
    const record = async (entry) =>
      appendFile(
        join(root, "channel-receipts.jsonl"),
        JSON.stringify({ at: Date.now(), ...entry }) + "\n",
        { mode: 0o600 },
      );
    api.on("message_sending", async (event, ctx) => {
      if (!(await authorized(ctx, event.to)))
        return { cancel: true, cancelReason: "Outside the private test DM" };
    });
    api.on("reply_payload_sending", async (event, ctx) => {
      const p = event.payload;
      if (p.audioAsVoice !== true || !(await authorized(ctx))) return;
      const refs = [
        p.mediaUrl,
        ...(p.mediaUrls ?? []),
        ...(p.attachments ?? []).map((a) => a.path ?? a.mediaUrl ?? a.url),
      ];
      const store = await realpath(join(root, "media", "tool-speech-synthesis")).catch(
        () => undefined,
      );
      for (const ref of refs) {
        if (typeof ref !== "string" || !store) continue;
        const candidate = ref.startsWith("file://") ? fileURLToPath(ref) : ref;
        if (!isAbsolute(candidate)) continue;
        const file = await realpath(candidate).catch(() => undefined);
        if (!file || dirname(file) !== store) continue;
        const stat = await lstat(file);
        if (!stat.isFile() || stat.size < 1 || stat.size > 8 * 1024 * 1024) continue;
        await copyFile(file, join(root, "channel-outbound.ogg"));
        await record({ kind: "outbound-voice", run: event.runId ?? ctx.runId });
        break;
      }
    });
    api.on("message_received", async (event, ctx) => {
      if (!(await authorized(ctx, event.from))) return;
      const audio = [...(event.media ?? []), ...(event.originalMedia ?? [])].some(
        (m) => m.kind === "audio" || m.kind === "voice" || m.contentType?.startsWith("audio/"),
      );
      const id = event.messageId ?? event.providerUpdate?.messageId ?? ctx.messageId;
      if (audio && id) await record({ kind: "inbound-audio", id: String(id) });
    });
    api.on("message_sent", async (event, ctx) => {
      if (!(await authorized(ctx, event.to))) return;
      if (event.success && event.messageId)
        await record({ kind: "sent", id: String(event.messageId), run: event.runId ?? ctx.runId });
      else await record({ kind: event.success ? "missing-receipt-id" : "send-failed" });
    });
  },
};
