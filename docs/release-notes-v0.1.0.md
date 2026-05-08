# v0.1.0

`omp-openai-provider-tools` 首个 npm 发布版本。

## 主要功能

- 为 OMP / Pi-family runtime 提供 OpenAI Responses provider-native `web_search` 注入。
- 支持按模型元数据启用 provider-native `image_generation`。
- 使用 `compat.openaiProviderTools` 作为配置入口，避免独立插件配置文件漂移。
- 在 provider-native 工具结果可用时发送可见回显：
  - `web_search` 回显对 Agent 上下文不可见，仅用于 UI 提示；
  - `image_generation` 回显保存图片、显示图片预览，并把图片附件加入后续模型上下文。
- 支持 `image_generation` 结果同步保存、合法 replay 规范化，以及可选 stream interruption。
- 提供 OMP 与 Pi 双 manifest：`omp.extensions` 和 `pi.extensions`。

## 发布验证

- `bun test`：93 pass，0 fail。
- `bun pm pack --dry-run`：14 个文件，未包含内部计划或发布文档。
- `npm pack --dry-run --json`：14 个文件，发布内容仅包含 `package.json`、`README.md`、`docs/runtime-compatibility.md` 和 `src/*.ts`。
- `omp plugin doctor`：4 ok，0 warnings，0 errors。

## npm

- Package: `omp-openai-provider-tools`
- Version: `0.1.0`
