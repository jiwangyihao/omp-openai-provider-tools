# omp-openai-provider-tools

`omp-openai-provider-tools` is a Pi-family extension package for OpenAI Responses provider-native `web_search` and `image_generation` tools. It is designed for OMP and Pi-family runtimes that expose compatible extension hooks and capability gates.

The extension is explicit opt-in. It does not inject provider-native tools by default; a matching provider entry must be configured, and each tool only activates when its `enabled` value is `true`.

This package does not store API keys, read provider credentials, or configure credential environment variables. Authentication remains owned by the runtime/provider configuration.

## Runtime support

The package declares both extension metadata entries:

- `omp.extensions`: `./src/extension.ts`
- `pi.extensions`: `./src/extension.ts`

Full behavior depends on runtime capability gates: mutable OpenAI Responses request hooks, request-scoped model metadata, safe host-tool conflict control, visible message delivery, and image artifact persistence or a writable fallback directory. See [runtime compatibility notes](./docs/runtime-compatibility.md) for the current boundary.

## Configuration files

OMP configuration paths:

- User: `~/.omp/agent/openai-provider-tools.yml`
- Project: `.omp/openai-provider-tools.yml`

Pi configuration paths:

- User: `~/.pi/agent/openai-provider-tools.yml`
- Project: `.pi/openai-provider-tools.yml`

Project-level provider entries take precedence over user-level entries. The first matching provider entry is used.

## Example configuration

```yaml
version: 1
providers:
  - name: official-openai
    match:
      api: openai-responses
      provider: openai
    tools:
      web_search:
        enabled: true
      image_generation:
        enabled: true
        output_format: png

  - name: compatible-example
    match:
      api: openai-responses
      provider: compatible-example
      baseUrl:
        prefix: https://gateway.example.invalid/v1
    tools:
      web_search:
        enabled: true
      image_generation:
        enabled: true
    output:
      directory: ./provider-tool-images
```

The `official-openai` entry shows the generic OpenAI provider name only; credentials still come from the runtime/provider registry. The `compatible-example` entry uses fictional host values for illustration.

## Image results

Generated images are saved as files rather than returned as base64 text context. The extension uses the configured output directory when present, then the runtime session artifact directory when available, and finally the agent default image directory. Base64 image payloads are not sent back into the conversation as text context.