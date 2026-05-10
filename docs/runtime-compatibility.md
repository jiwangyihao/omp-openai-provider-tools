# Runtime Compatibility Notes

## Scope

This document records compatibility observations and required capability gates for the Pi-family provider-native tools plugin. It is not a live provider test, does not validate credentials, and does not call OpenAI or any OpenAI-compatible provider.

## OMP 14.7.3 observed capabilities

| Capability | Status | Evidence | Plugin behavior |
| --- | --- | --- | --- |
| Extension entry and hook registration | Observed | OMP 14.7.3 extension runtime supports extension entries and event hooks including `before_provider_request`; see `docs/superpowers/specs/2026-05-07-openai-provider-tools-design.md`. | Register the shared extension entry and attach provider request inspection only through runtime hooks. |
| Extension factory / extension entry shape | Observed | OMP 14.7.3 extension runtime accepts a shared extension factory/entry shape; manifest docs and `docs/superpowers/specs/2026-05-07-openai-provider-tools-design.md` define the plugin entry contract. | Export the shared extension entry only in the documented runtime shape; do not invent runtime-specific factories. |
| Synchronous in-place `before_provider_request` payload mutation | Observed | OMP 14.7.3 OpenAI Responses provider calls `options?.onPayload?.(params)`. | Mutate the existing OpenAI Responses params object synchronously; do not depend on a returned replacement payload or deferred mutation. |
| Request-scoped model/context source | Observed | OMP 14.7.3 extension/custom tool context shapes expose model/context metadata; OpenAI Responses payload handling requires request model consistency. | Prefer the request/event model when present; use context model only after consistency checks confirm it describes the same provider request. |
| OpenAI Responses native history payload | Observed | Assistant messages can carry `providerPayload.type === "openaiResponsesHistory"` with `providerPayload.items[]`. | Parse provider-native `image_generation_call` results for saved files, and parse displayable provider tool results such as `web_search_call` for visible echo messages. |
| `agent_end` assistant message shape | Observed | Extension events can access `AgentMessage`; observed assistant messages preserve OpenAI Responses history as `providerPayload.type === "openaiResponsesHistory"` with `providerPayload.items[]`. | Parse only observed assistant/provider payloads for image results. If native history is absent, no image save success message is emitted; diagnose via troubleshooting and runtime capability checks. |
| Image persistence locations | Observed | OMP 14.7.3 session manager exposes artifact directory, save, and allocation APIs; the plugin also supports `compat.openaiProviderTools.outputDirectory` and an agent image directory. | Persist generated image files in the first available location: configured output directory, session artifact directory, then the agent image directory under the runtime agent home. |
| Visible custom message delivery | Observed | OMP 14.7.3 runtime message APIs can deliver visible custom messages. | Send compatibility warnings, provider tool result echoes, image-save failures, and saved image notices visibly without embedding image base64. |
| Runtime model `compat` metadata retention | Observed | OMP 14.7.3 `models.yml` loader preserves provider/model `compat` objects and recursively merges provider-level and model-level compatibility metadata into the runtime model. Top-level unknown model fields are not copied into the final `Model` object. | Use `compat.openaiProviderTools` as the primary provider/model capability marker instead of a separate plugin YAML or top-level custom fields. |
| Live status overlay UI | Observed / Capability-gated | OMP interactive runtimes expose `ctx.ui.custom(factory, { overlay: true })`; OMP's autoresearch dashboard uses that overlay path for focused dashboard-style UI. RPC/headless/print or older runtimes may not expose interactive custom overlay support. | Probe `ctx.ui.custom` capability. If absent, live `web_search` status is a no-op while final provider result summaries continue. Completed status auto-closes after a short delay, and final result echo/lifecycle cleanup closes any active overlay immediately. Do not fall back to the old short status widget. |
| Active tools conflict-control API | Required for safe behavior | No exact OMP 14.7.3 per-turn get/set active-tools API is recorded here; safe behavior requires an observed read/write or equivalent block/restore conflict-control mechanism before removing host-side tools. | Remove conflicting host-side tools only when a safe conflict-control mechanism exists and provider-native injection is ensured; otherwise warn/avoid unsafe removal. |
| System prompt / before-agent return semantics | Guarded | Exact system prompt mutation or before-agent return shape is not recorded as an observed OMP 14.7.3 dependency for this plugin. | Do not depend on system prompt mutation for correctness; provider-native tool injection must be correct through provider request hooks and visible warnings. |
| Image result handling expectation | Guarded | Automatic file saving depends on preserved OpenAI Responses native history containing `image_generation_call.result` plus a writable configured, artifact, or agent image directory. | Save image results only when native history and persistence capabilities are present. Absent history produces no image save success message; use troubleshooting and capability checks to diagnose missing native history. |

## Pi-family required capabilities

| Capability gate | Status | Evidence | Plugin behavior |
| --- | --- | --- | --- |
| Extension registration | Required | Runtime must expose `pi.extensions`, `omp.extensions`, or equivalent extension metadata and hook registration. | Load the shared extension entry only through explicit compatible runtime APIs. |
| Mutable provider request payload | Required | `before_provider_request` or an equivalent hook must expose mutable OpenAI Responses params before send. | Inject `web_search` and `image_generation` provider-native tools only when mutation can happen synchronously before the provider call. |
| Active tools read/write or equivalent conflict-control mechanism | Required | Runtime must expose current tools and a safe way to remove conflicting host-side tools for a turn, or an equivalent block/restore mechanism. | Prevent duplicate host-side/provider-native search or image semantics; if safe conflict control is unavailable, do not remove host-side tools. |
| Request-scoped model metadata | Required | Runtime events or provider request context must expose request-scoped model metadata, or expose context model metadata that can be checked against the request. | Resolve provider-native tool eligibility from the current request model; use context metadata only after consistency checks. |
| Image-generation model opt-in metadata | Required for image generation | A broad provider match can cover both image-capable and non-image backend routes. The selected model must expose `compat.openaiProviderTools.imageGeneration: true`. | Inject `image_generation` only when selected-model metadata opts in; leave `web_search` unaffected. |
| Custom provider opt-in metadata | Required for custom OpenAI-compatible providers | Official OpenAI Responses can be detected from provider/base URL, but arbitrary gateways cannot be assumed to support provider-native tools. Custom providers must expose `compat.openaiProviderTools.enabled: true` after provider/model metadata merge. | Enable provider-native `web_search` for custom providers only after explicit provider metadata opt-in. |
| Before-agent/system prompt independence | Guarded | Pi-family support must not require a specific system prompt mutation or before-agent return shape unless a runtime documents it. | Keep correctness independent from prompt mutation; use provider request mutation and visible warnings as the authoritative behavior. |
| Session artifact directory or visible warning path | Required | Runtime must expose a writable artifact/output path, or at least visible warning delivery. | Persist image files when possible; otherwise warn visibly with the real limitation. |
| Custom or visible message delivery | Required | Runtime must expose a user-visible notification or custom message API. | Report compatibility warnings, save failures, and saved file paths through visible messages. |
| OpenAI Responses native history preservation | Guarded | Automatic image saving requires `providerPayload.type === "openaiResponsesHistory"` with `items[]` entries that include `image_generation_call.result`. | If a Pi runtime lacks native history preservation, automatic image file saving is skipped and no save success message is emitted; diagnose via troubleshooting and runtime capability checks. |
| Agent-end native history preservation | Guarded | Automatic image extraction requires `agent_end`/assistant messages to preserve `providerPayload.type === "openaiResponsesHistory"` with `items[]`. | Parse only preserved native assistant/provider payloads. Absent or non-native message shapes produce no image results and no saved-image message. |

## Runtime selection rule

Detect explicit runtime metadata when available. The primary configuration source for provider-native tool eligibility is the runtime model metadata preserved from `models.yml`, especially `compat.openaiProviderTools`. The plugin does not load standalone `openai-provider-tools.yml` files.

## Safety rules for implementation

- Do not put API keys in plugin config.
- Do not design environment-variable credential handling for this plugin; credentials remain owned by the runtime model/provider registry.
- Do not hardcode provider names, provider hosts, gateway names, or private endpoints.
- Do not set `tool_choice`.
- Official OpenAI Responses models may use provider-native `web_search` by default; custom OpenAI-compatible providers must opt in with `compat.openaiProviderTools.enabled: true`; selected models must opt in with `compat.openaiProviderTools.imageGeneration: true` before enabling `image_generation`.
- Tie per-tool host-side tool removal to ensured provider-native injection for that same provider tool type, with visible warning or request blocking when injection cannot be ensured.
- Preserve provider-native execution semantics: provider tools run inside the model provider request path and use the same request context that the provider receives.
- Keep provider-native `web_search` live status overlay UI-only: do not write session messages, do not expose it to model context, keep completed status visible only briefly, and clear it on final provider-result echo, cancellation, errors, and session switches.
- Do not create live overlay status for provider-native `image_generation`; keep existing keepalive/interruption/final result behavior.
