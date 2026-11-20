import type { PluginCapabilityCatalogHostContext } from "openclaw/plugin-sdk/plugin-entry";

type Host = PluginCapabilityCatalogHostContext;
type Config = Parameters<Host["resolveApiKeyForProvider"]>[0]["cfg"];

/** Standalone clients can use an explicit credential or the operator's environment. */
export function requireKey(value?: unknown): string {
  const key = value === undefined ? process.env.SARVAM_API_KEY : value;
  if (typeof key !== "string" || !key.trim() || /[\r\n]/.test(key)) {
    throw new Error("Configure a Sarvam API-key profile or set SARVAM_API_KEY.");
  }
  return key.trim();
}

/** The host owns profile selection. Never retry with a different account on auth failure. */
export async function resolveCapabilityKey(host: Pick<Host, "resolveApiKeyForProvider">, cfg: Config): Promise<string> {
  const result = await host.resolveApiKeyForProvider({ provider: "sarvam", cfg, credentialPrecedence: "profile-first" });
  if (result.mode !== "api-key" || !result.apiKey) throw new Error("An active Sarvam API-key profile is required.");
  return requireKey(result.apiKey);
}

export function hasCapabilityKey(host: Pick<Host, "isProviderApiKeyConfigured">, cfg: Config): boolean {
  return host.isProviderApiKeyConfigured({ provider: "sarvam", cfg, profileTypes: ["api_key"] });
}

export function hasCapabilityKeyAsync(host: Pick<Host, "isProviderApiKeyConfiguredAsync">, cfg: Config): Promise<boolean> {
  return host.isProviderApiKeyConfiguredAsync({ provider: "sarvam", cfg, profileTypes: ["api_key"] });
}
