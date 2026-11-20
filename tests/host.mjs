import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

export const execute = promisify(execFile);
export const binary = process.env.OPENCLAW_BIN || resolve("node_modules/.bin/openclaw");
export function jsonOutput(output) {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "").trim();
  try { return JSON.parse(clean); } catch {
    for (const pos of clean.matchAll(/^(?:\{|\[)/gm)) {
      try { return JSON.parse(clean.slice(pos.index)); } catch { /* CLI log prefix */ }
    }
    throw new Error("OpenClaw CLI did not return JSON.");
  }
}
export function safeMessage(value, secrets = [], limit = 2600) {
  let message = String(value);
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, "[redacted]");
  return message.replace(/https?:\/\/[^\s"']+\?[^\s"']+/g, "[signed URL]")
    .replace(/[A-Za-z0-9+/=]{100,}/g, "[encoded payload]").slice(-limit);
}
export async function freePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  return port;
}
export async function isolatedHost({ live = false, archive } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sarvam-host-"));
  const configPath = join(dir,"openclaw.json");
  const token = randomBytes(32).toString("hex");
  const env = { ...process.env, OPENCLAW_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_AGENT_DIR: join(dir,"agents/main/agent"), OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_NO_RESPAWN: "1" };
  if (!live) delete env.SARVAM_API_KEY;
  const privateValues = [token, env.SARVAM_API_KEY];
  const safe = value => safeMessage(value, privateValues);
  // OpenClaw accepts non-interactive key input on stdin and writes its native agent store.
  async function storeSarvamKey(key = env.SARVAM_API_KEY) {
    if (!key) throw new Error("Expected a Sarvam test key.");
    privateValues.push(key);
    const child = spawn(binary, ["models", "auth", "paste-api-key", "--agent", "main", "--provider", "sarvam", "--profile-id", "sarvam:test"],
      {env, timeout:60_000, stdio:["pipe","ignore","ignore"]});
    const finished = once(child,"exit");
    child.stdin.on("error", () => {});
    child.stdin.end(key + "\n");
    const [status] = await finished;
    if (status !== 0) throw new Error("OpenClaw could not save the test API-key profile.");
    delete env.SARVAM_API_KEY;
  }
  const cmd = async(args, timeout = 120000) => {
    try { return (await execute(binary, args, { env, timeout, maxBuffer: 16 * 1024 * 1024 })).stdout; }
    catch (err) {
      const output = [err.stderr, err.stdout].filter(Boolean).join("\n").trim();
      throw new Error(safe(output || `OpenClaw ${args[0]} failed (${err.code ?? "unknown"}).`));
    }
  };
  const read = async () => JSON.parse(await readFile(configPath,"utf8"));
  const write = async (cfg) => writeFile(configPath, JSON.stringify(cfg,null,2), {mode:0o600});
  let gateway;
  let log = "";
  const stop = async () => {
    if (!gateway || gateway.exitCode !== null || gateway.signalCode) return;
    const done = once(gateway,"exit");
    gateway.kill("SIGTERM");
    await Promise.race([done, sleep(6000,undefined,{ref:false})]);
    if (gateway.exitCode === null && !gateway.signalCode) { gateway.kill("SIGKILL"); await done; }
  };
  const close = async () => { await stop(); await rm(dir, {recursive:true,force:true}); };
  const start = async port => {
    log = "";
    gateway = spawn(binary, ["gateway","--port",String(port),"--bind","loopback"],{env,stdio:["ignore","pipe","pipe"]});
    for (const stream of [gateway.stdout,gateway.stderr]) stream.on("data", b=>{log=(log+b.toString()).slice(-80000);});
    const deadline = Date.now()+90000;
    while (!/\[gateway\] ready/i.test(log)) {
      if (gateway.exitCode !== null || gateway.signalCode || Date.now()>deadline) throw new Error("Gateway startup failed. "+safe(log));
      await sleep(200);
    }
    await cmd(["gateway","health","--port",String(port),"--json"]);
  };
  const rpc = async (port, method, params={}, timeout=60000, final=false) => jsonOutput(await cmd(
    ["gateway","call",method,"--port",String(port),"--params",JSON.stringify(params),"--timeout",String(timeout),
      ...(final?["--expect-final"]:[]),"--json"],timeout+20000));
  try {
    await mkdir(join(dir,"workspace"));
    await write({gateway:{mode:"local"},agents:{defaults:{workspace:join(dir,"workspace"),skipBootstrap:true}}});
    if (!archive) {
      const {stdout}=await execute("npm",["pack","--json","--pack-destination",dir],{maxBuffer:8*1024*1024});
      const packed = jsonOutput(stdout);
      archive=join(dir,(Array.isArray(packed) ? packed[0] : packed["openclaw-plugin-sarvam"]).filename);
    }
    const args = [resolve("tests/confirm-local-install.py"), binary, "plugins", "install", "npm-pack:"+resolve(archive), "--accept-capabilities"];
    try { await execute("python3", args, {env,timeout:180000,maxBuffer:4*1024*1024}); }
    catch (err) { throw new Error(safe([err.stdout,err.stderr,err.message].filter(Boolean).join("\n"))); }
    await cmd(["plugins","enable","sarvam"]);
    return {dir,env,cmd,read,write,close,start,stop,rpc,storeSarvamKey,logs:()=>safeMessage(log, privateValues, 50000),archive};
  } catch (err) { await close(); throw err; }
}
export async function smoke() {
  const host = await isolatedHost({archive:process.env.SARVAM_TEST_ARCHIVE});
  try {
    const report=jsonOutput(await host.cmd(["plugins","inspect","sarvam","--runtime","--json"]));
    assert.equal(report.plugin.id,"sarvam"); assert.equal(report.plugin.status,"loaded");
    for (const field of ["providerIds","mediaUnderstandingProviderIds","realtimeTranscriptionProviderIds","speechProviderIds","embeddingProviderIds"]) {
      assert.ok(report.plugin[field]?.includes("sarvam"),"Missing registered "+field);
    }
    assert.ok(report.plugin.contracts.decisionProviders.includes("sarvam"));
    assert.equal(report.plugin.realtimeVoiceProviderIds.length,0);
    const cfg=await host.read();
    for (const file of ["speech-only","models-only","voice-agent"]) {
      const example=JSON.parse(await readFile("examples/"+file+".json","utf8"));
      await host.write({...cfg,...example,plugins:{...cfg.plugins,...example.plugins}});
      await host.cmd(["config","validate","--json"]);
    }
    console.log(JSON.stringify({version:(await host.cmd(["--version"])).trim(),plugin:report.plugin.status,examples:3}));
  } finally {await host.close();}
}
