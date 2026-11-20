import {
  decodeSystemOneResponse, encodeSystemOneQuestions, validateDecisionBatchV2, validateDecisionResultV2,
  type DecisionBatchV2, type DecisionProviderV2, type ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { jsonBody, readJson, request, SarvamHttpError } from "../http.js";
import { FACTORY_URL } from "./catalog.js";

type Evaluation = {
  apiKey?: string;
  model: string;
  deadlineMonotonicMs: number;
  signal: AbortSignal;
  isAdmissible: () => boolean;
  reasoning?: "auto" | "off" | "on";
};

function wireInput(batch: DecisionBatchV2, model: string) {
  if (model !== "sarvam-prism" && model !== "clef") return;
  if (!validateDecisionBatchV2(batch)) return;
  // OpenClaw decision contract v2 requires at least two alternatives for either model.
  const min = 2;
  for (const question of Object.values(batch.questions)) {
    if (question.type === "boolean") {
      if (!question.instructions && !question.criteria) return;
    } else if (question.type === "choice") {
      const length = Object.keys(question.criteria).length;
      if (length < min || length > 255) return;
    } else if (question.type === "score") {
      if (question.criteria.length < min || question.criteria.length > 10) return;
    } else return;
  }
  const questions = encodeSystemOneQuestions(batch);
  const state = batch.state;
  if (state.type === "text") return { model, state: state.text, questions };
  if (state.type === "json" && state.value !== null && (typeof state.value === "object" || typeof state.value === "string")) {
    return { model, state: state.value, questions };
  }
  if (model === "clef" && state.type === "image" && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(state.dataUri)) {
    return { model, state: state.text ?? "", images: [state.dataUri], questions };
  }
}

export async function evaluateDecision(
  batch: DecisionBatchV2, ctx: Evaluation, fetchFn?: typeof fetch,
): Promise<ProviderDecisionOutcomeV2> {
  ctx.signal.throwIfAborted();
  const body = wireInput(batch, ctx.model);
  if (!body || (ctx.reasoning && ctx.reasoning !== "auto")) return { status: "unavailable", reason: "unsupported-input" };
  if (!ctx.apiKey) return { status: "unavailable", reason: "credentials-unavailable" };
  let admissionError: { cause: unknown } | undefined;
  const beforeRequest = () => {
    ctx.signal.throwIfAborted();
    let admitted: boolean;
    try { admitted = ctx.isAdmissible(); }
    catch (cause) { admissionError = { cause }; throw cause; }
    if (!admitted || performance.now() >= ctx.deadlineMonotonicMs) throw new Error("Decision expired.");
  };
  try {
    const lease = await request("/v2/systemone", jsonBody(body), {
      apiKey: ctx.apiKey, signal: ctx.signal, beforeRequest, timeoutMs: Math.max(1, Math.ceil(ctx.deadlineMonotonicMs - performance.now())),
      guard: fetchFn ? undefined : fetchWithSsrFGuard, fetchFn,
    });
    try {
      const reply = await readJson(lease.response);
      beforeRequest();
      const result = decodeSystemOneResponse(batch, reply);
      if (reply.model !== ctx.model || !validateDecisionResultV2(batch, result)) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      return { status: "ok", result };
    } finally { await lease.release(); }
  } catch (error) {
    if (admissionError) throw admissionError.cause;
    ctx.signal.throwIfAborted();
    if (error instanceof SarvamHttpError) {
      if (error.code === "provisioning_required" || [401, 402, 403].includes(error.status)) return { status: "unavailable", reason: "authentication" };
      if (error.status === 429) return { status: "unavailable", reason: "rate-limited" };
      if ([400, 404, 413, 422].includes(error.status)) return { status: "unavailable", reason: "unsupported-input" };
    }
    return { status: "unavailable", reason: "transport" };
  }
}

export const decisions: DecisionProviderV2 = {
  id: "sarvam", contractVersion: 2,
  async evaluate(batch, ctx) {
    if (ctx.model.baseUrl && ctx.model.baseUrl.replace(/\/+$/, "") !== FACTORY_URL) {
      return { status: "unavailable", reason: "unsupported-input" };
    }
    return evaluateDecision(batch, { model: ctx.model.id, apiKey: ctx.auth.apiKey, signal: ctx.signal,
      deadlineMonotonicMs: ctx.deadlineMonotonicMs, isAdmissible: ctx.isAdmissible, reasoning: ctx.reasoning });
  },
};
