# Runtime Compatibility Notes

## Scope

This document records compatibility observations and required capability gates for the Pi-family provider-native tools plugin. It is not a live provider test, does not validate credentials, and does not call OpenAI or any OpenAI-compatible provider.

## OMP 14.7.3 observed capabilities

| Capability | Status | Evidence | Plugin behavior |
| --- | --- | --- | --- |
| Extension entry and hook registration | Observed | OMP 14.7.3 extension runtime supports extension entries and event hooks including `before_provider_request`; see `docs/superpowers/specs/2026-05-07-openai-provider-tools-design.md`. | Register the shared extension entry and attach provider request inspection only through runtime hooks. |
| Synchronous in-place `before_provider_request` payload mutation | Observed | OMP 14.7.3 OpenAI Responses provider calls `options?.onPayload?.(params)`. | Mutate the existing OpenAI Responses params object synchronously; do not depend on a returned replacement payload or deferred mutation. |
| OpenAI Responses native history payload | Observed | Assistant messages can carry `providerPayload.type === "openaiResponsesHistory"` with `providerPayload.items[]`. | Parse provider-native `image_generation_call` results from preserved history when present. |
| Session artifact APIs | Observed | OMP 14.7.3 session manager exposes artifact directory, save, and allocation APIs. | Prefer configured output directory, then runtime session artifact persistence for generated image files. |
| Visible custom message delivery | Observed | OMP 14.7.3 runtime message APIs can deliver visible custom messages. | Send compatibility warnings, image-save failures, and saved image notices visibly without embedding image base64. |
| Active tools conflict handling requirement | Required for safe behavior | The design requires host-side tool removal to be tied to ensured provider-native injection. | Remove conflicting host-side tools only when the current provider request path can ensure provider-native injection or can be safely blocked/restored on failure. |
| Image result handling expectation | Guarded | Automatic file saving depends on preserved OpenAI Responses native history plus a writable configured or artifact directory. | Save image results only when native history and persistence capabilities are present; otherwise warn visibly and avoid claiming files were saved. |

## Pi-family required capabilities

| Capability gate | Status | Evidence | Plugin behavior |
| --- | --- | --- | --- |
| Extension registration | Required | Runtime must expose `pi.extensions`, `omp.extensions`, or equivalent extension metadata and hook registration. | Load the shared extension entry only through explicit compatible runtime APIs. |
| Mutable provider request payload | Required | `before_provider_request` or an equivalent hook must expose mutable OpenAI Responses params before send. | Inject `web_search` and `image_generation` provider-native tools only when mutation can happen synchronously before the provider call. |
| Active tools read/write or equivalent conflict-control mechanism | Required | Runtime must expose current tools and a safe way to remove conflicting host-side tools for a turn, or an equivalent block/restore mechanism. | Prevent duplicate host-side/provider-native search or image semantics; if safe conflict control is unavailable, do not remove host-side tools. |
| Session artifact directory or visible warning path | Required | Runtime must expose a writable artifact/output path, or at least visible warning delivery. | Persist image files when possible; otherwise warn visibly with the real limitation. |
| Custom or visible message delivery | Required | Runtime must expose a user-visible notification or custom message API. | Report compatibility warnings, save failures, and saved file paths through visible messages. |
| OpenAI Responses native history preservation | Guarded | Automatic image saving requires `providerPayload.type === "openaiResponsesHistory"` with `items[]`. | If a Pi runtime lacks native history preservation, warn visibly and skip automatic image file saving rather than pretending success. |

## Runtime selection rule

Detect explicit runtime or capability metadata when available. When runtime identity is unknown, load all existing `.omp` and `.pi` plugin configs in deterministic project-before-user order and warn visibly that runtime identity was not explicit. Unknown runtime must never be silently treated as OMP-only, and Pi configuration must not be ignored just because OMP is the primary verified runtime.

## Safety rules for implementation

- Do not put API keys in plugin config.
- Do not design environment-variable credential handling for this plugin; credentials remain owned by the runtime model/provider registry.
- Do not hardcode provider names, provider hosts, gateway names, or private endpoints.
- Do not set `tool_choice`.
- Keep all provider tools disabled unless the matching config explicitly sets `enabled: true`.
- Tie per-tool host-side tool removal to ensured provider-native injection for that same provider tool type, with visible warning or request blocking when injection cannot be ensured.
- Preserve provider-native execution semantics: provider tools run inside the model provider request path and use the same request context that the provider receives.
