import type {
  PluginCapabilityCatalogHostContext,
  RealtimeTranscriptionProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { hasCapabilityKey, hasCapabilityKeyAsync, resolveCapabilityKey } from "../auth.js";
import { AUTH_HEADER, WS_ORIGIN, type JsonObject } from "../http.js";
import { pcmConverter } from "./pcm.js";
import { modelSettings, REALTIME_MODELS } from "./settings.js";

type HostSocket = PluginCapabilityCatalogHostContext["createRealtimeTranscriptionWebSocketSession"];
type Socket = Parameters<NonNullable<Parameters<HostSocket>[0]["onOpen"]>>[0];
type SessionInput = Parameters<RealtimeTranscriptionProviderPlugin["createSession"]>[0];
const RATE = 16000;
const FRAME = 3200; // 100 ms of mono signed PCM16.
const MAX_BUFFER = FRAME * 30;

function exactOption(value: unknown, values: readonly string[], name: string): string {
  if (typeof value !== "string" || !values.includes(value)) throw new Error("Invalid Saaras " + name);
  return value;
}

export function createSaarasSession(req: SessionInput, create: HostSocket, getKey: () => Promise<string>) {
  const config = req.providerConfig;
  const protocol = exactOption(
    config.protocol ?? (config.model === "saaras:v3" ? "legacy" : "realtime"),
    ["realtime", "legacy"],
    "WebSocket protocol",
  );
  const modern = protocol === "realtime";
  const parameters = modelSettings(config, modern ? "realtime" : "legacy");
  const url = new URL(modern ? "/speech-to-text-realtime/ws" : "/speech-to-text/ws", WS_ORIGIN);
  for (const [key, value] of Object.entries(parameters))
    url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  url.searchParams.set("sample_rate", String(RATE));
  if (modern) {
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("return_timestamps", "true");
    url.searchParams.set(
      "stream_type",
      exactOption(config.streamType ?? "fast", ["fast", "balanced", "simulated"], "stream type"),
    );
    url.searchParams.set("endpointing", "vad");
    for (const name of [
      "threshold",
      "silence_duration_ms",
      "min_speech_duration_ms",
      "prefix_padding_ms",
    ] as const) {
      const value = config[name];
      if (value === undefined) continue;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        (name === "threshold" ? value > 1 : !Number.isInteger(value))
      )
        throw new Error("Invalid Saaras " + name);
      url.searchParams.set(name, String(value));
    }
  } else {
    url.searchParams.set("input_audio_codec", "pcm_s16le");
    url.searchParams.set("vad_signals", "true");
    url.searchParams.set("flush_signal", "true");
    if (config.high_vad_sensitivity !== undefined) {
      if (typeof config.high_vad_sensitivity !== "boolean") throw new Error("Invalid Saaras VAD sensitivity");
      url.searchParams.set("high_vad_sensitivity", String(config.high_vad_sensitivity));
    }
  }
  const sampleRate = Number(config.sampleRate ?? 8000);
  const channels = Number(config.channels ?? 1);
  const encoding = config.encoding ?? "mulaw";
  if (
    ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate) ||
    ![1, 2].includes(channels) ||
    (encoding !== "mulaw" && encoding !== "pcm16le")
  )
    throw new Error("Invalid Saaras input encoding, sample rate or channel count");
  const convert = pcmConverter({ sampleRate, channels, encoding }, RATE);
  let socket: Socket | undefined;
  let queue: Buffer[] = [];
  let bytes = 0;
  let tail = Buffer.alloc(0);
  let tick: NodeJS.Timeout | undefined;
  let keepalive: NodeJS.Timeout | undefined;
  let lastAudioAt = 0;
  let finishTimeout: NodeJS.Timeout | undefined;
  let finalRequested = false;
  let sentEnd = false;
  let stopped = false;
  let utteranceActive = false;
  let receivedFinal = false;
  let legacyPending = 0;
  let quiet: NodeJS.Timeout | undefined;
  let update:
    | { patch: JsonObject; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
    | undefined;
  let finish: { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } | undefined;
  const seen = new Set<string>();

  function stop(error?: Error, report = true) {
    if (stopped) return;
    stopped = true;
    clearTimeout(tick);
    clearTimeout(finishTimeout);
    clearInterval(keepalive);
    clearTimeout(quiet);
    if (update) {
      clearTimeout(update.timer);
      update.reject(new Error("Saaras connection closed during a settings update"));
      update = undefined;
    }
    queue = [];
    tail = Buffer.alloc(0);
    try {
      if (error) {
        finish?.reject(error);
        if (report) req.onError?.(error);
      } else finish?.resolve();
    } finally {
      connection.close();
    }
  }

  // Legacy sends a final for each VAD segment, with no end-of-stream ack.
  // Keep reading while speech is pending and allow late server events to arrive.
  function settleLegacy() {
    clearTimeout(quiet);
    if (sentEnd && receivedFinal && !legacyPending) quiet = setTimeout(() => stop(), 1000);
  }

  function drain() {
    if (stopped || tick || !socket?.isReady()) return;
    const chunk = queue.shift();
    if (chunk) {
      bytes -= chunk.length;
      const audio = chunk.toString("base64");
      // The legacy server validates this envelope as audio/wav; the negotiated
      // input_audio_codec describes the actual raw PCM payload.
      const message = modern
        ? { event: "audio_input", audio }
        : { audio: { data: audio, sample_rate: RATE, encoding: "audio/wav" } };
      if (!socket.sendJson(message)) return stop(new Error("Saaras streaming audio was interrupted"));
      lastAudioAt = Date.now();
      tick = setTimeout(
        () => {
          tick = undefined;
          drain();
        },
        (chunk.length / (RATE * 2)) * 1000,
      );
    } else if (finalRequested && !sentEnd) {
      sentEnd = true;
      if (!socket.sendJson(modern ? { event: "end" } : { type: "flush" }))
        return stop(new Error("Saaras could not finalize the stream"));
      // The legacy protocol has no stream-end acknowledgement. A preceding VAD
      // final may already cover the whole utterance; otherwise wait for flush.
      if (!modern) settleLegacy();
      finishTimeout = setTimeout(
        () => stop(new Error("Saaras timed out waiting for final transcription")),
        14000,
      );
    }
  }

  function final(text: unknown, identity?: string) {
    if (typeof text !== "string" || !text.trim() || (identity && seen.has(identity))) return;
    if (identity) {
      seen.add(identity);
      if (seen.size > 2048) seen.delete(seen.values().next().value!);
    }
    utteranceActive = false;
    receivedFinal = true;
    req.onTranscript?.(text.trim());
  }

  const connection = create<JsonObject>({
    providerId: "sarvam",
    url: () => url.href,
    headers: async () => ({ [AUTH_HEADER]: await getKey() }),
    callbacks: { onError: () => stop(new Error("Saaras realtime connection failed")) },
    readyOnOpen: false,
    maxQueuedBytes: MAX_BUFFER,
    maxReconnectAttempts: 2,
    closeTimeoutMs: 1000,
    sendAudio() {}, // PCM is framed and paced by the bounded queue above.
    onOpen(t) {
      if (stopped) return t.closeNow();
      if (socket && (utteranceActive || legacyPending || finalRequested || update || bytes)) {
        socket = t;
        return stop(new Error("Saaras connection changed during an utterance"));
      }
      socket = t;
      seen.clear();
      receivedFinal = false;
      if (!modern) {
        t.markReady();
        drain();
      }
    },
    onClose(t) {
      t.closeNow();
    },
    onMessage(event, t) {
      if (stopped || t !== socket || !t.isOpen()) return;
      const data = event.data && typeof event.data === "object" ? (event.data as JsonObject) : {};
      if (modern) {
        switch (event.event) {
          case "session.begin":
            t.markReady();
            lastAudioAt = Date.now();
            clearInterval(keepalive);
            keepalive = setInterval(() => {
              if (
                !stopped &&
                !finalRequested &&
                t === socket &&
                t.isReady() &&
                Date.now() - lastAudioAt >= 25000
              ) {
                if (!t.sendJson({ event: "ping" })) stop(new Error("Saaras keepalive failed"));
              }
            }, 25000);
            keepalive.unref();
            drain();
            break;
          case "vad.speech_start":
            utteranceActive = true;
            req.onSpeechStart?.();
            break;
          case "transcript.partial":
            if (typeof event.text === "string") req.onPartial?.(event.text);
            break;
          case "transcript.final": {
            const id =
              typeof event.start_s === "number" && typeof event.end_s === "number"
                ? event.start_s + "-" + event.end_s
                : undefined;
            final(event.text, id);
            break;
          }
          case "config.updated":
            if (update) {
              for (const [key, value] of Object.entries(update.patch))
                url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
              clearTimeout(update.timer);
              update.resolve();
              update = undefined;
            }
            break;
          case "session.end":
            if (sentEnd) stop();
            else stop(new Error("Saaras ended the realtime session"));
            break;
          case "error": {
            const failure = new Error("Saaras rejected the realtime stream");
            if (event.is_fatal !== false) {
              if (!t.isReady()) t.failConnect(failure);
              stop(failure);
            } else req.onError?.(new Error("Saaras rejected a realtime frame"));
            break;
          }
        }
      } else if (event.type === "events" && data.signal_type === "START_SPEECH") {
        clearTimeout(quiet);
        legacyPending++;
        utteranceActive = true;
        req.onSpeechStart?.();
      } else if (event.type === "data") {
        // request_id can identify the entire socket; two distinct utterances
        // within one connection may legitimately have the same ID.
        final(data.transcript);
        legacyPending = Math.max(0, legacyPending - 1);
        settleLegacy();
      } else if (event.type === "error") {
        stop(new Error("Saaras rejected the legacy stream"));
      }
    },
  });

  return {
    connect: () => (stopped ? Promise.reject(new Error("Saaras session is closed")) : connection.connect()),
    isConnected: () => !stopped && connection.isConnected(),
    sendAudio(input: Buffer) {
      if (!input.length || stopped || finalRequested) return;
      if (input.length > 256 * 1024) return stop(new Error("Saaras audio chunk exceeds buffer capacity"));
      const pcm = convert(input);
      if (bytes + tail.length + pcm.length > MAX_BUFFER)
        return stop(new Error("Saaras realtime audio queue is full"));
      const buffer = tail.length ? Buffer.concat([tail, pcm]) : pcm;
      let offset = 0;
      for (; offset + FRAME <= buffer.length; offset += FRAME) {
        queue.push(Buffer.from(buffer.subarray(offset, offset + FRAME)));
        bytes += FRAME;
      }
      tail = Buffer.from(buffer.subarray(offset));
      drain();
    },
    update(settings: JsonObject): Promise<void> {
      if (!modern || !socket?.isReady() || finalRequested || update || stopped)
        throw new Error("Saaras settings update unavailable");
      const keys = Object.keys(settings);
      if (!keys.length || keys.some((key) => !["language_code", "mode", "keyterms"].includes(key)))
        throw new Error("Unsupported Saaras settings update");
      const normalized = modelSettings({ ...parameters, ...settings }, "realtime");
      const patch = Object.fromEntries(keys.map((key) => [key, normalized[key]]));
      return new Promise<void>((resolve, reject) => {
        update = {
          patch,
          resolve,
          reject,
          timer: setTimeout(() => stop(new Error("Saaras settings acknowledgement timed out")), 5000),
        };
        if (!socket?.sendJson({ event: "config.update", ...patch }))
          stop(new Error("Saaras could not update settings"));
      });
    },
    finish() {
      if (finish) return finish.promise;
      if (stopped || !socket?.isReady()) return Promise.reject(new Error("Saaras session is not connected"));
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((success, failure) => {
        resolve = success;
        reject = failure;
      });
      finish = { promise, resolve, reject };
      finalRequested = true;
      if (tail.length) {
        queue.push(tail);
        bytes += tail.length;
        tail = Buffer.alloc(0);
      }
      drain();
      return finish.promise;
    },
    close() {
      stop(finish ? new Error("Saaras transcription cancelled") : undefined, false);
    },
  };
}

export function realtimeProvider(
  host: PluginCapabilityCatalogHostContext,
): RealtimeTranscriptionProviderPlugin {
  return {
    id: "sarvam",
    label: "Sarvam Saaras",
    models: REALTIME_MODELS,
    defaultModel: "saaras:v4",
    isConfigured: ({ cfg }) => hasCapabilityKey(host, cfg),
    isConfiguredAsync: ({ cfg }) => hasCapabilityKeyAsync(host, cfg),
    createSession(req) {
      return createSaarasSession(req, host.createRealtimeTranscriptionWebSocketSession, () =>
        resolveCapabilityKey(host, req.cfg),
      );
    },
  };
}
