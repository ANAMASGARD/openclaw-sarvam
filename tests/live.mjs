// Each opt-in suite executes serially and caps input duration, cases or API calls.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { join } from "node:path";

if (process.env.SARVAM_LIVE_TEST !== "1") throw new Error("Billed tests require SARVAM_LIVE_TEST=1.");
if (!process.env.SARVAM_API_KEY && !process.env.SARVAM_TEST_KEY_FILE) throw new Error("Supply a Sarvam test credential.");
const dir = process.env.SARVAM_STT_FIXTURES;
if (!dir) throw new Error("Prepare SARVAM_STT_FIXTURES using tests/fixtures/saaras-audio.py.");
for (const file of ["references.json","en_us.wav","hi_in.wav"]) await access(join(dir,file));
const failed = [];
async function run(name, args, extra = {}) {
  const job = spawn(process.execPath, args, {stdio:"inherit",env:{...process.env,...extra}});
  const [code] = await once(job,"exit");
  if (code !== 0) failed.push(name);
}
for (const suite of ["live-stt","live-tts","live-factory","gateway-tts","gateway-factory","gateway-voice"]) {
  await run(suite, ["tests/local-key.mjs",suite]);
}
await run("Saaras Gateway", ["node_modules/vitest/vitest.mjs","run","tests/stt-gateway.test.ts"], {SARVAM_STT_GATEWAY_TEST:"1"});
if (failed.length) {
  console.error("Failed suites: " + failed.join(", "));
  process.exitCode = 1;
}
