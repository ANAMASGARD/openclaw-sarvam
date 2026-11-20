import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { bulbulProvider } from "./provider.js";

export function registerTts(api: OpenClawPluginApi): void {
  api.registerSpeechProvider(bulbulProvider);
}
