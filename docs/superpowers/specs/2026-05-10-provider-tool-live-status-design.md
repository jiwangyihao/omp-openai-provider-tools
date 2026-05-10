# Provider Tool 实时状态 UI 设计

**日期：** 2026-05-10

## 背景

`omp-openai-provider-tools` 目前会在 `message_end` / `agent_end` 中读取 `providerPayload.type === "openaiResponsesHistory"`，再把 provider-native `web_search` 和 `image_generation` 的结果打包成 UI-only custom message。这个路径可靠，但对 `web_search` 有一个明显限制：只有一轮模型请求结束后才能显示 provider 侧搜索已经开始、正在查询什么、是否已完成。

用户希望在 OpenAI Responses provider-native `web_search` 流式事件到达时，先在 OMP UI 中显示实时搜索状态；请求结束后继续沿用现有最终回显，并清空实时状态 UI。`image_generation` 不纳入本实时 UI 范围：一方面图片本身不适合做 overlay / widget 预览，另一方面当前插件已支持结果到达后中断流并尽快回显，实时性收益不足。

## 目标

- 在 provider-native `web_search_call` 流式事件出现后，尽早展示 UI-only 实时搜索状态。
- 最终 `web_search` 结果仍由现有 `message_end` / `agent_end` 汇总逻辑发送，避免重复实现最终结果渲染。
- 实时 UI 不进入 LLM 上下文，不写 session message，不影响 replay。
- 请求结束、失败、取消、session 切换或新 session 开始时，实时 UI 必须被清理。
- 不影响现有行为：host-tool conflict、防重、图片保存、图片回显、图片上下文桥、keepalive、可选 image stream interruption。
- 旧 runtime、print/RPC/headless 模式或没有 UI API 时安全降级为 no-op。

## 非目标

- 不改 OMP 或 Pi runtime 源码。
- 不 fork OpenAI SDK。
- 不把 provider tool 的实时状态暴露给模型。
- 不替代最终 `sendMessage` 回显；实时 UI 只是临时状态层。
- 不实现真实 host-side search/image 工具。
- 不在插件配置中存储 API key 或 provider 私有凭据。
- 不为 `image_generation` 增加实时 overlay / widget；图片生成继续依赖现有 keepalive、可选中断、最终保存和回显。

## 当前 runtime 能力证据

### Extension UI API

OMP/Pi extension context 已提供交互 UI 能力，源码证据：

- `C:/Users/34404/.bun/install/cache/@oh-my-pi/pi-coding-agent@14.9.2@@@1/src/extensibility/extensions/types.ts:224-253`
  - `ExtensionContext` 包含 `ui: ExtensionUIContext` 与 `hasUI: boolean`。
  - `hasUI` 标注为 print/RPC 模式下为 `false`。
- `.../extensibility/extensions/types.ts:123-150`
  - `ui.setStatus(key, text | undefined)` 可设置 footer/status bar 文本。
  - `ui.setWorkingMessage(message?)` 可设置 streaming loading message。
  - `ui.setWidget(key, content, options?)` 可设置 editor 上/下方 widget。
  - `ui.custom(factory, { overlay?: boolean })` 可显示自定义组件，`overlay: true` 走 overlay 层。
- `.../modes/controllers/extension-ui-controller.ts:243-285`
  - `setHookWidget` 会按 key 替换/清除 widget；`content === undefined` 清除；每次 rebuild 后调用 `ctx.ui.requestRender()`。
  - `string[]` widget 最多显示 10 行，超过会追加 `... (widget truncated)`。
- `.../autoresearch/dashboard.ts:32-53`
  - `ctx.ui.setWidget("autoresearch", ...)` 用于非阻塞、可持续更新的状态 dashboard。
- `.../autoresearch/dashboard.ts:55-120`
  - `ctx.ui.custom(..., { overlay: true })` 用于带键盘输入、可滚动、需要用户关闭的交互 overlay。

结论：实时 provider 状态应默认使用 `ui.setWidget`，而不是 `custom(..., { overlay: true })`。`custom overlay` 会获取焦点并等待 `done()` 结束，更适合用户主动展开详情，不适合模型流式请求期间自动弹出。

### OpenAI Responses 流事件

当前 runtime 会消费 OpenAI Responses SDK stream 并处理一部分事件，源码证据：

- `C:/Users/34404/.bun/install/cache/@oh-my-pi/pi-ai@14.9.2@@@1/src/providers/openai-responses.ts:103-127`
  - `OPENAI_RESPONSES_PROGRESS_EVENT_TYPES` 包含 `response.output_item.added`、`response.output_item.done`、`response.completed`、`response.failed`、`error` 等。
- `.../providers/openai-responses.ts:253-273`
  - provider 调用 `processResponsesStream(iterateWithIdleTimeout(...))`，并通过 `onOutputItemDone` 收集 native output items。
- `.../providers/openai-responses-shared.ts:310-358`
  - `response.output_item.added` 只为 `reasoning`、`message`、`function_call`、`custom_tool_call` 建立可见 blocks；provider-native `web_search_call` / `image_generation_call` 不会进入普通 assistant stream block。
- `.../providers/openai-responses-shared.ts:473-537`
  - `response.output_item.done` 会调用 `onOutputItemDone(item)`，但仍只对 reasoning/message/function/custom tool 推送普通 stream event；provider-native tool item 最终主要保存在 native history。

插件侧已经有 Responses stream wrapper：

- `src/stream-interruption.ts:89-103`
  - 包装 `globalThis.fetch`，匹配 `/responses` 请求并用 `wrapImageGenerationStream` 包裹 `Response.body`。
- `src/stream-interruption.ts:210-288`
  - `wrapImageGenerationStream` 逐个 SSE event 解析 raw event，可在转发给 runtime 前观察事件。
- `src/stream-interruption.ts:291-366`
  - `wrapImageGenerationEventIterable` 可观察 SDK event object。

结论：插件可以在不改 runtime 的前提下，通过已有 fetch/SDK wrapper 观察 provider-native tool 流事件。实时状态只需要覆盖 `web_search`；`image_generation` 相关 wrapper 继续服务 keepalive / interruption，不进入 live status tracker。

## 推荐方案

### 方案 A：只用最终回显，不做实时 UI

- 保持现状，只在 `message_end` / `agent_end` 汇总展示。
- 优点：最稳、无 runtime UI 兼容问题。
- 缺点：不能解决用户感知延迟；`web_search` 时用户仍不知道 provider tool 是否已开始执行或正在查询什么。

### 方案 B：使用 `ui.custom(..., { overlay: true })` 自动弹出 overlay

- 流式事件出现时自动打开 overlay，自定义组件渲染状态，结束后关闭。
- 优点：是真正 overlay 层，可做复杂交互。
- 缺点：会抢焦点；`custom()` 返回 Promise，生命周期以用户或代码调用 `done()` 为中心；自动弹出会干扰输入和快捷键；异常清理复杂。

### 方案 C（推荐）：使用非阻塞 `ui.setWidget` 作为实时状态层

- 在 provider stream 中观察 `web_search_call` 事件，更新一个 keyed widget，例如 `openai-provider-tools-live`。
- widget 显示在 editor 上方或下方，内容为 1-4 行搜索状态摘要。
- 请求结束、失败、取消或 session_start 时调用 `setWidget(key, undefined)` 清除。
- 最终仍由现有 custom message renderer 显示完整 `web_search` 结果。

推荐理由：`setWidget` 是 OMP 已用于持续状态 dashboard 的非阻塞 UI API；按 key 替换和清除，天然适合流式状态。它不需要用户操作、不抢焦点，并且能在无 UI runtime 中安全跳过。

## 用户体验设计

### 默认折叠状态

显示一块短状态 widget，最多 4 行：

```text
OpenAI provider web_search
• searching "provider native image_generation" …
```

状态文案只描述 provider-native `web_search` 生命周期，不展示 API key、headers、完整 payload 或 response body。

### 状态阶段

#### `web_search`

- `queued`：已观察到 `web_search_call` item，但尚未完成。
- `searching`：观察到 action query / queries 或 provider-specific searching event。
- `completed`：观察到 `response.output_item.done` 且 item type 为 `web_search_call`。
- `failed`：观察到 `response.failed` / `error`，或 stream 抛错。

展示字段：

- query / queries（截断到单行）；
- status；
- sources/citations 计数（只有 done item 中存在时展示）。

#### `image_generation`

本期不展示实时 UI。

原因：

- 图片结果不适合在 overlay/widget 中预览，终端渲染与保存逻辑已由最终回显负责。
- 当前插件已有 provider image result 到达后的可选 stream interruption，实际用户感知接近“结果一到就回显”。
- `image_generation` 长等待期间的可靠性由 semantic keepalive 解决，不需要额外 UI 层。

实现仍必须保证观察 `web_search` 时不破坏现有 `image_generation` keepalive / interruption。

### 清理策略

- `response.completed`：清理 widget，交给最终回显。
- `response.failed` / `error`：显示失败状态一小段时间后清理，或在 `agent_end` 清理。
- stream `catch` / downstream cancel：清理 widget。
- `message_end` / `agent_end`：完成最终回显后清理 widget。
- `session_start` / `session_shutdown`：无条件清理 widget。

## 架构设计

### 新增模块边界

#### `src/provider-tool-live-status.ts`

职责：维护 provider tool 实时状态，不处理 SSE 解析。

建议导出：

```ts
export interface ProviderToolLiveUiSink {
  hasUI?: boolean;
  setWidget?: (key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
  setStatus?: (key: string, text: string | undefined) => void;
}

export interface ProviderToolLiveTracker {
  onEvent(event: unknown): void;
  fail(error: unknown): void;
  clear(): void;
}

export function createProviderToolLiveTracker(options: {
  ui?: ProviderToolLiveUiSink;
  enabledTools: readonly ProviderToolType[];
  widgetKey?: string;
  now?: () => number;
  throttleMs?: number;
}): ProviderToolLiveTracker;
```

内部状态：

```ts
type LiveToolStatus = {
  id: string;
  type: "web_search";
  phase: "queued" | "searching" | "completed" | "failed";
  startedAt: number;
  updatedAt: number;
  query?: string;
  status?: string;
  sourceCount?: number;
  citationCount?: number;
  error?: string;
};
```

关键规则：

- 以 provider item id 为主键；没有 id 时使用稳定 fingerprint。
- 每次事件只更新状态，不发送最终 message。
- UI update 节流，默认 `250 ms`，避免每个 SSE chunk 都重绘。
- clear 必须幂等；重复调用不报错。
- `hasUI !== true` 或缺少 `setWidget` 时 no-op。

#### `src/responses-stream-observer.ts`

职责：解析/转发 Responses stream，并把 `web_search` 事件分发给 live tracker，同时继续服务现有 `image_generation` keepalive / interruption。

当前 `stream-interruption.ts` 已同时承担：

- request policy registry；
- fetch patch；
- SDK `Stream.fromSSEResponse` patch；
- SSE parsing；
- keepalive；
- image result interruption。

新功能如果继续堆在这个文件中，会让职责过重。建议采用“小步重命名/提取”：

1. 先保留 `stream-interruption.ts` 的 public exports，避免大范围 callsite 变化。
2. 内部引入更通用的 `RequestObservationPolicy`：

```ts
type RequestObservationPolicy = {
  enabledTools: ProviderToolType[];
  interruptOnImageResult: boolean;
  keepaliveIntervalMs?: number;
  liveTracker?: ProviderToolLiveTracker; // 仅在启用 web_search 时创建
};
```

3. 将 `wrapImageGenerationStream` 泛化为 `wrapOpenAIResponsesStream(body, policy)`，旧函数作为测试兼容 wrapper 保留或迁移测试。
4. 将 `wrapImageGenerationEventIterable` 泛化为 `wrapOpenAIResponsesEventIterable(source, policy, controller?)`。
5. raw SSE event 解析后统一调用：

```ts
const event = parseSseData(rawEvent);
policy.liveTracker?.onEvent(event);
```

6. 转发顺序保持不变：先观察，再按原样 enqueue raw event。观察失败不得阻断 provider stream。

#### `src/types.ts`

扩展本插件本地 runtime type：

```ts
export interface ExtensionContextLike {
  hasUI?: boolean;
  ui?: {
    notify?: ...;
    setWidget?: (key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
    setStatus?: (key: string, text: string | undefined) => void;
  };
}
```

### 注册流程

当前只在 image_generation 注入后调用：

```ts
registerImageGenerationRequest(payload, { ... });
```

建议改为：

```ts
registerProviderToolRequest(payload, {
  enabledTools: result.ensured,
  interruptOnImageResult: modelInterruptsProviderImageGeneration(eligibilityModel),
  keepaliveIntervalMs: modelProviderImageGenerationKeepaliveIntervalMs(eligibilityModel),
  liveTracker: createProviderToolLiveTracker({
    ui: providerToolLiveUiFromContext(ctx),
    enabledTools: result.ensured,
  }),
});
```

兼容要求：

- 如果 `result.ensured` 只包含 `web_search`，注册 stream observer，但不启用 image keepalive/interruption。
- 如果只包含 `image_generation`，保持现有 keepalive/interruption 行为，不创建 live tracker。
- 如果同时包含两者，共用同一个 request observer：`web_search` 事件更新 widget，`image_generation` 事件只走 keepalive/interruption 相关逻辑。

### Request policy registry 调整

当前 registry 用 `stableStringify(payload)` 聚合相同 payload，并用 `count` 支持重试。实时 UI 引入后，同 payload 的不同请求可能对应不同 UI tracker。建议从“计数聚合”改为“FIFO 队列”：

```ts
const requestPolicies = new Map<string, RequestObservationPolicy[]>();
```

- register：`queue.push(policy)`。
- consume：`queue.shift()`；队列为空则删除 key。
- 这样 identical payload retry 仍可工作，并且每次 fetch 消费自己的 tracker。

## 事件解析策略

### SSE raw stream

`wrapOpenAIResponsesStream` 已经按 `\n\n` / `\r\n\r\n` 切分 SSE event。新增：

```ts
function parseSseEvent(rawEvent: string): unknown | undefined {
  const data = rawEvent
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  return parseJson(data);
}
```

注意：SSE comment（例如 `:`）和 provider transport `keepalive` 不应进入 live tracker 状态，也不应影响最终回显。

### SDK iterable stream

`wrapOpenAIResponsesEventIterable` 直接收到 object event，调用 `liveTracker.onEvent(result.value)`。

保持现有 keepalive 规则：非语义 provider keepalive 不应推迟插件合成 semantic keepalive。

## UI 渲染策略

### Widget key

使用固定 key：

```ts
const LIVE_STATUS_WIDGET_KEY = "openai-provider-tools-live";
```

同一个 session 同时只有一块 provider tools 状态 widget。新请求开始会覆盖旧状态；`session_start` 清空。

### Placement

默认 `aboveEditor`。理由：

- OMP `setWidget` 默认就是 `aboveEditor`；
- provider tool 状态与当前请求强相关，放在输入区上方更像“运行状态”；
- 不影响最终 assistant message 区域。

后续可以通过 metadata 增加实验配置：

```yaml
compat.openaiProviderTools.liveStatusPlacement: belowEditor
```

本期不建议新增配置，保持 YAGNI。

### 节流

- 状态变化立即记录。
- UI render 最多每 `250 ms` 一次。
- `completed` / `failed` / `clear` 立即刷新。

### 错误隔离

- `setWidget` 抛错：记录 `logger.warn`，禁用本 tracker 后续 UI 更新，不影响 provider stream。
- `onEvent` 解析异常：吞掉并记录 debug/warn，不影响原始 SSE 转发。
- 清理异常：吞掉并记录 warn，避免在 `agent_end` 中破坏最终回显。

## 与最终回显的关系

实时 widget 与最终 custom message 是两个不同层级：

- 实时 widget：临时、UI-only、不持久化、只显示 `web_search` 进行中状态。
- 最终 custom message：现有 `buildProviderToolResultSummaryMessage` / `buildImageSummaryMessage`，在 `message_end` / `agent_end` 发送，持久化在 session 中，但 `content` 对 `web_search` 仍为空，保持 agent-invisible；`image_generation` 最终回显不变。

最终回显完成后调用 tracker clear：

```ts
handleMessageEndProviderToolResults(...);
liveStatusManager.clear(ctx);
```

如果最终没有 provider payload（runtime 不保留 native history），widget 也必须清理，避免“已完成但没有最终消息”的状态残留。可以同时发 warning（沿用现有策略）。

## 测试策略

### 单元测试

新增 `test/provider-tool-live-status.test.ts`：

- `web_search_call` added 后显示 searching/queued。
- `web_search_call` done 后显示 completed，包含 query 与 source/citation 计数。
- 不为 `image_generation_call` 生成 live widget；相关事件只用于现有 keepalive / interruption 回归验证。
- `response.failed` / `error` 显示 failed 并可 clear。
- `hasUI: false` 或无 `setWidget` 时 no-op。
- UI 更新节流可控（使用 fake `now` / scheduler 或注入 throttle 为 0）。
- `clear()` 幂等并调用 `setWidget(key, undefined)`。

### Stream wrapper 回归测试

扩展 `test/extension.test.ts` 或新增 `test/responses-stream-observer.test.ts`：

- provider 发送 `response.output_item.added` `web_search_call` 时，wrapper 调用 tracker 并原样转发 SSE。
- provider 发送 `image_generation_call` 时，不更新 tracker，但保持 keepalive / interruption 逻辑。
- provider 只发送 SSE comment / transport keepalive 时，不更新 tracker、不推迟 semantic keepalive。
- stream 抛错时 tracker `fail()` + `clear()` 被调用，原始错误继续向下游传播。
- downstream cancel 时 tracker clear。
- identical payload retries 使用 FIFO policy，两个 tracker 分别消费。

### Extension 集成测试

- OMP-style ctx 提供 `hasUI: true` + `ui.setWidget`，注入 `web_search` 后注册 live tracker。
- headless ctx 或旧 ctx 不提供 `setWidget` 时不抛错。
- `message_end` / `agent_end` 最终回显后清空 widget。
- `session_start` 清空旧 widget。

## 迁移与兼容

- 保留现有 public export 名称一轮，避免测试与外部引用断裂。
- 新 API 命名以 `ProviderTool` / `OpenAIResponses` 为中心，不再把 stream wrapper 命名限制为 `ImageGeneration`。
- 对旧 runtime：如果 `ctx.hasUI !== true` 或 `ctx.ui.setWidget` 不存在，则实时状态完全 no-op；最终回显照常工作。
- 对 Pi-family：同样遵循 `hasUI` 与 `setWidget` 能力探测，不做包名硬编码。

## 风险与缓解

1. **风险：误用 `custom overlay` 抢焦点。**
   - 缓解：默认只用 `setWidget`；`custom overlay` 仅作为未来用户主动展开详情的可选增强。

2. **风险：频繁 SSE 事件导致 UI 重绘过多。**
   - 缓解：tracker 内置节流，默认 250 ms；done/fail/clear 立即刷新。

3. **风险：stream wrapper 职责继续膨胀。**
   - 缓解：新增 `provider-tool-live-status.ts`，并把通用观察逻辑提取为 `responses-stream-observer.ts` 或在现文件内先形成清晰分区，后续再重命名。

4. **风险：相同 payload 重试时 tracker 串线。**
   - 缓解：policy registry 从 count 聚合改成 FIFO queue。

5. **风险：实时状态和最终回显不一致。**
   - 缓解：实时状态只展示进行中/完成信号，不承担最终数据真实性；最终结果仍以 runtime `providerPayload` 为准。

6. **风险：provider-specific 事件类型不稳定。**
   - 缓解：核心状态只依赖 OpenAI Responses 标准 `response.output_item.added` / `response.output_item.done` / `response.completed` / `response.failed` / `error`；provider-specific `response.image_generation_call.generating`、`response.web_search_call.searching` 只作为增强。

## 推荐实施顺序

1. 扩展本地 `ExtensionContextLike` UI 类型，并新增 live tracker 单元测试。
2. 实现 `provider-tool-live-status.ts`，先不接入 stream。
3. 将 request policy registry 改为 FIFO queue，确保现有 keepalive / interruption 测试仍通过。
4. 泛化 stream wrapper：在 raw SSE 与 SDK iterable 两条路径中调用 tracker。
5. 在 `before_provider_request` 中为包含 `web_search` 的 `result.ensured` 创建 live tracker；包含 `image_generation` 时仍注册 keepalive / interruption policy。
6. 在 `session_start` / `message_end` / `agent_end` / error/cancel 路径清理 widget。
7. 更新 README / runtime compatibility 文档，说明实时状态是 UI-only、非持久、只覆盖 `web_search` 且可降级。

## 验收标准

- 使用 provider-native `web_search` 时，用户能在请求结束前看到查询进行中状态；请求结束后状态 widget 被清空，最终 web_search summary 正常显示。
- 使用 provider-native `image_generation` 时，不出现实时 widget；现有 semantic keepalive、可选 interruption、图片结果保存和最终回显不回退。
- headless / print / RPC / 旧 runtime 没有 `setWidget` 时没有异常，最终回显保持现状。
- 实时 widget 不写入 assistant message，不进入 LLM 可见上下文。
- 所有现有测试通过，并新增覆盖 stream 事件观察、widget 清理、FIFO policy、无 UI 降级的测试。
