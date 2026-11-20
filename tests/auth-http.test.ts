import { afterEach, expect, it, vi } from "vitest";
import { requireKey, resolveCapabilityKey } from "../src/auth.js";
import { request, readJson } from "../src/http.js";

afterEach(() => vi.unstubAllEnvs());
it("uses each host-selected profile on every operation, including rotation", async () => {
  vi.stubEnv("SARVAM_API_KEY", "other-account");
  const resolveApiKeyForProvider = vi.fn().mockResolvedValueOnce({ apiKey: "first", mode: "api-key" })
    .mockResolvedValueOnce({ apiKey: "rotated", mode: "api-key" });
  const context = { resolveApiKeyForProvider };
  expect(await resolveCapabilityKey(context, {})).toBe("first");
  expect(await resolveCapabilityKey(context, {})).toBe("rotated");
  resolveApiKeyForProvider.mockRejectedValueOnce(new Error("locked account unavailable"));
  await expect(resolveCapabilityKey(context, {})).rejects.toThrow();
});
it("reports missing credentials before dispatch and refuses foreign origins", async () => {
  vi.stubEnv("SARVAM_API_KEY", "");
  expect(() => requireKey()).toThrow(/SARVAM_API_KEY/);
  const fetchFn = vi.fn();
  await expect(request("https://invalid.example/test", {}, { apiKey: "secret", fetchFn })).rejects.toThrow(/origin/i);
  expect(fetchFn).not.toHaveBeenCalled();
});
it.each([400,401,402,403,404,429,500,503])("keeps HTTP %i but omits reflected keys and user text",async status => {
  const fetchFn = vi.fn(async () => Response.json({error:{message:"sample-secret customer transcript"}}, {status}));
  const error = await request("/v2/models", {}, {apiKey:"sample-secret", fetchFn}).catch(e=>e);
  expect(error.status).toBe(status);
  expect(error.message).not.toMatch(/sample-secret|customer transcript/);
});
it("authenticates the fixed origin and enforces the response size limit", async () => {
  const fetchFn: typeof fetch = async (url, init) => {
    expect(String(url)).toBe("https://api.sarvam.ai/v2/models");
    expect(new Headers(init?.headers).get("api-subscription-key")).toBe("example");
    return Response.json({data: "oversized"});
  };
  const lease = await request("/v2/models", {}, {apiKey:"example", fetchFn});
  try { await expect(readJson(lease.response, 3)).rejects.toThrow(/exceed/i); }
  finally { await lease.release(); }
});

it("offers the environment key only for a missing, unbound Sarvam account in a cold CLI", async () => {
  vi.stubEnv("SARVAM_API_KEY", "env-account");
  const error = Object.assign(new Error("No credential found"), {provider:"sarvam",code:"missing-provider-auth"});
  const host = {resolveApiKeyForProvider: vi.fn().mockRejectedValue(error)};
  expect(await resolveCapabilityKey(host, {})).toBe("env-account");
  await expect(resolveCapabilityKey(host, {auth:{profiles:{"sarvam:owner":{provider:"sarvam",mode:"api_key"}}}})).rejects.toBe(error);
  await expect(resolveCapabilityKey(host, {auth:{order:{sarvam:["sarvam:missing"]}}})).rejects.toBe(error);
  await expect(resolveCapabilityKey(host, {models:{providers:{sarvam:{baseUrl:"https://api.sarvam.ai/v2",models:[],apiKey:"profile"}}}})).rejects.toBe(error);
  host.resolveApiKeyForProvider.mockRejectedValue(Object.assign(new Error("disallowed"),{provider:"sarvam",code:"access-denied"}));
  await expect(resolveCapabilityKey(host, {})).rejects.toThrow("disallowed");
});

it("retries transient reads within the limit and respects long Retry-After", async () => {
  const fetchFn=vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({},{status:429,headers:{"retry-after":"0"}}))
    .mockResolvedValueOnce(Response.json({ok:true}));
  const lease=await request("/v2/models",{}, {apiKey:"temporary",fetchFn},1);
  try {expect(await readJson(lease.response)).toEqual({ok:true});}
  finally {await lease.release();}
  fetchFn.mockClear().mockResolvedValue(Response.json({},{status:503,headers:{"retry-after":"120"}}));
  await expect(request("/v2/models",{}, {apiKey:"temporary",fetchFn},2)).rejects.toMatchObject({status:503});
  expect(fetchFn).toHaveBeenCalledOnce();
});
