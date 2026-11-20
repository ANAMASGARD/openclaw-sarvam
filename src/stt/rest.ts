import { readJson, request, type Transport } from "../http.js";
import type { Recording } from "./audio.js";
import { modelSettings, type SttSettings } from "./settings.js";

export async function transcribeShort(file: Recording, settings: SttSettings, transport: Transport) {
  if (file.seconds > 30) throw new Error("Use Saaras Batch for recordings longer than 30 seconds");
  const options = modelSettings(settings, "rest");
  const form = new FormData();
  for (const [key, value] of Object.entries(options))
    form.set(key, typeof value === "string" ? value : JSON.stringify(value));
  if (file.extension === "pcm") form.set("input_audio_codec", "pcm_s16le");
  form.set("file", new Blob([Uint8Array.from(file.buffer)], { type: file.mime }), "voice." + file.extension);
  const { response, release } = await request("/speech-to-text", { method: "POST", body: form }, transport);
  try {
    const result = await readJson(response);
    if (typeof result.transcript !== "string" || !result.transcript.trim())
      throw new Error("Saaras returned an empty transcript");
    return { text: result.transcript.trim(), model: String(options.model) };
  } finally {
    await release();
  }
}
