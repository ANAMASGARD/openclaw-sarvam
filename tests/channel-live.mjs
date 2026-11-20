// Private-channel acceptance with handset or generated Gateway input.
import { createHmac, randomBytes, randomInt } from "node:crypto";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { execute, freePort, isolatedHost, jsonOutput } from "./host.mjs";
import { deliverGatewayReply, submitAudio, verifySpokenLookup } from "./channel-input.mjs";
import { telegramReceipt } from "./telegram-receipt.mjs";

class Blocked extends Error {}
const channel = process.env.SARVAM_TEST_CHANNEL ?? process.argv[2];
const ingress = process.env.SARVAM_CHANNEL_INGRESS ?? "phone";
const utterance =
  "This is the mango orchard. Use the test lookup tool for the current test color. Say all three words exactly in order.";
const allPairs = ["saaras:v3", "saaras:v4"].flatMap((stt) =>
  ["bulbul:v3", "bulbul:v4-flash"].map((tts) => ({ stt, tts })),
);
const pairs = process.env.SARVAM_TEST_PAIR
  ? allPairs.filter((p) => p.stt + "/" + p.tts === process.env.SARVAM_TEST_PAIR)
  : allPairs;
if (!pairs.length) throw new Error("SARVAM_TEST_PAIR must name a Saaras/Bulbul model pair");
const phraseWords = [
  "red",
  "green",
  "yellow",
  "blue",
  "purple",
  "orange",
  "pink",
  "gold",
  "black",
  "white",
  "silver",
  "brown",
];
const json = (value) => console.log(JSON.stringify(value));
const fail = (ok, reason) => {
  if (!ok) throw new Error(reason);
};
const needs = (ok, reason) => {
  if (!ok) throw new Blocked(reason);
};
const words = (value) =>
  String(value)
    .normalize("NFKC")
    .toLowerCase()
    .match(/[a-z]+/g)
    ?.join(" ") ?? "";
const auditSalt = randomBytes(32);
const digest = (id) => createHmac("sha256", auditSalt).update(id).digest("hex").slice(0, 16);
const colorWords = (text) =>
  words(text)
    .split(" ")
    .filter((w) => phraseWords.includes(w))
    .join(" ");
const speaksColor = (text, color) => colorWords(text).includes(color);
const transcriptText = (obj) => {
  if (Array.isArray(obj)) return obj.flatMap(transcriptText).join(" ");
  if (obj && typeof obj === "object")
    return Object.entries(obj)
      .flatMap(([k, v]) =>
        typeof v === "string" && ["text", "transcript"].includes(k)
          ? [v]
          : typeof v === "object"
            ? [transcriptText(v)]
            : [],
      )
      .join(" ");
  return "";
};
async function fileStat(path) {
  try {
    return await lstat(path);
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}
async function privatePath(path, type, name) {
  needs(typeof path === "string" && isAbsolute(path), name + " requires an absolute path");
  const meta = await fileStat(path);
  needs(
    meta &&
      (type === "file" ? meta.isFile() : meta.isDirectory()) &&
      !(meta.mode & 0o077) &&
      (process.getuid === undefined || meta.uid === process.getuid()),
    name + " must be a private, owner-only " + type,
  );
  return meta;
}
async function config() {
  needs(
    ["phone", "gateway", "whatsapp-self"].includes(ingress) &&
      (ingress !== "whatsapp-self" || channel === "whatsapp"),
    "Choose phone, gateway or whatsapp-self ingress",
  );
  needs(
    ["telegram", "whatsapp"].includes(channel),
    "Select telegram or whatsapp with SARVAM_TEST_CHANNEL",
  );
  needs(
    process.env.SARVAM_LIVE_TEST === "1" && process.env.SARVAM_CHANNEL_LIVE === "1",
    "Opt in with SARVAM_LIVE_TEST=1 and SARVAM_CHANNEL_LIVE=1 after authorizing the test recipient",
  );
  needs(process.env.SARVAM_API_KEY, "Supply the Sarvam test credential");
  const path = process.env.SARVAM_CHANNEL_CONFIG;
  await privatePath(path, "file", "SARVAM_CHANNEL_CONFIG");
  const p = JSON.parse(await readFile(path, "utf8"));
  needs(
    p.channel === channel && p.recipient === p.approvedRecipient,
    "Confirm the single recipient in the private channel config",
  );
  needs(
    typeof p.recipient === "string" &&
      (channel === "telegram" ? /^[1-9]\d{0,18}$/ : /^\+[1-9]\d{6,14}$/).test(p.recipient),
    "Use a Telegram private user ID or WhatsApp E.164 number",
  );
  p.account ??= "default";
  needs(
    typeof p.account === "string" && /^[a-z0-9][a-z0-9_-]{0,40}$/.test(p.account),
    "Invalid dedicated test account ID",
  );
  await privatePath(p.evidenceDir, "directory", "evidenceDir");
  if (channel === "telegram") await privatePath(p.tokenFile, "file", "Telegram tokenFile");
  else {
    needs(p.selfChat === true, "Use an explicitly approved, paired WhatsApp self-chat");
    await privatePath(p.authDir, "directory", "WhatsApp authDir");
    needs(
      (await fileStat(join(p.authDir, "creds.json")))?.isFile(),
      "Pair the dedicated WhatsApp test account first",
    );
    needs(
      typeof p.channelPluginPath === "string" && isAbsolute(p.channelPluginPath),
      "Provide the installed official WhatsApp plugin path",
    );
    const manifest = JSON.parse(
      await readFile(join(p.channelPluginPath, "openclaw.plugin.json"), "utf8"),
    );
    needs(
      manifest.id === "whatsapp",
      "The channel plugin path must contain the WhatsApp extension",
    );
  }
  p.timeoutSeconds ??= 300;
  needs(
    Number.isInteger(p.timeoutSeconds) && p.timeoutSeconds >= 30 && p.timeoutSeconds <= 1800,
    "timeoutSeconds must be 30–1800",
  );
  needs(
    p.requirePlayback === undefined || typeof p.requirePlayback === "boolean",
    "requirePlayback must be a boolean",
  );
  return p;
}
function hostConfig(installed, p, pair, port, dir, relay) {
  const allow = ["sarvam", channel, "sarvam-e2e-probe", "sarvam-channel-receipt"];
  const loadPaths = [resolve("tests/fixtures/probe"), resolve("tests/fixtures/channel-receipt")];
  if (channel === "whatsapp") loadPaths.push(p.channelPluginPath);
  const account = {
    enabled: true,
    dmPolicy: "allowlist",
    allowFrom: [p.recipient],
    groupPolicy: "disabled",
    ...(channel === "telegram"
      ? {
          tokenFile: p.tokenFile,
          apiRoot: relay.apiRoot,
          network: { dangerouslyAllowPrivateNetwork: true },
        }
      : { authDir: p.authDir, selfChatMode: true, pluginHooks: { messageReceived: true } }),
  };
  return {
    ...installed,
    gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token" } },
    plugins: {
      ...installed.plugins,
      allow,
      load: { paths: loadPaths },
      entries: {
        ...installed.plugins?.entries,
        sarvam: { enabled: true },
        [channel]: { enabled: true },
        "sarvam-e2e-probe": { enabled: true, hooks: { allowConversationAccess: true } },
        "sarvam-channel-receipt": { enabled: true, hooks: { allowConversationAccess: true } },
      },
    },
    channels: {
      [channel]: {
        enabled: true,
        defaultAccount: p.account,
        dmPolicy: "allowlist",
        allowFrom: [p.recipient],
        groupPolicy: "disabled",
        accounts: { [p.account]: account },
      },
    },
    agents: {
      defaults: {
        ...installed.agents?.defaults,
        workspace: join(dir, "workspace"),
        skipBootstrap: true,
        model: { primary: "sarvam/glm5.3-flash", fallbacks: [] },
      },
    },
    tools: {
      allow: ["sarvam_test_lookup"],
      media: {
        audio: { enabled: true, language: "en-IN", timeoutSeconds: 100 },
        models: [{ provider: "sarvam", model: pair.stt, capabilities: ["audio"] }],
      },
    },
    tts: {
      auto: ingress === "gateway" ? "off" : "inbound",
      provider: "sarvam",
      providers: {
        sarvam: {
          modelId: pair.tts,
          speaker: pair.tts === "bulbul:v3" ? "shubh" : "shubh_enhi_ads",
          language: "en-IN",
        },
      },
    },
  };
}
async function rows(path) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
async function waitAccount(host, port, p) {
  const until = Date.now() + 45_000;
  for (;;) {
    const health = await host.rpc(port, "channels.status", { probe: false });
    const group = health.channelAccounts?.[channel];
    const acc =
      Object.values(group ?? {}).find((x) => x.accountId === p.account) ?? group?.[p.account];
    if (acc?.running && (channel === "telegram" || acc.connected === true)) return;
    if (Date.now() >= until || acc?.lifecycle === "blocked")
      throw new Blocked("Dedicated channel account did not connect");
    await sleep(1000);
  }
}
async function runPair(host, installed, p, pair, relay) {
  const run =
    channel +
    "-" +
    pair.stt.at(-1) +
    "-" +
    pair.tts.substring(7) +
    "-" +
    randomBytes(4).toString("hex");
  const challenge = [...phraseWords];
  const color = [0, 1, 2].map(() => challenge.splice(randomInt(challenge.length), 1)[0]).join(" ");
  let file;
  const exported = join(p.evidenceDir, run + ".ogg"),
    receipt = join(p.evidenceDir, run + ".json");
  await writeFile(join(host.dir, "test-color.txt"), color, { mode: 0o600 });
  for (const name of [
    "lookups.jsonl",
    "model-events.jsonl",
    "channel-receipts.jsonl",
    "channel-outbound.ogg",
    "telegram-received.ogg",
  ])
    await rm(join(host.dir, name), { force: true });
  relay?.reset();
  const port = await freePort();
  await host.write(hostConfig(installed, p, pair, port, host.dir, relay));
  await host.cmd(["config", "validate", "--json"]);
  await host.start(port);
  if (host.logs().includes("channel autostart suppressed"))
    await host.rpc(port, "channels.start", { channel, accountId: p.account });
  await waitAccount(host, port, p);
  json({
    status: ingress === "phone" ? "AWAITING_INPUT" : "SUBMITTING_AUDIO",
    channel,
    ingress,
    ...pair,
    utterance,
    optionalReceivedNote: exported,
    optionalPlaybackReceipt: receipt,
  });
  const submitted =
    ingress === "phone" ? undefined : await submitAudio(host, port, p, channel, ingress, utterance);
  const staged =
    ingress === "gateway"
      ? await deliverGatewayReply(host, port, p, channel, pair.tts, submitted, (text) =>
          speaksColor(text, color),
        )
      : undefined;
  const until = Date.now() + p.timeoutSeconds * 1000;
  let received,
    sent,
    source,
    playback,
    previousProgress = "";
  for (;;) {
    const events = await rows(join(host.dir, "channel-receipts.jsonl"));
    fail(
      !events.some((e) => e.kind === "send-failed"),
      "The channel reported outbound delivery failure",
    );
    received =
      ingress === "gateway"
        ? submitted
        : (events.find(
            (e) => e.kind === "inbound-audio" && (!submitted || e.id === submitted.id),
          ) ?? relay?.inbound().at(0));
    const payload =
      received && events.find((e) => e.kind === "outbound-voice" && e.at >= received.at);
    sent =
      received &&
      (relay?.receipts().find((e) => e.at >= received.at && (!staged || e.id === staged.id)) ??
        staged ??
        events.find(
          (e) =>
            e.kind === "sent" &&
            e.at >= (payload?.at ?? received.at) &&
            (!payload?.run || !e.run || e.run === payload.run) &&
            e.id !== received.id,
        ));
    const played = await fileStat(receipt),
      audio = await fileStat(exported);
    if (played) {
      needs(played.isFile() && played.size <= 2048, "Provide a small private playback receipt");
      playback = JSON.parse(await readFile(receipt, "utf8"));
    }
    const progress = [
      received && (ingress === "gateway" ? "Gateway audio attachment" : "inbound channel voice"),
      (payload || staged) && "native voice",
      sent && "channel receipt",
      playback && "phone playback",
    ]
      .filter(Boolean)
      .join(", ");
    if (progress && progress !== previousProgress) {
      json({ status: "EVIDENCE", channel, ...pair, observed: progress });
      previousProgress = progress;
    }
    if (received && sent && (!p.requirePlayback || playback)) {
      if (relay?.receipts().some((r) => r.id === sent.id)) {
        file = join(host.dir, "telegram-received.ogg");
        await relay.download(sent.id, file);
        source = "Telegram getFile from sendVoice receipt";
        break;
      }
      if (audio && playback) {
        needs(
          audio.isFile() && audio.size > 0 && audio.size <= 8 * 1024 * 1024,
          "Provide a recipient-exported Ogg no larger than 8 MiB",
        );
        source = "recipient-export";
        file = exported;
        break;
      }
      if ((payload || staged) && channel === "whatsapp") {
        source = staged
          ? "Gateway send(asVoice) acknowledged by WhatsApp"
          : "native voice payload accepted by WhatsApp";
        file = staged?.file ?? join(host.dir, "channel-outbound.ogg");
        break;
      }
    }
    if (Date.now() >= until)
      throw new Blocked(
        "Missing phone input, authenticated outbound voice evidence, or requested recipient playback within the test window",
      );
    await sleep(500);
  }
  if (playback)
    fail(
      playback.played === true && playback.voiceNote === true && speaksColor(playback.heard, color),
      "Recipient playback did not confirm the spoken challenge in a voice note",
    );
  const calls = await rows(join(host.dir, "lookups.jsonl")),
    models = await rows(join(host.dir, "model-events.jsonl"));
  fail(
    calls.some((x) => x.color === color),
    "The Sarvam agent did not call the synthetic lookup",
  );
  fail(
    models.some((x) => x.heardOrchard && x.provider === "sarvam" && x.model === "glm5.3-flash"),
    "The inbound transcript did not reach the configured Sarvam model",
  );
  const tts = await host.rpc(port, "tts.status");
  fail(
    tts.provider === "sarvam" && tts.fallbackProviders?.length === 0,
    "Expected a Sarvam-only TTS pipeline",
  );
  const { stdout } = await execute("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name,channels,sample_rate:format=format_name,duration",
    "-of",
    "json",
    file,
  ]);
  const meta = JSON.parse(stdout),
    audio = meta.streams?.[0];
  fail(
    meta.format?.format_name === "ogg" &&
      audio?.codec_name === "opus" &&
      audio.channels === 1 &&
      audio.sample_rate === "48000" &&
      Number(meta.format.duration) > 0.25,
    "The received file must be a playable mono 48 kHz Ogg/Opus voice note",
  );
  const answer = jsonOutput(
    await host.cmd([
      "infer",
      "audio",
      "transcribe",
      "--file",
      file,
      "--model",
      "sarvam/saaras:v4",
      "--language",
      "en-IN",
      "--json",
    ]),
  );
  await verifySpokenLookup({
    expected: color, recognizedColors: colorWords(transcriptText(answer)), ingress, file,
    mismatchFile: join(p.evidenceDir, run + "-mismatch.ogg"),
  });
  await writeFile(
    join(p.evidenceDir, run + "-accepted.json"),
    JSON.stringify({
      channel,
      ingress,
      ...pair,
      at: new Date().toISOString(),
      inputId: received.id,
      sentId: sent.id,
      source,
      recipientPlayback: Boolean(playback),
    }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  return {
    senderReceipt: digest(sent.id),
    inputReceipt: digest(received.id),
    externalInbound: ingress !== "gateway",
    handsetInbound: ingress === "phone",
    codec: audio.codec_name,
    hz: Number(audio.sample_rate),
    seconds: Number(meta.format.duration),
    spokenChallenge: true,
    evidence: source,
    recipientPlayback: Boolean(playback),
  };
}
const completed = [];
let host, relay;
let cfg;
function report(pair, error, details = {}) {
  const status = error ? (error instanceof Blocked ? "BLOCKED" : "FAIL") : "PASS";
  let reason;
  if (error) {
    const message = String(error.message);
    try {
      const rpc = jsonOutput(message).error;
      reason =
        typeof rpc?.message === "string"
          ? [rpc.code, rpc.message].filter(Boolean).join(" ")
          : undefined;
    } catch {
      /* Local command errors can also be plain text. */
    }
    reason ??= message.split("\n").find((line) => /[a-z]/i.test(line)) ?? "Channel test failed";
    if (cfg?.recipient) reason = reason.replaceAll(cfg.recipient, "[test peer]");
    reason = reason.replace(/[0-9]{5,}:[\w-]{12,}/g, "[bot credential]");
    if (process.env.SARVAM_API_KEY)
      reason = reason.replaceAll(process.env.SARVAM_API_KEY, "[redacted]");
    reason = reason.replace(/[A-Za-z0-9+/=]{100,}/g, "[attachment]").slice(0, 220);
  }
  completed.push(status);
  json({ channel: channel ?? "unspecified", ingress, ...pair, status, reason, ...details });
}
try {
  cfg = await config();
  host = await isolatedHost({ live: true, archive: process.env.SARVAM_TEST_ARCHIVE });
  if (channel === "telegram")
    relay = await telegramReceipt({
      token: (await readFile(cfg.tokenFile, "utf8")).trim(),
      recipient: cfg.recipient,
    });
  await writeFile(
    join(host.dir, "channel-acceptance.json"),
    JSON.stringify({ channel, account: cfg.account, recipient: cfg.recipient }),
    { mode: 0o600 },
  );
  const installed = await host.read();
  for (const pair of pairs) {
    try {
      report(pair, undefined, await runPair(host, installed, cfg, pair, relay));
    } catch (e) {
      report(pair, e);
    } finally {
      await host.stop();
    }
  }
} catch (e) {
  for (const pair of pairs.slice(completed.length)) report(pair, e);
} finally {
  if (host) await host.close();
  if (relay) await relay.close();
}
if (completed.some((s) => s === "FAIL")) process.exitCode = 1;
else if (completed.some((s) => s === "BLOCKED")) process.exitCode = 2;
