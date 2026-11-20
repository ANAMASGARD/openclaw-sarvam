import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { readFactoryCatalog, supportsResponses } from "../dist/factory/catalog.js";
import { embedTexts } from "../dist/factory/embeddings.js";
import { jsonBody, readJson, request, SarvamHttpError } from "../dist/http.js";

if (process.env.SARVAM_LIVE_TEST !== "1" || !process.env.SARVAM_API_KEY) {
  throw new Error("Set SARVAM_LIVE_TEST=1 and SARVAM_API_KEY to run the opt-in Token Factory tests.");
}
const limit = Number(process.env.SARVAM_FACTORY_CALL_LIMIT ?? 50);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 80) throw new Error("Set the request budget between 1 and 80.");
const only = new Set((process.env.SARVAM_FACTORY_MODELS ?? "").split(",").filter(Boolean));
let requests = 0;
const transport = {
  apiKey: process.env.SARVAM_API_KEY, timeoutMs: 60_000,
  beforeRequest() { if (++requests > limit) throw new Error("Token Factory request budget exhausted."); },
};
const report = { catalog: [], results: [], requests: 0 };
async function record(entry) {
  report.results.push(entry);
  report.requests = requests;
  console.log(JSON.stringify(entry));
  if (process.env.SARVAM_FACTORY_REPORT) {
    await writeFile(process.env.SARVAM_FACTORY_REPORT, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  }
}
async function post(path, body) {
  const lease = await request(path, jsonBody(body), transport);
  try { return await readJson(lease.response); } finally { await lease.release(); }
}

const tools = [{ type: "function", function: { name: "lookup_test_ticket", description: "Look up the current verification code on the given ticket.",
  parameters: { type: "object", properties: { ticket: { type: "string" } }, required: ["ticket"] } } }];
async function chat(model) {
  const messages = [{ role: "user", content: "Call lookup_test_ticket for ticket S-42 exactly once, then answer with only the code the tool returned." }];
  const body = { model, messages, tools, max_tokens: 1024 };
  const first = await post("/v2/chat/completions", body);
  assert.equal(first.model, model, "Different model answered the first call");
  const message = first.choices?.[0]?.message;
  const call = message?.tool_calls?.[0];
  assert.equal(message?.tool_calls?.length, 1, "Expected exactly one tool call");
  assert.equal(call.function?.name, "lookup_test_ticket", "Wrong tool name");
  assert.equal(JSON.parse(call.function.arguments).ticket, "S-42", "Wrong ticket");
  assert.equal(typeof call.id, "string", "Missing tool call ID");
  const code = "RUBY-" + randomBytes(3).toString("hex").toUpperCase();
  messages.push({ role: "assistant", content: message.content, tool_calls: message.tool_calls,
    ...(typeof message.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {}) },
    { role: "tool", tool_call_id: call.id, content: JSON.stringify({ code }) });
  const second = await post("/v2/chat/completions", body);
  assert.equal(second.model, model, "Different model answered the tool replay");
  assert.ok(second.choices?.[0]?.message?.content?.includes(code), "Answer omitted the secret tool result");
  return "Tool executed and final answer contained the per-run ticket code.";
}
async function decisions(model) {
  const reply = await post("/v2/systemone", { model, state: "The parcel was delivered to the customer.",
    questions: { delivered: { type: "noul", instructions: "Has the customer received the parcel?" } } });
  assert.equal(reply.model, model);
  const p = reply.answers?.delivered?.noul;
  assert.ok(typeof p === "number" && p > 0.5 && p <= 1, "Incorrect delivery classification");
  return "Delivery classification probability " + p;
}
async function embeddings() {
  const { vectors } = await embedTexts(["task: search result | query: how do I reset my password?",
    "title: none | text: reset the password in account security.", "title: none | text: A giraffe is a tall animal."], transport);
  const dot = v => vectors[0].reduce((n, val, i) => n + val * v[i], 0);
  assert.ok(dot(vectors[1]) > dot(vectors[2]), "Retrieval did not identify the password document");
  return "The 768-dimensional query ranked the relevant document first.";
}
async function responses(model) {
  const reply = await post("/v2/responses", { model, store: false, input: "Reply with exactly the word mango.", max_output_tokens: 768 });
  const answer = reply.output?.filter(i => i.type === "message").flatMap(i => i.content ?? []).map(c => c.text).join(" ");
  assert.equal(reply.model, model);
  assert.ok(answer && /mango/i.test(answer), "Missing expected Responses answer");
  return "Stateless Responses returned the requested word.";
}
const models = await readFactoryCatalog(transport);
assert.ok(models.length, "The account did not return any testable model IDs.");
for (const id of only) assert.ok(models.some(row => row.id === id), "The requested model is absent from the account catalog: " + id);
report.catalog = models.map(({ id, type, access, available }) => ({ id, type, access, available }));
for (const row of models) {
  if (only.size && !only.has(row.id)) continue;
  const operations = [[row.type, row.type === "chat" ? chat : row.type === "decision" ? decisions : embeddings]];
  if (row.type === "chat" && supportsResponses(row.id) && row.available) operations.push(["responses", responses]);
  for (const [operation, test] of operations) {
    try {
      const evidence = await test(row.id);
      await record({ model: row.id, operation, status: "PASS", evidence });
    } catch (error) {
      const http = error instanceof SarvamHttpError ? error.status : undefined;
      const restricted = !row.available && row.access === "provisioned" && (error.code === "provisioning_required" || http === 404);
      const status = restricted || [402, 429].includes(http) ? "BLOCKED" : "FAIL";
      const evidence = error instanceof SarvamHttpError ? error.message : error.code === "ERR_ASSERTION" ? error.message.split("\n")[0] : "Request or verification failed";
      await record({ model: row.id, operation, status, http, evidence });
      if (status === "FAIL" || row.available) process.exitCode = 1;
    }
  }
}
