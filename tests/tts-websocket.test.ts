import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { openBulbulSocket } from "../src/tts/websocket.js";
import { bulbulRequest } from "../src/tts/models.js";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function fixture(reply: (client: WebSocket, turn: number) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("socket port missing");
  const frames: unknown[] = [];
  server.on("connection", (socket, req) => {
    expect(req.headers["api-subscription-key"]).toBe("fixture-token");
    let turns = 0;
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      frames.push(frame);
      if (frame.type === "flush") reply(socket, ++turns);
    });
  });
  const session = await openBulbulSocket("bulbul:v3", {
    apiKey: "fixture-token",
    timeoutMs: 2000,
    createSocket(url, options) {
      expect(url.hostname).toBe("api.sarvam.ai");
      expect(url.searchParams.get("model")).toBe("bulbul:v3");
      expect(url.searchParams.get("send_completion_event")).toBe("true");
      return new WebSocket("ws://127.0.0.1:" + address.port, options);
    },
  });
  return { session, frames, server };
}
const body = bulbulRequest("Hello", { model: "bulbul:v3", codec: "linear16" }, "websocket");
describe("Bulbul WebSocket", () => {
  it("flushes sequential utterances and emits ordered base64 audio", async () => {
    const { session, frames } = await fixture((c, turn) => {
      for (const s of ["a", "b"]) {
        c.send(
          JSON.stringify({
            type: "audio",
            data: { content_type: "audio/pcm", audio: Buffer.from(s + turn).toString("base64") },
          }),
        );
      }
      c.send(JSON.stringify({ type: "event", data: { event_type: "final" } }));
    });
    try {
      for (const turn of [1, 2]) {
        const stream = session.synthesize(body);
        await expect(new Response(stream).text()).resolves.toBe("a" + turn + "b" + turn);
      }
      expect(frames).toHaveLength(6);
      expect(frames[0]).toEqual({
        type: "config",
        data: {
          language_code: "en-IN",
          speaker: "shubh",
          output_audio_codec: "linear16",
          speech_sample_rate: 22050,
        },
      });
      expect(frames[1]).toEqual({ type: "text", data: { text: "Hello" } });
    } finally {
      session.close();
    }
  });
  it.each(["malformed", "empty-final", "premature-close", "upstream-error"])(
    "rejects %s without leaking text",
    async (kind) => {
      const { session } = await fixture((c) => {
        if (kind === "malformed") c.send("!");
        else if (kind === "empty-final")
          c.send(JSON.stringify({ type: "event", data: { event_type: "final" } }));
        else if (kind === "upstream-error")
          c.send(JSON.stringify({ type: "error", data: { code: 403, message: "fixture-token" } }));
        else c.close();
      });
      try {
        await expect(new Response(session.synthesize(body)).text()).rejects.toThrow(/Bulbul/);
      } finally {
        session.close();
      }
    },
  );
  it("disconnects on stream cancellation", async () => {
    const { session, server } = await fixture(() => {});
    const socket = [...server.clients][0];
    const closed = once(socket, "close");
    const stream = session.synthesize(body);
    await stream.cancel();
    await closed;
    expect(() => session.synthesize(body)).toThrow(/closed/i);
  });
  it("allows discarding buffered audio from a finished turn while the next turn runs", async () => {
    const releaseSecond = Promise.withResolvers<void>();
    const { session } = await fixture(async (client, number) => {
      if (number === 2) await releaseSecond.promise;
      const audio = Buffer.from(String(number)).toString("base64");
      for (let i = 0; i < 2; i++) {
        client.send(JSON.stringify({ type: "audio", data: { content_type: "audio/pcm", audio } }));
      }
      client.send(JSON.stringify({ type: "event", data: { event_type: "final" } }));
    });
    try {
      const first = session.synthesize(body).getReader();
      await first.read();
      let second: ReadableStream<Uint8Array> | undefined;
      await vi.waitFor(() => {
        second = session.synthesize(body);
      });
      await first.cancel();
      releaseSecond.resolve();
      await expect(new Response(second).text()).resolves.toBe("22");
    } finally {
      releaseSecond.resolve();
      session.close();
    }
  });
});
