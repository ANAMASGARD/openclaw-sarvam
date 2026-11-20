# Telegram and WhatsApp voice acceptance

The isolated Gateway transcribes a voice question with the selected Saaras model, runs a tool through Token Factory, speaks the tool's unpredictable answer with the selected Bulbul model, and sends the voice reply to an approved chat. Each channel runs four model combinations sequentially. Use a dedicated test bot or linked WhatsApp account. Stop any other Gateway using those same channel credentials before starting.

## Prepare private settings

Create an operator-owned directory outside the checkout with mode `0700` and an `evidence` subdirectory with the same permissions. Put the channel's JSON config in this directory with mode `0600`. Provide actual absolute paths and replace each placeholder. Each invocation uses one account and exactly one approved recipient. Leave your usual Gateway configuration in place. The test creates its own state directory and installs the packaged Sarvam plugin there.

For **Telegram**, use an existing dedicated bot and open its private chat from the target user's account. Save its BotFather token alone in a regular file with mode `0600`. The allowlisted value is the numeric ID of that private user. Groups and bot usernames are outside this test.

```json
{
  "channel": "telegram",
  "account": "default",
  "recipient": "<numeric private Telegram user ID>",
  "approvedRecipient": "<same ID>",
  "tokenFile": "/absolute/private/telegram-token",
  "evidenceDir": "/absolute/private/evidence"
}
```

For **WhatsApp**, pair the dedicated number using OpenClaw's official WhatsApp channel, then use that number's **Message yourself** chat. Point the harness to the already paired, owner-only Baileys auth directory containing `creds.json` and the installed root of the official WhatsApp plugin, which contains its `openclaw.plugin.json`. The channel can refresh the paired credentials during normal use. The test enables the documented inbound-message hook for this isolated account. [OpenClaw WhatsApp setup](https://docs.openclaw.ai/channels/whatsapp)

```json
{
  "channel": "whatsapp",
  "account": "default",
  "recipient": "<your linked number in +countrycode format>",
  "approvedRecipient": "<same number>",
  "selfChat": true,
  "authDir": "/absolute/private/whatsapp-credentials",
  "channelPluginPath": "/absolute/path/to/official/whatsapp-plugin",
  "evidenceDir": "/absolute/private/evidence"
}
```

## Run the conversation

Expose your test `SARVAM_API_KEY` to the process. From the repository root run the following commands, substituting your private config path. To test WhatsApp, set `SARVAM_TEST_CHANNEL=whatsapp` and use its JSON config.

```sh
npm run build
SARVAM_LIVE_TEST=1 SARVAM_CHANNEL_LIVE=1 \
SARVAM_TEST_CHANNEL=telegram SARVAM_CHANNEL_CONFIG=/absolute/private/telegram.json \
node tests/channel-live.mjs
```

To load only the Sarvam key from an owner-managed dotenv file, use the same environment settings, set `SARVAM_TEST_KEY_FILE=/absolute/private/key.env`, and run `node tests/local-key.mjs channel-live`. An optional `SARVAM_TEST_ARCHIVE=/absolute/path/to/openclaw-plugin-sarvam-0.1.0.tgz` selects a specific packed release. `SARVAM_TEST_PAIR='saaras:v4/bulbul:v4-flash'` reruns a single pair.

Choose the input path with `SARVAM_CHANNEL_INGRESS`.

| Value | How audio enters | Evidence required |
| --- | --- | --- |
| `gateway` | eSpeak NG and FFmpeg generate a short Ogg locally. The ordinary `chat.send` RPC submits those bytes with `deliver: false` in a fresh private session. The harness reads the agent's tool-backed reply through `chat.history`, calls `tts.convert`, and passes the returned audio to the authenticated `send` RPC with `asVoice: true` for the approved account and recipient. | Actual STT, agent tool, TTS and outbound channel receipt. Results carry `externalInbound: false` and `handsetInbound: false`. No handset action is needed. |
| `whatsapp-self` | The Gateway's documented `send` RPC sends the synthetic recording as a voice message to the paired number's own chat. | The WhatsApp adapter must independently receive the sent message ID before the agent answers. If the client suppresses the self-echo, the input stage is blocked. This mode sends an extra test note to the designated self-chat. |
| `phone` (default) | The tester sends a voice note from the actual Telegram user account or linked WhatsApp handset. | A real channel inbound voice event and verified outbound delivery. |

For an unattended test, add `SARVAM_CHANNEL_INGRESS=gateway` to the command above. For handset input use the steps below. A Telegram bot token only authenticates the bot, so a genuine human-originated Telegram update requires a Telegram user's message.

1. Wait for `AWAITING_INPUT` in the terminal. Record and send this voice note from the approved private chat: **“This is the mango orchard. Use the test lookup tool for the current test color. Say all three words exactly in order.”**
2. When the Gateway replies, you can play the voice note. Wait for the next `AWAITING_INPUT` before forwarding the **original request** to the same chat. Repeat for the remaining pairs. The tool returns new words each time.
3. Use the terminal's per-pair status to identify the exact model pair and stage. The default input window is five minutes per pair. Set `timeoutSeconds` in the private config to change it.

## What each result proves

- **Telegram** uses OpenClaw's real Telegram adapter. A test-only loopback relay forwards its requests to the official HTTPS Bot API. It observes Telegram's actual authenticated `sendVoice` response for the approved chat and downloads the provider-stored recording using its returned voice file ID. This adds no extra Telegram messages. [Telegram Voice and getFile](https://core.telegram.org/bots/api#getfile)
- **WhatsApp** uses the paired official channel adapter. For automatic Gateway input, the adapter must acknowledge the explicit voice send and return a provider message ID. For native incoming DMs, the harness pairs a successful channel send receipt with the outgoing OpenClaw `audioAsVoice` payload. It checks the corresponding Ogg in each case. The result labels the evidence source. [OpenClaw message hooks](https://docs.openclaw.ai/plugins/hooks/messages)
- All modes require the appropriate input receipt, a Saaras transcript reaching the selected Sarvam chat model, a fresh lookup call, and a mono 48 kHz Ogg/Opus recording that speaks the three words. FFprobe checks the recording and Saaras transcribes the captured answer. Logs show pseudonymous receipt references. The private evidence directory receives the Gateway or channel input ID and the channel's accepted message ID. On a generated Gateway trial that fails its spoken-content check, the harness saves an owner-only `-mismatch.ogg` there and reports the recognized color words. The temporary Gateway deletes its own state and audio.
- Handset playback is recorded separately. To require it, add `"requirePlayback": true` to the private config. Play the returned voice note and save `{"played":true,"voiceNote":true,"heard":"<words you heard>"}` to the `optionalPlaybackReceipt` path printed for that turn. If the channel encoder cannot expose its sent media, save the actual received note unchanged at `optionalReceivedNote` and supply the playback receipt. Only a verified attestation produces `recipientPlayback: true`.

`PASS` records a verified voice round trip with its stated evidence source. `BLOCKED` and exit code 2 identify missing credentials, pairing, phone input or evidence. `FAIL` and exit code 1 identify a failed assertion or upstream execution. An unexecuted channel remains unverified even if a local fixture passes.
