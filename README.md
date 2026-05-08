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


## Configuration

The recommended configuration surface is the OMP/Pi model registry (`models.yml`). Provider-native tools are capabilities of the selected provider/model, so keeping the markers beside provider and model definitions avoids a second plugin-specific file that can drift out of sync.

### Official OpenAI Responses provider

For the official OpenAI Responses provider, provider-native `web_search` is enabled by default when the selected runtime model is explicitly an OpenAI Responses model and the provider/base URL identifies official OpenAI:

```yaml
providers:
  openai:
    api: openai-responses
    baseUrl: https://api.openai.com/v1
```

`image_generation` is never enabled by provider defaults. It still requires model-level opt-in because image generation depends on the specific model/backend account.

### OpenAI-compatible providers

For custom OpenAI-compatible Responses providers, opt in at provider level with `compat.openaiProviderTools.enabled: true`:

```yaml
providers:
  compatible-example:
    api: openai-responses
    baseUrl: https://gateway.example.invalid/v1
    compat:
      openaiProviderTools:
        enabled: true
```

This enables provider-native `web_search` for matching Responses models on that provider. The plugin does not infer support for arbitrary gateways from `openai-responses` alone.

### Model opt-in for `image_generation`

Enable provider-native image generation only on model variants that route to image-capable backend accounts:

```yaml
providers:
  compatible-example:
    models:
      - id: gpt-5.5-image
        name: GPT-5.5 Image
        api: openai-responses
        reasoning: true
        compat:
          openaiProviderTools:
            imageGeneration: true
```

When provider-level and model-level `compat` are both present, OMP merges them into the runtime model. A custom provider can therefore enable provider-native tools once at provider level and enable image generation only on selected model variants.

### Optional image output directory

If the runtime exposes `compat.openaiProviderTools.outputDirectory`, the plugin uses it as the preferred saved-image directory. Otherwise it falls back to the runtime session artifact directory and then the agent default image directory.

```yaml
compat:
  openaiProviderTools:
    enabled: true
    outputDirectory: ./provider-tool-images
```


## Credential policy

The plugin does not read, store, or request API keys. It does not use environment variables for plugin credentials. Provider authentication remains in the runtime/model provider configuration that already owns provider credentials.

Do not put keys or private endpoints in plugin settings or extension-specific files. Provider credentials stay in the runtime model/provider registry (`models.yml` or the host runtime's equivalent credential store).

## Behavior

- Official OpenAI Responses models get provider-native `web_search` by default. Custom OpenAI-compatible providers must opt in with `compat.openaiProviderTools.enabled: true`. `image_generation` additionally requires selected-model opt-in with `compat.openaiProviderTools.imageGeneration: true`.
- The plugin does not set `tool_choice`; provider tool selection remains controlled by the model/provider request.
- For matching models, corresponding host-side `web_search` or `generate_image` tools are removed only when provider-native injection for that same capability can be ensured.
- If safe injection or safe host-tool conflict control cannot be ensured, the plugin warns or blocks transparently instead of creating ambiguous behavior.
- Provider errors remain provider errors. The plugin surfaces warnings and blocked states so the user can distinguish configuration/runtime issues from provider responses.

## Image results

Image files are extracted from OpenAI Responses native history, specifically preserved provider-native `image_generation` results. The plugin does not place base64 image payloads into text conversation context.

Saved image directory order:

1. `compat.openaiProviderTools.outputDirectory`, when configured.
2. Runtime session artifact directory, when available.
3. Agent default image directory.

When an image is saved, the plugin sends a visible custom message with the saved path. The message is delivered as next-turn context, so the agent can read the path on a later turn instead of receiving an opaque base64 payload. If saving fails, the failure is logged and reported visibly when the runtime supports visible messages.

## Provider tool result echoes

Provider-native tools do not pass through the host-side tool renderer. To keep the user from seeing a silent provider-side action, the plugin emits visible custom messages for displayable provider results preserved in OpenAI Responses native history.

Currently, `web_search_call` history is summarized with the provider action, query, citations, and sources when available. Image generation is echoed through the saved-image message described above.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No provider-native tools appear | For official OpenAI, confirm the selected model is an OpenAI Responses model on provider `openai` or host `api.openai.com`. For custom providers, confirm runtime model metadata contains `compat.openaiProviderTools.enabled: true`. For image generation, also confirm the selected model has `compat.openaiProviderTools.imageGeneration: true`. |
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
| Official OpenAI dry run | Use an official OpenAI Responses runtime provider; confirm provider-native `web_search` is injected from model/provider metadata and `tool_choice` is absent. |
| Compatible provider dry run | Use a test runtime provider with `compat.openaiProviderTools.enabled: true`; confirm provider-native `web_search` is injected only when the metadata is present. |
| Provider-native `web_search` live e2e | Send a real request that allows provider-native search; confirm the Responses request carries `web_search` and the provider returns native search call history or a provider-side error transparently. |
| Provider-native `image_generation` live e2e | Send a real request that allows provider-native image generation; confirm the Responses request carries `image_generation` and the provider returns native image generation call history or a provider-side error transparently. |
| Image file saved live e2e | After a provider-native image generation response, confirm the visible custom message reports the saved image path and the file exists in the configured output, session artifact, or agent default image directory. |
| Targeted tests | Run `bun test test/package-manifest.test.ts`. |
| Package dry run | Run `bun pm pack --dry-run`. |