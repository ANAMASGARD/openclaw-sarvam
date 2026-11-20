import { expect, it, vi } from "vitest";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { registerFactory } from "../src/factory/index.js";

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
