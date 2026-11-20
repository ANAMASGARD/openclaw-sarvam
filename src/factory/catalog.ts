import type { OpenClawConfig, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { object, readJson, request, string, type JsonObject, type Transport } from "../http.js";

export const FACTORY_URL = "https://api.sarvam.ai/v2";
export const DEFAULT_CHAT = "glm5.3-flash";

type ProviderConfig = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string];
type Model = ProviderConfig["models"][number];
type CatalogContext = Parameters<NonNullable<ProviderPlugin["catalog"]>["run"]>[0];

export type SarvamModel = {
  id: string;
  name: string;
  type: "chat" | "decision" | "embedding";
  access: string;
  available: boolean;
  contextLength: number;
  maxTokens: number;
  image: boolean;
  tools: boolean;
  reasoning: boolean;
};

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseRow(raw: JsonObject): SarvamModel | undefined {
  const type = raw.type;
  if (type !== "chat" && type !== "decision" && type !== "embedding") return;
  const id = string(raw.id);
  if (!id || id.length > 192 || /[\s\x00-\x1f\x7f]/.test(id)) throw new Error("Invalid Sarvam catalog model ID.");
  const access = string(raw.access) ?? "unknown";
  const available = raw.whitelisted === true || (raw.whitelisted === undefined && access === "standard");
  const contextLength = positiveInteger(raw.context_length, 8192);
  const defaults = typeof raw.default_parameters === "object" && raw.default_parameters !== null
    ? object(raw.default_parameters, "Sarvam model defaults") : {};
  return {
    id, name: string(raw.display_name) ?? id, type, access, available, contextLength,
    maxTokens: Math.min(contextLength, positiveInteger(defaults.max_tokens, 2048)),
    image: raw.supports_image_input === true, tools: raw.supports_tools === true,
    reasoning: Boolean(raw.reasoning),
  };
}

/** A fresh read belongs exclusively to the supplied account. No process-wide credential cache. */
export async function readFactoryCatalog(transport: Transport): Promise<SarvamModel[]> {
  const lease = await request("/v2/models", { method: "GET" }, transport, 1);
  try {
    const body = await readJson(lease.response, 1024 * 1024);
    if (!Array.isArray(body.data) || body.data.length > 2048) throw new Error("Invalid Sarvam model catalog.");
    const seen = new Set<string>();
    const rows: SarvamModel[] = [];
    for (const value of body.data) {
      const row = parseRow(object(value, "Sarvam catalog row"));
      if (!row) continue;
      if (seen.has(row.id)) throw new Error("Duplicate ID in Sarvam model catalog.");
      rows.push(row);
      seen.add(row.id);
    }
    return rows;
  } finally {
    await lease.release();
  }
}

export function runtimeModels(rows: readonly SarvamModel[]) {
  return rows.filter(row => row.type === "chat" && row.available).map(row => ({
    id: row.id, name: row.name, api: "openai-completions",
    input: row.image ? ["text", "image"] : ["text"],
    reasoning: row.reasoning, contextWindow: row.contextLength, maxTokens: row.maxTokens,
    // Catalog responses contain no USD prices. OpenClaw requires numeric cost fields.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsTools: row.tools, supportsStore: false, supportsDeveloperRole: false,
      supportsLongCacheRetention: false, supportsPromptCacheKey: false, supportsStrictMode: false,
      maxTokensField: "max_tokens", supportsReasoningEffort: false, supportsUsageInStreaming: true,
    },
  } satisfies Model));
}

export async function discoverForHost(ctx: CatalogContext): Promise<SarvamModel[]> {
  const auth = ctx.resolveProviderApiKey("sarvam");
  if (auth.mode && auth.mode !== "api_key") return [];
  // The catalog may supply an env marker as apiKey and the request-ready value separately.
  const apiKey = auth.discoveryApiKey || (auth.apiKey === "SARVAM_API_KEY" ? ctx.env.SARVAM_API_KEY : auth.apiKey);
  if (!apiKey) return [];
  return readFactoryCatalog({ apiKey, signal: ctx.signal, timeoutMs: 12_000, guard: fetchWithSsrFGuard });
}

// The discovery endpoint does not advertise protocol-specific support. Sarvam documents these
// routes explicitly on its Responses API page; Chat Completions continues discovering all IDs.
const RESPONSES_IDS = new Set([
  "sarvam-105b", "glm5.3", "glm5.3-flash", "gemma4", "deepseekv4.1-flash-1017",
  "deepseekv4.1-flash-1017-interactive", "deepseekv4-pro", "kimi-k3.1-pro", "qwen38-27b",
]);
export function supportsResponses(id: string): boolean {
  return RESPONSES_IDS.has(id);
}
