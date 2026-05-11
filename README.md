# OMP OpenAI Provider Tools

[![npm version](https://img.shields.io/npm/v/omp-openai-provider-tools.svg)](https://www.npmjs.com/package/omp-openai-provider-tools)
[![npm downloads](https://img.shields.io/npm/dw/omp-openai-provider-tools.svg)](https://www.npmjs.com/package/omp-openai-provider-tools)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-blue.svg)](./LICENSE)

> **Latest in v0.1.3 | v0.1.3 最近更新**
>
> - Fixes long-running provider-native `image_generation` streams on OMP 14.9+ | 修复 OMP 14.9+ 中 provider-native `image_generation` 长时间生成的流式空闲误判
> - Adds request-scoped semantic keepalives without disabling global runtime timeout protection | 增加请求级语义 keepalive，不全局关闭运行时 timeout 保护
> - Keeps OpenAI SDK stream patching lazy so the extension loads without a direct `openai` runtime dependency | 保持 OpenAI SDK stream patch 惰性加载，扩展不需要直接运行时依赖 `openai`
> - Limits image-only custom provider opt-in to `image_generation`, avoiding accidental `web_search` injection | 自定义 provider 仅开启图像能力时只注入 `image_generation`，避免误注入 `web_search`

[中文](#中文) | [English](#english)

---

<a name="中文"></a>

## 中文

`omp-openai-provider-tools` 为 **OMP** 增加 OpenAI 风格的 **provider-executed tool** 支持，核心覆盖两类 OpenAI Responses 原生工具：

- `web_search`
- `image_generation`

插件会在 OMP 即将向 OpenAI Responses provider 发起请求时，把可用的 provider-native tools 注入到同一次模型请求中。工具由 provider 在模型请求内部执行，不再通过 OMP 本地工具另起一条代理链路来完成搜索或绘图。

项目地址：<https://github.com/jiwangyihao/omp-openai-provider-tools>

许可证：[MPL-2.0](./LICENSE)

## 为什么选择 provider-executed tools？

### `image_generation`：主 Agent 直接带上下文绘图

OMP 原生 `generate_image` 工具本质上会启动一个不共享完整上下文的新绘图会话。这个新会话能看到的信息主要来自工具调用参数，而工具调用参数能表达的信息是有限的：

- Agent 很难逐字复述自己当前已经看到的图像、附件、局部细节和任务背景。
- 输入图像的原始路径可能没有被准确传给绘图工具。
- 即使路径被传入，那个路径也可能只存在于当前设备或当前 runtime 环境里。
- 多轮编辑时，「上一轮图像 + 当前修改要求 + 主对话上下文」很容易在本地工具边界处丢失。

OpenAI 的 provider-executed `image_generation` 不同：它发生在同一次 OpenAI Responses 请求内部。调用图像模型（例如 GPT Image 2）时，provider 能看到主 Agent 当前请求里的上下文，包括传入的图像内容。这正是多轮连续编辑图像的基础。

因此，如果目标是稳定完成「基于上一张图继续修改」这类任务，应该允许真正的主 Agent 直接调用 provider-native `image_generation`。

同时，插件支持通过模型变体区分「带生图工具」和「不带生图工具」的模型 ID。这样可以保留两种工作方式：

- **主 Agent 直接绘图**：适合当前对话上下文本身就是图像任务的一部分，例如连续编辑同一张图。
- **绘图子代理**：适合完整软件工程项目中偶尔需要生成图片的场景。主 Agent 的软件工程上下文通常对绘图帮助不大，还会浪费图像模型输入；此时可以把绘图任务交给启用了 `image_generation` 的子代理。这个子代理可以主动收集绘图所需上下文，并基于自己的绘制结果多次迭代。相比原生工具，它不是只吃一次有限的工具参数，而是有自己的上下文扩充和迭代能力。

### `web_search`：主 Agent 直接使用 provider 检索结果

OpenAI provider-executed tools 通常不会把原始工具输出暴露给宿主应用。OMP 原生 `web_search` 面向 OpenAI provider 时，为了让主 Agent 使用搜索能力，通常需要另起一个搜索会话或近似子代理：它执行搜索、描述结果，并从引用元数据里还原一部分搜索结果。

这种方式可用，但主 Agent 看到的是被总结过的二手结果。它受限于：

- 本地工具输入输出格式；
- OpenAI 对 provider-side 检索细节的隐藏；
- 子会话总结质量；
- 额外模型请求带来的输入 token 和延迟。

使用原始 provider-executed `web_search` 时，主 Agent 在同一次 OpenAI Responses 请求中可以直接利用 provider 隐藏的原始检索结果，而且不需要重新发起本地工具会话，节约一次请求和额外输入 token。

代价是：下一轮请求中，Agent 不再拥有上一轮 provider 内部原始搜索结果的直接访问权限。这可能导致更频繁地重新搜索。不过实际使用中，主要有价值的信息通常会很快固化进模型回答或推理过程；只有「完整页面原文需要长期参考」这类任务会受到明显影响。遇到这种场景，应再使用 `read`、浏览器或其他显式抓取方式把原文带入上下文。

---

## 插件做了什么

- **启用 provider-executed tools**
  - 官方 OpenAI Responses provider 默认启用 provider-native `web_search`。
  - 其他 OpenAI-compatible 中转站必须通过 `compat.openaiProviderTools.enabled: true` 手动启用。
  - `image_generation` 必须按模型显式启用，避免普通模型意外获得生图能力。

- **安全处理本地工具冲突**
  - 只有确认 provider-native tool 能注入成功时，才移除对应的 OMP 本地 `web_search` / `generate_image`。
  - 安装插件本身不会禁用任何 OMP 原生工具；冲突处理发生在进入会话后的运行时。
  - 在 `before_agent_start` 阶段，插件会根据当前会话实际选中的 provider/model 和 `compat.openaiProviderTools` 元数据判断 provider-native tools 是否可用；只有当前目标会启用 provider-native `web_search` 或 `image_generation` 时，才快照 active tools 并移除当轮会冲突的本地 `web_search` / `generate_image`。
  - 在 `before_provider_request` 阶段，插件会再次校验实际 OpenAI Responses 请求目标，并把 provider-native tools 注入请求；如果目标不匹配、无法验证或注入失败，就恢复之前的 active tools 快照并告警或中止，避免出现「本地工具被移除但 provider tool 没有注入」的假成功。
  - 插件不会设置 `tool_choice`，是否调用工具仍由模型和 provider 决定。
  - 插件不读取、不保存、不要求任何 API key；provider 凭据仍归 OMP/Pi 的模型配置管理。

- **展示 provider-native `web_search` 回显**
  - 每轮请求中如果 provider 调用了 `web_search`，插件会聚合展示调用次数和检索词。
  - 回显用于提示用户「provider 侧发生了搜索」，优先通过 `ctx.ui.notify` 立即插入当前交互 UI 的消息列表；这是 UI-only 通道，不会写入 Agent message、不会进入 LLM 上下文，也不会在 streaming / 本地工具执行期间作为 steer 消息中断后续工具。缺少 `ctx.ui.notify` 的 runtime 才退回到非触发式 next-turn 可见消息。
  - `web_search` 的原始 provider-side 检索结果仍只在当次 provider 请求内部可用。

- **实时展示 provider-native `web_search` 状态**
  - 在支持 `ctx.ui.custom(..., { overlay: true })` 的 OMP/Pi 交互 runtime 中，provider-native `web_search_call` 流式事件到达时，插件会自动弹出一块临时 dashboard-style overlay，提示正在搜索的 query、状态和 source 计数。
  - 这个实时 overlay 是 UI-only、非持久状态，不写入 session message，不进入 Agent 上下文；完成状态会短暂保留，随后自动关闭；最终 `web_search` summary 仍由 `message_end` / `agent_end` 回显路径负责，回显出现时会立即关闭 overlay。
  - headless / print / RPC / 旧 runtime 缺少交互 overlay 能力时自动降级为 no-op；插件不会回退显示旧的短状态 widget。
  - `image_generation` 不显示实时 overlay；它继续使用现有 keepalive、可选中断、图片保存和最终回显路径。

- **保存并展示 provider-native `image_generation` 结果**
  - 自动从 OpenAI Responses history 中提取 `image_generation` 结果。
  - 将生成图像保存到临时目录、session artifact 目录或配置的输出目录。
  - 在终端中直接展示生成图像。
  - 展开详情时显示完整生图参数、文件信息和 revised prompt。
  - 对 provider-native `image_generation` 流，插件会在空闲等待期间注入请求级 Responses keepalive，避免 OMP 14.9+ 的 120 秒流式 idle watchdog 把长时间生图误判为卡死；该处理只作用于本插件已注入 `image_generation` 的 provider 请求，不会全局关闭 OMP 超时保护。
  - 将图片作为 image attachment 放入后续上下文，让 Agent 能基于生成结果继续编辑或判断是否需要再次生成。

---

## 安装

<details open>
<summary><b>面向人类用户</b></summary>

**选项 A：让 LLM 帮你安装**

把下面这段话丢给 OMP / Claude Code / Cursor 等任意 LLM Agent：

```text
请先查看 omp-openai-provider-tools 最新 GitHub Release 正文里的安装或升级说明，然后严格执行其中带明确版本号的 OMP 安装命令。不要使用裸包名或 latest。安装后运行 OMP 的插件检查命令确认插件可用。随后帮助用户配置 OpenAI 官方 provider 或用户自己的 OpenAI-compatible 中转站：检查现有模型/provider 元数据，指导用户把配置放到 `compat.openaiProviderTools`，不要读取、输出、保存或索要 API key 明文。官方 OpenAI Responses provider 可默认使用 provider-native `web_search`；中转站必须显式设置 `compat.openaiProviderTools.enabled: true`；只有图像能力模型才设置 `compat.openaiProviderTools.imageGeneration: true`。如果用户需要绘图子代理工作流，使用 `npx omp-openai-provider-tools configure-image-agent --model <image-capable-model-alias> --dry-run` 生成配置预览；`--model` 必须由安装 Agent 根据用户实际 provider/model 配置填写，不要使用示例模型名。参考说明：https://github.com/jiwangyihao/omp-openai-provider-tools/releases/latest
```

**选项 B：手动安装**

当前版本：

```bash
omp plugin install npm:omp-openai-provider-tools@0.1.3
```

本地开发时可以链接 checkout：

```bash
omp plugin link <path-to-this-repo>
```

如果 OMP 已在运行，安装或升级后重启会话再验证。

</details>

<details>
<summary><b>面向 LLM 智能体</b></summary>

### 步骤指引

1. 读取本仓库最新 GitHub Release：

   ```text
   https://github.com/jiwangyihao/omp-openai-provider-tools/releases/latest
   ```

2. 提取其中带明确版本号的安装命令。当前版本示例：

   ```bash
   omp plugin install npm:omp-openai-provider-tools@0.1.3
   ```

3. 安装后不要停在插件安装本身。继续帮助用户配置 OpenAI 官方 provider 或用户自己的 OpenAI-compatible 中转站：确认当前模型使用 `openai-responses`，把能力声明写入模型或 provider 元数据的 `compat.openaiProviderTools`，不要新建插件专用配置文件。

4. 如果是官方 OpenAI Responses provider，`web_search` 可按默认启用；如果是 OpenAI-compatible 中转站，必须显式设置 `compat.openaiProviderTools.enabled: true`；如果某个模型支持 provider-native `image_generation`，只在该模型变体上设置 `compat.openaiProviderTools.imageGeneration: true`。

5. 不要读取、输出、保存或索要 API key 明文。provider 凭据仍由 OMP/Pi 原有模型配置管理。

6. 如果用户需要绘图子代理工作流，先根据用户实际 provider/model 配置确定图像能力模型别名，再运行预览命令：

   ```bash
   npx omp-openai-provider-tools configure-image-agent --model <image-capable-model-alias> --dry-run
   ```

   其中 --model 必须由安装 Agent 根据用户实际 provider/model 配置填写。不要把文档里的占位符当成真实模型名，也不要使用私有路由示例。确认预览无误后再去掉 `--dry-run` 写入 agent 文件。若用户已经有同名 agent，不要覆盖；改用 `--print` 生成模板并人工合并，或在用户明确要求后使用 `--force`。

7. 这个命令不会在插件安装时自动写入或覆盖用户的 agent 配置。它生成的 `image_generator` 模板会要求子代理主动收集项目上下文，使用只读工具查找视觉相关 README、设计文档、assets、screenshots、品牌或样式说明；生成后按用户要求自检，明显不满足硬性要求时最多主动再生成一次。

8. 安装后运行：

   ```bash
   omp plugin doctor
   ```

9. 如果 OMP 已经运行，重启后再进行功能验证。

</details>

---

## 配置

推荐把配置放在 OMP/Pi 的模型或 provider 元数据里，而不是再维护一个插件专用 YAML。provider-executed tools 是所选 provider/model 的能力，配置应该跟模型路由放在一起。

### 官方 OpenAI Responses provider

官方 OpenAI Responses provider 上，`web_search` 默认启用：

```yaml
providers:
  openai:
    api: openai-responses
    baseUrl: https://api.openai.com/v1
```

`image_generation` 不会默认启用，必须放在具体模型变体上：

```yaml
providers:
  openai:
    models:
      - id: image-capable-model
        name: Image-capable model
        api: openai-responses
        compat:
          openaiProviderTools:
            imageGeneration: true
```

### OpenAI-compatible 中转站

中转站需要显式 opt-in：

```yaml
providers:
  compatible-example:
    api: openai-responses
    baseUrl: https://gateway.example.invalid/v1
    compat:
      openaiProviderTools:
        enabled: true
```

如果该中转站的某个模型也支持生图，再在模型上启用：

```yaml
providers:
  compatible-example:
    models:
      - id: gateway-image-model
        name: Gateway image model
        api: openai-responses
        compat:
          openaiProviderTools:
            imageGeneration: true
```

### 可选图像输出目录

```yaml
compat:
  openaiProviderTools:
    enabled: true
    outputDirectory: ./provider-tool-images
```

保存目录优先级：

1. `compat.openaiProviderTools.outputDirectory`
2. runtime session artifact 目录
3. Agent 默认图像目录

### 可选：配置图像子代理

插件本身只提供 provider-native tools 注入能力，不会在插件安装时自动写入或覆盖用户的 agent 配置。若希望使用「主 Agent 负责工程上下文、图像子代理负责生图」的工作流，可以显式运行 CLI 生成推荐模板：

```bash
npx omp-openai-provider-tools configure-image-agent --model <image-capable-model-alias> --dry-run
```

其中 --model 必须由安装 Agent 根据用户实际 provider/model 配置填写。它应该指向已经设置 `compat.openaiProviderTools.imageGeneration: true` 的模型别名，而不是文档占位符。确认预览后写入：

```bash
npx omp-openai-provider-tools configure-image-agent --model <image-capable-model-alias>
```

如果已有 `image_generator`，命令默认拒绝覆盖。可用 `--print` 输出模板并人工合并；只有在确认要替换现有 agent 时才使用 `--force`。

推荐模板会赋予子代理只读上下文工具（`read` / `find` / `search`）和 `yield`，并要求它：

1. 主动收集项目上下文，例如 README、设计文档、assets、screenshots、品牌或样式说明；
2. 根据主 Agent 提供的信息和自己收集到的上下文整理生图提示词；
3. 使用 provider-native `image_generation` 生成或编辑图像；
4. 生成后按用户硬性要求自检；
5. 如果结果明显不满足要求，最多主动再生成一次；
6. 不修改项目文件、不提交、不读取密钥或私有 provider 配置。

---

## 使用方式

### provider-native `web_search`

安装并配置后，无需额外命令。模型请求符合条件时，插件会把：

```json
{ "type": "web_search" }
```

注入 OpenAI Responses 请求。provider 如果在这轮请求里执行了搜索，OMP 终端会出现类似回显：

```text
OpenAI provider completed web_search (1 call).
Queries: latest OMP provider tools
1 citation
```

在支持 `ctx.ui.notify` 的交互 runtime 中，这条 UI-only 回显会立即插入当前消息列表，只显示 summary、检索词以及 citation/source 计数；它不会进入 Agent 上下文，也不会作为 steer 消息中断后续工具。缺少 `ctx.ui.notify` 的 runtime 才退回到非触发式 next-turn 可见消息，legacy fallback 中仍可通过自定义消息 renderer 展开查看 provider history 保留的引用和 sources。

如果 runtime 支持 `ctx.ui.custom(..., { overlay: true })`，provider-native `web_search_call` 流式事件到达且 provider 暴露了 query/source/error 等可展示细节时，还会自动弹出一块临时 dashboard-style overlay，实时提示 query、状态和 source 计数。这个 overlay 是 UI-only，不持久化、不进入 Agent 上下文，也不会替代请求结束后的 summary 回显；完成状态会短暂保留后自动关闭，且 summary 回显出现时会立即关闭 overlay。headless / print / RPC / 旧 runtime 缺少交互 overlay 能力时自动降级为 no-op，且不会回退显示旧的短状态 widget。`image_generation` 不显示实时 overlay。

### provider-native `image_generation`

为模型变体启用 `imageGeneration: true` 后，模型可以在同一次 OpenAI Responses 请求中调用：

```json
{ "type": "image_generation" }
```

生成完成后，插件会：

1. 保存图像文件；
2. 在终端显示图像预览；
3. 在展开详情中显示 MIME、bytes、SHA-256、size、quality、revised prompt 等信息；
4. 把生成图像作为 image attachment 交给后续上下文，让 Agent 能继续编辑这张图。

---

## 适合谁使用

- 希望 OMP 主 Agent 能直接使用 OpenAI provider-native `web_search` 的用户
- 需要多轮连续编辑图像，而不是每次都让本地工具另起绘图会话的用户
- 使用 OpenAI-compatible 中转站，并希望手动声明 provider-native tools 能力的用户
- 想把普通模型和生图模型变体分开管理的用户
- 想让绘图子代理拥有自己的上下文扩充和迭代能力，而不是只吃一次本地工具参数的用户

## 注意事项

- 插件不会强制工具调用：不会设置 `tool_choice`。
- provider-native `web_search` 的隐藏原始结果只在当次 provider 请求内部可用；下一轮如果需要同一批原始资料，可能需要重新搜索或显式读取网页原文。
- provider-native `image_generation` 会消耗对应 provider/model 的图像生成额度。
- `image_generation` 结果会作为 image attachment 进入后续上下文；如果会话被压缩、裁剪或删除，对应上下文和 artifact 可用性也会变化。
- 对真正卡死且 provider 不再返回任何事件的生图请求，插件 keepalive 会避免 OMP idle watchdog 过早中断；用户仍可手动取消该轮请求。
- 自定义中转站不会自动启用 provider tools，必须通过 `compat.openaiProviderTools.enabled: true` 明确声明。
- 运行时兼容性取决于 OMP/Pi 是否暴露 request hook、active-tool 控制、custom message、artifact 目录和 terminal image 渲染能力。详见 [runtime compatibility notes](./docs/runtime-compatibility.md)。

## 故障排查

| 现象 | 检查项 |
| --- | --- |
| 没有注入 provider-native tools | 确认当前模型是 `openai-responses`，官方 OpenAI provider 或自定义 provider 已启用 `compat.openaiProviderTools.enabled: true`。 |
| `image_generation` 没有出现 | 确认具体模型变体设置了 `compat.openaiProviderTools.imageGeneration: true`。 |
| 本地 `web_search` / `generate_image` 仍在 | 插件只有在能安全注入 provider-native tool 时才移除本地工具；查看 OMP warning。 |
| 生成图没有显示 | 确认终端支持 OMP 的图片渲染；如果同一会话里 `read` 能显示图片，而本插件不能，请报告 bug。 |
| 生成图没有保存 | 确认 provider 返回了 OpenAI Responses native image history，并检查输出目录或 session artifact 目录是否可写。 |
| 生图约 2 分钟后报 `OpenAI responses stream stalled...` | 升级到包含 provider-native image keepalive 的插件版本；它会仅对已注入 `image_generation` 的 Responses 流补请求级进展事件。 |
| Web 搜索回显太少 | provider 不暴露原始输出；插件只能展示 OpenAI Responses history 中保留下来的 query、citation 和 source。 |

---

<a name="english"></a>

## English

`omp-openai-provider-tools` adds OpenAI-style **provider-executed tool** support to **OMP** and Pi-family runtimes. It focuses on OpenAI Responses native `web_search` and `image_generation`.

Instead of launching a separate host-side tool session, the plugin injects provider-native tools into the same OpenAI Responses request sent to the model provider.

Repository: <https://github.com/jiwangyihao/omp-openai-provider-tools>

License: [MPL-2.0](./LICENSE)

## Why provider-executed tools?

### `image_generation`

Host-side image tools typically start a separate drawing session. That session only sees the tool arguments, so it can easily lose the main Agent's image inputs, file paths, visual context, or multi-turn editing intent.

OpenAI provider-executed `image_generation` runs inside the same provider request. The image backend can see the main Agent request context, including image attachments. This is the important difference for multi-turn image editing.

You can still create image-capable model variants and route drawing tasks to an image subagent. Compared with a native one-shot drawing tool, that subagent can actively gather visual context and iterate on its own results.

### `web_search`

A host-side search tool for OpenAI often has to start another session or subagent, ask it to search, summarize the result, and reconstruct citations. The main Agent receives second-hand summarized information.

Provider-executed `web_search` lets the main Agent use provider-side search results inside the same request, with no extra local tool request. The tradeoff is that those hidden raw search results are not directly available in later requests; long-lived source material should still be explicitly fetched when needed.

## What this plugin does

- Enables provider-executed `web_search` for official OpenAI Responses models.
- Lets custom OpenAI-compatible providers opt in with `compat.openaiProviderTools.enabled: true`.
- Lets selected model variants opt in to provider-native `image_generation`.
- Safely removes conflicting host-side `web_search` / `generate_image` tools only when provider-native injection is ensured.
- Never sets `tool_choice`.
- Installing the plugin does not globally disable host-side tools; host-side conflict handling happens at runtime for the currently selected provider/model, immediately before the agent run and provider request.
- Emits visible UI-only summaries for provider-native `web_search` calls through `ctx.ui.notify` when available, so the summary appears promptly in the interactive message list without entering Agent context, steering the current run, or interrupting later local tools. Runtimes without `ctx.ui.notify` fall back to non-triggering `nextTurn` messages.
- Automatically opens a temporary UI-only dashboard-style overlay for provider-native `web_search` stream events on interactive runtimes that expose `ctx.ui.custom(..., { overlay: true })` once provider events include displayable query/source/error details.
- The live overlay is not persisted, is not sent as a session message, and is not visible to the Agent. Completed status stays visible briefly and then auto-closes; final `web_search` summaries still come from `message_end` / `agent_end` and close the overlay immediately when echoed. Headless, print, RPC, or older runtimes without interactive overlay support degrade to no-op and the plugin does not fall back to the old short status widget.
- Provider-native `image_generation` does not use a live overlay; it keeps the existing keepalive, optional interruption, save, and final echo paths.
- Saves provider-native image results, renders them inline in the terminal, and exposes expanded generation metadata.
- Adds generated images as image attachments for later editing context.
- Injects request-scoped Responses keepalives while provider-native `image_generation` is waiting, so OMP 14.9+ does not mistake long image generation for a stalled stream. This is scoped only to requests where this plugin injected `image_generation`; it does not globally disable runtime timeout protection.

## Installation

For OMP:

```bash
omp plugin install npm:omp-openai-provider-tools@0.1.3
```

For local development:

```bash
omp plugin link <path-to-this-repo>
```

For Pi-family runtimes:

```bash
pi install npm:omp-openai-provider-tools@0.1.3
pi -e npm:omp-openai-provider-tools@0.1.3
```

Verify:

```bash
omp plugin doctor
```

## Configuration

Official OpenAI Responses providers get provider-native `web_search` by default when the selected model/provider identity is clearly official OpenAI.

Custom providers must opt in:

```yaml
compat:
  openaiProviderTools:
    enabled: true
```

Image generation must be enabled on selected model variants:

```yaml
compat:
  openaiProviderTools:
    imageGeneration: true
```

Optional image output directory:

```yaml
compat:
  openaiProviderTools:
    outputDirectory: ./provider-tool-images
```

Optional image subagent template:

```bash
npx omp-openai-provider-tools configure-image-agent --model <image-capable-model-alias> --dry-run
```

The installing Agent must fill `--model` from the user's actual provider/model registry. Plugin installation does not automatically create or overwrite user agent files. The generated template grants only read-only context tools plus `yield`, requires the image subagent to call provider-native `image_generation` / `image_gen.imagegen` when visible instead of returning text-only prompts, asks it to gather task-relevant project context, self-check the generated image, and retry at most once when hard requirements are clearly missed.

## Notes

- The plugin does not store or request provider credentials.
- Provider authentication stays in the runtime model/provider registry.
- Provider-native `web_search` raw results are only available inside the provider request that produced them.
- Provider-native `image_generation` may consume provider image-generation quota.
- Runtime compatibility depends on OMP/Pi extension APIs. See [runtime compatibility notes](./docs/runtime-compatibility.md).
- For truly stuck image-generation requests where the provider never completes, the plugin keepalive prevents premature idle-watchdog aborts; users can still manually cancel the turn.
