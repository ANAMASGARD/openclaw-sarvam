import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const chat = { id: 424242, type:"private", first_name:"Test" };
const sender = { id:chat.id, is_bot:false, first_name:"Test" };
const bot = { id:737373, is_bot:true, first_name:"Test", username:"sarvam_fixture_bot", can_join_groups:true };

export async function telegramFixture() {
  let sample, downloaded = false, sent = false, update = 0, outgoing, failure;
  const textReplies = [];
  const server = createServer(async (req, res) => {
    const result = value => res.writeHead(200, {"content-type":"application/json"}).end(JSON.stringify({ok:true,result:value}));
    try {
      if (req.url.includes("/file/bot")) {
        downloaded = true;
        res.writeHead(200, {"content-type":"audio/ogg","content-length":sample.length}).end(sample);
        return;
      }
      const method = req.url.split("/").at(-1);
      const body = await new Response(req).arrayBuffer();
      if (method==="getUpdates") {
        await sleep(160);
        if (!sample || sent) { result([]); return; }
        sent=true;
        result([{update_id:update,message:{message_id:update,from:sender,chat,date:Math.floor(Date.now()/1000),
          voice:{duration:6,mime_type:"audio/ogg",file_id:"in"+update,file_unique_id:"in"+update,file_size:sample.length}}}]);
      } else if (method==="getMe") result(bot);
      else if (method==="getFile") result({file_id:"in"+update,file_unique_id:"in"+update,file_path:"voice/input.ogg",file_size:sample.length});
      else if (method==="getWebhookInfo") result({url:"",has_custom_certificate:false,pending_update_count:0});
      else if (method==="getMyCommands") result([]);
      else if (method==="sendVoice") {
        const form=await new Response(body,{headers:{"content-type":req.headers["content-type"]}}).formData();
        const pointer=form.get("voice");
        const voice=typeof pointer==="string" && pointer.startsWith("attach://") ? form.get(pointer.slice(9)) : pointer;
        assert.ok(voice instanceof Blob && voice.size>1000);
        assert.equal(outgoing,undefined,"Duplicate voice delivery");
        outgoing=Buffer.from(await voice.arrayBuffer());
        result({message_id:update+1,chat,date:Math.floor(Date.now()/1000),voice:{file_id:"out",file_unique_id:"out",duration:1}});
      } else if (method==="sendAudio" || method==="sendDocument") throw Error("Telegram produced a file attachment: "+method);
      else if (method==="sendMessage") {
        textReplies.push(Buffer.from(body).toString().slice(0,400));
        result({message_id:update+2,chat,date:Math.floor(Date.now()/1000),text:"test"});
      } else result(true);
    } catch (err) { failure=err; res.writeHead(500).end(); }
  });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  return {
    settings:{enabled:true,botToken:"737373:sarvam-fixture",apiRoot:"http://127.0.0.1:"+server.address().port,
      network:{dangerouslyAllowPrivateNetwork:true},dmPolicy:"allowlist",allowFrom:[String(chat.id)]},
    begin(bytes,id) { sample=bytes;update=id;downloaded=false;sent=false;outgoing=undefined;failure=undefined;textReplies.length=0; },
    async receive(timeout=110000) {
      const until=Date.now()+timeout;
      while(!outgoing && !failure && Date.now()<until) await sleep(200);
      if (failure) throw failure;
      assert.ok(downloaded,"OpenClaw did not download the incoming note");
      assert.ok(outgoing,"Telegram voice reply timed out: "+textReplies.join(" ").slice(0,400));
      return outgoing;
    },
    async close(){server.closeAllConnections();await new Promise(done=>server.close(done));},
  };
}
