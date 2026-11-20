import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { telegramReceipt } from "./telegram-receipt.mjs";
import { deliverGatewayReply, submitAudio, verifySpokenLookup } from "./channel-input.mjs";
import { sameRecipient } from "./fixtures/channel-receipt/index.js";

describe("allowlisted real-channel evidence collection", () => {
  it("keeps a private diagnostic clip only for a failed generated-audio check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sarvam-mismatch-"));
    try {
      const file = join(dir, "out.ogg"), mismatchFile = join(dir, "mismatch.ogg");
      const check = { file, mismatchFile, expected: "red green blue", recognizedColors: "red blue" };
      await writeFile(file, "synthetic fixture");
      await expect(verifySpokenLookup({ ...check, ingress: "phone" })).rejects.toThrow(/did not match/);
      await expect(stat(mismatchFile)).rejects.toMatchObject({ code: "ENOENT" });
      await verifySpokenLookup({ ...check, ingress: "gateway", recognizedColors: check.expected });
      await expect(stat(mismatchFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(verifySpokenLookup({ ...check, ingress: "gateway" })).rejects.toThrow(/heard color words "red blue"/);
      expect((await stat(mismatchFile)).mode & 0o777).toBe(0o600);
      expect(await readFile(mismatchFile, "utf8")).toBe("synthetic fixture");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("matches private channel peer identities and rejects group and unrelated IDs", () => {
    expect(sameRecipient("telegram", "telegram:123456", "123456")).toBe(true);
    expect(sameRecipient("telegram", "-123456", "123456")).toBe(false);
    expect(sameRecipient("whatsapp", "whatsapp:+919876543210", "+919876543210")).toBe(true);
    expect(sameRecipient("whatsapp", "919876543210:2@s.whatsapp.net", "+919876543210")).toBe(true);
    expect(sameRecipient("whatsapp", "919876543210@g.us", "+919876543210")).toBe(false);
    expect(sameRecipient("whatsapp", "919876543211@s.whatsapp.net", "+919876543210")).toBe(false);
  });
  it.each(["gateway", "whatsapp-self"])(
    "submits real encoded speech through the documented %s RPC",
    async (mode) => {
      const dir = await mkdtemp(join(tmpdir(), "sarvam-voice-input-"));
      const target = { account: "default", recipient: "+919876543210" };
      let calls = 0;
      try {
        const host = {
          dir,
          rpc: async (
            port: number,
            method: string,
            params: {
              attachments?: { content: string }[];
              buffer?: string;
              originatingTo?: string;
              originatingChannel?: string;
              to?: string;
              asVoice?: boolean;
              message?: string;
              deliver?: boolean;
            },
          ) => {
            calls++;
            expect(port).toBe(17777);
            expect(method).toBe(mode === "gateway" ? "chat.send" : "send");
            if (mode === "gateway") {
              expect(params).toMatchObject({ message: "", deliver: false });
              expect(params).not.toHaveProperty("originatingChannel");
              expect(params).not.toHaveProperty("suppressCommandInterpretation");
            } else expect(params).toMatchObject({ to: target.recipient, asVoice: true });
            const bytes = Buffer.from(
              params.attachments?.[0].content ?? params.buffer ?? "",
              "base64",
            );
            expect(bytes.subarray(0, 4).toString()).toBe("OggS");
            expect(bytes.includes("OpusHead")).toBe(true);
            return { messageId: "accepted", runId: "accepted" };
          },
        };
        const result = await submitAudio(
          host,
          17777,
          target,
          "whatsapp",
          mode,
          "The yellow train is at the station.",
        );
        expect(result.id).toBe("accepted");
        expect(calls).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it("sends the matching agent response through native synthesis to the selected number", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sarvam-send-test-"));
    const media = join(dir, "media", "tool-speech-synthesis");
    await mkdir(media, { recursive: true });
    const file = join(media, "reply.ogg");
    await writeFile(file, "OggSfixture");
    const methods: string[] = [];
    try {
      const host = {
        dir,
        rpc: async (_port: number, method: string, params: Record<string, unknown>) => {
          methods.push(method);
          if (method === "chat.history")
            return {
              messages: [
                { role: "user", content: "ignored user text" },
                {
                  role: "assistant",
                  content: [{ type: "text", text: "The words are red, pink and blue." }],
                },
              ],
            };
          if (method === "tts.convert") {
            expect(params).toMatchObject({
              text: "The words are red, pink and blue.",
              modelId: "bulbul:v3",
              provider: "sarvam",
              channel: "whatsapp",
            });
            return {
              provider: "sarvam",
              outputFormat: "opus",
              voiceCompatible: true,
              audioPath: file,
            };
          }
          expect(params).toMatchObject({
            asVoice: true,
            mediaUrl: file,
            to: "+919876543210",
            accountId: "default",
          });
          return { messageId: "accepted" };
        },
      };
      const result = await deliverGatewayReply(
        host,
        17777,
        { timeoutSeconds: 5, recipient: "+919876543210", account: "default" },
        "whatsapp",
        "bulbul:v3",
        { sessionKey: "private" },
        (text: string) => text.includes("red, pink and blue"),
      );
      expect(result.id).toBe("accepted");
      expect(methods).toEqual(["chat.history", "tts.convert", "send"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("uses the accepted sendVoice file identifier to download from the official origin", async () => {
    const token = "123456:fixture-credential",
      peer = "77123",
      bytes = Buffer.from("OggSfixture");
    const dir = await mkdtemp(join(tmpdir(), "sarvam-receipt-test-"));
    let scope = peer;
    const relay = await telegramReceipt({
      token,
      recipient: peer,
      fetchFn: async (input: string, options: RequestInit) => {
        const url = new URL(input);
        expect(url.origin).toBe("https://api.telegram.org");
        expect(options.redirect).toBe("error");
        if (url.pathname.endsWith("getFile")) {
          expect(JSON.parse(String(options.body))).toEqual({ file_id: "voice-id" });
          return Response.json({
            ok: true,
            result: { file_path: "voice/path.oga", file_size: bytes.length },
          });
        }
        if (url.pathname.endsWith("getUpdates"))
          return Response.json({
            ok: true,
            result: [
              {
                message: {
                  message_id: 812,
                  chat: { id: peer, type: "private" },
                  from: { id: peer, is_bot: false },
                  date: Math.floor(Date.now() / 1000),
                  voice: { file_id: "in-voice" },
                },
              },
            ],
          });
        if (url.pathname.endsWith("path.oga")) return new Response(bytes);
        return Response.json({
          ok: true,
          result: {
            message_id: 813,
            chat: { id: scope, type: "private" },
            voice: { file_id: "voice-id", duration: 1 },
          },
        });
      },
    });
    try {
      const url = relay.apiRoot + "/bot" + token + "/sendVoice";
      expect((await fetch(relay.apiRoot + "/bother/route")).status).toBe(404);
      const send = (chat_id: string) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id }),
        });
      expect((await send("999")).status).toBe(403);
      scope = "99";
      await send(peer);
      expect(relay.receipts()).toHaveLength(0);
      scope = peer;
      const reply = await send(peer);
      expect((await reply.json()).result.message_id).toBe(813);
      expect(relay.receipts()).toEqual([{ id: "813", at: expect.any(Number) }]);
      const form = new FormData();
      form.set("chat_id", peer);
      form.set("voice", new Blob([bytes], { type: "audio/ogg" }), "note.ogg");
      expect((await fetch(url, { method: "POST", body: form })).ok).toBe(true);
      await fetch(relay.apiRoot + "/bot" + token + "/getUpdates");
      expect(relay.inbound()).toEqual([{ id: "812", at: expect.any(Number) }]);
      const path = join(dir, "recording.ogg");
      await relay.download("813", path);
      expect(await readFile(path)).toEqual(bytes);
      relay.reset();
      await expect(relay.download("813", path)).rejects.toThrow("Missing authenticated");
    } finally {
      await relay.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
