import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execute, freePort, isolatedHost, jsonOutput } from "./host.mjs";
import { telegramFixture } from "./telegram-fixture.mjs";

if (process.env.SARVAM_LIVE_TEST!=="1" || !process.env.SARVAM_API_KEY) throw Error("Set SARVAM_LIVE_TEST=1 and SARVAM_API_KEY to run live Gateway tests.");
const host=await isolatedHost({live:true,archive:process.env.SARVAM_TEST_ARCHIVE});
const fixture=await telegramFixture();
const results=[];
try {
  if (process.env.SARVAM_TEST_STORED_PROFILE === "1") await host.storeSarvamKey();
  const installed=await host.read();
  const source=join(host.dir,"request.wav"), note=join(host.dir,"input.ogg");
  await execute("espeak-ng",["-v","en-us","-s","141","-w",source,
    "This is the mango orchard. Please use the test lookup tool to find the current test color. Tell me the color in one short sentence."]);
  await execute("ffmpeg",["-v","error","-i",source,"-ac","1","-ar","48000","-c:a","libopus",note]);
  const input=await readFile(note);
  let update=Math.floor(Date.now()/1000);
  for(const stt of ["saaras:v3","saaras:v4"]) for(const tts of ["bulbul:v3","bulbul:v4-flash"]) {
    const pair=stt+"/"+tts;
    if(process.env.SARVAM_TEST_PAIR && process.env.SARVAM_TEST_PAIR!==pair) continue;
    const color=["purple","yellow","silver","orange"][randomInt(4)];
    await writeFile(join(host.dir,"test-color.txt"),color,{mode:0o600});
    for(const f of ["lookups.jsonl","model-events.jsonl"]) await rm(join(host.dir,f),{force:true});
    const port=await freePort();
    const cfg={...installed,
      gateway:{mode:"local",bind:"loopback",port,auth:{mode:"token"}},
      plugins:{...installed.plugins,allow:["sarvam","telegram","sarvam-e2e-probe"],load:{paths:[resolve("tests/fixtures/probe")]},
        entries:{...installed.plugins?.entries,sarvam:{enabled:true},telegram:{enabled:true},"sarvam-e2e-probe":{enabled:true,hooks:{allowConversationAccess:true}}}},
      agents:{defaults:{...installed.agents?.defaults,workspace:join(host.dir,"workspace"),skipBootstrap:true,
        model:{primary:"sarvam/glm5.3-flash",fallbacks:[]}}},
      tools:{allow:["sarvam_test_lookup"],media:{audio:{enabled:true,language:"en-IN",timeoutSeconds:120},
        models:[{provider:"sarvam",model:stt,capabilities:["audio"]}]}},
      tts:{auto:"inbound",provider:"sarvam",providers:{sarvam:{modelId:tts,language:"en-IN",
        speaker:tts==="bulbul:v3"?"shubh":"shubh_enhi_ads"}}},
      channels:{telegram:fixture.settings}};
    try {
      await host.write(cfg); fixture.begin(input,++update);
      await host.cmd(["config","validate","--json"]);
      await host.start(port);
      if(host.logs().includes("channel autostart suppressed")) await host.rpc(port,"channels.start",{channel:"telegram"});
      const reply=await fixture.receive();
      const ttsStatus=await host.rpc(port,"tts.status");
      assert.equal(ttsStatus.provider,"sarvam");
      assert.deepEqual(ttsStatus.fallbackProviders,[],"Only Sarvam may satisfy this acceptance test");
      const calls=(await readFile(join(host.dir,"lookups.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
      assert.ok(calls.some(row=>row.color===color),"Agent did not execute the lookup");
      const events=(await readFile(join(host.dir,"model-events.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
      assert.ok(events.some(e=>e.heardOrchard && e.provider==="sarvam" && e.model==="glm5.3-flash"),"Transcript did not reach the chosen Sarvam model");
      const output=join(host.dir,"received-"+update+".ogg");await writeFile(output,reply);
      const {stdout}=await execute("ffprobe",["-v","error","-show_entries","stream=codec_name,channels,sample_rate:format=duration","-of","json",output]);
      const meta=JSON.parse(stdout);
      assert.equal(meta.streams[0].codec_name,"opus");assert.equal(meta.streams[0].sample_rate,"48000");assert.equal(meta.streams[0].channels,1);assert.ok(Number(meta.format.duration)>0.25);
      const content=jsonOutput(await host.cmd(["infer","audio","transcribe","--file",output,"--model","sarvam/saaras:v4","--language","en-IN","--json"]));
      assert.match(JSON.stringify(content),new RegExp(color,"i"),"The received audio must speak the tool result");
      results.push({stt,tts,status:"PASS",channel:"local Telegram Bot API",model:"glm5.3-flash",toolCalls:calls.length,
        spokenColor:color,codec:"opus",rate:48000,seconds:Number(meta.format.duration)});
    } catch (err) {
      results.push({stt,tts,status:"FAIL",error:err.message.slice(0,900)});
      if(process.env.SARVAM_TEST_LOG_DIR) await writeFile(join(process.env.SARVAM_TEST_LOG_DIR,"gateway-"+stt.at(-1)+"-"+tts.replaceAll(":","-")+".log"),host.logs(),{mode:0o600});
    } finally {
      console.log(JSON.stringify(results.at(-1))); await host.stop();
    }
  }
} finally { await host.close(); await fixture.close(); }
if(!results.length || results.some(r=>r.status!=="PASS")) process.exitCode=1;
