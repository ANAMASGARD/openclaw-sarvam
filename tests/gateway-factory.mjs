import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readFactoryCatalog, runtimeModels, supportsResponses, FACTORY_URL } from "../dist/factory/catalog.js";
import { freePort, isolatedHost, jsonOutput, safeMessage } from "./host.mjs";

const apiKey = process.env.SARVAM_API_KEY;
const phase = process.env.SARVAM_GATEWAY_PHASE || "all";
assert.ok(["all", "chat", "responses", "services"].includes(phase), "Choose all, chat, responses or services for SARVAM_GATEWAY_PHASE.");
if (!apiKey || process.env.SARVAM_LIVE_TEST !== "1") throw new Error("Set SARVAM_LIVE_TEST=1 and SARVAM_API_KEY for the live Gateway test.");
const catalog = await readFactoryCatalog({ apiKey });
const allowed = new Set((process.env.SARVAM_FACTORY_MODELS ?? "").split(",").filter(Boolean));
const rows = catalog.filter(row => row.available && row.type === "chat" && (!allowed.size || allowed.has(row.id)));
for (const id of allowed) assert.ok(rows.some(row => row.id === id), "Select an entitled chat model: " + id);
assert.ok(rows.length > 0 && rows.length <= 20, "Select between one and twenty available chat models for this run.");
const summary = [];
const host = await isolatedHost({ live: true, archive: process.env.SARVAM_TEST_ARCHIVE });
const port = await freePort();
const agents = new Map(rows.map((row, i) => [row.id, "factory-" + i]));
async function record(operation, model, run) {
  try {
    const evidence = await run();
    summary.push({ operation, model, ...(typeof evidence === "string" ? { status: "PASS", evidence } : evidence) });
  } catch (error) {
    summary.push({ operation, model, status: "FAIL", evidence: safeMessage(error.message, [apiKey]) });
    process.exitCode = 1;
  }
  console.log(JSON.stringify(summary.at(-1)));
  if (process.env.SARVAM_GATEWAY_REPORT) {
    await writeFile(process.env.SARVAM_GATEWAY_REPORT, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  }
}
async function receipts(file) {
  try { return (await readFile(join(host.dir, file), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function turn(model, protocol = "openai-completions") {
  const nonce = "amber-" + randomBytes(5).toString("hex");
  await writeFile(join(host.dir, "test-color.txt"), nonce, { mode: 0o600 });
  const prior = (await receipts("model-events.jsonl")).length;
  const id = randomUUID();
  const sessionKey = "agent:" + agents.get(model) + ":sarvam-verification-" + id;
  const result = await host.rpc(port, "agent", {
    agentId: agents.get(model), sessionKey,
    message: "Call sarvam_test_lookup once to look up today's test color. Reply with the exact color, including its full suffix.",
    timeout: 90, deliver: false, idempotencyKey: id,
  }, 105_000, true);
  const answer = result.result?.payloads?.map(part => part.text).join(" ") ?? "";
  const meta = result.result?.meta?.agentMeta;
  const observed = (await receipts("model-events.jsonl")).slice(prior);
  if (!answer.includes(nonce)) throw new Error("Gateway answer omitted the tool result. " +
    JSON.stringify({ status: result.status, summary: result.summary, answer: answer.slice(0, 250), provider: meta?.provider, model: meta?.model, observed }));
  assert.ok((await receipts("lookups.jsonl")).some(item => item.color === nonce), "Missing fixture invocation receipt.");
  assert.equal(meta?.provider, "sarvam", "Gateway did not report the expected provider.");
  assert.equal(meta?.model, model, "Gateway did not report the requested model.");
  assert.ok(observed.some(item => item.provider === "sarvam" && item.model === model), "Missing requested model execution event.");
  const history = await host.rpc(port, "chat.history", { sessionKey, agentId: agents.get(model) });
  const assistant = history.messages?.filter(message => message.role === "assistant") ?? [];
  if (!assistant.some(message => message.api === protocol && message.model === model && message.provider === "sarvam")) {
    throw new Error("Gateway transcript omitted the expected model protocol. " + JSON.stringify({
      protocol, model, historyFields: Object.keys(history), recorded: assistant.map(m => ({api:m.api, provider:m.provider, model:m.model, fields:Object.keys(m)})),
    }));
  }
  return "Gateway executed sarvam_test_lookup, replayed its private value, and the assistant transcript recorded " + protocol + " for the requested model.";
}
async function decision() {
  const result = await host.rpc(port, "tools.invoke", { name: "decision_evaluate", agentId: "main", args: {
    contractVersion: 2, state: { type: "text", text: "The parcel was delivered to the customer." },
    questions: { delivered: { type: "boolean", instructions: "Has the customer received the parcel?" } },
  } });
  if (!result.ok) throw new Error("Gateway could not invoke decision_evaluate. " + JSON.stringify(result.error));
  const evaluation = result.output?.details ?? JSON.parse(result.output?.content?.[0]?.text ?? "null");
  if (evaluation?.status !== "ok") throw new Error("Decision unavailable. " + JSON.stringify(evaluation));
  const p = evaluation.result?.answers?.delivered?.probabilityTrue;
  assert.ok(typeof p === "number" && p > 0.5 && p <= 1, "Wrong classification. " + JSON.stringify(evaluation));
  assert.equal(evaluation.provenance?.providerId, "sarvam");
  assert.equal(evaluation.result?.model, "sarvam-prism");
  return "Gateway decision_evaluate recorded Sarvam Prism provenance and delivery probability " + p + ".";
}
async function discover() {
  const reply = jsonOutput(await host.cmd(["models", "list", "--all", "--provider", "sarvam", "--refresh", "--json"]));
  const expected = catalog.filter(row => row.type === "chat" && row.available).map(row => "sarvam/" + row.id).sort();
  const actual = reply.models.filter(row => row.available).map(row => row.key).sort();
  assert.deepEqual(actual, expected, "Refreshed OpenClaw runnable catalog differs from account entitlements.");
  return "OpenClaw refreshed and exposed exactly " + actual.length + " entitled chat models.";
}
async function embedding() {
  const row = catalog.find(item => item.id === "embeddinggemma-2");
  try {
    const reply = jsonOutput(await host.cmd(["infer", "embedding", "create", "--agent", "main", "--provider", "sarvam",
      "--model", "sarvam/embeddinggemma-2", "--text", "Mango orchard verification document.", "--json"]));
    assert.equal(reply.provider, "sarvam");
    assert.equal(reply.model, "embeddinggemma-2");
    assert.equal(reply.outputs?.[0]?.embedding?.length, 768);
    assert.ok(reply.outputs[0].embedding.every(Number.isFinite));
    return "Native embedding inference returned 768 finite values.";
  } catch (error) {
    if (!row?.available && /Sarvam HTTP 400 \(provisioning_required\)/.test(error.message)) {
      return { status: "BLOCKED", evidence: "The native adapter authenticated and Sarvam returned HTTP 400 requiring organisation provisioning." };
    }
    throw error;
  }
}

try {
  const cfg = await host.read();
  cfg.plugins.allow = [...new Set([...(cfg.plugins.allow ?? []), "sarvam", "sarvam-e2e-probe"])];
  cfg.plugins.load = { ...cfg.plugins.load, paths: [...(cfg.plugins.load?.paths ?? []), resolve("tests/fixtures/probe")] };
  cfg.plugins.entries = { ...cfg.plugins.entries, "sarvam-e2e-probe": { enabled: true, hooks: { allowConversationAccess: true } },
    sarvam: { enabled: true, config: { stt: false, tts: false, tokenFactory: true } } };
  cfg.agents.defaults.model = { primary: "sarvam/" + rows[0].id, fallbacks: [] };
  cfg.agents.ownership = "explicit";
  cfg.agents.defaults.systemAgent = { agentId: "main" };
  cfg.agents.entries = { ...cfg.agents.entries, main: { ...cfg.agents.entries?.main },
    ...Object.fromEntries(rows.map(row => [agents.get(row.id), { model: { primary: "sarvam/" + row.id, fallbacks: [] } }])) };
  cfg.agents.defaults.decisionModel = "sarvam/sarvam-prism";
  cfg.tools = { allow: ["sarvam_test_lookup", "decision_evaluate"] };
  if (phase === "all" || phase === "chat") {
    await host.write(cfg);
    await host.start(port);
    for (const row of rows) await record("Gateway chat tool loop", row.id, () => turn(row.id));
    if (catalog.some(row => row.id === "sarvam-prism" && row.available)) await record("Gateway decision_evaluate", "sarvam-prism", decision);
    await host.stop();
  }
  const responseRows = rows.filter(row => supportsResponses(row.id));
  if (responseRows.length && (phase === "all" || phase === "responses")) {
    cfg.models = { mode: "merge", providers: { sarvam: { baseUrl: FACTORY_URL, api: "openai-responses",
      models: runtimeModels(responseRows).map(model => ({ ...model, api: "openai-responses" })) } } };
    await host.write(cfg);
    await host.start(port);
    for (const row of responseRows) await record("Gateway stateless Responses tool loop", row.id, () => turn(row.id, "openai-responses"));
  }
  if (phase === "all" || phase === "services") {
    await host.stop();
    cfg.agents.entries = { main: { memory: { search: { provider: "sarvam", model: "embeddinggemma-2", fallback: "none" } } } };
    await host.write(cfg);
    await record("OpenClaw CLI catalog", "sarvam", discover);
    await record("OpenClaw embedding using environment", "embeddinggemma-2", embedding);
    await host.storeSarvamKey();
    await record("OpenClaw embedding using saved profile", "embeddinggemma-2", embedding);
  }
} finally {
  await host.close();
}
