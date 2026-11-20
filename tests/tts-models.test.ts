import { describe, expect, it } from "vitest";
import { bulbulRequest, voicesFor } from "../src/tts/models.js";

describe("Bulbul configuration on the wire", () => {
  it("always chooses a model and a speaker from its own catalog", () => {
    const current = bulbulRequest("नमस्ते", { language: "hi-IN" });
    expect(current).toMatchObject({
      model: "bulbul:v4-flash",
      speaker: "shubh_enhi_ads",
      language_code: "hi-IN",
    });
    expect(bulbulRequest("Hello", { modelId: "bulbul:v3" })).toMatchObject({
      model: "bulbul:v3",
      speaker: "shubh",
    });
    expect(voicesFor("bulbul:v3")).toContain("shubh");
    expect(voicesFor("bulbul:v4-flash")).toContain("simran_en_customer");
    expect(voicesFor("bulbul:v4-flash")).not.toContain("shubh");
  });
  it.each([
    { modelId: "bulbul:v4-flash", speaker: "shubh" },
    { modelId: "bulbul:v3", speaker: "simran_en_customer" },
    { speaker: "not_a_real_voice" },
    { pace: 2.1 },
    { language: "fr-FR" },
    { modelId: "bulbul:v4" },
    { pitch: -1 },
  ])("rejects an invalid setting before sending audio %o", (settings) => {
    expect(() => bulbulRequest("Hello", settings)).toThrow();
  });
  it("validates format limits by transport", () => {
    expect(bulbulRequest("Hello", { codec: "opus", sampleRate: 48000 })).toMatchObject({
      output_audio_codec: "opus",
      speech_sample_rate: 48000,
    });
    expect(() => bulbulRequest("Hello", { codec: "opus", sampleRate: 22050 })).toThrow();
    expect(() => bulbulRequest("Hello", { sampleRate: 48000 }, "http")).toThrow();
    expect(() => bulbulRequest("a".repeat(2501), {})).toThrow();
    expect(() => bulbulRequest("a".repeat(3500), {}, "http")).not.toThrow();
  });
});
