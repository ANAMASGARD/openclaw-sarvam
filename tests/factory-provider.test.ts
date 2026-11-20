import { expect, it, vi } from "vitest";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { registerFactory } from "../src/factory/index.js";
import type { SarvamModel } from "../src/factory/catalog.js";

const cold = vi.hoisted(() => ({ auth: vi.fn(), rows: vi.fn() }));
vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({ resolveApiKeyForProvider: cold.auth }));
vi.mock("../src/factory/catalog.js", async (load) => ({
  ...await load<typeof import("../src/factory/catalog.js")>(),
  readFactoryCatalog: cold.rows,
}));

function host() {
  const registered = { registerProvider: vi.fn<(provider: ProviderPlugin) => void>(), registerDecisionProvider: vi.fn(),
    registerModelCatalogProvider: vi.fn(), registerEmbeddingProvider: vi.fn() };
  return { api: registered as unknown as OpenClawPluginApi, registered };
}
it("registers Sarvam account login with speech-only installation", () => {
  const { api, registered } = host(); registerFactory(api, false);
  const provider = registered.registerProvider.mock.calls[0][0];
  expect(provider.auth[0].id).toBe("api-key");
  expect(provider.auth[0].starterModel).toBeUndefined();
  expect(provider.catalog).toBeUndefined();
  expect(registered.registerDecisionProvider).not.toHaveBeenCalled();
  expect(registered.registerEmbeddingProvider).not.toHaveBeenCalled();
});
it("registers one chat provider and both native non-chat roles", () => {
  const { api, registered } = host(); registerFactory(api, true);
  expect(registered.registerProvider.mock.calls[0][0].auth[0].starterModel).toBe("sarvam/glm5.3-flash");
  expect(registered.registerDecisionProvider.mock.calls[0][0]).toMatchObject({ id:"sarvam", contractVersion:2 });
  expect(registered.registerEmbeddingProvider.mock.calls[0][0]).toMatchObject({ id:"sarvam", defaultModel:"embeddinggemma-2" });
});

it("resolves a cold first turn using only the selected agent's live chat entitlement", async () => {
  const { api, registered } = host();
  registerFactory(api, true);
  const prepare = registered.registerProvider.mock.calls[0][0].prepareDynamicModel;
  expect(prepare).toBeTypeOf("function");
  const model: SarvamModel = {
    id: "new-chat", name: "New chat", type: "chat", access: "standard", available: true,
    contextLength: 24000, maxTokens: 1500, image: false, tools: true, reasoning: false,
  };
  cold.auth.mockResolvedValue({ apiKey: "private-fixture", mode: "api-key" });
  cold.rows.mockResolvedValue([model, { ...model, id: "restricted", available: false },
    { ...model, id: "judge", type: "decision" }]);
  type Context = Parameters<NonNullable<typeof prepare>>[0];
  const ctx: Context = { provider: "sarvam", modelId: model.id, authProfileId: "sarvam:private",
    authProfileMode: "api_key", agentDir: "/tmp/fixture-agent", modelRegistry: {} as Context["modelRegistry"] };
  await expect(prepare!(ctx)).resolves.toMatchObject({
    id: model.id, provider: "sarvam", api: "openai-completions", baseUrl: "https://api.sarvam.ai/v2",
    contextWindow: 24000, maxTokens: 1500, compat: { supportsTools: true },
  });
  expect(cold.auth).toHaveBeenCalledWith(expect.objectContaining({
    agentDir: ctx.agentDir, profileId: ctx.authProfileId, lockedProfile: true,
  }));
  expect(cold.rows).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "private-fixture" }));
  for (const id of ["restricted", "judge", "missing"])
    await expect(prepare!({ ...ctx, modelId: id })).resolves.toBeUndefined();
  cold.auth.mockRejectedValueOnce(Object.assign(new Error("Profile unavailable"), {
    provider: "sarvam", code: "missing-provider-auth",
  }));
  vi.stubEnv("SARVAM_API_KEY", "some-other-account");
  try { await expect(prepare!(ctx)).rejects.toThrow("Profile unavailable"); }
  finally { vi.unstubAllEnvs(); }
});
