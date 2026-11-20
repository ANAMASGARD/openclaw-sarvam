export type SttSettings = Record<string, unknown>;
export type SttTransport = "rest" | "batch" | "realtime" | "legacy";
export const RECORDED_MODELS = ["saaras:v4", "saaras:v3"] as const;
export const REALTIME_MODELS = ["saaras:v4", "saaras:v3-realtime", "saaras:v3"] as const;
const languages = new Set(
  "as bn brx doi en gu hi kn kok ks mai ml mni mr ne od pa sa sat sd ta te ur"
    .split(" ")
    .map((code) => code + "-IN"),
);
const modes = new Set(["transcribe", "translate", "verbatim", "translit", "codemix"]);

export function modelSettings(raw: SttSettings, transport: SttTransport): SttSettings {
  const model = raw.model ?? "saaras:v4";
  const allowed = transport === "realtime" ? ["saaras:v4", "saaras:v3-realtime"] : RECORDED_MODELS;
  if (!allowed.some((id) => id === model))
    throw new Error("Invalid Saaras model for " + transport + ". Choose " + allowed.join(" or "));
  const mode = raw.mode ?? "transcribe";
  if (typeof mode !== "string" || !modes.has(mode)) throw new Error("Invalid Saaras transcript mode");
  const modern = transport === "realtime";
  const lang = raw.language_code ?? raw.language ?? (modern ? "auto" : "unknown");
  let language = lang;
  if (lang === "unknown" || lang === "auto") language = modern ? "auto" : "unknown";
  else if (lang === "or-IN" || lang === "od-IN") language = modern ? "or-IN" : "od-IN";
  else if (typeof lang !== "string" || !languages.has(lang))
    throw new Error("Unsupported Saaras language code");
  const result: SttSettings = { model, mode, language_code: language };
  if (raw.keyterms !== undefined) {
    const terms = raw.keyterms;
    if (
      model !== "saaras:v4" ||
      !Array.isArray(terms) ||
      terms.length > 50 ||
      !terms.every((v) => typeof v === "string" && v.trim() && [...v].length <= 64)
    ) {
      throw new Error("Saaras v4 accepts up to 50 nonempty keyterms of at most 64 characters");
    }
    result.keyterms = terms;
  }
  if (transport === "rest" || transport === "batch") {
    if (raw.with_timestamps !== undefined) {
      if (typeof raw.with_timestamps !== "boolean") throw new Error("with_timestamps must be boolean");
      result.with_timestamps = raw.with_timestamps;
    }
  }
  if (transport === "batch") {
    if (raw.with_diarization !== undefined) {
      if (typeof raw.with_diarization !== "boolean") throw new Error("with_diarization must be boolean");
      result.with_diarization = raw.with_diarization;
    }
    if (raw.num_speakers !== undefined) {
      const speakers = raw.num_speakers;
      if (
        raw.with_diarization !== true ||
        typeof speakers !== "number" ||
        !Number.isInteger(speakers) ||
        speakers < 1 ||
        speakers > 20
      ) {
        throw new Error("Enable diarization and choose 1–20 speakers");
      }
      result.num_speakers = speakers;
    }
  }
  return result;
}
