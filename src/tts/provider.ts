import type {
  PluginCapabilityCatalogHostContext,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { hasCapabilityKey, hasCapabilityKeyAsync, resolveCapabilityKey } from "../auth.js";
import { object, readBytes, SarvamHttpError, type JsonObject, type Transport } from "../http.js";
import {
  AUDIO_LIMIT,
  bufferSource,
  checkPrefix,
  encodeVoiceNote,
  isOpus,
  isVoiceNote,
  isWave,
  peek,
} from "./audio.js";
import { streamHttp, synthesizeRest } from "./http.js";
import { bulbulModel, bulbulRequest, FORMATS, type Delivery } from "./models.js";
import { DEFAULT_MODEL, MODELS, voicesFor } from "./voices.js";
import { streamWebSocket, type SocketOptions } from "./websocket.js";

type SpeechRequest = Parameters<SpeechProviderPlugin["synthesize"]>[0];
type Target = SpeechRequest["target"];

function withDeadline<T extends Transport>(options: T) {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  return {
    ...options,
    signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline,
  };
}
function targetSettings(config: JsonObject, target: Target, delivery: Delivery): JsonObject {
  if (target === "voice-note")
    return { ...config, codec: "opus", sampleRate: delivery === "rest" ? 48000 : 24000 };
  if (target === "telephony") return { ...config, codec: "linear16", sampleRate: 8000 };
  return config;
}
function unsupportedCodec(error: unknown) {
  return error instanceof SarvamHttpError && error.code === "unsupported_audio_codec";
}

export async function bufferedBulbul(
  text: string,
  config: JsonObject,
  target: Target,
  options: Transport,
) {
  const transport = withDeadline(options);
  const body = bulbulRequest(text, targetSettings(config, target, "rest"));
  let audioBuffer: Buffer;
  try {
    audioBuffer = await synthesizeRest(body, transport);
  } catch (error) {
    if (target !== "voice-note" || !unsupportedCodec(error)) throw error;
    audioBuffer = await synthesizeRest(
      { ...body, output_audio_codec: "wav", speech_sample_rate: 24000 },
      transport,
    );
  }
  if (target === "voice-note" && !isVoiceNote(audioBuffer.subarray(0, 96))) {
    const format = isWave(audioBuffer)
      ? "wav"
      : isOpus(audioBuffer.subarray(0, 96))
        ? "ogg"
        : undefined;
    if (!format) throw new Error("Bulbul returned an incompatible voice-note format");
    const encoded = encodeVoiceNote(bufferSource(audioBuffer), transport.signal, format);
    try {
      audioBuffer = await readBytes(new Response(encoded.audioStream), AUDIO_LIMIT);
    } finally {
      await encoded.release();
    }
  }
  checkPrefix(audioBuffer, body.output_audio_codec);
  return { ...FORMATS[body.output_audio_codec], audioBuffer };
}

export async function streamedBulbul(
  text: string,
  config: JsonObject,
  target: Target,
  options: SocketOptions,
) {
  const transport = withDeadline(options);
  const delivery = config.streamTransport ?? "http";
  if (delivery !== "http" && delivery !== "websocket")
    throw new Error("Bulbul streamTransport must be http or websocket");
  const body = bulbulRequest(text, targetSettings(config, target, delivery), delivery);
  const start = delivery === "websocket" ? streamWebSocket : streamHttp;
  let checked;
  try {
    checked = await peek(await start(body, transport));
  } catch (error) {
    if (target !== "voice-note" || !unsupportedCodec(error)) throw error;
    checked = await peek(
      await start({ ...body, output_audio_codec: "wav", speech_sample_rate: 24000 }, transport),
    );
  }
  try {
    let { head, source } = checked;
    if (target === "voice-note" && !isVoiceNote(head)) {
      const format = isWave(head) ? "wav" : isOpus(head) ? "ogg" : undefined;
      if (!format) throw new Error("Bulbul returned an incompatible voice-note stream");
      source = encodeVoiceNote(source, transport.signal, format);
    } else checkPrefix(head, body.output_audio_codec);
    return { ...FORMATS[body.output_audio_codec], ...source };
  } catch (error) {
    await checked.source.release();
    throw error;
  }
}

export function bulbulProvider(context: PluginCapabilityCatalogHostContext): SpeechProviderPlugin {
  function settings({
    providerConfig,
    providerOverrides = {},
  }: Pick<SpeechRequest, "providerConfig" | "providerOverrides">) {
    const combined = { ...providerConfig, ...providerOverrides };
    const model = bulbulModel(combined.modelId ?? combined.model);
    const selected =
      providerOverrides.speaker ?? providerOverrides.speakerVoice ?? providerOverrides.voiceId;
    if (selected !== undefined) combined.speaker = selected;
    else if (model !== bulbulModel(providerConfig.modelId ?? providerConfig.model)) {
      // A model-only Gateway override should select that model's own default speaker.
      delete combined.speaker;
      delete combined.speakerVoice;
      delete combined.voiceId;
    }
    return combined;
  }
  async function transport(req: Pick<SpeechRequest, "cfg" | "timeoutMs">): Promise<SocketOptions> {
    return {
      apiKey: await resolveCapabilityKey(context, req.cfg),
      timeoutMs: req.timeoutMs,
      guard: context.fetchWithSsrFGuard,
    };
  }
  return {
    id: "sarvam",
    label: "Sarvam Bulbul",
    defaultModel: DEFAULT_MODEL,
    defaultTimeoutMs: 60_000,
    models: MODELS,
    isConfigured: ({ cfg }) => hasCapabilityKey(context, cfg),
    isConfiguredAsync: ({ cfg }) => hasCapabilityKeyAsync(context, cfg),
    resolveConfig({ rawConfig }) {
      const providers = rawConfig.providers;
      const nested =
        providers && typeof providers === "object" && !Array.isArray(providers)
          ? (providers as JsonObject).sarvam
          : undefined;
      return nested === undefined ? {} : object(nested, "tts.providers.sarvam");
    },
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => ({
      ...baseTtsConfig,
      ...talkProviderConfig,
    }),
    resolveTalkOverrides({ params }) {
      const result: JsonObject = {};
      if (params.modelId !== undefined) result.modelId = bulbulModel(params.modelId);
      if (params.voiceId !== undefined) result.speaker = params.voiceId;
      if (params.language !== undefined) result.language = params.language;
      if (params.speed !== undefined) result.pace = params.speed;
      return result;
    },
    parseDirectiveToken({ key, value, policy }) {
      if (["model", "modelid", "model_id"].includes(key) && policy.allowModelId) {
        if (!MODELS.some((id) => id === value))
          return { handled: true, warnings: ["Unknown Bulbul model"] };
        return { handled: true, overrides: { modelId: value } };
      }
      if (["voice", "speaker", "voiceid", "voice_id"].includes(key) && policy.allowVoice) {
        if (!MODELS.some((model) => voicesFor(model).includes(value)))
          return { handled: true, warnings: ["Unknown Bulbul speaker"] };
        return { handled: true, overrides: { speaker: value } };
      }
      return { handled: false };
    },
    async listVoices({ providerConfig }) {
      return voicesFor(bulbulModel(providerConfig?.modelId ?? providerConfig?.model)).map((id) => ({
        id,
        name: id,
      }));
    },
    async synthesize(req) {
      return bufferedBulbul(req.text, settings(req), req.target, await transport(req));
    },
    async streamSynthesize(req) {
      const config = settings(req);
      const opts = await transport(req);
      if (config.streamTransport === "websocket")
        opts.agent = context.createDebugProxyWebSocketAgent(context.resolveDebugProxySettings());
      return streamedBulbul(req.text, config, req.target, opts);
    },
    async synthesizeTelephony(req) {
      const { audioBuffer } = await bufferedBulbul(
        req.text,
        settings(req),
        "telephony",
        await transport(req),
      );
      return { audioBuffer, sampleRate: 8000, outputFormat: "pcm" };
    },
  };
}
