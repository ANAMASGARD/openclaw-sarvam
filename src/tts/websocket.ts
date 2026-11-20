import WebSocket, { type ClientOptions } from "ws";
import { requireKey } from "../auth.js";
import { AUTH_HEADER, WS_ORIGIN, SarvamHttpError, object, type Transport } from "../http.js";
import { AUDIO_LIMIT, decodeAudio, ownedStream, type AudioSource } from "./audio.js";
import type { Synthesis } from "./models.js";
import type { BulbulModel } from "./voices.js";

export type SocketOptions = Transport & {
  agent?: ClientOptions["agent"];
  createSocket?: (url: URL, options: ClientOptions) => WebSocket;
};

/** A connection's negotiated model applies to every sequential synthesis turn. */
export async function openBulbulSocket(model: BulbulModel, options: SocketOptions) {
  const apiKey = requireKey(options.apiKey);
  const url = new URL("/text-to-speech/ws", WS_ORIGIN);
  url.searchParams.set("model", model);
  url.searchParams.set("send_completion_event", "true");
  options.signal?.throwIfAborted();
  options.beforeRequest?.();
  const timeout = options.timeoutMs ?? 60_000;
  const socketOptions: ClientOptions = {
    headers: { [AUTH_HEADER]: apiKey },
    agent: options.agent,
    handshakeTimeout: Math.min(15_000, timeout),
    followRedirects: false,
    perMessageDeflate: false,
    maxPayload: 4 * 1024 * 1024,
  };
  const socket = options.createSocket
    ? options.createSocket(url, socketOptions)
    : new WebSocket(url, socketOptions);
  let closed = false;
  let turn: { controller: ReadableStreamDefaultController<Uint8Array>; size: number } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let rejectConnection: ((error: Error) => void) | undefined;
  function stop(error = new Error("Bulbul WebSocket synthesis was closed")) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    rejectConnection?.(error);
    rejectConnection = undefined;
    turn?.controller.error(error);
    turn = undefined;
    socket.terminate();
  }
  const abort = () => stop(new Error("Bulbul WebSocket synthesis was cancelled"));
  const armTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop(new Error("Bulbul WebSocket timed out")), timeout);
    timer.unref();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  socket.on("error", () => stop(new Error("Bulbul WebSocket connection failed")));
  socket.on("unexpected-response", (req, res) => {
    res.resume();
    req.destroy();
    stop(new SarvamHttpError(res.statusCode ?? 502));
  });
  socket.on("close", () => stop(new Error("Bulbul WebSocket closed before completion")));
  socket.on("message", (data, binary) => {
    if (closed) return;
    try {
      if (binary) throw new Error("Bulbul WebSocket returned an unexpected binary frame");
      let frame: Record<string, unknown>;
      try {
        frame = object(JSON.parse(data.toString()), "Bulbul WebSocket event");
      } catch {
        throw new Error("Bulbul WebSocket returned malformed JSON");
      }
      const payload = object(frame.data, "Bulbul WebSocket payload");
      if (frame.type === "error") {
        // Upstream messages may contain user text or a reflected credential.
        const invalidCodec =
          /(?:codec|opus)/i.test(String(payload.message)) &&
          /(?:invalid|unsupported|not supported|rate)/i.test(String(payload.message));
        if (invalidCodec && [400, 422].includes(Number(payload.code)))
          throw new SarvamHttpError(Number(payload.code), "unsupported_audio_codec");
        throw new Error(
          `Bulbul WebSocket synthesis failed${Number.isInteger(payload.code) ? " (code " + payload.code + ")" : ""}`,
        );
      }
      if (!turn) throw new Error("Bulbul WebSocket sent audio outside an active turn");
      if (frame.type === "audio") {
        if (typeof payload.content_type !== "string" || !payload.content_type.startsWith("audio/"))
          throw new Error("Bulbul WebSocket returned non-audio content");
        const chunk = decodeAudio(payload.audio, AUDIO_LIMIT - turn.size);
        turn.size += chunk.length;
        turn.controller.enqueue(chunk);
        if ((turn.controller.desiredSize ?? 0) <= 0) socket.pause();
        return;
      }
      if (frame.type !== "event" || payload.event_type !== "final" || !turn.size) {
        throw new Error("Bulbul WebSocket returned an unexpected completion event");
      }
      turn.controller.close();
      turn = undefined;
      socket.resume();
      armTimer();
    } catch (error) {
      stop(error instanceof Error ? error : new Error("Bulbul WebSocket protocol error"));
    }
  });

  await new Promise<void>((resolve, reject) => {
    rejectConnection = reject;
    socket.once("open", () => {
      rejectConnection = undefined;
      armTimer();
      resolve();
    });
    if (options.signal?.aborted) abort();
  });
  return {
    close: () => stop(),
    synthesize(body: Synthesis) {
      if (closed || socket.readyState !== WebSocket.OPEN)
        throw new Error("Bulbul WebSocket is closed");
      if (turn) throw new Error("Finish the active Bulbul synthesis before starting another turn");
      if (body.model !== model)
        throw new Error("Start another Bulbul connection to use a different model");
      options.beforeRequest?.();
      const { model: _model, text, ...config } = body;
      let owner: ReadableStreamDefaultController<Uint8Array>;
      return new ReadableStream<Uint8Array>(
        {
          start(controller) {
            owner = controller;
            turn = { controller, size: 0 };
            armTimer();
            for (const message of [
              { type: "config", data: config },
              { type: "text", data: { text } },
              { type: "flush" },
            ]) {
              socket.send(JSON.stringify(message), (error) => {
                if (error) stop(new Error("Bulbul WebSocket send failed"));
              });
            }
          },
          pull() {
            if (turn?.controller === owner) socket.resume();
          },
          // Sarvam has no documented cancel message. Closing fences late frames and interrupts the turn.
          cancel() {
            if (turn?.controller === owner) stop();
          },
        },
        { highWaterMark: 256 * 1024, size: (chunk) => chunk.byteLength },
      );
    },
  };
}

export async function streamWebSocket(
  body: Synthesis,
  options: SocketOptions,
): Promise<AudioSource> {
  const session = await openBulbulSocket(body.model, options);
  try {
    return ownedStream(session.synthesize(body), async () => session.close(), options.signal);
  } catch (error) {
    session.close();
    throw error;
  }
}
