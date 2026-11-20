import { setTimeout as delay } from "node:timers/promises";
import { jsonBody, readJson, request, SarvamHttpError, type Transport } from "../http.js";
import { AUDIO_LIMIT, decodeAudio, ownedStream, type AudioSource } from "./audio.js";
import type { Synthesis } from "./models.js";

/** A rate-limit rejection can be retried before audio begins. Other POST outcomes may have incurred a charge. */
async function requestAudio(path: string, body: Synthesis, options: Transport) {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const send = () => request(path, jsonBody(body), { ...options, signal });
  try {
    return await send();
  } catch (error) {
    if (
      !(error instanceof SarvamHttpError) ||
      error.status !== 429 ||
      (error.retryAfterMs ?? 0) > 2000
    )
      throw error;
    await delay(Math.max(100, error.retryAfterMs ?? 400), undefined, { signal });
    return send();
  }
}

export async function synthesizeRest(body: Synthesis, options: Transport): Promise<Buffer> {
  const { response, release } = await requestAudio("/text-to-speech", body, options);
  try {
    const result = await readJson(response, Math.ceil((AUDIO_LIMIT * 4) / 3) + 4096);
    if (!Array.isArray(result.audios) || result.audios.length !== 1) {
      throw new Error("Bulbul must return one audio recording for this utterance");
    }
    return decodeAudio(result.audios[0]);
  } finally {
    await release();
  }
}

export async function streamHttp(body: Synthesis, options: Transport): Promise<AudioSource> {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const { response, release } = await requestAudio("/text-to-speech/stream", body, {
    ...options,
    signal,
  });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!response.body || (!type.startsWith("audio/") && type !== "application/octet-stream")) {
    await response.body?.cancel().catch(() => {});
    await release();
    throw new Error("Bulbul HTTP stream returned a non-audio response");
  }
  return ownedStream(response.body, release, signal);
}
