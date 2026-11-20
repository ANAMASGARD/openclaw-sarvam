import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { DEFAULT_CHAT, discoverForHost, FACTORY_URL, runtimeModels, supportsResponses } from "./catalog.js";
import { decisions } from "./decisions.js";
import { embeddings } from "./embeddings.js";

/** Auth belongs to the account even when the operator enables speech alone. */
export function registerFactory(api: OpenClawPluginApi, enabled: boolean): void {
  const provider: ProviderPlugin = {
    id: "sarvam", label: "Sarvam AI", envVars: ["SARVAM_API_KEY"],
    auth: [createProviderApiKeyAuthMethod({
      providerId: "sarvam", methodId: "api-key", label: "Sarvam API key",
      optionKey: "sarvamApiKey", flagName: "--sarvam-api-key", envVar: "SARVAM_API_KEY",
      promptMessage: "Enter your Sarvam API key", preserveExistingPrimary: true,
      ...(enabled ? { defaultModel: "sarvam/" + DEFAULT_CHAT } : {}),
    })],
  };
  if (enabled) {
    provider.catalog = {
      order: "profile",
      async run(ctx) {
        const models = runtimeModels(await discoverForHost(ctx));
        return models.length ? { provider: { baseUrl: FACTORY_URL, api: "openai-completions", auth: "api-key", models } } : null;
      },
    };
    provider.normalizeResolvedModel = ({ model }) => {
      if (model.baseUrl.replace(/\/+$/, "") !== FACTORY_URL) throw new Error("Sarvam models use https://api.sarvam.ai/v2.");
      if (model.api !== "openai-completions" && model.api !== "openai-responses") throw new Error("Unsupported Sarvam inference protocol.");
      if (model.api === "openai-responses" && !supportsResponses(model.id)) {
        throw new Error("This Sarvam model uses Chat Completions. Set api to openai-completions.");
      }
      return { ...model, compat: { ...model.compat, maxTokensField: "max_tokens",
        supportsStore: false, supportsResponsesContinuation: false, supportsPromptCacheKey: false, supportsDeveloperRole: false,
        supportsStrictMode: false, supportsReasoningEffort: false, supportsLongCacheRetention: false } };
    };
  }
  api.registerProvider(provider);
  if (!enabled) return;
  api.registerModelCatalogProvider({
    provider: "sarvam", kinds: ["text"],
    async liveCatalog(ctx) {
      return (await discoverForHost(ctx)).filter(row => row.type === "chat").map(row => ({
        provider: "sarvam", model: row.id, kind: "text", source: "live", authEnvVars: ["SARVAM_API_KEY"],
        label: row.available ? row.name : row.name + " (requires provisioning)",
        default: row.available && row.id === DEFAULT_CHAT,
        ...(row.available ? {} : { warnings: ["This account does not have access."] }),
      }));
    },
  });
  api.registerDecisionProvider(decisions);
  api.registerEmbeddingProvider(embeddings);
}
