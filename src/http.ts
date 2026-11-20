import { setTimeout as delay } from "node:timers/promises";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { requireKey } from "./auth.js";

export const ORIGIN = "https://api.sarvam.ai";
export const WS_ORIGIN = "wss://api.sarvam.ai";
export const AUTH_HEADER = "api-subscription-key";
export type JsonObject = Record<string, unknown>;
type Guard = typeof fetchWithSsrFGuard;
export type Transport = {
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  beforeRequest?: () => void;
  fetchFn?: typeof fetch;
  guard?: Guard;
  dispatcherPolicy?: Parameters<Guard>[0]["dispatcherPolicy"];
};
export function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object.");
  return value as JsonObject;
}
export function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function readBytes(response: Response, limit: number): Promise<Buffer> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid response size limit.");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.length;
      if (total > limit) throw new Error("Sarvam response exceeded the configured byte limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function readJson(response: Response, limit = 8 * 1024 * 1024): Promise<JsonObject> {
  const bytes = await readBytes(response, limit);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Sarvam returned malformed JSON."); }
  return object(parsed, "Sarvam response");
}

const hints: Record<number, string> = {
  400: "Check the model, parameters and input format.",
  401: "Check the active API-key profile.",
  402: "Account credit is required.",
  403: "Check the credential and account permission.",
  404: "Check the endpoint, model ID and account access.",
  413: "Input exceeds the provider size limit.",
  422: "Check the request parameters.",
  429: "The service rate limit was reached.",
};
export class SarvamHttpError extends Error {
  constructor(readonly status: number, readonly code?: string, readonly retryAfterMs?: number) {
    super("Sarvam HTTP " + status + (code ? " (" + code + ")" : "") + ". " +
      (code === "provisioning_required" ? "This model requires organisation provisioning." :
       hints[status] ?? "The upstream request failed."));
    this.name = "SarvamHttpError";
  }
}
async function toHttpError(response: Response): Promise<SarvamHttpError> {
  const body = await readJson(response, 16_384).catch((): JsonObject => ({}));
  const err = body.error && typeof body.error === "object" && !Array.isArray(body.error) ? body.error as JsonObject : body;
  // An upstream message can include a transcript, prompt, credential or signed URL.
  // Only return provider codes we recognise or categories determined locally.
  const detail = string(err.message) ?? string(err.detail) ?? "";
  const allowed = ["invalid_request_error","not_found_error","invalid_api_key_error","rate_limit_error","insufficient_quota"];
  const reported = string(err.code) ?? string(err.type);
  const codecRejected = [400, 422].includes(response.status) && /opus|audio.codec/i.test(detail) && /unsupported|not supported|not available|invalid|sample.rate/i.test(detail);
  const code = /provisioned throughput|not enabled for your organi[sz]ation|not whitelisted/i.test(detail) ?
    "provisioning_required" : codecRejected ? "unsupported_audio_codec" : reported && allowed.includes(reported) ? reported : undefined;
  const after = response.headers.get("retry-after");
  const ms = after ? /^\d+(\.\d+)?$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now() : NaN;
  return new SarvamHttpError(response.status, code, Number.isFinite(ms) ? Math.max(0, ms) : undefined);
}
type Lease = { response: Response; release(): Promise<void> };
export async function request(path: string, init: RequestInit, transport: Transport, retries = 0): Promise<Lease> {
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN || url.username || url.password) throw new Error("Invalid Sarvam API origin.");
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.set(AUTH_HEADER, requireKey(transport.apiKey));
  const deadline = AbortSignal.timeout(transport.timeoutMs ?? 60_000);
  const signal = AbortSignal.any([deadline, ...[transport.signal, init.signal].filter((s): s is AbortSignal => Boolean(s))]);
  const fetchFn = transport.fetchFn ?? fetch;
  const attempts = Math.min(2, Math.max(0, Math.floor(retries)));
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const options = { ...init, headers, signal, redirect: "error" as const };
    let lease: Lease;
    const beforeRequest = () => { signal.throwIfAborted(); transport.beforeRequest?.(); };
    beforeRequest();
    try {
      lease = transport.guard ? await transport.guard({
        url: url.href, init: options, fetchImpl: fetchFn, signal, maxRedirects: 0, requireHttps: true,
        mode: transport.dispatcherPolicy?.mode === "explicit-proxy" ? "trusted_explicit_proxy" : "trusted_env_proxy",
        dispatcherPolicy: transport.dispatcherPolicy, beforeRequest,
        capture: false, auditContext: "Sarvam AI",
      }) : { response: await fetchFn(url, options), release: async () => {} };
    } catch {
      signal.throwIfAborted();
      throw new Error("Could not connect to Sarvam AI.");
    }
    if (lease.response.ok) return lease;
    let error: SarvamHttpError;
    try { error = await toHttpError(lease.response); } finally { await lease.release(); }
    if (attempt >= attempts || ![429,500,502,503,504].includes(error.status) || (error.retryAfterMs ?? 0) > 10_000) throw error;
    await delay(Math.max(error.retryAfterMs ?? 0, 400 * 2 ** attempt), undefined, { signal });
  }
}
export function jsonBody(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
