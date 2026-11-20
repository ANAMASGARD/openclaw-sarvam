import { describe, expect, it } from "vitest";
import { bulbulRequest } from "../src/tts/models.js";
import { synthesizeRest, streamHttp } from "../src/tts/http.js";

const key = "private-test-value";
const req = bulbulRequest("Hello from the train station", { modelId: "bulbul:v3", codec: "mp3" });
const mp3 = Buffer.from([0xff, 0xfb, 0x94, 0x64, 0, 0, 4, 8]);

describe("Bulbul REST and HTTP streaming", () => {
  it("decodes the JSON audio and sends the exact model and speaker", async () => {
    const audio = await synthesizeRest(req, {
      apiKey: key,
      fetchFn: async (url, init) => {
        expect(String(url)).toBe("https://api.sarvam.ai/text-to-speech");
        expect(new Headers(init?.headers).get("api-subscription-key")).toBe(key);
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "bulbul:v3",
          speaker: "shubh",
        });
        return Response.json({ audios: [mp3.toString("base64")] });
      },
    });
    expect(audio).toEqual(mp3);
  });
  it.each([[], ["!malformed!"], [""], ["YWJj", "YWJj"]])(
    "rejects malformed audio array %#",
    async (...audios) => {
      await expect(
        synthesizeRest(req, { apiKey: key, fetchFn: async () => Response.json({ audios }) }),
      ).rejects.toThrow();
    },
  );
  it("reads raw bytes in order with backpressure and cancels the response", async () => {
    let cancelled = false;
    const raw = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(mp3);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await streamHttp(req, {
      apiKey: key,
      fetchFn: async (url) => {
        expect(String(url)).toBe("https://api.sarvam.ai/text-to-speech/stream");
        return new Response(raw, { headers: { "content-type": "audio/mpeg" } });
      },
    });
    const reader = response.audioStream.getReader();
    expect((await reader.read()).value).toEqual(mp3);
    await response.release();
    expect(cancelled).toBe(true);
  });
  it("treats a JSON success body on the binary endpoint as an error", async () => {
    await expect(
      streamHttp(req, {
        apiKey: key,
        fetchFn: async () => Response.json({ error: "sensitive prompt" }),
      }),
    ).rejects.toThrow(/audio/i);
  });
});

it("retries one explicit rate rejection and preserves the selected account", async () => {
  let attempts = 0;
  const bytes = await synthesizeRest(req, {
    apiKey: key,
    fetchFn: async (_, init) => {
      expect(new Headers(init?.headers).get("api-subscription-key")).toBe(key);
      attempts++;
      return attempts === 1
        ? Response.json(
            { error: { code: "rate_limit_error" } },
            { status: 429, headers: { "retry-after": "0" } },
          )
        : Response.json({ audios: [mp3.toString("base64")] });
    },
  });
  expect(bytes).toEqual(mp3);
  expect(attempts).toBe(2);
});
