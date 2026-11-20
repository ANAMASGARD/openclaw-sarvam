import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveCapabilityKey } from "../auth.js";
import { jsonBody, object, readJson, request, type Transport } from "../http.js";
import { FACTORY_URL } from "./catalog.js";

type Adapter = Parameters<OpenClawPluginApi["registerEmbeddingProvider"]>[0];
type Provider = NonNullable<Awaited<ReturnType<Adapter["create"]>>["provider"]>;
type CallOptions = NonNullable<Parameters<Provider["embed"]>[1]>;
const MODEL = "embeddinggemma-2";
const DIMENSIONS = 768;
const MAX_INPUTS = 64;

export async function embedTexts(input: string[], transport: Transport) {
  if (!input.length || input.length > MAX_INPUTS || input.some(v => !v.trim() || Buffer.byteLength(v) > 128 * 1024)) {
    throw new Error("Sarvam embedding requests require 1–64 nonempty text inputs within the input limit.");
  }
  const lease = await request("/v2/embeddings", jsonBody({ model: MODEL, input, encoding_format: "float" }), transport);
  try {
    const body = await readJson(lease.response, 3 * 1024 * 1024);
    if (body.model !== MODEL || !Array.isArray(body.data) || body.data.length !== input.length) throw new Error("Invalid Sarvam vector response.");
    const vectors: number[][] = [];
    for (const value of body.data) {
      const item = object(value, "Sarvam embedding vector");
      const index = item.index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= input.length || vectors[index] ||
        !Array.isArray(item.embedding) || item.embedding.length !== DIMENSIONS ||
        !item.embedding.every(v => typeof v === "number" && Number.isFinite(v))) {
        throw new Error("Invalid Sarvam embedding vector or index.");
      }
      vectors[index] = item.embedding;
    }
    const stats = body.usage && typeof body.usage === "object" ? object(body.usage, "Sarvam usage") : {};
    const usage = typeof stats.prompt_tokens === "number" && Number.isSafeInteger(stats.prompt_tokens) && stats.prompt_tokens >= 0 &&
      typeof stats.total_tokens === "number" && Number.isSafeInteger(stats.total_tokens) && stats.total_tokens >= stats.prompt_tokens
      ? { promptTokens: stats.prompt_tokens, totalTokens: stats.total_tokens } : undefined;
    return { vectors, usage };
  } finally { await lease.release(); }
}

function textInput(input: Parameters<Provider["embed"]>[0], opts: CallOptions = {}) {
  if (typeof input !== "string" && input.parts?.some(part => part.type !== "text")) throw new Error("EmbeddingGemma accepts text only.");
  const text = typeof input === "string" ? input : input.text;
  if (!text.trim()) throw new Error("EmbeddingGemma requires nonempty text.");
  if (opts.inputType === "query" && !opts.queryInstructionApplied) return "task: search result | query: " + text;
  if (opts.inputType === "document" && !opts.documentFormatApplied) return "title: none | text: " + text;
  if (opts.inputType === "classification") return "task: classification | query: " + text;
  if (opts.inputType === "clustering") return "task: clustering | query: " + text;
  if (opts.inputType === "semantic") return "task: sentence similarity | query: " + text;
  return text;
}

export const embeddings: Adapter = {
  id: "sarvam", authProviderId: "sarvam", defaultModel: MODEL, transport: "remote",
  async create(options) {
    if (options.model && options.model !== MODEL) throw new Error("Sarvam embedding model must be embeddinggemma-2.");
    if (options.dimensions && options.dimensions !== DIMENSIONS) throw new Error("EmbeddingGemma returns 768 dimensions.");
    if (options.remote?.baseUrl && options.remote.baseUrl.replace(/\/+$/, "") !== FACTORY_URL) throw new Error("Use the Sarvam Token Factory base URL.");
    if (options.remote?.apiKey || Object.keys(options.remote?.headers ?? {}).length) {
      throw new Error("Set the credential on the Sarvam provider account to use it for embeddings.");
    }
    const embedBatch: Provider["embedBatch"] = async (items, opts) => {
      if (!items.length) return [];
      opts?.signal?.throwIfAborted();
      // Resolve at each physical operation so changed credentials and per-agent profiles take effect.
      const { resolveApiKeyForProvider } = await import("openclaw/plugin-sdk/agent-runtime");
      const apiKey = await resolveCapabilityKey({
        resolveApiKeyForProvider: args => resolveApiKeyForProvider({ ...args, agentDir: options.agentDir, signal: opts?.signal }),
      }, options.config);
      const result = await embedTexts(items.map(i => textInput(i, opts)), { apiKey, signal: opts?.signal, guard: fetchWithSsrFGuard });
      opts?.onUsage?.(result.usage);
      return result.vectors;
    };
    return {
      provider: { id: "sarvam", model: MODEL, dimensions: DIMENSIONS, maxInputTokens: 8192,
        maxInputsPerRequest: MAX_INPUTS, embed: async (input, opts) => (await embedBatch([input], opts))[0], embedBatch },
      runtime: { id: "sarvam", cacheKeyData: { provider: "sarvam", model: MODEL, dimensions: DIMENSIONS, format: "gemma-task-prefix-v1" } },
    };
  },
};
