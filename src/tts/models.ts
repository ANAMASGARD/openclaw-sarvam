import type { JsonObject } from "../http.js";
import { DEFAULT_MODEL, MODELS, voicesFor, type BulbulModel } from "./voices.js";

export { voicesFor };
export type Delivery = "rest" | "http" | "websocket";
export type Codec = keyof typeof FORMATS;
export const FORMATS = {
  wav: { outputFormat: "wav", fileExtension: ".wav", voiceCompatible: false },
  mp3: { outputFormat: "mp3", fileExtension: ".mp3", voiceCompatible: false },
  opus: { outputFormat: "opus", fileExtension: ".ogg", voiceCompatible: true },
  flac: { outputFormat: "flac", fileExtension: ".flac", voiceCompatible: false },
  aac: { outputFormat: "aac", fileExtension: ".aac", voiceCompatible: false },
  linear16: { outputFormat: "pcm", fileExtension: ".pcm", voiceCompatible: false },
  alaw: { outputFormat: "alaw", fileExtension: ".alaw", voiceCompatible: false },
  mulaw: { outputFormat: "mulaw", fileExtension: ".mulaw", voiceCompatible: false },
} as const;

const LANGUAGES = new Set([
  "bn-IN",
  "en-IN",
  "gu-IN",
  "hi-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "od-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
]);
const STREAM_RATES = [8000, 16000, 22050, 24000];
const REST_RATES = [...STREAM_RATES, 32000, 44100, 48000];

export function bulbulModel(value?: unknown): BulbulModel {
  if (value === undefined) return DEFAULT_MODEL;
  if (value === MODELS[0] || value === MODELS[1]) return value;
  throw new Error("Bulbul modelId must be bulbul:v3 or bulbul:v4-flash");
}

export function bulbulRequest(text: string, config: JsonObject, delivery: Delivery = "rest") {
  const limit = delivery === "http" ? 3500 : 2500;
  if (typeof text !== "string" || !text.trim() || [...text].length > limit) {
    throw new Error(`Bulbul ${delivery} needs between 1 and ${limit} characters of text`);
  }
  const model = bulbulModel(config.modelId ?? config.model);
  const speaker =
    config.speaker ??
    config.speakerVoice ??
    config.voiceId ??
    (model === "bulbul:v3" ? "shubh" : "shubh_enhi_ads");
  if (typeof speaker !== "string" || !voicesFor(model).includes(speaker)) {
    throw new Error(`Choose a speaker from the ${model} voice catalog`);
  }
  const language = config.language ?? config.languageCode ?? config.language_code ?? "en-IN";
  if (typeof language !== "string" || !LANGUAGES.has(language))
    throw new Error("Unsupported Bulbul language code");
  const codec = config.codec ?? (delivery === "rest" ? "wav" : "mp3");
  if (typeof codec !== "string" || !Object.hasOwn(FORMATS, codec))
    throw new Error("Unsupported Bulbul codec");
  const rate = config.sampleRate ?? (codec === "opus" ? 24000 : 22050);
  const rates = delivery === "rest" ? REST_RATES : STREAM_RATES;
  if (
    typeof rate !== "number" ||
    !rates.includes(rate) ||
    (codec === "opus" && [22050, 32000, 44100].includes(rate))
  ) {
    throw new Error(`Unsupported Bulbul sampleRate for ${codec} on ${delivery}`);
  }

  const optional: Record<string, string | number | boolean> = {};
  for (const [key, min, max] of [
    ["pace", 0.5, 2],
    ["pitch", -0.5, 0.5],
    ["loudness", 0.1, 2.5],
    ["temperature", 0.01, 1],
  ] as const) {
    const value = key === "pace" ? (config.pace ?? config.speed) : config[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Bulbul ${key} must be between ${min} and ${max}`);
    }
    optional[key] = value;
  }
  for (const [setting, wire, min, max] of [
    ["minBufferSize", "min_buffer_size", 30, 200],
    ["maxChunkLength", "max_chunk_length", 50, 500],
  ] as const) {
    if (config[setting] === undefined || delivery !== "websocket") continue;
    const v = config[setting];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      throw new Error(`Bulbul ${setting} must be an integer between ${min} and ${max}`);
    }
    optional[wire] = v;
  }
  if (config.dictId !== undefined) {
    if (typeof config.dictId !== "string" || !/^p_[\da-f]{8}$/i.test(config.dictId))
      throw new Error("Invalid Bulbul dictId");
    optional.dict_id = config.dictId;
  }
  if (config.enablePreprocessing !== undefined) {
    if (typeof config.enablePreprocessing !== "boolean")
      throw new Error("Bulbul enablePreprocessing must be a boolean");
    optional.enable_preprocessing = config.enablePreprocessing;
  }
  if (config.bitrate !== undefined) {
    if (
      typeof config.bitrate !== "string" ||
      !["32k", "64k", "96k", "128k", "192k"].includes(config.bitrate)
    ) {
      throw new Error("Bulbul bitrate requires a supported streaming bitrate");
    }
    if (delivery !== "rest") optional.output_audio_bitrate = config.bitrate;
  }
  return {
    ...optional,
    text,
    model,
    speaker,
    language_code: language,
    output_audio_codec: codec as Codec,
    speech_sample_rate: rate,
  };
}

export type Synthesis = ReturnType<typeof bulbulRequest>;
