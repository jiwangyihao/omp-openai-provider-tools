# OpenAI Provider Tools 插件设计

**日期：** 2026-05-07

## 背景

Oh My Pi (OMP) 是从 Pi / pi-mono 分叉并定制而来的 runtime。两者同源，但不是继承关系：包作用域、配置目录、插件安装机制、TypeScript 加载方式和部分扩展 API 都可能分叉。

本插件面向 Pi-family runtime，目标是在 OMP 与原版 Pi 中为 OpenAI Responses API 的 provider-native tools 提供一致的用户级扩展能力。插件不针对某个中转站，不硬编码 `sub2api`、`baseUrl` 或私有 provider 名。用户可以显式配置 OpenAI 官方 provider，也可以配置实际兼容 OpenAI Responses provider-native tools 的 OpenAI-compatible provider。

## 目标

构建一个名为 `omp-openai-provider-tools` 的独立 npm 包，用于在主模型请求中注入 OpenAI Responses provider-native tools：

- `web_search`
- `image_generation`

插件只负责请求注入、冲突工具移除、image result 保存和可见消息回填。provider tool 的真实执行发生在模型 provider 侧，因此它能共享主请求上下文，包括当前对话文本和已进入主请求的图片输入。

## 非目标

- 不改 OMP 或 Pi 安装缓存。
- 不 fork OMP 或 Pi。
- 不向 OMP 或 Pi 提 PR。
- 不内置任何具体 OpenAI-compatible provider 的名称、域名或凭据。
- 不引入额外搜索或生图服务。
- 不把 image base64 写入后续文本上下文。

## Runtime 支持边界

### OMP

OMP 是首要验证目标。插件通过 `package.json` 的 `omp.extensions` 暴露 extension entry：

```json
{
  "omp": {
    "extensions": ["./src/extension.ts"]
  }
}
```

安装方式：

```bash
omp plugin install omp-openai-provider-tools
```

也支持本地开发链接：

```bash
omp plugin link /path/to/omp-openai-provider-tools
```

OMP 配置文件：

```text
~/.omp/agent/openai-provider-tools.yml
.omp/openai-provider-tools.yml
```

### 原版 Pi

Pi 是正式兼容目标，但必须通过兼容探测确认当前 Pi 版本提供插件所需能力。插件通过 `package.json` 的 `pi.extensions` 暴露同一 entry：

```json
{
  "pi": {
    "extensions": ["./src/extension.ts"]
  }
}
```

安装方式：

```bash
pi install npm:omp-openai-provider-tools
pi -e npm:omp-openai-provider-tools
```

Pi 配置文件：

```text
~/.pi/agent/openai-provider-tools.yml
.pi/openai-provider-tools.yml
```

Pi 包发现需要在 `package.json` 中加入：

```json
{
  "keywords": ["pi-package"]
}
```

### 必需 runtime 能力

插件在任一 runtime 中启用完整功能前，必须确认以下能力存在：

1. `before_provider_request` 事件能观察 OpenAI Responses 请求 payload，并允许同步原地修改 payload。
2. `before_agent_start` 或等价事件能在发送请求前调整 active tools，并能让本轮 system prompt 使用更新后的工具列表。
3. active tools API 能读取当前工具列表并按工具名设置新列表。实现必须兼容两种 shape：
   - OMP：`string[]`
   - Pi：`{ name: string }[]` 或等价 tool object 数组
4. `agent_end` 或等价事件能读取 assistant message。
5. image result 保存功能需要 runtime 暴露 OpenAI Responses native history。支持的 message payload 结构为：

```ts
{
  providerPayload: {
    type: "openaiResponsesHistory",
    items: Array<Record<string, unknown>>
  }
}
```

如果当前 runtime 缺少第 5 项，插件仍可执行 provider tool 注入，但不得宣称 image result 自动保存已启用。插件必须记录 warning，说明当前 runtime/version 未暴露可解析的 OpenAI Responses native history。

## 配置模型

插件默认不对任何 provider 注入 tools。用户必须显式配置匹配规则。

### 配置文件合并

每次读取配置时分别尝试加载用户级和项目级文件：

- OMP：`~/.omp/agent/openai-provider-tools.yml` 与 `.omp/openai-provider-tools.yml`
- Pi：`~/.pi/agent/openai-provider-tools.yml` 与 `.pi/openai-provider-tools.yml`

合并规则：

1. 两个文件都不存在：不启用任何 provider tools，并记录 debug。
2. 某个文件 YAML 语法错误：记录 warning，忽略该文件，继续处理另一个文件。
3. `providers` 合并顺序为：项目级配置在前，用户级配置在后。
4. 第一条匹配的 provider entry 生效，不做多 entry 合并。
5. 项目级配置因此可以覆盖用户级默认配置。

### 配置 schema

配置必须使用 `version: 1`：

```yaml
version: 1
providers:
  - name: official-openai
    match:
      api: openai-responses
      provider: openai
      baseUrl:
        host: api.openai.com
    tools:
      web_search:
        enabled: true
        search_context_size: high
      image_generation:
        enabled: true
        output_format: png
    output:
      directory: ~/.omp/agent/provider-tool-images

  - name: private-openai-compatible-gateway
    match:
      api: openai-responses
      provider: my-openai-compatible-provider
      baseUrl:
        prefix: https://gateway.example.com/v1
    tools:
      web_search:
        enabled: true
      image_generation:
        enabled: true
        output_format: png
```

字段规则：

- `version`：必填，目前只接受 `1`。
- `providers`：必填数组。
- `providers[].name`：必填，仅用于日志和错误消息。
- `providers[].match.api`：必填，必须为 `openai-responses`。
- `providers[].match.provider`：可选，匹配 runtime model provider 名。
- `providers[].match.modelId`：可选，精确匹配 request payload 的 `model` 或 runtime model id。
- `providers[].match.modelName`：可选，精确匹配 runtime model name。
- `providers[].match.baseUrl`：可选对象，只允许以下一种模式：
  - `equals`：规范化后完整 URL 相等。
  - `prefix`：规范化后 URL 以前缀开头。
  - `host`：URL host 相等。
- `providers[].tools.web_search.enabled`：只有显式 `true` 才启用。
- `providers[].tools.image_generation.enabled`：只有显式 `true` 才启用。
- tool 未出现、`enabled` 缺失或 `enabled: false` 都表示不启用该 tool。
- `providers[].output.directory`：可选，配置 image 文件保存目录。支持 `~` 展开。未配置时使用 runtime session artifact 目录；没有 artifact 目录时使用用户级 agent 目录下的 `provider-tool-images/`。

未知字段处理：

- `match` 或 `tools.*` 中出现未知字段：该 provider entry 无效，记录 warning，并跳过该 entry。
- 单个 tool 参数非法：该 tool 无效，记录 warning；同一 entry 中其他有效 tool 仍可启用。

### 匹配算法

匹配对象由请求 payload 和 runtime model 共同构造：

- `api`：由当前 provider request hook 所在 provider 类型推断；插件只处理 OpenAI Responses payload。
- `modelId`：优先使用 request payload 的 `model` 字段。
- `provider`、`baseUrl`、`modelName`：来自 runtime context 的 model snapshot。

为了避免模型切换或 queued message 导致误注入，插件必须执行请求级一致性检查：

- 如果 hook event 提供 request-scoped model，优先使用 event model。
- 如果 hook event 不提供 request-scoped model，只能在 `payload.model` 与 `ctx.model.id` 或 `ctx.model.name` 一致时使用 `ctx.model` 的 provider/baseUrl/modelName。
- 如果无法确认 payload 与 context model 属于同一请求，插件必须跳过注入并记录 debug。

匹配规则：

- entry 中声明的所有 `match` 字段必须同时匹配。
- `provider` 和 `baseUrl.host` 按小写比较。
- `modelId` 和 `modelName` 按精确字符串比较。
- URL 比较前去除尾部 `/`。
- 不支持隐式 substring 匹配。

## 请求注入

插件监听 `before_provider_request`。当前请求匹配配置时，插件同步原地修改 payload。

OpenAI Responses payload 判定规则：

- payload 是 object。
- `payload.model` 是非空 string。
- payload 包含 `input` 字段。
- payload 不包含 Chat Completions 的 `messages` 字段。

注入规则：

- `payload.tools` 缺失：创建空数组并追加配置启用的 provider tools。
- `payload.tools` 是数组：追加配置启用且尚不存在的 provider tools。
- `payload.tools` 存在但不是数组：记录 warning，不修改 payload。
- payload 无法判定为 OpenAI Responses：不修改 payload。
- 不覆盖已有 tools。
- 不重复追加同类型 provider tool。
- 不设置 `tool_choice`。

`web_search` 注入示例：

```json
{
  "type": "web_search",
  "search_context_size": "high"
}
```

`image_generation` 注入示例：

```json
{
  "type": "image_generation",
  "output_format": "png"
}
```

允许的 `web_search` 参数：

- `search_context_size`: `low` / `medium` / `high`

允许的 `image_generation` 参数：

- `output_format`: `png` / `jpeg` / `webp`
- `quality`: `low` / `medium` / `high` / `auto`
- `size`: string
- `background`: `transparent` / `opaque` / `auto`
- `action`: `auto` / `generate` / `edit`

默认不设置 `action`，由 provider 根据主请求上下文决定生成或编辑。

## 本地工具冲突处理

host-side tools 的移除必须与 provider-native 注入能力绑定，不能只因为配置匹配就无条件移除。

移除前置条件：

1. 当前 turn 的目标模型匹配配置。
2. runtime 兼容探测已确认该模型路径会产生可修改的 OpenAI Responses payload。
3. 插件能在 `before_agent_start` 记录一个本轮 provider tools 预期状态，并在 `before_provider_request` 验证同一请求确实完成注入。

满足前置条件时，插件在 `session_start` 和 `before_agent_start` 检查 active tools，并移除会与 provider-native 能力混淆的 host-side tools：

- `web_search`
- `generate_image`

目的：模型上下文中只出现一种搜索/生图语义，即 provider-native tools。未匹配配置的模型不改变 active tools。

实现必须把 OMP 与 Pi 的 active tools shape 归一化为工具名集合，再调用 runtime 提供的设置 API。设置失败时记录 warning，并不得继续假设 host-side tools 已移除。

如果本轮已经移除 host-side tools，但随后 `before_provider_request` 发现 payload 无法注入 provider-native tools，插件必须阻止该请求继续以错误语义执行：优先调用 runtime 提供的 abort/block 能力；如果当前 runtime 不允许阻止 provider request，则发送可见 warning，恢复后续 turn 的 active tools，并把该 runtime/provider 组合标为当前会话不兼容。

如果移除 active tools 后 runtime 重建了 system prompt，插件在 `before_agent_start` 返回最新 system prompt，避免本轮请求仍携带旧工具描述。

## Image result 处理

provider-native `image_generation` 不会表现为 runtime 本地 tool result。插件在 `agent_end` 后读取 assistant message 的 provider history：

```ts
assistant.providerPayload.type === "openaiResponsesHistory"
Array.isArray(assistant.providerPayload.items)
```

查找：

```ts
item.type === "image_generation_call"
typeof item.result === "string"
```

支持字段：

- `id`
- `result`
- `revised_prompt`
- `output_format`
- `size`
- `quality`

处理流程：

1. 去除可选 data URI 前缀。
2. base64 解码为图片 bytes。
3. 根据 `output_format` 或 MIME type 判断扩展名。
4. 使用图片 bytes 的 SHA-256 前缀生成稳定文件名。
5. 保存到配置的 `output.directory`；未配置时保存到 session artifact 目录；仍没有 artifact 目录时保存到用户级 agent 目录的 `provider-tool-images/`。
6. 发送可见 custom message，内容包含：
   - 图片路径
   - MIME type
   - bytes
   - size / quality / output_format
   - revised prompt

custom message 不包含 base64。保存图片只服务于用户访问和审计，不替代 provider-native history。

### 去重语义

去重作用域是当前 session 内的插件进程。

去重 key：

1. 如果 `image_generation_call.id` 存在，使用 `runtimeSessionId + id`。
2. 如果没有 id，使用 `runtimeSessionId + sha256(imageBytes)`。

同一 key 已处理过时：

- 不重复发送 custom message。
- 如果文件已存在，复用已有文件路径。

同一图片 bytes 但不同 provider id 视为不同 provider 输出，可以再次发送 custom message。

## 错误处理

- 配置缺失：记录 debug，不影响会话。
- 配置语法或结构错误：记录 warning，不注入 tools。
- 当前 runtime 缺少必要事件或 payload 行为：记录 warning，说明当前 runtime/version 不满足插件要求。
- provider 拒绝某个 tool：保留 provider/runtime 原始错误语义。
- active tools 设置失败：记录 warning，不修改 provider payload。
- image result 解析失败：记录 warning，并发送可见消息说明图片结果未保存。
- image result 保存失败：记录 warning，并发送可见消息说明保存失败的真实原因。

## 包依赖策略

OMP 与 Pi 使用不同 package scope：

- OMP：`@oh-my-pi/*`
- Pi：`@mariozechner/*`

插件运行时不能强绑定其中一个 scope。实现要求：

- extension factory 只依赖 runtime 传入的 `pi` 对象。
- 内部定义最小 TypeScript shape，避免运行时 import OMP/Pi core 包。
- npm 包不得在 `dependencies` 中声明 `@oh-my-pi/*` 或 `@mariozechner/*`。
- 如果需要类型包，只能放入 `devDependencies`，或作为 optional peer dependency 并设置 `peerDependenciesMeta.optional = true`。
- 构建产物不得包含对 OMP/Pi core 包的运行时 import。
- 测试使用 fake `ExtensionAPI` 和 fake event context。
- YAML 解析器作为普通 runtime dependency 打包。

## 测试策略

### 实现前兼容探测

进入 TDD 实现前，必须先固化 OMP 与 Pi 的最小 runtime shape：

- extension factory 形状。
- `before_provider_request` 事件 payload。
- request-scoped model 是否存在。
- active tools 读取与设置 API。
- `before_agent_start` 返回 system prompt 的语义。
- `agent_end` assistant message 结构。
- OpenAI Responses native history 是否保存为 `providerPayload.items`。
- session artifact 目录 API。
- custom message / visible notification API。

探测结果写入 README 或测试 fixture 注释。若 Pi 当前版本缺少 image history 能力，Pi 的 image result 自动保存必须标为不适用于该版本。

### 单元测试

覆盖：

- 配置解析。
- OMP 配置路径解析。
- Pi 配置路径解析。
- 用户级与项目级配置合并。
- 官方 OpenAI provider 匹配。
- OpenAI-compatible provider 匹配。
- 第一条匹配规则生效。
- request payload 与 context model 不一致时不注入。
- 不匹配模型时不注入、不移除 tools。
- 注入资格未通过时不移除 host-side tools。
- `web_search` 注入不重复。
- `image_generation` 注入不重复。
- `payload.tools` 缺失、数组、非数组三种行为。
- 不设置 `tool_choice`。
- host-side tools 已移除但 provider payload 注入失败时触发 abort/block 或可见 warning。
- OMP string[] active tools shape。
- Pi tool object[] active tools shape。
- `image_generation_call.result` 提取。
- data URI 前缀处理。
- 图片保存路径和去重。
- custom message 构造。
- 错误消息不伪装成功。

### Extension 事件测试

使用 fake API 覆盖：

- `session_start`
- `before_agent_start`
- `before_provider_request`
- `agent_end`

### Runtime 兼容验证

手动验证矩阵：

| Runtime | 安装方式 | Provider 类型 | 验证模式 | 验证内容 |
| --- | --- | --- | --- | --- |
| OMP | `omp plugin link` | 官方 OpenAI | dry-run / payload inspection | extension 加载、工具注入、`tool_choice` 未设置、host-side tools 移除 |
| OMP | `omp plugin link` | OpenAI-compatible | dry-run / payload inspection | 配置匹配、工具注入、错误透明 |
| OMP | `omp plugin install` | 官方 OpenAI 或 OpenAI-compatible | package install | npm 包安装路径、manifest 加载、配置路径 |
| OMP | 手动启用真实 provider | 用户选择 | live e2e | provider 返回 `web_search_call` 或 `image_generation_call`，图片保存成功 |
| Pi | `pi -e` | 官方 OpenAI | dry-run / payload inspection | 临时加载、事件兼容、工具注入 |
| Pi | `pi -e` | OpenAI-compatible | dry-run / payload inspection | 配置匹配、事件兼容 |
| Pi | `pi install` | 官方 OpenAI 或 OpenAI-compatible | package install | package install、`pi.extensions` 加载、配置路径 |
| Pi | 手动启用真实 provider | 用户选择 | live e2e | provider native item 和 image history 能力验证 |

真实 provider e2e 不进入默认测试，避免消耗用户额度。README 提供手动验证命令、预期事件形状，并明确哪些步骤会调用真实 provider。

## 发布验收

发布前必须检查 npm tarball：

- `package.json` 包含 `omp.extensions`。
- `package.json` 包含 `pi.extensions`。
- `keywords` 包含 `pi-package`。
- Runtime dependency 只包含真正运行所需的第三方库，例如 YAML 解析器。
- 不把 OMP/Pi core 包放入 `dependencies`。
- `files` 或默认 npm 发布内容包含：
  - `src/`
  - `README.md`
  - `docs/` 中必要的设计或配置说明
  - `package.json`
- `npm pack --dry-run` 或等价命令显示上述文件均会发布。

## 文档要求

README 必须包含：

- 项目定位：OpenAI Responses provider-native tools package for Pi-family runtimes。
- OMP 安装方式。
- Pi 安装方式。
- 官方 OpenAI 配置示例。
- OpenAI-compatible provider 配置示例。
- 配置路径说明。
- 支持的 tool 参数。
- Runtime 兼容要求。
- dry-run / payload inspection 验证步骤。
- live e2e 手动验证步骤，并标明会调用真实 provider。
- 常见错误排查。

## 成功标准

- 用户可以不改 OMP/Pi 源码，通过安装插件启用 provider-native `web_search`。
- 用户可以配置官方 OpenAI provider 或 OpenAI-compatible provider。
- 模型上下文中不会同时暴露 host-side 搜索/生图工具和 provider-native tools。
- provider 返回 `image_generation_call.result` 且 runtime 暴露 native history 时，插件能保存图片并回填可见消息。
- provider 或 runtime 不兼容时，用户能看到真实错误或 warning。
- npm 包同时提供 `omp.extensions` 与 `pi.extensions` entry。
- npm tarball 包含运行和文档所需文件。
- OMP 与 Pi 的兼容差异在 README 中明确说明。
