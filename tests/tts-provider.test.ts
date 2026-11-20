import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { bufferedBulbul, streamedBulbul } from "../src/tts/provider.js";

const wav = execFileSync("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=660:duration=0.25",
  "-ar",
  "24000",
  "-ac",
  "1",
  "-f",
  "wav",
  "pipe:1",
]);
const probe = (b: Buffer) =>
  JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", "pipe:0"], {
      input: b,
      encoding: "utf8",
    }),
  ).streams[0];

describe("OpenClaw voice notes", () => {
  it("converts provider WAV bytes into a playable, mono Ogg/Opus note", async () => {
    const result = await bufferedBulbul("Train", {}, "voice-note", {
      apiKey: "fixture-token",
      fetchFn: async (_, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "bulbul:v4-flash",
          output_audio_codec: "opus",
          speech_sample_rate: 48000,
        });
        return Response.json({ audios: [wav.toString("base64")] });
      },
    });
    expect(result).toMatchObject({
      fileExtension: ".ogg",
      outputFormat: "opus",
      voiceCompatible: true,
    });
    expect(probe(result.audioBuffer)).toMatchObject({
      codec_name: "opus",
      sample_rate: "48000",
      channels: 1,
    });
  });
  it("streams WAV fallback through FFmpeg when upstream rejects Opus", async () => {
    const codecs: string[] = [];
    const result = await streamedBulbul("Train", {}, "voice-note", {
      apiKey: "fixture-token",
      fetchFn: async (_, init) => {
        const body = JSON.parse(String(init?.body));
        codecs.push(body.output_audio_codec);
        if (body.output_audio_codec === "opus")
          return Response.json(
            { error: { message: "Unsupported audio codec opus" } },
            { status: 400 },
          );
        return new Response(wav, { headers: { "content-type": "audio/wav" } });
      },
    });
    const b = Buffer.from(await new Response(result.audioStream).arrayBuffer());
    expect(codecs).toEqual(["opus", "wav"]);
    expect(probe(b)).toMatchObject({ codec_name: "opus", sample_rate: "48000", channels: 1 });
    await result.release();
  });
  it("keeps a 402 terminal and rejects non-audio bytes with a success status", async () => {
    let calls = 0;
    await expect(
      bufferedBulbul("Train", {}, "voice-note", {
        apiKey: "fixture",
        fetchFn: async () => {
          calls++;
          return Response.json({}, { status: 402 });
        },
      }),
    ).rejects.toThrow(/402/);
    expect(calls).toBe(1);
    await expect(
      bufferedBulbul("Train", {}, "audio-file", {
        apiKey: "fixture",
        fetchFn: async () =>
          Response.json({
            audios: [Buffer.from("json masquerading as speech").toString("base64")],
          }),
      }),
    ).rejects.toThrow(/incompatible/);
  });
});

it("honors Gateway model and voice overrides and speech-only credentials", async () => {
  const { bulbulProvider } = await import("../src/tts/provider.js");
  const provider = bulbulProvider({
    isProviderApiKeyConfigured: () => true,
    resolveApiKeyForProvider: async () => ({ mode: "api-key", apiKey: "active-profile" }),
    fetchWithSsrFGuard: async ({ init }: { init: RequestInit }) => {
      expect(new Headers(init.headers).get("api-subscription-key")).toBe("active-profile");
      expect(JSON.parse(String(init.body))).toMatchObject({ model: "bulbul:v3", speaker: "shubh" });
      return {
        response: Response.json({ audios: [wav.toString("base64")] }),
        release: async () => {},
      };
    },
  } as Parameters<typeof bulbulProvider>[0]);
  const overrides = provider.resolveTalkOverrides?.({
    talkProviderConfig: {},
    params: { modelId: "bulbul:v3" },
  });
  expect(overrides).toMatchObject({ modelId: "bulbul:v3" });
  const res = await provider.synthesize({
    cfg: {},
    target: "audio-file",
    timeoutMs: 1500,
    text: "Hello",
    providerConfig: { modelId: "bulbul:v4-flash", speaker: "simran_en_customer" },
    providerOverrides: overrides,
  });
  expect(res.fileExtension).toBe(".wav");
  expect(
    provider.resolveTalkOverrides?.({
      talkProviderConfig: {},
      params: { modelId: "bulbul:v4-flash", voiceId: "aparna_hi_customer" },
    }),
  ).toEqual({ modelId: "bulbul:v4-flash", speaker: "aparna_hi_customer" });
});
