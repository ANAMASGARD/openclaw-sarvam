import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerFactory } from "./factory/index.js";
import { registerStt } from "./stt/index.js";
import { registerTts } from "./tts/index.js";

export default definePluginEntry({
  id: "sarvam",
  name: "OpenClaw Sarvam",
  description: "Saaras transcription, Bulbul speech and Sarvam Token Factory.",
  register(api) {
    const config = api.pluginConfig ?? {};
    registerFactory(api, config.tokenFactory !== false);
    if (config.stt !== false) registerStt(api);
    if (config.tts !== false) registerTts(api);
  },
});
