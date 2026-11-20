import { describe, expect, it } from "vitest";
import { readFactoryCatalog, runtimeModels, supportsResponses } from "../src/factory/catalog.js";

const basic = { type: "chat", id: "brand-new-model", display_name: "New", context_length: 32000,
  access: "standard", whitelisted: true, supports_tools: true, supports_image_input: false,
  default_parameters: { max_tokens: 1700 } };

describe("Token Factory account catalog", () => {
  it("keeps restricted and non-chat models outside the runnable chat catalog", async () => {
    const data = [basic, { ...basic, id: "enterprise", access: "provisioned", whitelisted: false },
      { ...basic, id: "embed", type: "embedding" }, { ...basic, id: "judge", type: "decision" }];
    const rows = await readFactoryCatalog({ apiKey: "test", fetchFn: async (url, init) => {
      expect(String(url)).toBe("https://api.sarvam.ai/v2/models");
      expect(new Headers(init?.headers).get("api-subscription-key")).toBe("test");
      return Response.json({ data });
    }});
    const models = runtimeModels(rows).filter(model => model.inference?.chat !== false);
    expect(models.map(model => model.id)).toEqual(["brand-new-model"]);
    expect(rows.find(row => row.id === "enterprise")?.available).toBe(false);
    expect(models[0]).toMatchObject({ contextWindow: 32000, maxTokens: 1700,
      compat: { supportsTools: true, maxTokensField: "max_tokens", supportsStore: false } });
    expect(supportsResponses("sarvam-105b-conversations")).toBe(false);
    expect(supportsResponses("glm5.3-flash")).toBe(true);
  });
  it("rejects malformed catalog responses without inventing fallback models", async () => {
    await expect(readFactoryCatalog({ apiKey: "test", fetchFn: async () => Response.json({ data: {} }) })).rejects.toThrow(/catalog/i);
  });
});

it("resolves fresh entitlements for each credential and rejects duplicate model IDs", async () => {
  const fetchFn: typeof fetch = async (_url, init) => Response.json({ data: [
    { ...basic, id:"leased", access:"provisioned", whitelisted: new Headers(init?.headers).get("api-subscription-key") === "first-account" },
  ] });
  expect(runtimeModels(await readFactoryCatalog({apiKey:"first-account", fetchFn})).map(row => row.id)).toEqual(["leased"]);
  expect(runtimeModels(await readFactoryCatalog({apiKey:"other-account", fetchFn}))).toEqual([]);
  await expect(readFactoryCatalog({apiKey:"fixture",fetchFn:async () => Response.json({data:[basic,basic]})})).rejects.toThrow(/duplicate/i);
});
