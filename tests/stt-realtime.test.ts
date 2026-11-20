import { describe, expect, it, vi } from "vitest";
import { createSaarasSession } from "../src/stt/realtime.js";
import type { PluginCapabilityCatalogHostContext } from "openclaw/plugin-sdk/plugin-entry";
type Create = PluginCapabilityCatalogHostContext["createRealtimeTranscriptionWebSocketSession"];
function wire() {
  let opts: Parameters<Create>[0];
  const frames: unknown[] = [];
  let ready = false,
    open = false;
  const t = {
    callbacks: {},
    isReady: () => ready,
    isOpen: () => open,
    markReady: () => {
      ready = true;
    },
    closeNow: () => {
      ready = false;
      open = false;
    },
    failConnect: () => {
      ready = false;
      open = false;
    },
    sendBinary: () => {
      throw Error("Saaras requires JSON audio");
    },
    sendJson: (v: unknown) => {
      frames.push(v);
      return open;
    },
  };
  const create: Create = (settings) => {
    opts = settings as Parameters<Create>[0];
    return {
      async connect() {
        open = true;
        opts.onOpen?.(t);
        if (String(typeof opts.url === "function" ? await opts.url() : opts.url).includes("realtime/ws"))
          opts.onMessage?.({ event: "session.begin" }, t);
      },
      close() {
        opts.onClose?.(t);
      },
      sendAudio(b) {
        opts.sendAudio(b, t);
      },
      isConnected: () => ready,
    };
  };
  return {
    frames,
    create,
    url: () => String(typeof opts.url === "function" ? opts.url() : opts.url),
    event: (value: unknown) => opts.onMessage?.(value, t),
  };
}

describe("streaming transcription protocol lifecycle", () => {
  it("waits for a modern final, preserves identical utterances at different times, and ignores stale events", async () => {
    const w = wire(),
      onTranscript = vi.fn(),
      onPartial = vi.fn();
    const session = createSaarasSession(
      {
        providerConfig: {
          model: "saaras:v3-realtime",
          language_code: "hi-IN",
          encoding: "pcm16le",
          sampleRate: 16000,
        },
        onTranscript,
        onPartial,
      },
      w.create,
      async () => "test",
    );
    await session.connect();
    expect(new URL(w.url()).searchParams.get("model")).toBe("saaras:v3-realtime");
    session.sendAudio(Buffer.alloc(3200));
    expect(w.frames[0]).toMatchObject({ event: "audio_input", audio: Buffer.alloc(3200).toString("base64") });
    w.event({ event: "transcript.partial", text: "yes" });
    for (const time of [0, 0, 1])
      w.event({ event: "transcript.final", start_s: time, end_s: time + 1, text: "yes" });
    expect(onTranscript).toHaveBeenCalledTimes(2);
    expect(onPartial).toHaveBeenCalledWith("yes");
    const pending = session.finish();
    await vi.waitFor(() => expect(w.frames).toContainEqual({ event: "end" }));
    w.event({ event: "session.end" });
    await pending;
    expect(session.isConnected()).toBe(false);
    w.event({ event: "transcript.final", start_s: 2, end_s: 3, text: "stale" });
    expect(onTranscript).toHaveBeenCalledTimes(2);
  });
  it("uses the legacy PCM query and required per-frame WAV envelope", async () => {
    const w = wire(),
      onTranscript = vi.fn(),
      onPartial = vi.fn();
    const session = createSaarasSession(
      {
        providerConfig: {
          model: "saaras:v3",
          language_code: "en-IN",
          encoding: "pcm16le",
          sampleRate: 16000,
        },
        onTranscript,
        onPartial,
      },
      w.create,
      async () => "test",
    );
    await session.connect();
    const url = new URL(w.url());
    expect(url.pathname).toBe("/speech-to-text/ws");
    expect(url.searchParams.get("input_audio_codec")).toBe("pcm_s16le");
    session.sendAudio(Buffer.alloc(3200));
    expect(w.frames[0]).toMatchObject({
      audio: { encoding: "audio/wav", data: Buffer.alloc(3200).toString("base64"), sample_rate: 16000 },
    });
    const pending = session.finish();
    await vi.waitFor(() => expect(w.frames).toContainEqual({ type: "flush" }));
    // The legacy request ID is shared by all VAD-delimited segments on this socket.
    for (const word of ["hello", "again"]) {
      w.event({ type: "events", data: { signal_type: "START_SPEECH" } });
      w.event({ type: "data", data: { request_id: "r1", transcript: word } });
    }
    await pending;
    expect(onTranscript.mock.calls.map((call) => call[0])).toEqual(["hello", "again"]);
    expect(onPartial).not.toHaveBeenCalled();
  });
  it("rejects an oversized realtime backlog and refuses late callbacks on cancel", async () => {
    const w = wire(),
      onError = vi.fn(),
      onTranscript = vi.fn();
    const session = createSaarasSession(
      {
        providerConfig: { model: "saaras:v4", sampleRate: 16000, encoding: "pcm16le" },
        onError,
        onTranscript,
      },
      w.create,
      async () => "test",
    );
    await session.connect();
    session.sendAudio(Buffer.alloc(128 * 1024));
    expect(onError).toHaveBeenCalled();
    session.close();
    w.event({ event: "transcript.final", text: "stale" });
    expect(onTranscript).not.toHaveBeenCalled();
  });
  it("accepts an acknowledged v4-only keyterms update on the modern connection", async () => {
    const w = wire(),
      session = createSaarasSession({ providerConfig: { model: "saaras:v4" } }, w.create, async () => "test");
    await session.connect();
    const applied = session.update({ keyterms: ["New Delhi"] });
    expect(w.frames).toContainEqual({ event: "config.update", keyterms: ["New Delhi"] });
    w.event({ event: "config.updated" });
    await applied;
    session.close();
  });
});
