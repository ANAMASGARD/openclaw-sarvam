import { describe, expect, it, vi } from "vitest";
import { evaluateDecision } from "../src/factory/decisions.js";

const batch = { state: { type: "text", text: "The current status is delivered." }, questions: {
  shipped: { type: "boolean", instructions: "Has this item shipped?" },
} } as const;
const params = { apiKey: "placeholder", model: "sarvam-prism", isAdmissible: () => true,
  deadlineMonotonicMs: performance.now() + 40000, signal: new AbortController().signal };
describe("Sarvam decision evaluation", () => {
  it("preserves the native probability with the selected model and successful usage", async () => {
    const result = await evaluateDecision(batch, params, async (url, init) => {
      expect(String(url)).toBe("https://api.sarvam.ai/v2/systemone");
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "sarvam-prism", questions: { shipped: { type: "noul" } } });
      return Response.json({ model: "sarvam-prism", answers: { shipped: { type: "noul", noul: 0.931 } },
        usage: { input_tokens: 24, output_tokens: 0 } });
    });
    expect(result).toMatchObject({ status: "ok", result: { answers: { shipped: { probabilityTrue: 0.931 } }, usage: { inputTokens: 24 } } });
  });
  it("keeps retired requests and image evidence on text-only models off the wire", async () => {
    const transport = vi.fn();
    await expect(evaluateDecision(batch, { ...params, isAdmissible: () => false }, transport)).resolves.toMatchObject({ status: "unavailable" });
    const image = { ...batch, state: { type: "image" as const, dataUri: "data:image/png;base64,YQ==" } };
    await expect(evaluateDecision(image, params, transport)).resolves.toMatchObject({ status: "unavailable", reason: "unsupported-input" });
    expect(transport).not.toHaveBeenCalled();
  });
});

it("distinguishes an unprovisioned decision model from invalid evidence", async () => {
  await expect(evaluateDecision(batch, { ...params, model: "clef" }, async () => Response.json({
    error: { message: "Please enable Provisioned Throughput for this model.", type: "invalid_request_error" },
  }, {status: 400}))).resolves.toEqual({ status: "unavailable", reason: "authentication" });
  await expect(evaluateDecision(batch, params, async () => Response.json({
    model: "wrong-model", answers: { shipped: {type:"noul", noul:0.9} },
  }))).resolves.toEqual({ status: "unavailable", reason: "invalid-response" });
});

it("sends only inline images to the native Clef images field", async () => {
  const dataUri = "data:image/jpeg;base64,/9j/AA==";
  const result = await evaluateDecision({ ...batch, state: { type:"image", dataUri, text:"The parcel." } },
    { ...params, model:"clef" }, async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({model:"clef",state:"The parcel.",images:[dataUri]});
      return Response.json({model:"clef",answers:{shipped:{type:"noul",noul:0.9}},usage:{input_tokens:12,output_tokens:0}});
    });
  expect(result).toMatchObject({status:"ok"});
});

it("propagates caller cancellation and a retired grant without sending evidence", async () => {
  const fetchFn = vi.fn();
  const controller = new AbortController();
  controller.abort(new Error("Cancelled by the host"));
  await expect(evaluateDecision(batch, {...params, signal:controller.signal}, fetchFn)).rejects.toThrow("Cancelled by the host");
  await expect(evaluateDecision(batch, {...params, isAdmissible() {throw new Error("Host grant retired");}}, fetchFn)).rejects.toThrow("Host grant retired");
  expect(fetchFn).not.toHaveBeenCalled();
});
