# Sarvam v0.1.0 verification

Tests ran on Fedora Linux on 20 November 2026 with Node.js 24.18.0, npm 12.2.0 and FFmpeg/FFprobe 8.1.3. Live Sarvam calls used one test account. All recordings were public evaluation speech or generated test phrases. Production plugins exclude test hooks, personal identifiers, recordings, keys and job receipts.

**NOT READY for public ClawHub publication under the full acceptance criteria.** Saaras, Bulbul, the seven entitled chat models and Prism worked in OpenClaw. Telegram and WhatsApp accepted all eight Gateway-originated voice replies. Handset-originated conversations and eight provisioning-restricted model IDs remain open. The pull request contains the installable review build. [Implementation and CI checks](https://github.com/ANAMASGARD/openclaw-sarvam/pull/1)

## Model APIs

| Sarvam service | Real model and transport | Result |
| --- | --- | --- |
| Saaras v3 | REST, signed-file Batch, legacy WebSocket, modern `saaras:v3-realtime` WebSocket | PASS on all four |
| Saaras v4 | REST, signed-file Batch, legacy WebSocket, modern WebSocket with acknowledged settings update | PASS on all four |
| Bulbul v3 | Buffered REST, binary HTTP streaming, WebSocket | PASS on all three in Hindi and English |
| Bulbul v4-flash | Buffered REST, binary HTTP streaming, WebSocket | PASS on all three in Hindi and English |
| Token Factory chat | Seven entitled chat models, tool request followed by a second answer | PASS 7/7 |
| Token Factory Responses | Six entitled models supporting stateless Responses | PASS 6/6 |
| Prism decisions | Native OpenClaw decision tool, text fixture, answer and provenance | PASS |
| Clef, EmbeddingGemma, six provisioned chat models | An inference request on the relevant route for each catalog ID | BLOCKED by organisation provisioning, HTTP 400 |

The Saaras direct suite ran 13 cases across eight model/transport combinations. Both versions accepted exactly 30 seconds through REST, and the Batch clients reopened 31-second jobs and retrieved transcripts. Separate runs exercised diarization, aligned timestamps and WebM duration recovery. The v4 Hindi-English test recovered the independent reference words. [Saaras fixtures, WER and limitations](stt.md)

The Bulbul direct suite synthesized 12 utterances. FFprobe verified their codecs, durations, rates and channels. Transcribing the received audio recovered 47 of 48 expected keywords in the initial run and all 48 in a repeat. The six English voice-note outputs were mono 48 kHz Ogg/Opus. Both models also returned raw signed 8 kHz PCM through OpenClaw's telephony surface. [Bulbul measurements](tts.md)

The account's live catalog listed 16 IDs. Seven chat models and Prism returned usable answers. For eight restricted IDs the plugin normalized the upstream provisioning response to `provisioning_required`. Native OpenClaw embedding requests authenticated using both the process environment and a stored agent profile. Successful Clef inference, live embeddings and vector retrieval require provisioned access. [Per-model results](factory.md)

Repeat testing exposed two ways an entitled model could briefly appear unknown. A catalog connection failed before a DeepSeek turn, and a freshly started Gateway accepted its first GLM turn before applying its background catalog. Discovery now retries recognized transient connection failures once within the original deadline. On a cold registry miss, OpenClaw's public `prepareDynamicModel` hook resolves the exact requested chat model from the active account. Tests cover socket reset, cancellation, policy rejection, an ambiguous write failure, and denying access under the wrong profile. [OpenClaw provider runtime hooks](https://docs.openclaw.ai/plugins/sdk-provider-plugins/runtime-hooks)

## Native OpenClaw

- Real packaged 2026.11.5 Gateway agents completed seven Chat Completions and six Responses tool conversations. Each agent had to execute a lookup, use its unpredictable value and record the selected provider, model and protocol in the host transcript.
- A fresh 2026.11.5 installation ran the native audio CLI with only the environment key. After saving the credential in OpenClaw and removing it from the process environment, separate CLI processes recovered the Batch job. The production meeting engine selected both live realtime model versions, recognized 19 words from each μ-law input and disposed a cancelled session without a late transcript.
- On both 2026.11.5 and 2026.11.6, Gateway buffered synthesis and its public speech-streaming interface returned Ogg/Opus on both Bulbul versions over every supported transport. Cancelling an active WebSocket synthesis after the first audio chunk passed on each host. The channel adapter selected voice-note format through a loopback Telegram fixture.
- A local Telegram Bot API fixture fed a generated voice note into the official Telegram adapter. All four Saaras/Bulbul pairs passed on 2026.11.5 with an environment key and on 2026.11.6 with a stored profile and no environment key. OpenClaw transcribed each recording, ran the agent and its tool, then automatically sent a spoken reply. FFprobe checked the resulting file and a second transcription checked its spoken answer.

## Real channel delivery

The two real private accounts were an allowlisted Telegram bot DM and the linked WhatsApp account's self-chat. A generated spoken question entered OpenClaw via an audio-only `chat.send` attachment. The Sarvam agent had to call a lookup tool to learn three random words. The harness passed its answer through the native speech and messaging APIs. Each passing cell below has a distinct external send receipt, mono 48 kHz Ogg/Opus audio, and an independently transcribed reply containing the three expected words.

| Saaras for input | Bulbul for reply | Real Telegram voice file | Real WhatsApp voice send |
| --- | --- | --- | --- |
| `saaras:v3` | `bulbul:v3` | PASS, 2.40 s | PASS, 1.46 s |
| `saaras:v3` | `bulbul:v4-flash` | PASS, 1.05 s | PASS, 0.89 s |
| `saaras:v4` | `bulbul:v3` | PASS, 2.05 s | PASS, 6.72 s |
| `saaras:v4` | `bulbul:v4-flash` | PASS, 8.17 s | PASS, 2.73 s |

Telegram returned a `sendVoice` receipt for each reply. The harness downloaded Telegram's stored file with `getFile` and checked that file. WhatsApp's official OpenClaw channel accepted each voice send and returned a message ID. Its duration and spoken-content checks used the outgoing file passed to the channel. WhatsApp recipient-side download and playback are **NOT TESTED**.

Eight genuine handset-originated voice conversations remain **BLOCKED**. The Telegram account sent the bot a real private Start message. No handset voice note arrived during the live input windows. In a separate trial, WhatsApp accepted a test recording sent to the linked account's self-chat. Its adapter produced no new inbound event for that self-sent message. Neither trial supplies a handset voice receipt. Raw chat IDs, message IDs and credentials stay outside the repository. [Channel acceptance procedure](channel-tests.md)

## Installation and release checks

The package declares the tested OpenClaw range `>=2026.11.5 <=2026.11.6`. Installation of an npm archive, runtime provider inspection and config validation use isolated profiles. The three operator examples cover speech-only, models-only and combined configurations.

| Check | Observed result |
| --- | --- |
| Fresh `npm ci --ignore-scripts`, TypeScript typecheck and build | PASS |
| Offline Vitest | 87 passed, 0 failed, 1 billed test skipped |
| ClawHub Plugin Inspector | PASS, seven expected runtime registrations, zero warnings or breakages |
| OpenClaw compatibility lint | PASS, zero warnings |
| Packed plugin on OpenClaw 2026.11.5 and 2026.11.6 | PASS on both. Each host loaded the installed plugin and validated all three example configurations. |
| Production dependencies, `npm audit --omit=dev` | PASS, zero known vulnerabilities |
| Full development tree, `npm audit` | 19 moderate and 2 high findings, zero critical. The two high findings concern `brace-expansion` and `undici` bundled by the pinned development host's npm dependency. |

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run validate
npm run lint
npm run test:package
npm audit --omit=dev
npm pack --dry-run
npm pack
```

The ClawHub Plugin Inspector validates native providers and checks seven runtime registrations. The two target hosts' `openclaw plugins validate --root .` authoring command reports **FAIL** because it requires tool or feature authoring metadata. CI runs the ClawHub Inspector plus a real archive install and runtime inspection on both host releases. The single skipped offline test is an opt-in, billed Gateway experiment. Its separate authenticated result appears above.

## Scope

The plugin covers the three Model API families and their OpenClaw surfaces. Full-duplex calling, Samvaad phone provisioning and campaigns, translation and document intelligence are outside v0.1.0. Short validation clips establish routing, playable output and sampled recognition quality. They do not establish accuracy across every language, speaker or noise condition.
