# Saaras speech recognition

Select `sarvam` as your audio provider in `tools.media.models`. Choose `saaras:v4` or `saaras:v3` explicitly there. OpenClaw passes transcribed voice notes to the agent that owns the channel. The speech-only example enables incoming voice notes without selecting an agent language model. [Speech-only configuration](../examples/speech-only.json) · [OpenClaw audio ingestion](https://docs.openclaw.ai/nodes/audio)

Install FFmpeg so that `ffprobe` and `ffmpeg` are on the Gateway's PATH. Browser recordings with missing container duration are measured from their audio packets. The plugin measures each recording before submission and sends recordings up to 30 seconds to REST. It sends longer recordings to Batch. Source formats include WAV, MP3, AAC, FLAC, Ogg/Opus, M4A/MP4, WebM, AIFF, AMR and WMA. A raw `.pcm` recording must be signed little-endian PCM16, mono at 16 kHz. Corrupt or unmeasurable files fail before upload. OpenClaw's media limit defaults to 20 MB and its timeout defaults to 60 seconds. For a long job, the Batch CLI lets the conversation continue while Sarvam processes the audio. [Sarvam transport limits](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/which-api-to-use) · [OpenClaw audio settings](https://docs.openclaw.ai/nodes/audio)

## Models and recognition modes

| Transport | Saaras v3 model ID | Saaras v4 model ID | Result |
| --- | --- | --- | --- |
| REST | `saaras:v3` | `saaras:v4` | One transcript |
| Batch | `saaras:v3` | `saaras:v4` | Per-file transcripts, optional timestamps and speaker labels |
| Modern realtime WebSocket | `saaras:v3-realtime` | `saaras:v4` | Partial and final transcripts |
| Legacy streaming WebSocket | `saaras:v3` | `saaras:v4` | A final per detected utterance |

All four transports accept `transcribe`, `translate` (English output), `verbatim`, `translit` (Roman script) and `codemix`. Leave the language unspecified for auto-detection, or choose a code such as `hi-IN` or `en-IN`. The plugin sends the automatic-language and Odia codes each endpoint expects. Saaras v4 accepts up to 50 keyterms of up to 64 characters each. [Recognition modes](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/rest-api) · [Keyterm prompting](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/how-to/keyterms)

## Durable Batch jobs

```sh
openclaw sarvam batch submit meeting.wav --model saaras:v4 --language hi-IN --diarize --speakers 2 --timestamps
openclaw sarvam batch list
openclaw sarvam batch status LOCAL_JOB_ID
openclaw sarvam batch resume LOCAL_JOB_ID
openclaw sarvam batch results LOCAL_JOB_ID
```

`submit` returns a local job ID after Sarvam accepts the start request. On interruption, use `list` to recover it. `status` reports the local submission phase, upstream ID when known, and Sarvam's status. Once the job reaches a terminal state, `results` retrieves the individual files and includes any diarization and timing fields returned by Sarvam. Partial failures retain a separate outcome for each input, identified by its zero-based position, such as `input-0.wav`. Each job accepts 1–20 files with up to two hours and 128 MiB per file, subject to a 256 MiB local total. [Batch guide](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/batch-api)

The job ID survives CLI and Gateway restarts. `resume` obtains fresh signed upload links for an interrupted upload. It reconciles an interrupted start with Sarvam before permitting an explicit `resume LOCAL_JOB_ID --retry-start`. A lost response to the initial create request can leave the upstream ID unknown. Check the provider account before submitting the same input again. Stopping local polling leaves an already-started job running remotely.

The plugin stores receipts and pending audio below the active OpenClaw state directory in `sarvam/batch/`. Each credential owns a separate namespace. Job metadata and pending audio are encrypted and authenticated with AES-256-GCM. Directory permissions are owner-only and staged audio is removed after a confirmed start. The plugin fetches transcripts on demand. Signed object transfers use HTTPS and send only their storage authorization. Complete pending jobs before rotating the key. The original credential is required to reopen its local receipts. Use `list` under that credential to recover an interrupted job.

## Realtime consumers

An OpenClaw consumer, such as the meeting engine, selects the `sarvam` realtime transcription provider. Set its provider configuration to `{"model":"saaras:v4","language_code":"hi-IN"}` for the modern endpoint. Use `saaras:v3-realtime` for modern v3. To choose legacy v4, include `"protocol":"legacy"`. Choosing `saaras:v3` selects legacy automatically. The default audio input matches OpenClaw's telephony convention of mono 8 kHz μ-law. Consumers delivering PCM explicitly set `encoding: "pcm16le"`, `sampleRate` and `channels`. The plugin normalizes the input to mono 16 kHz PCM and paces frames in real time. [Modern WebSocket](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming) · [Legacy WebSocket](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/streaming-api)

The modern adapter waits for `session.begin`, forwards partial and completed speech, uses server VAD, and accepts acknowledged updates to language, mode and v4 keyterms. The legacy server expects an `audio/wav` label in each JSON audio envelope even when the negotiated `input_audio_codec` is raw PCM. It emits several final segments with the same connection-level `request_id`. The adapter preserves each segment. Host cancellation releases the socket and rejects stale callbacks.

## Live evidence, November 20, 2026

Both models completed all four transports using actual Sarvam endpoints. The independent English and Hindi samples are human speech from Google FLEURS. English scoring normalizes numbers, capitalization, punctuation and the spoken plural “years.” The two 31-second samples contain real speech followed by silence. The bilingual test concatenates two different speakers. These figures describe the small test set. [FLEURS dataset and CC BY 4.0 license](https://huggingface.co/datasets/google/fleurs)

| Model | REST | Batch with signed upload and download | Legacy WebSocket | Modern WebSocket |
| --- | --- | --- | --- | --- |
| Saaras v3 | PASS, English WER 0 and Hindi WER 0.042 | PASS, English WER 0, job reopened | PASS, two English finals, WER 0 | PASS, Hindi WER 0.042, 124 partials and one final |
| Saaras v4 | PASS, English and Hindi WER 0 | PASS, Hindi WER 0, job reopened | PASS, one Hindi final, WER 0 | PASS, English WER 0, 73 partials and one final, acknowledged keyterm update |

A second live run enabled speaker labels and timestamps on both 31-second Batch jobs. Each returned one timed segment with a speaker ID and zero WER. The Batch guide illustrates timing labels under `timestamps.chunks`. Both live responses used `timestamps.words` with aligned start and end arrays. The plugin preserves the upstream timing and diarization payloads. [Batch response format](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/batch-api)

The v4 `codemix` test passed on 19.83 seconds of Hindi followed by English, with WER and CER both zero. Both model versions also accepted exactly 30 seconds through REST with zero WER. The 13 direct cases use a total test budget of 224.55 seconds of input. The live results include actual finalization events and decoded transcripts. Two additional REST checks encoded the English fixture as a streaming WebM whose container has no duration. Both models recognized the expected phrase from the 92,433-byte, 10.548-second recording after the packet-timeline fallback. The 16 standalone deterministic tests separately exercise malformed inputs, signed storage boundaries, recovery, credential isolation, duplicate events, cancellation and bounded queues.

A separate **PASS** used OpenClaw 2026.11.5, an installed package archive and a fresh state directory. The native `infer audio transcribe` command recognized the known speech using only the environment key and a configured audio-model entry. The test then moved the key into the native agent profile, removed it from every OpenClaw subprocess environment and exercised Batch across five separate CLI commands. Sarvam marked the 31-second job completed and its transcript contained the expected phrase.

The same Gateway's production meeting engine selected the installed `sarvam` provider through the host registry and recognized 19 words from 96,480 bytes of live 8 kHz μ-law input with `saaras:v3-realtime` and `saaras:v4`. The host disposed both sessions. A third connection cancelled the v4 stream after 200 ms of input and produced no completed transcript. The microphone and agent-consult observer were local fixtures. Joining a public meeting or a phone network was outside this run.

To reproduce the direct checks, export your own `SARVAM_API_KEY` or set `SARVAM_TEST_KEY_FILE` to a private local dotenv file that contains it. The runner reads only the named key and the fixture helper verifies the two public recordings by SHA-256.

```sh
export SARVAM_STT_FIXTURES="$(mktemp -d)"
python3 tests/fixtures/saaras-audio.py "$SARVAM_STT_FIXTURES"
npm run build
SARVAM_LIVE_TEST=1 node tests/local-key.mjs live-stt
SARVAM_LIVE_TEST=1 SARVAM_STT_GATEWAY_TEST=1 npm test -- --run tests/stt-gateway.test.ts
```

The direct runner processes cases sequentially and caps its audio budget at 230 seconds by default. Set `SARVAM_STT_CASES` to a comma-separated list such as `saaras:v3/batch,saaras:v4/batch` for a subset, or set `SARVAM_STT_BUDGET_SECONDS` to a smaller limit. The opt-in host test installs the built package into an isolated profile and processes real audio. External meeting joins and physical calls require their own accounts and remain separately verifiable.
