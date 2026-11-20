// Local runner for a private dotenv file. Pass only the Sarvam credential to the selected suite.
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
const names = new Set(["live-stt","live-tts","live-factory","gateway-factory","gateway-voice","gateway-tts","channel-live"]);
const name = process.argv[2];
if (!names.has(name)) throw new Error("Choose a supported live test suite.");
if (process.env.SARVAM_LIVE_TEST !== "1") throw new Error("Live tests require SARVAM_LIVE_TEST=1.");
if (!process.env.SARVAM_API_KEY && process.env.SARVAM_TEST_KEY_FILE) {
  process.env.SARVAM_API_KEY = parseEnv(await readFile(process.env.SARVAM_TEST_KEY_FILE,"utf8")).SARVAM_API_KEY || "";
}
if (!process.env.SARVAM_API_KEY) throw new Error("Set SARVAM_API_KEY or use SARVAM_TEST_KEY_FILE for local testing.");
await import("./"+name+".mjs");
