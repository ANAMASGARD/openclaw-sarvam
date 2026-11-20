// A transparent test-only relay. The real Bot API returns the voice file_id only in sendVoice.
import { createServer } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writeFile } from "node:fs/promises";
const origin = "https://api.telegram.org";
const limit = 8 * 1024 * 1024;
async function bounded(response, max) {
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Telegram returned an empty response");
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((size += value.length) > max)
        throw new Error("Telegram test response exceeded the size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function telegramReceipt({ token, recipient, fetchFn = fetch }) {
  if (!/^\d+:[\w-]{10,}$/.test(token)) throw new Error("Invalid dedicated Telegram token file");
  let sent = [];
  let inbound = [];
  let since = Math.floor(Date.now() / 1000);
  const base = "/bot" + token + "/",
    fileBase = "/file" + base;
  const server = createServer(async (req, res) => {
    let path;
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      path = url.pathname;
      const api = path.startsWith(base),
        member = api ? path.slice(base.length) : undefined;
      const file = path.startsWith(fileBase) && /^[\w./-]+$/.test(path.slice(fileBase.length));
      if (
        (!file && !(api && /^[a-zA-Z][a-zA-Z0-9]+$/.test(member))) ||
        !["GET", "POST"].includes(req.method)
      ) {
        res.writeHead(404).end();
        return;
      }
      const abandoned = new AbortController();
      res.once("close", () => {
        if (!res.writableFinished) abandoned.abort();
      });
      const signal = AbortSignal.any([abandoned.signal, AbortSignal.timeout(100_000)]);
      const type = req.headers["content-type"] ?? "";
      let body = req.method === "POST" ? req : undefined;
      if (
        member &&
        /^(send|copyMessage|forwardMessage|editMessage|deleteMessage|setMessageReaction)/i.test(
          member,
        )
      ) {
        let chat = url.searchParams.get("chat_id");
        if (body) {
          body = await bounded(new Response(Readable.toWeb(req)), limit + 64 * 1024);
          const envelope = new Response(body, { headers: { "content-type": type } });
          if (type.startsWith("application/json")) chat = (await envelope.json()).chat_id;
          else if (type.includes("form")) chat = (await envelope.formData()).get("chat_id");
        }
        if (String(chat) !== recipient) {
          res.writeHead(403).end();
          return;
        }
      }
      const upstream = await fetchFn(origin + path + url.search, {
        method: req.method,
        headers: {
          ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
        },
        ...(body ? { body, duplex: "half" } : {}),
        signal,
        redirect: "error",
      });
      const headers = {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      };
      const method = member?.toLowerCase();
      if (method === "sendvoice" || method === "getupdates") {
        const body = await bounded(upstream, 4 * 1024 * 1024);
        if (upstream.ok) {
          const out = JSON.parse(body);
          const message = out.result;
          if (out.ok && method === "getupdates" && Array.isArray(out.result)) {
            for (const update of out.result) {
              const m = update.message;
              if (
                m?.chat?.type === "private" &&
                String(m.chat.id) === recipient &&
                String(m.from?.id) === recipient &&
                m.from.is_bot === false &&
                m.date >= since &&
                Number.isSafeInteger(m.message_id) &&
                typeof m.voice?.file_id === "string" &&
                !inbound.some((e) => e.id === String(m.message_id))
              ) {
                inbound.push({ id: String(m.message_id), at: Date.now() });
              }
            }
            inbound = inbound.slice(-64);
          }
          if (
            out.ok &&
            method === "sendvoice" &&
            message?.chat?.type === "private" &&
            String(message.chat.id) === recipient &&
            Number.isSafeInteger(message.message_id) &&
            typeof message.voice?.file_id === "string" &&
            message.voice.duration > 0
          )
            sent.push({
              id: String(message.message_id),
              fileId: message.voice.file_id,
              at: Date.now(),
            });
        }
        res.writeHead(upstream.status, headers).end(body);
      } else {
        res.writeHead(upstream.status, headers);
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
        else res.end();
      }
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    apiRoot: "http://127.0.0.1:" + server.address().port,
    reset() {
      sent = [];
      inbound = [];
      since = Math.floor(Date.now() / 1000);
    },
    inbound() {
      return [...inbound];
    },
    receipts() {
      return sent.map(({ id, at }) => ({ id, at }));
    },
    async download(id, dest) {
      const record = sent.find((x) => x.id === id);
      if (!record) throw new Error("Missing authenticated Telegram voice receipt");
      const r = await fetchFn(origin + base + "getFile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_id: record.fileId }),
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
      });
      if (!r.ok) throw new Error("Telegram getFile returned HTTP " + r.status);
      const meta = JSON.parse(await bounded(r, 1024 * 1024));
      const f = meta.result?.file_path;
      if (
        !meta.ok ||
        typeof f !== "string" ||
        !/^[\w.-]+(?:\/[\w.-]+)*$/.test(f) ||
        f.split("/").some((s) => s === "." || s === "..") ||
        !(meta.result.file_size > 0 && meta.result.file_size <= limit)
      )
        throw new Error("Telegram returned invalid voice file metadata");
      const media = await fetchFn(origin + fileBase + f, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!media.ok) throw new Error("Telegram voice download returned HTTP " + media.status);
      const bytes = await bounded(media, limit);
      if (bytes.length !== meta.result.file_size) throw new Error("Incomplete Telegram voice file");
      await writeFile(dest, bytes, { mode: 0o600 });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}
