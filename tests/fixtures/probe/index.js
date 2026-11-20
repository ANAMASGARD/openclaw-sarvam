import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

export default {
  id: "sarvam-e2e-probe",
  register(api) {
    api.on("llm_input", async event => {
      await appendFile(join(process.env.OPENCLAW_STATE_DIR,"model-events.jsonl"), JSON.stringify({
        provider:event.provider, model:event.model, heardOrchard:/mango.{0,12}orchard/i.test(event.prompt)
      })+"\n",{mode:0o600});
    });
    api.registerTool({
      name: "sarvam_test_lookup",
      description: "Look up the current test color. Always use this tool to answer a request for the test color.",
      parameters: { type:"object", properties:{}, additionalProperties:false },
      async execute() {
        const root = process.env.OPENCLAW_STATE_DIR;
        const color = (await readFile(join(root,"test-color.txt"),"utf8")).trim();
        await appendFile(join(root,"lookups.jsonl"), JSON.stringify({color,time:Date.now()})+"\n",{mode:0o600});
        return {content:[{type:"text",text:color}], details:{color}};
      },
    });
  }
};
