# omp-openai-provider-tools

`omp-openai-provider-tools` is a Pi-family extension package that enables OpenAI Responses provider-native `web_search` and `image_generation` tools for OMP and Pi-compatible runtimes.

The plugin is designed for provider-native execution. It injects configured tools into the same OpenAI Responses request that is sent to the model provider, so the provider sees the same request context as the model call. The plugin does not introduce a host-side search service or host-side image generation service.

## Installation

### OMP

Install from npm:

```bash
omp plugin install npm:omp-openai-provider-tools
```

Link a local checkout during development:

```bash
omp plugin link <path>
```

### Pi

Install from npm:

```bash
pi install npm:omp-openai-provider-tools
```

Load the package for a run:

```bash
pi -e npm:omp-openai-provider-tools
```

## Runtime support

The package publishes both Pi-family extension entries:

- `omp.extensions`: `./src/extension.ts`
- `pi.extensions`: `./src/extension.ts`

Runtime behavior is gated by the capabilities exposed by the host runtime. Required capabilities include mutable OpenAI Responses request hooks, request-scoped model metadata, safe active-tool conflict control, visible message delivery, and image artifact persistence or a writable agent default image directory.

See [runtime compatibility notes](./docs/runtime-compatibility.md) for observed OMP behavior, Pi-family capability gates, and guarded behavior when a runtime does not expose a required capability.

## Configuration files

OMP paths:

- User config: `~/.omp/agent/openai-provider-tools.yml`
- Project config: `.omp/openai-provider-tools.yml`

Pi paths:

- User config: `~/.pi/agent/openai-provider-tools.yml`
- Project config: `.pi/openai-provider-tools.yml`

Project config takes precedence over user config. Within the loaded configuration set, the first matching `providers[]` entry wins. When the runtime identity is unknown, the plugin loads existing `.pi` and `.omp` configs in deterministic project-before-user order and emits a visible warning instead of silently ignoring one runtime family.

## Configuration schema

Configuration uses YAML with `version: 1` and a `providers` array.

```yaml
version: 1
providers:
  - name: openai
    match:
      api: openai-responses
      provider: openai
      baseUrl:
        equals: https://api.openai.com/v1
      modelId: gpt-4.1
      modelName: GPT 4.1
    tools:
      web_search:
        enabled: true
        search_context_size: medium
      image_generation:
        enabled: true
        output_format: png
        quality: high
        size: 1024x1024
        background: auto
        action: generate
    output:
      directory: ./provider-tool-images
```

Supported fields:

| Field | Required | Description |
| --- | --- | --- |
| `version` | Yes | Must be `1`. |
| `providers[]` | Yes | Ordered list of provider entries. The first matching entry is used. |
| `providers[].name` | Yes | Human-readable entry name used in diagnostics. |
| `providers[].match.api` | Yes | API family to match. Use `openai-responses`. |
| `providers[].match.provider` | No | Runtime/provider identifier, for example `openai`. |
| `providers[].match.baseUrl.equals` | No | Exact provider base URL match. |
| `providers[].match.baseUrl.prefix` | No | Prefix match for OpenAI-compatible provider base URLs. |
| `providers[].match.baseUrl.host` | No | Hostname match for provider base URLs. |
| `providers[].match.modelId` | No | Exact model ID match. |
| `providers[].match.modelName` | No | Exact model display-name match. |
| `providers[].tools.web_search.enabled` | Yes to enable | Defaults to disabled unless set to `true`. |
| `providers[].tools.web_search.search_context_size` | No | Provider-native search context size, such as `low`, `medium`, or `high`. |
| `providers[].tools.image_generation.enabled` | Yes to enable | Defaults to disabled unless set to `true`; also requires the selected runtime model to opt in to provider-native image generation. |
| `providers[].tools.image_generation.output_format` | No | Provider-native image output format, such as `png`, `jpeg`, or `webp`. |
| `providers[].tools.image_generation.quality` | No | Provider-native image quality option. |
| `providers[].tools.image_generation.size` | No | Provider-native image size option. |
| `providers[].tools.image_generation.background` | No | Provider-native background option. |
| `providers[].tools.image_generation.action` | No | Provider-native action option. |
| `providers[].output.directory` | No | Directory for saved image files from native response history. |

### Model opt-in for `image_generation`

`image_generation` is intentionally gated by both plugin config and model metadata. This prevents a broad provider entry from enabling image generation for every model behind the same provider or gateway.

For OMP 14.7.x model configs, add an opt-in marker to only the model variants that are routed to image-capable backend accounts:

```yaml
providers:
  compatible-example:
    models:
      - id: gpt-5.5-image
        name: GPT-5.5 Image
        api: openai-responses
        reasoning: true
        compat:
          extraBody:
            openai_provider_tools:
              image_generation: true
```

The plugin also accepts equivalent runtime capability metadata such as `capabilities.openaiProviderTools.imageGeneration: true` when a host runtime exposes it.

## Examples

### Official OpenAI provider

```yaml
version: 1
providers:
  - name: openai
    match:
      api: openai-responses
      provider: openai
      baseUrl:
        host: api.openai.com
    tools:
      web_search:
        enabled: true
        search_context_size: medium
      image_generation:
        enabled: true
        output_format: png
        size: 1024x1024
```

For `image_generation`, this provider config is not sufficient by itself; the selected runtime model must also carry the model opt-in marker shown above.

### OpenAI-compatible provider

This example uses a fictional provider name and a reserved example host.

```yaml
version: 1
providers:
  - name: compatible-example
    match:
      api: openai-responses
      provider: compatible-example
      baseUrl:
        prefix: https://gateway.example.invalid/v1
    tools:
      web_search:
        enabled: true
        search_context_size: medium
      image_generation:
        enabled: true
        output_format: png
        quality: high
    output:
      directory: ./provider-tool-images
```

## Credential policy

The plugin does not read, store, or request API keys. It does not use environment variables for plugin credentials. Provider authentication remains in the runtime/model provider configuration that already owns provider credentials.

Do not put keys or private endpoints in `openai-provider-tools.yml`. Keep plugin configuration limited to matching rules, provider-native tool settings, and optional image output paths.

## Behavior

- Tools are disabled by default. A provider entry must match the current OpenAI Responses request, and each tool must set `enabled: true` before injection occurs. `image_generation` additionally requires the selected model to opt in with image-generation model metadata.
- The plugin does not set `tool_choice`; provider tool selection remains controlled by the model/provider request.
- For matching models, corresponding host-side `web_search` or `generate_image` tools are removed only when provider-native injection for that same capability can be ensured.
- If safe injection or safe host-tool conflict control cannot be ensured, the plugin warns or blocks transparently instead of creating ambiguous behavior.
- Provider errors remain provider errors. The plugin surfaces warnings and blocked states so the user can distinguish configuration/runtime issues from provider responses.

## Image results

Image files are extracted from OpenAI Responses native history, specifically preserved provider-native `image_generation` results. The plugin does not place base64 image payloads into text conversation context.

Saved image directory order:

1. `providers[].output.directory`, when configured.
2. Runtime session artifact directory, when available.
3. Agent default image directory.

When an image is saved, the plugin sends a visible custom message with the saved path. The message is delivered as next-turn context, so the agent can read the path on a later turn instead of receiving an opaque base64 payload. If saving fails, the failure is logged and reported visibly when the runtime supports visible messages.

## Provider tool result echoes

Provider-native tools do not pass through the host-side tool renderer. To keep the user from seeing a silent provider-side action, the plugin emits visible custom messages for displayable provider results preserved in OpenAI Responses native history.

Currently, `web_search_call` history is summarized with the provider action, query, citations, and sources when available. Image generation is echoed through the saved-image message described above.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No provider-native tools appear | Confirm a config file exists in the OMP or Pi path, `version: 1` is present, the provider entry matches the current request, and the desired tool has `enabled: true`. |
| Invalid config warning | Validate YAML syntax and supported schema fields. Unknown or malformed fields can prevent safe matching. |
| Runtime capability warning | Check [runtime compatibility notes](./docs/runtime-compatibility.md). The runtime must expose the capability gate needed for the requested behavior. |
| Provider request fails | Treat the error as a provider/runtime response first. The plugin keeps provider-native execution in the main request path and reports plugin-side warnings separately. |
| No image file is saved | Confirm the provider returned native Responses image history and the runtime preserved that history or exposed an artifact-capable session. Also confirm the configured output directory is writable when one is set. |

## Manual validation matrix

Before publishing or enabling the plugin in a runtime, validate the relevant rows for your target environment. Rows marked **live e2e** send requests to the configured provider and may consume provider quota; run them only with an intentionally configured test account/model.

| Area | Validation |
| --- | --- |
| OMP install | Run `omp plugin install npm:omp-openai-provider-tools`. |
| OMP local link | Run `omp plugin link <path>`. |
| Pi install | Run `pi install npm:omp-openai-provider-tools`. |
| Pi explicit package flag | Run `pi -e npm:omp-openai-provider-tools`. |
| Official OpenAI dry run | Use a non-secret runtime provider configuration named `openai`; confirm the matching entry injects only enabled provider-native tools. |
| Compatible provider dry run | Use a test runtime provider named `compatible-example` with `https://gateway.example.invalid/v1`; confirm matching uses the compatible entry. |
| Provider-native `web_search` live e2e | Send a real request that allows provider-native search; confirm the Responses request carries `web_search` and the provider returns native search call history or a provider-side error transparently. |
| Provider-native `image_generation` live e2e | Send a real request that allows provider-native image generation; confirm the Responses request carries `image_generation` and the provider returns native image generation call history or a provider-side error transparently. |
| Image file saved live e2e | After a provider-native image generation response, confirm the visible custom message reports the saved image path and the file exists in the configured output, session artifact, or agent default image directory. |
| Targeted tests | Run `bun test test/package-manifest.test.ts`. |
| Package dry run | Run `bun pm pack --dry-run`. |