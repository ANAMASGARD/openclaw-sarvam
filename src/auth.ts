import type { PluginCapabilityCatalogHostContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentDir, tryResolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";

type Host = PluginCapabilityCatalogHostContext;
type AuthRequest = Parameters<Host["resolveApiKeyForProvider"]>[0];
type Config = AuthRequest["cfg"];

function readinessParams(cfg: Config) {
  const agent = cfg && tryResolveDefaultAgentId(cfg);
  return {
    provider: "sarvam", cfg, profileTypes: ["api_key" as const],
    ...(agent && cfg ? { agentDir: resolveAgentDir(cfg, agent) } : {}),
  };
}

/** Standalone clients can use an explicit credential or the operator's environment. */
export function requireKey(value?: unknown): string {
  const key = value === undefined ? process.env.SARVAM_API_KEY : value;
  if (typeof key !== "string" || !key.trim() || /[\r\n]/.test(key)) {
    throw new Error("Configure a Sarvam API-key profile or set SARVAM_API_KEY.");
  }
  return key.trim();
}

/** Cold CLI processes can miss third-party env metadata before provider discovery completes. */
export function unboundEnvironmentKey(cfg?: Config): string | undefined {
  const hasProfile = Object.values(cfg?.auth?.profiles ?? {}).some(profile => profile.provider === "sarvam");
  if (hasProfile || cfg?.auth?.order?.sarvam?.length || cfg?.models?.providers?.sarvam?.apiKey) return;
  const key = process.env.SARVAM_API_KEY;
  return key?.trim() ? requireKey(key) : undefined;
}

/** Use host-selected credentials first. Only a missing, unbound account can use the shell key. */
export async function resolveCapabilityKey(
  host: Pick<Host, "resolveApiKeyForProvider">,
  cfg: Config,
  scope: Pick<AuthRequest, "agentDir" | "workspaceDir" | "profileId" | "signal"> = {},
): Promise<string> {
  const result = await host.resolveApiKeyForProvider({
    provider: "sarvam", cfg, credentialPrecedence: "profile-first", ...scope,
    ...(scope.profileId ? { lockedProfile: true } : {}),
  }).catch((error: unknown) => {
    if (!scope.profileId && error instanceof Error && "code" in error && error.code === "missing-provider-auth" &&
      "provider" in error && error.provider === "sarvam") {
      const key = unboundEnvironmentKey(cfg);
      if (key) return { mode: "api-key", apiKey: key };
    }
    throw error;
  });
  if (result.mode !== "api-key" || !result.apiKey) throw new Error("An active Sarvam API-key profile is required.");
  return requireKey(result.apiKey);
}

export function hasCapabilityKey(host: Pick<Host, "isProviderApiKeyConfigured">, cfg: Config): boolean {
  return host.isProviderApiKeyConfigured(readinessParams(cfg)) || Boolean(unboundEnvironmentKey(cfg));
}

export async function hasCapabilityKeyAsync(host: Pick<Host, "isProviderApiKeyConfiguredAsync">, cfg: Config): Promise<boolean> {
  return await host.isProviderApiKeyConfiguredAsync(readinessParams(cfg)) || Boolean(unboundEnvironmentKey(cfg));
}
