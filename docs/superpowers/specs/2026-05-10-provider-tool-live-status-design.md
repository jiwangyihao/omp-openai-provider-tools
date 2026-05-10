# Provider Tool 实时状态 UI 设计

**日期：** 2026-05-10

## 背景

`omp-openai-provider-tools` 会在 `message_end` / `agent_end` 中读取 `providerPayload.type === "openaiResponsesHistory"`，再把 provider-native `web_search` 和 `image_generation` 的结果打包成 UI-only custom message。这个最终回显路径可靠，但 `web_search` 在请求结束前缺少可见进度。

用户最终选择自动 dashboard-style overlay，而不是短状态 widget：provider-native `web_search_call` 流式事件到达时，如果 runtime 支持 `ctx.ui.custom(..., { overlay: true })`，插件自动弹出临时 overlay；请求完成后短暂保留 completed 状态，然后自动关闭；如果同一会话内最终 provider result 回显先出现，则立即关闭 overlay。

`image_generation` 不纳入实时 overlay：它继续使用现有 keepalive、可选 interruption、图片保存、terminal render、最终回显和后续编辑上下文桥。

## 目标

- 在 provider-native `web_search_call` 流式事件出现后，尽早展示 UI-only 实时搜索状态。
- 使用 `ctx.ui.custom(factory, { overlay: true })` 自动打开 dashboard-style overlay。
- completed 状态短暂可见，然后自动关闭。
- `message_end` / `agent_end` 最终 provider result 回显出现时，立即关闭仍在显示的 overlay。
- 实时 UI 不进入 LLM 上下文，不写 session message，不影响 replay。
- 请求失败、取消、session 切换、新 session、message/agent 生命周期结束时，实时 UI 必须幂等清理。
- 旧 runtime、print/headless/RPC 或没有 `ctx.ui.custom` 时安全降级为 no-op；不回退到旧短状态 widget。
- 不影响 host-tool conflict、防重、图片保存、图片回显、图片上下文桥、keepalive、可选 image stream interruption。

## 非目标

- 不改 OMP 或 Pi runtime 源码。
- 不 fork OpenAI SDK。
- 不把 provider tool 的实时状态暴露给模型。
- 不替代最终 `sendMessage` 回显；实时 overlay 只是临时状态层。
- 不实现真实 host-side search/image 工具。
- 不在插件配置中存储 API key 或 provider 私有凭据。
- 不为 `image_generation` 增加实时 overlay；图片生成继续依赖现有 keepalive、可选中断、最终保存和回显。

## Runtime 能力边界

- `ExtensionContext` 暴露 `ui` 与 `hasUI`；`hasUI` 只是提示，不能替代能力探测。
- 本功能只依赖 `ctx.ui.custom(factory, { overlay: true })`。
- `ctx.ui.setWidget`、`setStatus`、`setWorkingMessage` 不用于 provider-native `web_search` live overlay。
- RPC/headless/print 或旧 runtime 即使提供 `setWidget`，只要缺少 `custom`，live overlay 就 no-op。
- `custom` 工厂生成的组件实现：
  - `render(width): string[]`
  - `handleInput(data)`：`q` / `esc` / `escape` 关闭 overlay
  - `dispose()`：runtime 外部关闭时清理 tracker、timer 和 active 集合

## OpenAI Responses 流事件

插件通过 Responses raw SSE / SDK iterable wrapper 观察 provider-native 事件：

- `response.output_item.added` + `item.type === "web_search_call"`：创建或更新搜索状态，打开 overlay。
- `response.web_search_call.searching`：更新搜索中状态。
- `response.output_item.done` + `web_search_call`：标记该搜索调用完成，刷新 overlay；如果所有搜索调用完成，调度 completed auto-close。
- `response.completed`：把未失败搜索标记 completed，立即渲染 completed 状态并调度 auto-close；stream observer 不再同步 `clear()`，避免 completed overlay 一闪而过。
- `response.failed` / 顶层 `error` / upstream error / cancel / image-result interruption：失败或终止路径必须清理 tracker。
- `image_generation_call` 不传入 live tracker，只走 keepalive / interruption / result 保存相关路径。

## UI 设计

Overlay 内容为 dashboard-style 文本行：

```text
OpenAI provider web_search
──────────────────────────
live overlay • completed
phase completed • calls 1 • elapsed 2s
• ws-12345 completed
  query: latest OMP provider tools
  sources: 3
 esc/q close  j/k scroll
```

要求：

- 不展示 API key、headers、完整 payload 或 response body。
- query 最多展示 3 条，每条截断，避免 overlay 被 provider 返回撑爆。
- source count 只展示数量，不在 live 层重新实现最终 citation/source renderer。
- overlay 支持手动关闭；关闭后不再因旧 timer 重开。
- completed 默认短暂保留，便于用户看到 provider 搜索确实完成；最终 summary 回显出现时优先立即关闭。

## 架构

### `ProviderToolLiveStatusManager`

- extension 作用域单例。
- `createTracker({ enabledTools, ui })` 只在 `enabledTools` 包含 `web_search` 时返回 tracker。
- `image_generation` only 返回 `undefined`。
- 管理 active tracker 集合，支持 `clearAll()`。
- 通过注入的 `scheduler` / `now` 支持 deterministic tests。
- 缺少 `ui.custom` 时 no-op；不调用 `setWidget` fallback。
- UI 抛错时记录 warning、禁用后续 live UI，并清理 active tracker、pending render timer、pending auto-close timer。

### `ProviderToolLiveTracker`

- 维护 `LiveOverlaySnapshot` 与每个 `web_search_call` 的 `LiveOverlayCallSnapshot`。
- 第一次相关事件到达时调用 `ui.custom(factory, { overlay: true })`。
- 后续更新调用 overlay `requestRender()`，不重复打开 overlay。
- `clear()`：取消 pending render / auto-close，关闭 overlay，移出 active set。
- `fail()`：渲染 failed 状态后立即关闭并移出 active set。
- `disable()` / `dispose()`：不调用 overlay `done()`，但取消 timer 并移出 active set，避免 runtime 主动关闭后残留。

### `responses-stream-observer.ts`

- raw SSE 仍原样转发。
- `response.completed` 只传给 tracker `onEvent()`，由 tracker 自己调度 auto-close。
- `response.failed` / `error` 调用 `fail()` 后 `clear()`。
- downstream cancel、upstream error、image result interruption 仍立即 `clear()`。
- raw + SDK 双路径通过 request policy 避免重复观察 terminal 事件。

### `extension.ts`

- `providerToolLiveUiFromContext(ctx)` 传入 `hasUI`、`setWidget`、`custom`；manager 只使用 `custom`。
- `before_provider_request` 注入成功后注册 unified observation policy：
  - `enabledTools: result.ensured`
  - image keepalive/interruption only if `image_generation` ensured
  - live tracker only if `web_search` ensured
- `message_end` / `agent_end` 在发送最终 provider result echo 后 `finally clearLiveStatus()`，保证回显出现时 overlay 关闭。
- `session_start` / `session_before_switch` / `session_switch` / `session_branch` / `session_shutdown` 无条件清理。

## 测试策略

- `provider-tool-live-status.test.ts`
  - 自动打开 overlay，不调用短状态 widget。
  - dashboard renderer 包含 header、phase、query、source count、footer。
  - image-only 不创建 tracker。
  - missing custom / only setWidget runtime no-op。
  - completed 状态短暂可见，按 `completedAutoCloseMs` 自动关闭。
  - `response.completed` 取消 pending throttled render，但不会立即关闭 overlay。
  - `clear()` / `fail()` / keyboard close / runtime `dispose()` / UI failure 清理 timer 和 active tracker。
- `responses-stream-observer.test.ts`
  - `response.completed` 不立即 `clear()`，让 completed overlay auto-close。
  - `response.failed` / `error` fail + clear。
  - image result interruption、downstream cancel、upstream error 仍 clear。
  - raw SSE 原样转发，image_generation_call 不进入 live tracker。
- `extension.test.ts`
  - web_search 请求注册 live overlay tracker，不发送实时 session message。
  - final provider result echo 发送后关闭 overlay。
  - image_generation only 不打开 overlay。
  - combined web_search + image_generation 不破坏 interruption / keepalive。
  - lifecycle hooks 清理 overlay。
- `docs.test.ts`
  - README / runtime compatibility 描述 overlay-only、no widget fallback、completed auto-close、echo close、image_generation no overlay。

## 验收标准

- 使用 provider-native `web_search` 时，用户能在请求结束前看到 dashboard-style overlay。
- completed 搜索状态短暂保留后自动隐藏；最终 provider result 回显出现时立即隐藏。
- 使用 provider-native `image_generation` 时，不出现实时 overlay；现有 semantic keepalive、可选 interruption、图片结果保存和最终回显不回退。
- headless / print / RPC / 旧 runtime 没有 `ctx.ui.custom` 时没有异常，也不显示短状态 widget。
- 实时 overlay 不写入 assistant message，不进入 LLM 可见上下文。
- 所有现有测试通过，并新增覆盖 stream 事件观察、overlay 清理、session switch 清理、双路径去重、错误隔离、FIFO policy、无 UI 降级、文档一致性的测试。
