# OpenAI Provider Tools 实现计划

> **执行约束：** 按用户要求直接在当前主分支开发，不创建 worktree。实现阶段必须使用子代理执行开发与审查；每个新启动子代理的提示词必须包含本计划路径、规格路径和必要文件路径，且提示词不少于 2000 字。每个实现任务完成后必须并发启动 3-5 个只读 review 子代理，按审查-修改循环处理，直到该任务通过后再进入下一任务。

**规格来源：** `docs/superpowers/specs/2026-05-07-openai-provider-tools-design.md`

**目标：** 将当前探索原型改造成 Pi-family runtime 的 OpenAI Responses provider-native tools 插件：用户通过配置显式启用 OpenAI 官方或 OpenAI-compatible provider 的 `web_search` 与 `image_generation`；插件在 `before_provider_request` 原地注入 Responses provider-native tools；匹配模型移除 host-side `web_search` / `generate_image` 以避免语义冲突；`image_generation_call.result` 保存为文件并发送可见 custom message；不修改 OMP/Pi 源码或缓存、不 fork、不 PR、不硬编码任何 provider。

**总体架构：**

- `src/types.ts`：内部最小 runtime/config 类型，不运行时绑定 `@oh-my-pi/*` 或 `@mariozechner/*`。
- `src/config.ts`：读取 `.omp/.pi` 用户级与项目级 YAML 配置，验证 `version: 1` schema，项目级 providers 优先。
- `src/match.ts`：基于当前 request payload 与 runtime model 构造 `RequestTarget`，执行 provider entry 第一条匹配。
- `src/request-injection.ts`：判定 OpenAI Responses payload，追加 `web_search` / `image_generation` tools，不覆盖已有 tool，不设置 `tool_choice`。
- `src/active-tools.ts`：归一化 OMP `string[]` 与 Pi `{ name: string }[]` active tools，只在注入资格成立时移除 host-side tools。
- `src/image-results.ts`：从 `providerPayload.type === "openaiResponsesHistory"` 的 `items` 提取 image results，按配置目录 → session artifact → agent 默认图片目录保存，去重并发送可见消息。
- `src/extension.ts`：extension wiring，缓存配置，注册 hooks，维护本轮注入预期状态，注入失败时 abort/block 或 visible warning，并标记 runtime/provider 组合为当前会话不兼容。

**顺序依赖：** 任务 0 先固化 runtime 能力边界；任务 1-2 建立类型与配置；任务 3 建立匹配和注入；任务 4 才能安全重写 extension；任务 5 接入图片结果；任务 6 完成 README 与发布验收。除同一任务内部 review 外，不并行跨任务实现，因为后续任务直接依赖前序 API。

---
## 任务 0：Runtime 兼容能力探测记录

**范围：** `docs/runtime-compatibility.md`、`README.md`（任务 6 补引用）、`test/fixtures/runtime-shapes.ts`

- [ ] 只读探测当前可用 OMP/Pi-family runtime 能力，不修改用户配置，不调用真实 provider。必须记录以下能力的观测来源：extension factory 形状、`before_provider_request` event 的 `payload` 可原地 mutation、request-scoped model/context 来源、active tools get/set API、system prompt 返回语义、`agent_end` message shape、session artifact directory API、visible/custom message API、OpenAI Responses native history 是否以 `providerPayload.type === "openaiResponsesHistory"` 与 `providerPayload.items[]` 出现。
- [ ] 创建 `test/fixtures/runtime-shapes.ts`，导出只读 fixture 常量，包含 OMP 14.7.3 已观测能力与 Pi 兼容要求。fixture 不能包含 API key、真实 provider host 或用户配置内容。
- [ ] 创建 `docs/runtime-compatibility.md`，用可审查的表格记录 OMP 与 Pi 的能力门槛：能力名、是否已观测、证据路径或文档路径、插件行为。若 Pi 当前无法观测某能力，记录为“需要 runtime capability gate”，并要求插件在运行时发送 visible warning，而不是静默假定兼容。
- [ ] 更新后续计划执行时的实现约束：extension runtime detection 必须使用 fixture 中的能力名或明确的 API/capability 信号；未知 runtime 不得默认只读 OMP 配置并忽略 Pi 配置。
- [ ] 启动 3 个只读 review 子代理审查 runtime 能力记录是否足以支撑后续实现。
- [ ] 提交：`docs(兼容): 记录 provider tools runtime 能力边界`

---

## 任务 1：包元数据和 runtime 类型边界

**范围：** `package.json`、`tsconfig.json`、`src/types.ts`、`test/package-manifest.test.ts`

- [ ] 编写失败测试 `test/package-manifest.test.ts`，断言：
  - `packageJson.omp.extensions` 等于 `["./src/extension.ts"]`。
  - `packageJson.pi.extensions` 等于 `["./src/extension.ts"]`。
  - `keywords` 包含 `pi-package`。
  - `files` 包含 `src`、`README.md`、`docs`。
  - `dependencies` 与 `peerDependencies` 不包含 `@oh-my-pi/pi-coding-agent`、`@mariozechner/pi-coding-agent` 或其他 runtime core 包。

测试骨架：

```ts
import { describe, expect, it } from "bun:test";
import packageJson from "../package.json";

describe("package manifest", () => {
	it("declares both OMP and Pi extension entry points", () => {
		expect(packageJson.omp).toEqual({ extensions: ["./src/extension.ts"] });
		expect(packageJson.pi).toEqual({ extensions: ["./src/extension.ts"] });
	});

	it("is discoverable as a Pi package and publishes runtime files", () => {
		expect(packageJson.keywords).toContain("pi-package");
		expect(packageJson.files).toEqual(expect.arrayContaining(["src", "README.md", "docs"]));
	});

	it("does not depend on OMP or Pi runtime packages", () => {
		for (const deps of [packageJson.dependencies ?? {}, packageJson.peerDependencies ?? {}]) {
			expect(deps).not.toHaveProperty("@oh-my-pi/pi-coding-agent");
			expect(deps).not.toHaveProperty("@mariozechner/pi-coding-agent");
		}
	});
});
```

- [ ] 运行 `bun test test/package-manifest.test.ts`，确认当前原型失败。
- [ ] 更新 `package.json`：
  - `description`: `Provider-native OpenAI Responses tools for OMP and Pi-family runtimes.`
  - `keywords`: 包含 `oh-my-pi`、`pi-package`、`omp`、`pi`、`extension`、`openai`、`responses`、`provider-tools`。
  - `dependencies`: 只添加普通 runtime dependency `yaml`。
  - 移除 `peerDependencies` 中的 OMP/Pi runtime 包。
  - 同时声明：

```json
"omp": { "extensions": ["./src/extension.ts"] },
"pi": { "extensions": ["./src/extension.ts"] },
"files": ["src", "README.md", "docs"]
```

- [ ] 创建 `src/types.ts`，定义最小 runtime shape 和配置类型。必须包含：
  - `LoggerLike`
  - `RuntimeModelLike`
  - `ExtensionContextLike`
  - `ExtensionApiLike`
  - `RuntimeActiveTool`
  - `BaseUrlMatch`
  - `WebSearchToolConfig`
  - `ImageGenerationToolConfig`
  - `ProviderToolsEntry`
  - `ProviderToolsConfig`

关键约束：`ExtensionApiLike` 和 `ExtensionContextLike` 只能描述插件实际使用字段，不能从 OMP/Pi 包 import 类型。

- [ ] 运行 `bun test test/package-manifest.test.ts`，确认通过。
- [ ] 启动 3 个只读 review 子代理审查本任务修改：manifest 兼容性、runtime 类型边界、发布文件范围。
- [ ] 根据 review 修改，直到通过。
- [ ] 提交：`feat(插件): 定义包元数据和运行时类型边界`

---

## 任务 2：配置加载、schema 验证和配置合并

**范围：** `src/config.ts`、`src/types.ts`、`test/config.test.ts`

- [ ] 编写失败测试 `test/config.test.ts`，覆盖：
  - `version: 1` 有效配置通过。
  - 默认不注入：没有 `enabled: true` 的 tool 在后续注入层不应启用；配置层只保留显式字段。
  - `providers` 必须数组。
  - provider 必须有 `name`、`match.api: openai-responses`、`tools`。
  - unknown top-level/provider/match/tool fields 产生 warning 且 validation failed。
  - `baseUrl` 只能是 `{ equals }`、`{ prefix }`、`{ host }` 三选一。
  - `web_search.search_context_size` 只能是 `low|medium|high`。
  - `image_generation.output_format` 只能是 `png|jpeg|webp`。
  - `image_generation.quality` 只能是 `low|medium|high|auto`。
  - `image_generation.background` 只能是 `transparent|opaque|auto`。
  - `image_generation.action` 只能是 `auto|generate|edit`。
  - OMP 配置路径：用户级 `~/.omp/agent/openai-provider-tools.yml`，项目级 `.omp/openai-provider-tools.yml`。
  - Pi 配置路径：用户级 `~/.pi/agent/openai-provider-tools.yml`，项目级 `.pi/openai-provider-tools.yml`。
  - 合并顺序：项目级 providers 在用户级 providers 前面，第一条匹配生效。
  - `output.directory` 支持 `~` 展开。
  - `detectRuntimeKind(api, ctx)` 能识别显式 runtime/capability metadata；无法识别时返回 `unknown`。
  - `loadAvailableProviderToolsConfig({ cwd, homeDir, runtime })` 在 `runtime: "unknown"` 时读取所有存在的 `.omp` 与 `.pi` 配置，项目级文件整体优先于用户级文件，并返回 warning 说明 runtime 未明确识别。
  - extension 场景下只有 Pi 用户级或项目级配置存在时，不能因为默认 OMP 分支而忽略 Pi 配置。

核心测试形态：

```ts
const loaded = await loadProviderToolsConfig({ cwd, homeDir, runtime: "omp" });
expect(loaded.config.providers.map(provider => provider.name)).toEqual(["project", "user"]);

const detected = detectRuntimeKind({ runtime: { name: "pi" } }, {});
expect(detected).toBe("pi");

const unknown = await loadAvailableProviderToolsConfig({ cwd, homeDir, runtime: "unknown" });
expect(unknown.config.providers.map(provider => provider.name)).toEqual(["pi-project", "omp-project", "pi-user", "omp-user"]);
expect(unknown.warnings.join("\n")).toContain("runtime");
```

- [ ] 运行 `bun test test/config.test.ts`，确认失败。
- [ ] 实现 `src/config.ts`：
  - 导出 `RuntimeKind = "omp" | "pi" | "unknown"`。
  - 导出 `getConfigPaths({ cwd, homeDir, runtime })`；`runtime` 为 `omp` 或 `pi` 时只返回对应路径。
  - 导出 `detectRuntimeKind(api, ctx)`；优先使用 runtime/capability metadata，不能识别时返回 `unknown`，不能猜成 OMP。
  - 导出 `expandHome(input, homeDir)`。
  - 导出 `validateProviderToolsConfig(input)`，返回 `{ ok, config?, warnings }`。
  - 导出 `loadProviderToolsConfig({ cwd, homeDir, runtime })`，返回 `{ config, warnings, paths }`。
  - 导出 `loadAvailableProviderToolsConfig({ cwd, homeDir, runtime })`；`runtime: "unknown"` 时按项目 Pi、项目 OMP、用户 Pi、用户 OMP 的确定顺序读取所有存在配置，并返回 visible/warning 文案供 extension 使用。
  - 对 YAML parse/read error：不存在文件静默跳过；存在但解析失败返回 warning，不 throw。
  - 对 invalid config：记录 warning，不采用该文件。
  - 合并结果始终是 `{ version: 1, providers: [...] }`。

- [ ] 更新 `src/types.ts`，补齐 config 类型字段：
  - provider entry `output?: { directory?: string }`。
  - tool config 的 optional 参数必须与规格一致。

- [ ] 运行 `bun test test/config.test.ts`，确认通过。
- [ ] 启动 4 个只读 review 子代理审查：schema 严格性、配置路径、合并优先级、错误透明。
- [ ] 根据 review 修改，直到通过。
- [ ] 提交：`feat(配置): 添加 provider tools 配置加载`

---

## 任务 3：Request target 匹配与 Responses tools 注入

**范围：** `src/match.ts`、`src/request-injection.ts`、`src/types.ts`、`test/match.test.ts`、`test/request-injection.test.ts`

- [ ] 编写失败测试 `test/match.test.ts`，覆盖：
  - OpenAI Responses payload 必须有 `model` 与 `input`，且不能是 Chat Completions `messages` payload。
  - `buildRequestTarget()` 使用 event model 优先；没有 event model 时用 `ctx.model`。
  - 没有 event model 时，`payload.model` 必须等于 `ctx.model.id` 或 `ctx.model.name`，否则返回 `undefined`。
  - provider 比较大小写不敏感。
  - `baseUrl.equals` 去尾 `/` 后比较。
  - `baseUrl.prefix` 去尾 `/` 后前缀比较。
  - `baseUrl.host` 使用 URL host 小写比较。
  - `modelId` 与 `modelName` 精确匹配。
  - 第一条 matching provider entry 生效。

- [ ] 编写失败测试 `test/request-injection.test.ts`，覆盖：
  - `isOpenAIResponsesPayload({ model, input }) === true`。
  - `isOpenAIResponsesPayload({ model, messages }) === false`。
  - `payload.tools` 缺失时创建数组。
  - `payload.tools` 是数组时追加缺失 provider tools。
  - `payload.tools` 非数组时返回 `{ ok:false }`，不 mutation。
  - 不重复已有 `{ type: "web_search" }` / `{ type: "image_generation" }`。
  - 不覆盖已有同类型 tool 的参数。
  - 不设置 `tool_choice`。
  - 只有 `enabled: true` 的 tool 会注入。
  - 注入结果必须区分 `ensured` 与 `added`：已有 provider-native tool 也计入 `ensured`，供 extension 验证本轮预期 provider tool 集合已满足。
  - `web_search` 参数只注入允许字段。
  - `image_generation` 参数只注入允许字段。

- [ ] 运行 `bun test test/match.test.ts test/request-injection.test.ts`，确认失败。
- [ ] 实现 `src/match.ts`：
  - 导出 `RequestTarget`。
  - 导出 `buildRequestTarget({ payload, contextModel, eventModel })`。
  - 导出 `findMatchingProvider(config, target)`。
  - 导出小函数 `normalizeBaseUrl()`、`baseUrlMatches()` 可直接测试或内部使用。

- [ ] 实现 `src/request-injection.ts`：
  - 导出 `InjectionResult`，形状为 `{ ok: true; ensured: ProviderToolType[]; added: ProviderToolType[] } | { ok: false; reason: string }`。
  - 导出 `getEnabledProviderToolTypes(entry)`，只返回 `enabled: true` 的 provider tool type。
  - 导出 `isOpenAIResponsesPayload(payload)`。
  - 导出 `injectConfiguredTools(payload, entry)`。
  - mutation 必须是原地 mutation，因为 OMP `openai-responses.ts` 只调用 `options?.onPayload?.(params)`，不等待返回值也不替换 payload。

- [ ] 运行 `bun test test/match.test.ts test/request-injection.test.ts`，确认通过。
- [ ] 启动 4 个只读 review 子代理审查：payload 判定、matching 一致性、tool 参数安全、无 `tool_choice`。
- [ ] 根据 review 修改，直到通过。
- [ ] 提交：`feat(注入): 添加请求匹配和 provider tools 注入`

---

## 任务 4：Active tools 冲突处理与 extension request flow

**范围：** `src/active-tools.ts`、`src/extension.ts`、`test/active-tools.test.ts`、`test/extension.test.ts`

- [ ] 编写失败测试 `test/active-tools.test.ts`，覆盖：
  - OMP `string[]` active tools 归一化。
  - Pi `{ name: string }[]` active tools 归一化。
  - malformed tool object 被忽略。
  - 根据 enabled provider tool 集合逐项移除 host-side 工具：`web_search` provider tool 对应 host-side `web_search`，`image_generation` provider tool 对应 host-side `generate_image`。
  - 无 enabled provider tool 时不移除任何 host-side tool。
  - 仅启用 `web_search` 时只移除 host-side `web_search`；仅启用 `image_generation` 时只移除 host-side `generate_image`；两者都启用时才移除两者。
  - 未包含目标 host-side 冲突工具时返回 `removed: false`。

- [ ] 重写 `test/extension.test.ts`，删除旧原型硬编码 `sub2api-openai` / `oai.jwyihao.top/v1` 测试。使用 fake extension API 与临时配置文件，覆盖：
  - extension 注册 `session_start`、`before_agent_start`、`before_provider_request`、`agent_end`。
  - 未配置时不移除 active tools，不注入。
  - 配置匹配且 request payload 可注入时，`before_provider_request` 注入 provider-native tools。
  - 配置匹配但 payload/model 不一致时，不注入。
  - 配置匹配但 `payload.tools` 非数组时，注入失败。
  - host-side tools 移除必须与逐项注入资格绑定：注入资格未通过时不移除；无 enabled provider tool 时不移除；只启用一个 provider tool 时只移除对应 host-side 工具。
  - before-agent 记录的 expected provider tool 集合必须与 before-provider 注入结果的 `ensured` 集合一致；不一致时视为注入失败。
  - 如果 before-agent 阶段已移除任一 host-side tool，但 before-provider 阶段注入失败，则优先调用 fake `ctx.abort()`；如果无 abort 能力，则发送 visible warning 并恢复后续 active tools。
  - 注入失败后，将该 runtime/provider/model 组合标记为当前会话不兼容，后续 turn 不再移除 host-side tools。
  - fake Pi runtime/capability metadata + 仅存在 `.pi` 用户级或项目级配置时，extension 能加载 Pi 配置并注入，不被 OMP 默认分支吞掉。
  - runtime unknown 且只存在 `.pi` 配置时，extension 读取 `.pi` 配置、发出 runtime 未识别 warning，并按 provider match 正常注入。

- [ ] 运行 `bun test test/active-tools.test.ts test/extension.test.ts`，确认失败。
- [ ] 实现 `src/active-tools.ts`：
  - `normalizeActiveToolNames(tools)`。
  - `enabledProviderToolsToHostTools(providerToolTypes)`，逐项映射 `web_search -> web_search`、`image_generation -> generate_image`。
  - `removeHostSideTools(toolNames, hostToolsToRemove)`，只移除传入集合。
  - `restoreHostSideTools(previousToolNames)` 如 extension 测试需要。

- [ ] 重写 `src/extension.ts`：
  - 默认 export function 接收 `ExtensionApiLike`。
  - 不从 OMP/Pi 包 import 类型。
  - `api.setLabel?.("OpenAI Provider Tools")`。
  - 使用 `detectRuntimeKind()` 与 `loadAvailableProviderToolsConfig()` 加载配置；runtime 明确时只加载该 runtime 配置，runtime unknown 时按任务 2 的确定顺序读取所有存在的 `.omp` 与 `.pi` 配置并发 warning，绝不能默认只读 OMP 配置而忽略 Pi 配置；实现必须不要求用户设置环境变量。
  - 维护 session state：loaded config、last intended entry、active tools snapshot、incompatible targets、processed image keys。
  - `before_agent_start`：只在当前 context model 能匹配配置、entry 至少有一个 `enabled: true` provider tool、runtime capability gate 确认可产生可修改 Responses payload、且该 target 未被标记不兼容时，按 enabled provider tool 集合逐项移除对应 host-side tools。首次未知时不得提前移除，除非实现能在同一 turn 严格恢复/abort。
  - `before_provider_request`：读取 `event.payload`，构造 target，匹配 entry，原地注入，记录 `ensured`/`added`；验证 `ensured` 覆盖 before-agent 的 expected provider tool 集合。
  - 注入失败或 expected/ensured 不一致：有 abort 能力则 abort；否则 warning + 恢复后续 active tools + 标记不兼容。

- [ ] 运行：

```bash
bun test test/active-tools.test.ts test/extension.test.ts test/config.test.ts test/match.test.ts test/request-injection.test.ts
```

- [ ] 启动 5 个只读 review 子代理审查：extension hook 时序、host-side tool 安全、runtime 兼容 gate、错误透明、旧硬编码移除。
- [ ] 根据 review 修改，直到通过。
- [ ] 提交：`feat(扩展): 接入 provider tools 注入流程`

---

## 任务 5：Image generation 结果保存与可见消息

**范围：** `src/image-results.ts`、`src/extension.ts`、`test/image-results.test.ts`、`test/extension.test.ts`

- [ ] 编写失败测试 `test/image-results.test.ts`，覆盖：
  - 只从 `message.providerPayload.type === "openaiResponsesHistory"` 且 `items[]` 中提取 `type === "image_generation_call"` 与 string `result`。
  - 支持 `data:image/png;base64,...` 和纯 base64。
  - 从 `output_format` 推断扩展名和 MIME。
  - SHA-256 命名；provider `id` 存在时去重 key 优先使用 id。
  - 保存目录优先级：`providers[].output.directory` → runtime session artifact dir → user agent `provider-tool-images/`。
  - 已存在同 hash 文件时不重复写入，返回 `reusedExisting: true`。
  - custom message `display: true`，包含文件路径、大小、revised prompt 摘要，不包含 base64。
  - invalid base64 或保存失败返回/抛出可由 extension 转成 visible error message。

- [ ] 扩展 `test/extension.test.ts`，覆盖：
  - `agent_end` 提取 image result 后调用 fake `sendMessage(message, { deliverAs: "nextTurn" })`。
  - 同一 session 同一 image result 不重复发送。
  - 配置了 `output.directory` 时优先保存到该目录。
  - 没有 session artifact 时保存到 agent 默认图片目录。
  - 保存失败时发送可见 error message，而非静默失败。

- [ ] 运行 `bun test test/image-results.test.ts test/extension.test.ts`，确认失败。
- [ ] 实现 `src/image-results.ts`：
  - `extractImageGenerationResults(message)`。
  - `decodeImageResult(result)`。
  - `imageResultKey(sessionId, result)`。
  - `saveImageResult(result, { outputDirectory, artifactDirectory, agentImageDirectory })`。
  - `buildImageMessage(result, saved)`。
  - `buildImageErrorMessage(result, error)`。

- [ ] 接入 `src/extension.ts` 的 `agent_end`：
  - 从 `event.messages` 或单条 message 中提取 results。
  - 使用 session id 或稳定派生 id 参与去重。
  - 使用当前匹配 provider entry 的 `output.directory`；如果无法定位 entry，则使用 artifact 目录或 agent 默认图片目录。
  - 调用 `api.sendMessage` 发送 visible custom message，不把 base64 放入上下文。

- [ ] 删除旧 `src/provider-tools.ts`，或改为纯 re-export：

```ts
export * from "./request-injection";
export * from "./image-results";
```

推荐删除并更新测试 import，确保仓库内不存在 `DEFAULT_TARGET_PROVIDER_NAMES`、`sub2api-openai`、`oai.jwyihao.top/v1` 硬编码。

- [ ] 运行：

```bash
bun test test/image-results.test.ts test/extension.test.ts
```

- [ ] 使用 `search` 检查硬编码残留：旧中转站名称/域名、旧默认 provider 常量、旧本地工具移除函数名不得出现在 `src`、`test`、`README.md` 或 `package.json` 中；只允许规格/计划作为历史禁止项提到旧名称。
- [ ] 启动 4 个只读 review 子代理审查：image extraction shape、保存路径优先级、去重、base64 不进入消息。
- [ ] 根据 review 修改，直到通过。
- [ ] 提交：`feat(图片): 保存 provider-native image generation 结果`

---

## 任务 6：README、发布验收和全量验证

**范围：** `README.md`、`package.json`、所有测试、打包输出

- [ ] 创建 `README.md`，必须包含：
  - 插件定位：Pi-family OpenAI Responses provider-native tools package。
  - OMP 安装：`omp plugin install npm:omp-openai-provider-tools`、`omp plugin link <path>`。
  - Pi 安装：`pi install npm:omp-openai-provider-tools`、`pi -e npm:omp-openai-provider-tools`。
  - OMP 配置路径：`~/.omp/agent/openai-provider-tools.yml`、项目 `.omp/openai-provider-tools.yml`。
  - Pi 配置路径：`~/.pi/agent/openai-provider-tools.yml`、项目 `.pi/openai-provider-tools.yml`。
  - 配置 schema 示例，分别展示 OpenAI 官方 provider 和 OpenAI-compatible provider。OpenAI-compatible 示例必须使用虚构 provider 名与保留示例域名（例如 `gateway.example.invalid`），禁止旧中转站名称、旧中转站域名、真实 provider 名、真实 host 或真实 key。
  - 明确：默认不注入；必须配置 `enabled: true`。
  - 明确：插件不读取、不保存 API key；凭据复用 runtime/model registry。
  - 明确：插件不设置 `tool_choice`。
  - 明确：匹配模型移除 host-side `web_search` / `generate_image` 是为了避免同名语义冲突，并与 provider-native 注入能力绑定。
  - 图片输出路径优先级：配置目录 → session artifact → agent 默认图片目录。
  - 错误透明：provider 原始错误向用户暴露；插件自身配置/保存错误用 visible warning/error message。
  - 手动验证矩阵：OMP package install/link、Pi package install/e flag、web_search native call、image_generation native call、OpenAI official、OpenAI-compatible。
  - 兼容能力记录：链接或摘录 `docs/runtime-compatibility.md`，说明 OMP 已观测能力、Pi runtime capability gate，以及 native history / artifact / custom message 能力不可用时的 visible warning 行为。
  - README 避免把本地替代执行路径写成卖点或限制；正面描述 provider-native execution 与错误透明。

- [ ] 更新 `test/package-manifest.test.ts`，确保 `README.md` 在 `files` 中。
- [ ] 运行全部测试：

```bash
bun test
```

- [ ] 运行打包 dry-run：

```bash
bun pm pack --dry-run
```

记录输出中的文件列表，必须只包含预期发布文件，不包含临时图片、调试日志、测试 key 或用户配置。

- [ ] 使用 `search` 执行最终静态检查：未完成标记、旧默认 provider 常量、旧中转站名称、旧中转站域名、真实密钥模式都不得出现在 `src`、`test`、`README.md` 或 `package.json` 中；README 示例若出现 compatible provider，必须使用虚构 provider 名和保留示例域名。

- [ ] 使用 `find`/`read` 检查仓库结构，确保没有生成图片或临时 artifacts 被纳入提交。
- [ ] 启动 5 个只读 review 子代理审查最终状态：README 安装配置、发布包、测试覆盖、隐私凭据、规格一致性。
- [ ] 根据 review 修改，直到通过。
- [ ] 最终提交：`docs: 添加插件使用与验证说明`
- [ ] 运行最终验证：

```bash
bun test
bun pm pack --dry-run
```

- [ ] 输出最终状态前检查：
  - `git status --short`
  - 所有实现和文档提交已完成，工作区只允许用户明确保留的未跟踪文件。
  - 若工作区仍有旧原型未跟踪文件，必须纳入、删除或说明阻塞原因。

---

## 子代理审查提示词模板

每个 review 子代理提示词必须包含至少以下内容，并按用户要求扩展到 2000 字以上：

```text
你是只读审查子代理。不要修改文件。当前仓库：C:/tmp/omp-openai-provider-tools。
规格文件：C:/tmp/omp-openai-provider-tools/docs/superpowers/specs/2026-05-07-openai-provider-tools-design.md。
实现计划：C:/tmp/omp-openai-provider-tools/docs/superpowers/plans/2026-05-07-openai-provider-tools-implementation.md。
本轮审查目标文件：<列出 1-5 个明确文件>。
请验证本轮修改是否满足规格与计划，尤其检查：<维度>。
必须返回 PASS 或 CHANGES_REQUESTED，并列出阻塞问题、证据文件与建议修复。只读，不运行项目级全量 build/test；可阅读相关文件和运行针对性测试命令。
```

## 实现子代理提示词模板

每个实现子代理提示词必须包含至少以下内容，并按用户要求扩展到 2000 字以上：

```text
你是实现子代理，直接在当前主分支工作，不创建 worktree。当前仓库：C:/tmp/omp-openai-provider-tools。
规格文件：C:/tmp/omp-openai-provider-tools/docs/superpowers/specs/2026-05-07-openai-provider-tools-design.md。
实现计划：C:/tmp/omp-openai-provider-tools/docs/superpowers/plans/2026-05-07-openai-provider-tools-implementation.md。
本轮任务：<任务名>。
目标文件：<最多 3-5 个明确文件>。
非目标：不要修改其他任务文件；不要触碰用户 OMP/Pi 配置；不要调用真实 provider；不要使用环境变量存储凭据；不要硬编码 sub2api 或任何 host。
TDD 步骤：先写失败测试，再实现，再运行本任务针对性测试。
验收：<列出测试命令和静态检查>。
```

## 完成标准

- 规格已通过子代理审查并已提交：`01873ed docs(设计): 完善 provider tools 插件规格`。
- 实现代码不含硬编码 `sub2api-openai`、`oai.jwyihao.top/v1` 或真实 API key。
- package 同时声明 `omp.extensions` 与 `pi.extensions`，并包含 `pi-package` keyword。
- runtime dependencies 不绑定 OMP/Pi package scope。
- 配置 schema、provider matching、Responses payload 注入、host-side tools 处理、image result 保存均有单元测试。
- `bun test` 通过。
- `bun pm pack --dry-run` 通过，输出包内容符合预期。
- README 说明 OMP/Pi 双 runtime 安装配置、错误透明、手动验证矩阵。

---

## 2026-05-08 追加计划：provider 结果回显、图片模型门控与图片子代理

**用户选择：** 实施推荐方案：provider-result echo、插件侧模型标记门控、`gpt-5.5` 图片变体，以及专用图片生成子代理。

**范围与边界：**

- 插件继续只通过 OpenAI Responses provider request path 注入 provider-native tools，不设置 `tool_choice`，不保存 API key，不硬编码 provider 名称、私有 base URL 或凭据。
- `web_search` 仍只受插件配置 `enabled: true` 与 provider match 控制。
- `image_generation` 必须同时满足插件配置 `enabled: true` 与当前 runtime model 显式 opt-in；这样同一 provider/gateway 下的非图片模型不会被误启用图片工具。
- 用户级 `gpt-5.5-image` 变体只添加模型元数据和等价映射，不复制或改写现有凭据。
- 专用图片子代理只作为 OMP agent markdown 定义，使用图片模型变体和最小 host tool 集；provider-native 图片能力仍由插件注入。

**实现步骤：**

1. 先写失败测试：覆盖未 opt-in 模型不注入 `image_generation`、已 opt-in 模型注入 `image_generation`、provider-native `web_search_call` 可见回显、`message_end` 与 `agent_end` 回显去重。
2. 在 `src/types.ts` 扩展最小 runtime model shape，支持 `headers`、`compat.extraBody`、`runtime.capabilities` 和 `capabilities`。
3. 在 `src/extension.ts` 增加模型 opt-in 判定与 per-model enabled tool 过滤；`before_agent_start` 和 `before_provider_request` 都使用过滤后的 provider tool 集合。
4. 新增 `src/provider-results.ts`：从 `providerPayload.type === "openaiResponsesHistory"` 中解析 displayable provider-native 结果，当前支持 `web_search_call` 与 URL citation/source 摘要；禁止把 base64 写入 custom message。
5. 在 `message_end` 与 `agent_end` 中发送 provider 结果 visible custom message，并按 session/result key 去重。
6. 更新 README 和 runtime compatibility 文档，说明图片模型 opt-in、provider 结果回显和图片保存路径的 next-turn 可见性。
7. 在用户模型配置中添加 `sub2api-openai/gpt-5.5-image` 变体，使用 `compat.extraBody.openai_provider_tools.image_generation: true` 标记图片能力。
8. 在用户 agent 目录添加 `image_generator` 子代理定义，绑定 `sub2api-openai/gpt-5.5-image`，仅启用最小 host tool。
9. 验证：运行 focused extension tests、全量 `bun test`、`bun pm pack --dry-run`、确认 no `.tgz` 残留、确认 OMP 能列出 `gpt-5.5-image` 模型变体。

**验收标准：**

- 非 opt-in 模型即使 provider config 启用 `image_generation` 也不会注入 provider-native 图片工具，也不会移除 host-side `generate_image`。
- opt-in 模型在相同 config 下会注入 `image_generation`，并继续保持不设置 `tool_choice`。
- provider-native `web_search_call` 至少回显 call/status/action/query/citations/sources 中可获得的信息，并对同一结果去重。
- 图片保存消息继续不包含 base64；保存路径作为 visible custom message 和 next-turn context 传递。
- `gpt-5.5-image` 可被 OMP 模型发现，`image_generator` agent 文件可被 OMP agent discovery 路径读取。
