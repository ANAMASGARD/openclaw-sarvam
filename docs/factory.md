# Token Factory

Enable `tokenFactory` in the Sarvam plugin to use chat, decisions or embeddings. The plugin fetches `GET https://api.sarvam.ai/v2/models` with the selected account. OpenClaw's runnable chat catalog includes entitled chat models and uses the advertised context window, output limit, supported inputs and tool support. The live catalog labels restricted chat models. Prices are absent from the catalog, so OpenClaw's required numeric cost fields use zero. Use Sarvam's dashboard for billing. [Sarvam model catalog](https://docs.sarvam.ai/api/token-factory/models)

## Connect your account

Export `SARVAM_API_KEY` in the Gateway environment, or enter it in OpenClaw's native login. Select a chat model explicitly when the agent should use Sarvam.

```sh
openclaw models auth login --provider sarvam --method api-key
openclaw models list --all --provider sarvam --refresh
openclaw models set sarvam/glm5.3-flash
```

The last command changes the default conversational model. Speech-only installations can omit it and disable `plugins.entries.sarvam.config.tokenFactory`. The same Sarvam credential works for the enabled services. The plugin resolves credentials in the current agent/account context. The catalog fetches fresh data on discovery and stores no credentials in a plugin-level cache.

## Choose a role

| OpenClaw service | Configuration | Sarvam endpoint |
| --- | --- | --- |
| Agent conversation, tools and streaming | `agents.defaults.model.primary`, for example `sarvam/glm5.3-flash` | `POST /v2/chat/completions` |
| Decision tool | `agents.defaults.decisionModel` or the agent's `decisionModel`, for example `sarvam/sarvam-prism` | `POST /v2/systemone` |
| Agent memory embeddings | Set the agent's `memory.search.provider` to `sarvam` and `memory.search.model` to `embeddinggemma-2` | `POST /v2/embeddings` |

Operators choose the chat, decision and embedding models independently. Prism supports Boolean, choice and score questions on text or structured state. Provisioned Clef also accepts an inline image. OpenClaw 2026.11.5 requires two or more options for choice and score questions, including Clef. Sarvam accepts single-option Clef requests when its API is used directly. The decision adapter passes the host's current request authority, cancellation and deadline checks through to inference. It preserves provider probabilities, rubric order and usage. [Sarvam Decisions](https://docs.sarvam.ai/api/token-factory/decisions-api) · [OpenClaw decision models](https://docs.openclaw.ai/concepts/decision-models)

EmbeddingGemma requires provisioned capacity. Its adapter requests float vectors, verifies 768 finite values per input, restores batch order from the provider indices, and applies the documented query and document prefixes when the host has not already formatted the text. [EmbeddingGemma 2](https://docs.sarvam.ai/api/token-factory/models/embeddinggemma-2)

The normal chat transport uses Chat Completions. The adapter uses the provider’s default thinking budget and caps generated tokens using the model’s catalog metadata. The documented `/v2/responses` models also support stateless requests. Set `api: "openai-responses"` on the specific model under `models.providers.sarvam.models` to request that transport. Sarvam requires full history on each call and accepts `store: false`. The Conversations variant uses Chat Completions. [Sarvam Responses](https://docs.sarvam.ai/api/token-factory/responses-api)

## Live account evidence

On 20 November 2026 the test account listed 16 model IDs. A 30-request run included a real inference request for each ID. Each chat test executed a synthetic lookup and required the model's second answer to contain the random lookup result. Each eligible Responses test checked the text returned. Prism judged an independent parcel-delivery fixture with probability 0.9710.

| Exact model | Native API probe | Stateless Responses probe |
| --- | --- | --- |
| `glm5.3-flash` | PASS, chat with tool | PASS |
| `glm5.3` | PASS, chat with tool | PASS |
| `gemma4` | PASS, chat with tool | PASS |
| `sarvam-105b` | PASS, chat with tool | PASS |
| `sarvam-105b-conversations` | PASS, chat with tool | UNSUPPORTED |
| `deepseekv4.1-flash-1017` | PASS, chat with tool | PASS |
| `deepseekv4.1-flash-1017-interactive` | PASS, chat with tool | PASS |
| `sarvam-prism` | PASS, decision | — |
| `clef` | BLOCKED, decision | — |
| `embeddinggemma-2` | BLOCKED, embedding | — |
| `qwen38-27b` | BLOCKED, chat | BLOCKED |
| `deepseekv4-pro` | BLOCKED, chat | BLOCKED |
| `mimo-v2.6-flash` | BLOCKED, chat | — |
| `mimo-v2.6-pro` | BLOCKED, chat | — |
| `kimi-k3` | BLOCKED, chat | — |
| `kimi-k3.1-pro` | BLOCKED, chat | BLOCKED |

All eight restricted IDs returned HTTP 400 with a message requiring organisation provisioning on their respective chat, decision or embedding endpoint. The adapter reports the redacted category `provisioning_required`. A direct EmbeddingGemma probe confirmed Sarvam’s wire error code was `invalid_request_error`. The test skipped additional Responses calls for restricted models. Some Sarvam documentation describes restricted models as absent from the list or yielding 404. This account's catalog explicitly returned those IDs with `whitelisted: false`. The plugin inspects the live access flags. [Provisioned model documentation](https://docs.sarvam.ai/api/token-factory/models)

## OpenClaw Gateway evidence

OpenClaw 2026.11.5 loaded the compiled npm archive into a temporary profile. Each agent had one Sarvam model and no fallback. The Gateway invoked a fixture tool that read a fresh random value from the local test directory. Every passing run returned that exact value, recorded the invocation in the fixture, emitted the expected provider and model in the host hook, and stored the requested transport on the assistant message in `chat.history`.

| Exact model | Gateway via Chat Completions | Gateway via stateless Responses |
| --- | --- | --- |
| `glm5.3-flash` | PASS | PASS |
| `glm5.3` | PASS | PASS |
| `gemma4` | PASS | PASS |
| `sarvam-105b` | PASS | PASS |
| `sarvam-105b-conversations` | PASS | UNSUPPORTED |
| `deepseekv4.1-flash-1017` | PASS | PASS |
| `deepseekv4.1-flash-1017-interactive` | PASS | PASS |

All 13 supported agent tool loops passed. OpenClaw's native `tools.invoke` also called `decision_evaluate` with a delivery fixture and returned `status: "ok"`, `provenance.providerId: "sarvam"`, result model `sarvam-prism` and a 0.9710 probability. This exercises the host credential and decision runtime separately from the direct HTTP probe.

The refreshed OpenClaw CLI catalog contained exactly the seven entitled chat models. Native `openclaw infer embedding create` reached Sarvam with the environment key, and a second run reached it through a saved OpenClaw API-key profile with the environment variable removed. Both returned the account’s HTTP 400 provisioning response. A successful live vector and a retrieval score require an organisation with EmbeddingGemma access.

An agent can receive its first request before the Gateway's background catalog is ready. On a cache miss, the plugin reads the live account catalog for the agent's selected profile and returns the exact entitled chat entry through OpenClaw's asynchronous model-resolution hook. It carries the advertised input, context and tool capabilities into that turn. [Provider runtime hooks](https://docs.openclaw.ai/plugins/sdk-provider-plugins/runtime-hooks)

## Reproduce

```sh
npm run build
SARVAM_LIVE_TEST=1 node tests/live-factory.mjs
SARVAM_LIVE_TEST=1 node tests/gateway-factory.mjs
```

Set `SARVAM_API_KEY` in the test process environment. The direct test caps underlying requests with `SARVAM_FACTORY_CALL_LIMIT` (50 by default). Set `SARVAM_FACTORY_MODELS` to a comma-separated subset for a focused run. The Gateway test installs an npm archive in a temporary profile, allows only its local lookup fixture and the core decision tool, and runs up to twenty selected chat models sequentially. Set `SARVAM_TEST_ARCHIVE` to test a specific archive. Set `SARVAM_GATEWAY_PHASE` to `chat`, `responses` or `services` for focused Gateway, catalog and embedding checks.
