import { expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import entry from "../src/index.js";

for (const stt of [false,true]) for (const tts of [false,true]) for (const tokenFactory of [false,true]) {
  it(`registers independent services stt=${stt} tts=${tts} tokenFactory=${tokenFactory}`, () => {
    const config = { agents:{ defaults:{ model:{ primary:"other/model" } } } };
    const api = {
      config, pluginConfig:{stt,tts,tokenFactory},
      registerProvider:vi.fn(), registerDecisionProvider:vi.fn(), registerEmbeddingProvider:vi.fn(),
      registerModelCatalogProvider:vi.fn(), registerMediaUnderstandingProvider:vi.fn(),
      registerRealtimeTranscriptionProvider:vi.fn(), registerSpeechProvider:vi.fn(), registerCli:vi.fn(),
    };
    entry.register(api as unknown as OpenClawPluginApi);
    expect(api.registerProvider).toHaveBeenCalledOnce();
    expect(api.registerProvider.mock.calls[0][0].auth).toHaveLength(1);
    expect(Boolean(api.registerProvider.mock.calls[0][0].catalog)).toBe(tokenFactory);
    expect(api.registerModelCatalogProvider).toHaveBeenCalledTimes(Number(tokenFactory));
    expect(api.registerDecisionProvider).toHaveBeenCalledTimes(Number(tokenFactory));
    expect(api.registerEmbeddingProvider).toHaveBeenCalledTimes(Number(tokenFactory));
    expect(api.registerMediaUnderstandingProvider).toHaveBeenCalledTimes(Number(stt));
    expect(api.registerRealtimeTranscriptionProvider).toHaveBeenCalledTimes(Number(stt));
    expect(api.registerCli).toHaveBeenCalledTimes(Number(stt));
    expect(api.registerSpeechProvider).toHaveBeenCalledTimes(Number(tts));
    expect(config.agents.defaults.model.primary).toBe("other/model");
  });
}
