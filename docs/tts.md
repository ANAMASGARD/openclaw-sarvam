# Bulbul speech synthesis

Set `SARVAM_API_KEY` in the Gateway environment or connect the `sarvam` provider through OpenClaw's credential onboarding. Select `sarvam` under top-level `tts`. Speech works independently of your chat model and transcription provider.

```json
{
  "tts": {
    "auto": "inbound",
    "provider": "sarvam",
    "providers": {
      "sarvam": {
        "modelId": "bulbul:v4-flash",
        "speaker": "simran_en_customer",
        "language": "en-IN",
        "streamTransport": "http"
      }
    }
  }
}
```

`inbound` enables spoken replies to incoming audio. Choose `always` for spoken replies to text messages as well. For v3, set `modelId` to `bulbul:v3` and `speaker` to `shubh`. For Hindi on v4-flash, try `language: "hi-IN"` and `speaker: "aparna_hi_customer"`. See the [speech-only configuration](../examples/speech-only.json) for a complete example.

## Models and settings

| Model | Plugin default speaker | Voice selection |
| --- | --- | --- |
| `bulbul:v4-flash` (plugin default) | `shubh_enhi_ads` | 222 case-sensitive persona identifiers in the reference catalog used for this release |
| `bulbul:v3` | `shubh` | 37 case-sensitive speaker names |

The plugin sends the selected model and speaker explicitly, including when both are defaults. A Gateway model override without an accompanying voice selects that model's default speaker. A mismatched voice produces an actionable error before synthesis. OpenClaw's voice-list operation returns the selected model's catalog. [Sarvam voices](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/voices)

Both models accept the same 11 language codes. The test suite exercises `en-IN` and `hi-IN`. Other controls include `pace` (0.5–2), `pitch` (−0.5–0.5), `loudness` (0.1–2.5), `temperature` (0.01–1), `sampleRate`, `codec`, `enablePreprocessing` and `dictId`. Streaming additionally accepts `bitrate`. WebSocket accepts `minBufferSize` and `maxChunkLength`. [Request parameters](https://docs.sarvam.ai/api-reference/text-to-speech/convert)

## Transports

| OpenClaw operation | Sarvam transport | Audio and completion |
| --- | --- | --- |
| Buffered synthesis, including Gateway `tts.convert` | `POST /text-to-speech`, up to 2,500 characters | Decodes one base64 recording from the JSON response. The file default is WAV. |
| Streaming synthesis, `streamTransport: "http"` (default) | `POST /text-to-speech/stream`, up to 3,500 characters | Forwards raw response bytes as they arrive. The file default is MP3. |
| Streaming synthesis, `streamTransport: "websocket"` | `wss://api.sarvam.ai/text-to-speech/ws`, up to 2,500 characters per utterance | Negotiates the model in the upgrade, sends configuration, text and flush, decodes each audio frame, and requires the server's final event. Cancelling an active turn closes its socket. |

An OpenClaw consumer calls `textToSpeechStream` to receive incremental audio. Ordinary buffered channel replies continue using the REST endpoint. OpenClaw supplies the completed text of an utterance to this speech provider. Separate streaming transcription and synthesis do not establish a hosted phone call. [HTTP streaming](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/http-stream) · [WebSocket messages](https://docs.sarvam.ai/api-reference/text-to-speech/stream)

For a voice-note target, the plugin requests native mono Ogg/Opus. Upstream WAV or stereo Ogg is converted to mono Ogg at 48 kHz with system FFmpeg and libopus. A confirmed codec rejection allows one WAV-format fallback. Other errors propagate without replaying a possibly billable utterance. For text-to-speech HTTP 429, the plugin retries at most once when the stated delay is at most two seconds. Audio is bounded to 32 MiB and the default synthesis deadline is 60 seconds.

## Live evidence

Tests used short English and Hindi phrases on 20 November 2026. FFprobe read each recording. English voice notes decoded as mono Opus at 48 kHz. Hindi audio decoded as mono PCM WAV for REST and mono MP3 for streaming, each at 24 kHz. The content check compared a Saaras v4 transcription against four expected words per phrase. It matched 47 of 48 words across twelve recordings. Chunk counts below are observed counts for this run and vary between requests.

| Model | Transport | English duration / chunks | Hindi duration / chunks | Expected words heard (English, Hindi) |
| --- | --- | --- | --- | --- |
| v3 | REST | 3.93 s / 1 | 4.35 s / 1 | 4/4, 4/4 |
| v3 | HTTP stream | 3.85 s / 8 | 3.98 s / 12 | 4/4, 4/4 |
| v3 | WebSocket | 4.21 s / 5 | 3.91 s / 12 | 4/4, 4/4 |
| v4-flash | REST | 4.89 s / 1 | 4.40 s / 1 | 4/4, 4/4 |
| v4-flash | HTTP stream | 5.05 s / 10 | 4.37 s / 8 | 4/4, 3/4 |
| v4-flash | WebSocket | 5.23 s / 6 | 4.97 s / 8 | 4/4, 4/4 |

Isolated OpenClaw 2026.11.5 and 2026.11.6 Gateways installed the packed plugin, enabled speech by itself, and selected the Telegram voice-note target using a loopback Telegram Bot API fixture. The Gateway's native `tts.convert` and `textToSpeechStream` exercised all six model/transport combinations against live Sarvam on each host version. All twelve produced mono 48 kHz Ogg/Opus recordings. Interrupting WebSocket synthesis after its first audio chunk also passed on each host. This test covers the Gateway dispatch, provider and channel format selection. External delivery to a Telegram user requires a separate channel test.

| Host | Model | REST | HTTP stream | WebSocket |
| --- | --- | --- | --- | --- |
| 2026.11.5 | v3 | 2.57 s | 3.68 s, 7 chunks | 3.70 s, 4 chunks |
| 2026.11.5 | v4-flash | 2.89 s | 4.89 s, 9 chunks | 5.15 s, 6 chunks |
| 2026.11.6 | v3 | 2.48 s | 3.51 s, 8 chunks | 3.78 s, 4 chunks |
| 2026.11.6 | v4-flash | 3.21 s | 5.05 s, 10 chunks | 4.99 s, 5 chunks |

Both Gateway versions also called `textToSpeechTelephony` with each Bulbul model. All four returned audible signed 16-bit PCM at 8 kHz. The application did not place a phone call. An additional live WebSocket check reused one connection for two consecutive utterances per model. Each utterance completed with independently decodable 24 kHz MP3 audio.

From the checkout, expose your own key to the test process and run the following. The direct test makes twelve synthesis requests and twelve short transcription checks. The Gateway test requests six voice notes, two short telephony samples, and interrupts one additional recording. Both tests run serially and clean up their temporary audio. Set `OPENCLAW_BIN` to an alternative OpenClaw executable to repeat the host test on a second installation.

```sh
npm run build
npm test -- --run tests/tts-*.test.ts
SARVAM_LIVE_TEST=1 node tests/live-tts.mjs
SARVAM_LIVE_TEST=1 node tests/gateway-tts.mjs
```
