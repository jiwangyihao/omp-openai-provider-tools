# Provider Tool Web Search Runtime 回归修复规格

**日期：** 2026-05-12  
**适用仓库：** `C:/tmp/omp-openai-provider-tools`  
**状态：** 已通过 review 循环后方可实现

## 0. 权威性 / Supersedes

本规格是 `web_search` runtime 回归修复的当前权威合同，覆盖并修正以下旧文档中的冲突条款：

- `C:/tmp/omp-openai-provider-tools/docs/superpowers/specs/2026-05-11-web-search-overlay-reliability-design.md`
- `C:/tmp/omp-openai-provider-tools/docs/superpowers/plans/2026-05-11-web-search-overlay-reliability.md`

旧规格 / 旧计划中以下内容必须视为废弃，不得作为实现依据：

- `ctx.ui.custom(..., { overlay: false })` 是最终 `web_search` 回显的首选或唯一交互 UI path；
- 非 overlay final card 长期占用 editor 是预期行为；
- 任务 4 中以 non-overlay custom card 作为最终回显的实现步骤；
- 任何把 editor replacement flow 作为持久 chat 结果展示的说明；
- interactive runtime 主路径 fallback 到 `api.sendMessage(..., { deliverAs: "nextTurn" })` 的说明。

旧规格中未冲突的条款仍可作为背景参考，包括：overlay 状态机、stable identity、timer 安全、`response.completed` 不直接关闭 overlay、overlay 可恢复性、`image_generation` 不回退等。但若旧文档与本规格冲突，以本规格为准。

后续实施必须同时更新 README、`docs/runtime-compatibility.md` 和 `test/docs.test.ts`，删除或改写旧的 non-overlay final card / editor-resident / 唯一交互 UI path 描述。

## 1. 背景

`omp-openai-provider-tools` 为 OpenAI Responses provider-native `web_search` 提供两类 UI：

1. 流式阶段的实时 overlay，用于显示 provider 正在执行的搜索调用。
2. 请求结束后的最终回显 card，用于展示最终 `web_search_call` 摘要、查询、引用和来源。

上一版 overlay 可靠性设计已经覆盖了条目归并、completed 折叠、overlay 可恢复性等问题，但真实 OMP runtime 仍出现新的回归：

- overlay 中显示的搜索数量远小于实际发生的搜索数量；
- overlay completed 后关闭太快，用户几乎看不到；
- 最终 `web_search` 回显 card 不显示；
- 请求结束时 OMP TUI 输入区消失，重启后 TUI 恢复，但回显仍不存在。

只读排查后确认：最终回显不能使用 `ctx.ui.custom(..., { overlay: false })` 作为长期 card，因为 OMP 的 non-overlay custom UI 是 editor replacement flow，必须调用 `done()` 才会恢复输入区。最终回显也不能改回 `api.sendMessage(..., { deliverAs: "nextTurn" })` 主路径，因为这会延迟到用户下一条消息才显示，并且 `custom_message` 会进入 LLM context。正确方向应参考 OMP 内置 `notify` / `showStatus` 插入逻辑：立即把 UI-only 内容插入 chat 显示面，不替换 editor，不写入 agent messages。

当前公开 OMP extension API 没有直接 `chatContainer.addChild()` 能力。因此，本修复的主路径必须使用现有 runtime 可验证能力组合实现等价语义：把最终 provider result 持久化为 UI-only `custom` session entry，并通过 `context` hook 在 LLM 请求前剥离插件自己的 display-only custom message，保证 visible custom card 由现有 `CustomMessageComponent` / `registerMessageRenderer` 在 idle flush 后即时渲染，但不进入 LLM context。

本规格定义完整修复方案，覆盖 overlay 计数、overlay 生命周期、最终回显即时插入、UI-only 持久性、测试和文档。

## 2. 术语

- **live overlay：** 请求期间的 transient overlay，只显示 provider-native `web_search` 实时状态。
- **final card / 最终回显 card：** 请求结束后显示在 chat transcript 中的 provider result card。
- **display custom message：** 在 runtime 已 idle 的 flush 阶段通过 `api.sendMessage(message, { triggerTurn: false })` 渲染的 custom message，只作为 TUI 显示载体；必须由本插件 `context` hook 从 LLM 上下文中移除。
- **UI-only custom entry：** 通过 `api.appendEntry(customType, data)` 写入的 `custom` session entry，runtime 明确不把它放入 LLM context。
- **headless fallback：** 非 interactive runtime 下的兼容路径，不是用户当前 OMP TUI 主路径。

## 3. 现有证据

### 3.1 OpenAI Responses `web_search` 生命周期事件覆盖不足

当前 `src/responses-stream-observer.ts` 只观察：

- `response.web_search_call.searching`
- `response.output_item.added` 且 `event.item.type === "web_search_call"`
- `response.output_item.done` 且 `event.item.type === "web_search_call"`
- 条件转发 `response.completed`

OpenAI SDK 类型定义中还存在：

- `response.web_search_call.in_progress`
- `response.web_search_call.completed`

这些 lifecycle event 的字段是 `item_id`、`output_index`、`sequence_number`，不包含完整 `item` 对象。若实际 provider 流中大量搜索只产生 `in_progress` / `completed` lifecycle event，而当前 observer 不转发，overlay 计数必然少于最终 `openaiResponsesHistory`。

### 3.2 Non-overlay custom UI 会替换 editor

OMP `ctx.ui.custom(factory, { overlay: false })` 行为：

- 保存当前 editor 文本；
- 清空 `editorContainer`；
- 把 custom component 放进 `editorContainer`；
- 聚焦 custom component；
- 只有调用 `done(result)` 时才恢复 editor 和原文本。

因此，最终回显 card 若通过 non-overlay custom UI 展示且不调用 `done()`，就会占用输入区，导致用户看到「对话框完全消失」。

### 3.3 内置 notify / status 的即时 UI-only 插入语义

OMP 内置 notify 路径是：

- extension `ctx.ui.notify(message, type)`；
- interactive controller 转到 `showHookNotify()`；
- `showHookNotify()` 调用 `ctx.showStatus()` / `ctx.showWarning()` / `ctx.showError()`；
- `showStatus()` / `showWarning()` / `showError()` 直接向 `chatContainer` 添加 `Spacer` / `Text` 组件并 `requestRender()`。

这条路径证明了目标语义：

- 立即显示，不等待下一轮用户消息；
- 不替换 editor；
- 不进入 agent message state；
- 不进入 LLM context。

但本插件最终 UX 不能退化为纯文本 `notify` / `showStatus`，必须保持自定义格式和 `Ctrl+O` 展开能力。

### 3.4 现有 runtime 可用能力

当前 OMP extension API 可验证能力包括：

- `api.registerMessageRenderer(customType, renderer)`：注册 custom message renderer。
- `api.sendMessage(message, options)`：发送 `custom_message`。当 runtime 不在 streaming 状态且 `triggerTurn` 未设置时，会立即 append 并触发 UI rebuild；但 `custom_message` 默认会参与 LLM context。
- `api.appendEntry(customType, data)`：写入 `custom` entry，runtime 注释明确说明不参与 LLM context。
- `ctx.sessionManager.getBranch()` / `getEntries()` / `getLeafId()`：只读读取当前 session entry，用于 replay 当前 branch 上的 UI-only custom entry。
- `api.on("context", handler)`：在 LLM 请求前得到 `AgentMessage[]`，可以返回过滤后的消息数组。

当前公开 API 不包括：

- `ctx.ui.addChatComponent(...)`
- `ctx.ui.addChatLines(...)`
- `ctx.chatContainer`

因此，本修复不能把这些 future hook 当作主路径。若后续 OMP runtime 正式提供 immediate chat component insertion API，可以新增适配，但当前规格的可交付主路径必须不依赖它。

### 3.5 Session 持久化与 LLM context 边界

OMP session entry 中：

- `custom_message` 会进入 `buildSessionContext()`，随后 `convertToLlm()` 以 user-role content 进入 LLM context；
- `custom` entry 只用于扩展状态持久化，不进入 `buildSessionContext()`；
- session tree 默认过滤会隐藏 `custom` bookkeeping entry；
- `context` hook 可在 LLM 请求前过滤 display-only custom messages，避免其进入 provider request。

因此，最终 `web_search` 回显的主路径必须同时满足：

1. 使用 existing custom message renderer 实现即时、自定义、可展开的 visible card；
2. 同步写入 UI-only `custom` entry 作为重启 / resume replay 数据；
3. 通过 `context` hook 移除本插件 display-only custom message，补齐 `custom_message` 本身会进入 LLM context 的 runtime 行为。

## 4. 目标

- overlay 对真实 OpenAI Responses `web_search` lifecycle event 覆盖完整，至少包括 `in_progress`、`searching`、`completed`、`output_item.added`、`output_item.done`。
- overlay 中的搜索数量与 provider 流式 lifecycle / 最终 history 的数量一致或可解释，不因漏事件而显著偏少。
- overlay 不显示 `unknown`、`res_...`、`resp_...` 等低置信临时 ID。
- completed overlay 至少保留到用户可感知；短暂完整展示后折叠，再延迟隐藏，最后才关闭 overlay。
- 最终 `web_search` 回显即时出现在 chat transcript，不替换 editor，不阻塞输入，不等待下一轮用户消息。
- 最终 `web_search` 回显默认折叠，支持与原 custom message renderer 一致的 `Ctrl+O` 展开 / 收起体验。
- 最终 `web_search` 回显是 UI-only：不进入 LLM context，不触发 steer / follow-up / next-turn。
- 最终回显插入成功是关闭实时 overlay 的权威信号。
- 最终回显数据写入 UI-only `custom` session entry；session reload / resume / tree navigation 后可从当前 branch replay。
- 保持 `image_generation` 现有行为不回退。

## 5. 非目标

- 不把 provider-native `web_search` 改成 host-side search。
- 不改变 provider tool 注入、active tool conflict 处理、`tool_choice` 删除策略或 API key 处理。
- 不把 `web_search` 最终结果写入 LLM context。
- 不恢复 `notify` / `showStatus` 的纯文本回显样式；notify 只作为语义参考，不作为最终视觉样式。
- 不依赖 `api.sendMessage(..., { deliverAs: "nextTurn" })` 作为 interactive runtime 主路径。
- 不依赖当前不存在的 `ctx.ui.addChatComponent` / `ctx.chatContainer` 公开 API。
- 不修改 OMP runtime 源码作为本插件修复的前置条件；如果将来选择新增 runtime API，必须另起规格，并在本插件中保留当前可用路径。
- 不为 `image_generation` 增加实时 overlay。
- 不尝试伪造缺失的最终 provider history；缺失最终 history 时只能显示 live overlay 的已知信息。

## 6. 设计原则

1. **UI-only 优先。** provider-native `web_search` 的可视化信息只给用户看，不改变模型上下文。
2. **即时显示。** 最终回显必须在请求结束后的第一个 idle flush 中插入当前 visible chat，不等待下一轮用户输入。
3. **不占用 editor。** 最终回显不得使用 non-overlay `ctx.ui.custom`。
4. **overlay 是临时状态，final card 是结果。** overlay 只表示本次请求正在或刚完成的实时状态；最终 card 代表本次 provider result 的 UI-only 结果。
5. **共享身份规则。** live overlay 与 final result extraction 必须复用同一套 `web_search` query normalization / identity helper。
6. **请求级生命周期，条目级展示状态。** `response.completed` 是请求完成事件，不是立即关闭 UI 的信号。
7. **错误隔离。** 单次 overlay 或 final UI 插入失败不能永久禁用后续请求。
8. **优先复用现有 renderer。** 最终 card 的视觉和 `Ctrl+O` 行为应继续复用 `provider-result-renderer.ts` 的渲染逻辑，避免平行实现。

## 7. 总体方案

### 7.1 禁止方案 A：继续使用 non-overlay `ctx.ui.custom`

- 优点：当前代码改动少。
- 缺点：会替换 editor，必须 `done()`，与长期结果 card 语义不匹配，已在真实 runtime 触发输入区消失。
- 结论：禁止作为最终回显路径。

### 7.2 禁止主路径方案 B：使用 `api.sendMessage(..., { deliverAs: "nextTurn" })`

- 优点：可复用 `registerMessageRenderer`，可被 session 持久化。
- 缺点：interactive streaming 时会延迟到下一轮；如果不额外过滤，`custom_message` 会进入 LLM context；用户已明确拒绝。
- 结论：只允许作为 `ctx.hasUI === false` 的 headless / RPC / print 诊断兜底，不得作为 interactive 主路径，不得关闭 overlay 的权威信号。

### 7.3 采用方案 C：idle-gated display custom message + context hook 过滤 + custom entry replay

主路径：

1. 注册 `openai-provider-tool-result` message renderer。
2. 在 `message_end` / `agent_end` 提取完整 final provider result，只收集和去重，不直接发送 visible card。
3. 将待显示 result 放入插件内部 pending final card 队列。
4. `turn_end` 触发一次 flush 尝试；任一 flush 尝试若发现 `ctx.isIdle() === false`，必须安排后续 macrotask / timer retry 继续检查。每次真正发送前都必须重新确认 `ctx.isIdle() === true`。
5. flush 时构建 display-only `ProviderToolResultMessage`。
6. 在 idle/display append 路径调用 `api.sendMessage(message, { triggerTurn: false })`，不设置 `deliverAs`。
7. 调用 `api.appendEntry("openai-provider-tool-result-ui", persistedData)` 写入 UI-only custom entry。
8. `context` hook 过滤 `role === "custom" && customType === "openai-provider-tool-result" && details.uiOnly === true` 的 display-only message，确保不进入 LLM context。
9. 只有 idle flush 中 display message 同步启动成功后，才关闭 live overlay。
10. `session_start` / `session_switch` / `session_tree` 后，从当前 branch 的 UI-only custom entry replay final card，但 replay 同样必须等 idle/display append path，带 `details.uiOnly === true`，并被 context hook 过滤。

禁止在 `message_end` / `agent_end` handler 内、`ctx.isIdle() === false` 时直接调用无 `deliverAs` 的 `api.sendMessage`。真实 OMP runtime 在 streaming / prompt-in-flight 状态下会把未设置 `deliverAs` 的 custom message 当作 steer，而不是即时 chat append；这会违反 UI-only 和即时回显目标。
若 pending final card 存在且当前 flush 仍非 idle，实现必须保留 pending 并安排 bounded deferred idle flush，例如使用 `setTimeout(..., 0)` / scheduler macrotask 重试；session switch / shutdown / branch 必须取消或失效旧 pending 和 retry token。不得只依赖 `turn_end`，因为真实 OMP 的 prompt-in-flight 可能在 `turn_end` handler 返回后才清零。

该方案使用 existing OMP renderer path 获得即时 custom formatted card 和 `Ctrl+O`，同时通过 idle-gated delivery 避免 streaming 期间默认 steer，通过插件自己的 context hook 修正 `custom_message` 默认进入 LLM context 的 runtime 行为。

## 8. 最终回显 UI 合同

### 8.1 Custom type 与 details

使用稳定 custom type：

```ts
const PROVIDER_TOOL_RESULT_CUSTOM_TYPE = "openai-provider-tool-result";
const PROVIDER_TOOL_RESULT_ENTRY_TYPE = "openai-provider-tool-result-ui";
```

visible message 必须包含：

```ts
{
  customType: PROVIDER_TOOL_RESULT_CUSTOM_TYPE,
  content: "OpenAI provider web_search result",
  display: true,
  details: {
    uiOnly: true,
    source: "omp-openai-provider-tools",
    resultKey: string,
    message: ProviderToolResultMessage
  },
  attribution: "agent"
}
```

要求：

- `content` 必须是短占位文本；renderer 只从 `details.message` 渲染真实详情。
- `details.uiOnly === true` 是 context hook 过滤条件之一。
- `resultKey` 用于 message_end / agent_end / replay 去重。

### 8.2 UI-only context hook

插件必须注册 `api.on("context", handler)`，过滤自己插入的 display-only final cards：

```ts
function filterProviderToolResultDisplayMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(message => {
    if (message.role !== "custom") return true;
    if (message.customType !== PROVIDER_TOOL_RESULT_CUSTOM_TYPE) return true;
    return !isProviderToolResultUiOnlyDetails(message.details);
  });
}
```

测试必须验证：

- 过滤本插件 `uiOnly` display message；
- 不过滤其它插件 custom messages；
- 不过滤本插件 custom type 但缺少 `uiOnly` 标记的未知消息；
- 过滤后 provider request 中没有 final `web_search` card 文本。

### 8.3 UI-only persistence 与 replay

每个成功插入的 final card 必须写入 `custom` entry：

```ts
api.appendEntry(PROVIDER_TOOL_RESULT_ENTRY_TYPE, {
  resultKey,
  sessionId,
  insertedAt: number,
  message: ProviderToolResultMessage
});
```

Replay 规则：

- 只读取 `ctx.sessionManager.getBranch()` 当前 branch 上的 `custom` entry。
- 只 replay `customType === PROVIDER_TOOL_RESULT_ENTRY_TYPE` 且 data shape 合法的 entry。
- 以 `resultKey` 去重，避免 session_start、session_switch、session_tree 和当前 turn 插入重复 card。
- replay 使用同一个 display custom message path，但不得再次 appendEntry。
- replay 失败只记录 warning，不影响后续请求。
- 当前 turn 刚插入的 card 不应在同一 hook 中重复 replay。

### 8.4 最终 card 组件行为

最终 card 必须复用 `provider-result-renderer.ts` 的渲染语义：

- 默认折叠：显示 summary 和 `[(Ctrl+O for more)]`。
- 展开后显示：queries、citations、sources、action details、result count。
- `Ctrl+O` 切换展开 / 收起。
- chat history 中的 `Ctrl+O` 由 OMP input controller 全局遍历 `chatContainer.children` 并调用 `setExpanded(expanded)`；因此 final card / wrapper 必须实现或转发 `setExpanded(expanded)`，不能只依赖 focused component 的 `handleInput(data)`。
- 使用 runtime theme 的 `customMessageBg`、`customMessageText`、`customMessageLabel` 等 token。
- 渲染宽度安全，不能超过 terminal width。
- 不支持 `q` / `Esc` 关闭；它是 chat 历史的一部分，不是 overlay。

### 8.5 回显插入时机

- `message_end` 中若能提取完整 completed `web_search_call`：只加入 pending final card 队列，不发送，不关闭 overlay。
- `message_end` 中若结果 incomplete：不插入 final card，不关闭 overlay。
- `agent_end` 作为兜底：若 `message_end` 没收集且 `agent_end` 能提取完整结果，则只加入 pending final card 队列，不发送，不关闭 overlay。
- 对同一 session / result key 去重，避免 `message_end` 与 `agent_end` 双重插入。
- idle flush 中 display custom message 同步启动成功后立即关闭当前 live overlay。
- `turn_end` / deferred idle flusher 发现仍非 idle 时，不发送、不关闭 overlay，并安排后续 retry；retry 必须按 generation / token 防止旧 session 或旧请求迟到发送。
- 插入失败不得把 `message_end` / `agent_end` / `turn_end` 本身当成关闭信号。
- `api.appendEntry` 持久化失败不应撤销已显示 card，但必须 warning；context hook 仍必须过滤 display custom message。

### 8.6 完整结果判定

最终 `web_search` result 保留规则：

- `status` 为 `completed`、`complete`、`succeeded`、`success` 时保留；
- `status` 缺失但有 `id` / `query` / `queries` / `citations` / `sources` / `actionType` / `actionDetails` 任一字段时保留；
- `status` 为 `in_progress`、`searching`、`failed`、`incomplete` 时不作为成功 final card 插入；
- failed result 可在后续单独设计错误 card，本规格不新增失败 final card。

## 9. Overlay 事件覆盖与归并合同

### 9.1 observer 必须观察的 live events

`src/responses-stream-observer.ts` 必须识别并转发：

- `response.web_search_call.in_progress`
- `response.web_search_call.searching`
- `response.web_search_call.completed`
- `response.output_item.added` 且 `item.type === "web_search_call"`
- `response.output_item.done` 且 `item.type === "web_search_call"`
- `response.completed`，但仅在本请求已经看到 `web_search` lifecycle event 后转发
- `response.failed` / top-level `error`

同时必须保持：

- raw SSE 原样透传；
- `image_generation_call` 不进入 live web_search tracker；
- image keepalive 和 interruption 逻辑不变。

### 9.2 lifecycle event 归一化

对 `response.web_search_call.*` 事件，tracker 需要支持 `item_id`：

```ts
interface WebSearchLifecycleEvent {
  type:
    | "response.web_search_call.in_progress"
    | "response.web_search_call.searching"
    | "response.web_search_call.completed";
  item_id?: string;
  output_index?: number;
  sequence_number?: number;
}
```

转换规则：

- `item_id` 作为 `providerItemId`。
- `sequence_number` 作为请求内排序 / 兜底 identity 输入之一。
- `in_progress` → phase `queued` 或 `searching`，但若没有 query/source/error，不直接打开 overlay。
- `searching` → phase `searching`。
- `completed` → phase `completed`，若已有同 `item_id` 或可归并 status，更新它；若仍没有可展示详情，不单独打开空 overlay。

### 9.3 query / action 提取

`web_search_call.action` 可能是：

- `search`：`query`、`queries[]`、`sources[]`；
- `open_page`：`url`；
- `find_in_page`：`pattern`。

final card 与 overlay 至少应：

- 对 `search` 收集 `query` / `queries[]`；
- 对 `open_page` 把 URL 作为 action detail，不把它伪装成 search query；
- 对 `find_in_page` 把 pattern 作为 action detail，不把它伪装成 search query；
- sources / citations 继续独立收集。

本规格允许第一版 UI 仍主要展示 Queries / Citations / Sources，但 extraction 不能丢失 action type 和基本 action detail，否则最终 call 数量与详情会让用户误解。

### 9.4 Stable identity 规则

共享 helper：

```ts
normalizeProviderWebSearchQueryForIdentity(value: unknown): string | undefined
```

语义：

- 仅接受非空 string；
- trim 后折叠空白；
- 不做展示截断；
- 大小写敏感。

tracker stable key 选择：

1. 如果 `providerItemId` 已映射到 status，使用该 status。
2. final item 带 `providerItemId` 时：
   - 若能通过唯一 normalized query 匹配已有临时 status，则把临时 status 迁移到正式 `providerItemId`。
   - 若不能唯一匹配，则创建新 status。
3. 没有 `providerItemId` 但有唯一 normalized query 时，使用 query 临时 key。
4. 没有 query 时，使用 `output_index` / `sequence_number` 形成 request-local placeholder key，但 placeholder 不可展示。
5. final `output_item.done` 若缺少 `item.id` 但携带 `output_index` / `sequence_number`，应优先归并同 request-local placeholder，而不是按 query 新建。
6. 同一 normalized query 若出现多个不同 final `providerItemId`，必须拆成多个 status，不能继续按 query 合并。

展示规则：

- 不展示内部 key。
- 不展示 `unknown`。
- 不展示 `res_...` / `resp_...` 这类请求级 ID。
- 无 query / source / citation / action detail / error 的 placeholder 不打开 overlay。

## 10. Overlay 生命周期与时长

### 10.1 默认时长

本规格新默认值 supersede 旧规格的 `1_500` / `3_000` / `4_000`：

```ts
completedCollapseMs = 3_000;
completedHideMs = 8_000;
completedAutoCloseMs = 10_000;
```

含义：

- completed 后完整展示至少 3 秒；
- 3 秒后折叠为一行摘要；
- 8 秒后该条目可隐藏；
- request completed 且全部条目 hidden 后，再允许 overlay auto-close，默认不早于最后 completed 后 10 秒。

这些值必须可通过 manager options 覆盖，便于测试使用短时长。选项名必须沿用现有 `completedAutoCloseMs`，不得新增不兼容别名。

### 10.2 打开

- 只有当流式事件包含可展示的 query、source、citation、action detail、error，或能归并到已有可展示 status 时才打开 overlay。
- queryless lifecycle placeholder 只参与后续归并，不直接渲染。
- `image_generation_call` 不打开 overlay。
- runtime 缺少 overlay custom UI 时直接 no-op；不得设置永久 disabled。

### 10.3 更新

- overlay 已打开时，后续状态变化调用 `requestRender()`。
- `requestRender()` 抛错或 reject：结束当前 tracker、取消 timer、记录 warning；不设置全局永久 disabled。
- 当前 tracker 已被 final card / auto-close / manual close / dispose 关闭后，迟到事件不得重新打开旧 overlay。

### 10.4 关闭

- final provider result idle flush display card 插入成功：立即关闭当前 active overlay。
- `response.completed`：不立即关闭，只触发 completed 状态和条目级折叠 / 隐藏。
- auto-close：仅关闭当前 tracker。
- 手动 `q` / `Esc`：关闭当前 tracker，并忽略同一 tracker 的迟到事件。
- runtime `dispose()`：关闭当前 tracker，但不污染 manager。
- session switch / shutdown / branch：关闭所有 active tracker。

### 10.5 重新出现

- 后续新的 `before_provider_request` 会创建新的 tracker。
- 新 tracker 不受之前正常关闭影响。
- final card、auto-close、手动关闭、runtime dispose、单次 UI failure 后，同一 manager 的新 tracker 都必须能再次打开 overlay。

## 11. 文件职责

### 11.1 `src/provider-results.ts`

负责：

- provider result extraction；
- shared web_search identity helper；
- action detail extraction；
- final result completeness 判定。

不得负责 UI 状态、timer 或 overlay 生命周期。

### 11.2 `src/provider-tool-live-status.ts`

负责：

- tracker 状态机；
- lifecycle event 归一化；
- stable key 归并；
- 条目级 visibility；
- timer 管理；
- overlay renderer snapshot；
- overlay close / dispose / fail 幂等。

不得重新实现 final result extraction；必须复用 shared helper。

### 11.3 `src/responses-stream-observer.ts`

负责：

- raw SSE / SDK iterable 原样转发；
- live event 识别与转发；
- request terminal event 转发；
- image keepalive / interruption 不回退。

不得在 stream observer 中做最终 UI 插入或 overlay 关闭策略。

### 11.4 `src/provider-result-renderer.ts`

负责：

- final result card 渲染；
- 折叠 / 展开状态；
- `Ctrl+O` 交互；
- message renderer 和可复用 component 创建入口。

必须避免把 non-overlay custom UI 生命周期和 card 持久化语义耦合。

### 11.5 `src/extension.ts`

负责：

- `message_end` / `agent_end` 提取完整 final provider result；
- pending final card 队列、去重和 idle-gated flush；
- display custom message 插入；
- context hook 过滤 UI-only final card；
- idle flush 插入成功后关闭 overlay；
- UI-only `custom` entry persistence 与 replay；
- 缺少能力时的安全 warning；
- session switch / shutdown / branch 清理。

不得用 `ctx.ui.custom(..., { overlay: false })` 展示 final card。不得在 `ctx.isIdle() === false` 时用无 `deliverAs` 的 `api.sendMessage` 发送 final card。

## 12. 测试策略

所有行为变更必须先写失败测试，再改实现。

### 12.1 `test/responses-stream-observer.test.ts`

新增 / 调整测试：

- `response.web_search_call.in_progress` 被识别为 live web_search lifecycle。
- `response.web_search_call.completed` 被识别并转发给 tracker。
- lifecycle event 只有 `item_id` 时不要求 `event.item`。
- `in_progress -> response.completed` 和 `searching -> response.completed` 两条只有 `item_id` 的序列都会设置 saw-live 标记并转发 request completion。
- `response.completed` 在已有 web_search lifecycle 后转发给 tracker，但不调用 `clear()`。
- raw SSE 原样透传。
- `image_generation_call` 不进入 live tracker。
- SDK iterable 路径与 raw SSE 路径不会重复 terminal event。

### 12.2 `test/provider-tool-live-status.test.ts`

新增 / 调整测试：

- `in_progress` / `searching` / `completed` 只有 `item_id` 时能更新同一 status。
- queryless placeholder 不打开 overlay。
- 后续 `output_item.done` 带 query 时能归并到同 `item_id` placeholder 并打开 overlay。
- `completed` 后完整展示、折叠、隐藏、auto-close 的时序符合 options。
- 默认 completed 可见时间不短于新默认值。
- 多个 call 中，一个 completed 隐藏后，仍显示正在 searching 的 call。
- 同 normalized query 但不同 final `web_search_call.id` 不合并。
- overlay 文本不包含 `unknown`、`res_`、`resp_`。
- `requestRender()` 失败只关闭当前 tracker；新 tracker 仍可打开 overlay。
- manual close / auto-close / dispose 后新 tracker 可打开 overlay。

### 12.3 `test/provider-results.test.ts`

新增 / 调整测试：

- `search` action 提取 `query` / `queries[]`。
- `open_page` action 提取 URL action detail。
- `find_in_page` action 提取 pattern action detail。
- statusless 但有 id/query/source/citation/action detail 的 final result 会保留。
- `in_progress` / `searching` 不作为 completed final card。
- normalization 不做展示截断，避免不同长 query 被误合并。

### 12.4 `test/provider-result-renderer.test.ts`

新增 / 调整测试：

- component creator 不依赖 `ctx.ui.custom`。
- 默认折叠内容包含 summary 和 `Ctrl+O` 提示。
- `Ctrl+O` 展开后显示 queries / citations / sources / action details。
- `setExpanded(true)` 和 `setExpanded(false)` 可展开 / 收起。
- `q` / `Esc` 不关闭 final card。

### 12.5 `test/extension.test.ts`

新增 / 调整测试：

- `message_end` / `agent_end` streaming 期间只加入 pending final card 队列，不调用默认 steer / followUp / nextTurn，不提前关闭 overlay。
- `turn_end` / idle flush 后 interactive final result 调用 display custom message path，`options` 不包含 `deliverAs: "nextTurn"`，不包含 `triggerTurn: true`。
- interactive final result 不调用 `ctx.ui.custom(..., { overlay: false })`。
- display custom message 带 `details.uiOnly === true` 和 `details.resultKey`。
- `context` hook 过滤本插件 UI-only final card，且不过滤其它 custom messages。
- final card 在 idle flush 插入成功后关闭 live overlay。
- final card 插入失败不关闭 live overlay，不使用 notify / showStatus 伪装成功。
- 插入成功后调用 `api.appendEntry(PROVIDER_TOOL_RESULT_ENTRY_TYPE, data)`；appendEntry 失败只 warning。
- `session_start` / `session_switch` / `session_tree` 从当前 branch replay UI-only custom entries，按 `resultKey` 去重，不重复 appendEntry；replay 也必须经过 idle-gated display path。
- `message_end` incomplete result 不插入 card，不关闭 overlay。
- `agent_end` completed result 可作为兜底加入 pending 队列，且去重。
- `ctx.hasUI === false` 的 headless fallback 若仍保留，必须只用非触发式兼容路径，不能作为 interactive 主路径。
- 没有 display path 能力时，不破坏 editor，不调用 non-overlay custom；interactive 验收不得把 warning/no card 视为成功。

### 12.6 `test/docs.test.ts`

文档测试需要覆盖：

- final `web_search` card 是 idle-gated display custom message + context hook filtering + UI-only custom entry replay；
- 不使用 non-overlay `ctx.ui.custom` 作为最终回显；
- interactive runtime 不使用 `nextTurn` 主路径；
- overlay 支持 `in_progress` / `searching` / `completed` lifecycle；
- completed overlay 展示、折叠、隐藏、auto-close 的新时序；
- `image_generation` 不使用 live overlay；
- README / runtime compatibility 不再包含 non-overlay final card editor-resident 旧断言。

## 13. 必须保留的 `image_generation` 回归验证

由于本次会修改 `responses-stream-observer.ts` 和 `extension.ts`，必须保留或运行以下回归：

- web_search-only 请求不注册 image keepalive。
- combined `web_search` + `image_generation` stream 仍能触发 image interruption。
- `image_generation_call` 不进入 live tracker，但 raw stream 被正确截断并追加 `[DONE]`。
- `message_end` / `agent_end` 图片保存与最终回显仍通过。
- image result 仍作为 image attachment / context bridge 进入后续编辑上下文。
- provider-native `image_generation` payload injection、configured params、active tool conflict removal / restore 不回退。

必须纳入 focused 验证：

```bash
bun test test/request-injection.test.ts
```

## 14. 子代理实施计划

后续开发不使用 worktree，直接在当前主分支 / 当前工作树开发。不得读取 `C:/Users/34404/.omp/agent/models.yml`。新启动子代理必须提供本规格完整路径、必要 plan 路径和完整上下文；review 循环通过后才能进入实现。

### 14.1 任务 A：result extraction / identity / action details

**主改文件：**

- `src/provider-results.ts`
- `test/provider-results.test.ts`

**不得触碰：** `src/extension.ts`、`src/provider-tool-live-status.ts`、`src/responses-stream-observer.ts`。

**依赖：** 无，可先行。

**验收命令：**

```bash
bun test test/provider-results.test.ts
```

**交付：** 补齐 action detail extraction、completeness 判定、shared identity helper。

### 14.2 任务 B：stream observer lifecycle coverage

**主改文件：**

- `src/responses-stream-observer.ts`
- `test/responses-stream-observer.test.ts`

**不得触碰：** final card / renderer / docs。

**依赖：** 无，可与任务 A、C、D 并行；如需 shared helper，必须等待任务 A 或只使用公开合同。

**验收命令：**

```bash
bun test test/responses-stream-observer.test.ts
```

**交付：** 识别并转发 `in_progress` / `searching` / `completed` lifecycle event，保持 raw SSE 和 image behavior。

### 14.3 任务 C：live overlay 状态机

**主改文件：**

- `src/provider-tool-live-status.ts`
- `test/provider-tool-live-status.test.ts`

**不得触碰：** final card delivery、docs。

**依赖：** 需要任务 A 的 helper 合同；如果任务 A 未完成，可先按规格中的函数签名编写测试，集成时由主代理合并。

**验收命令：**

```bash
bun test test/provider-tool-live-status.test.ts
```

**交付：** `item_id` placeholder、stable merge、new completed timings、timer 安全、overlay 可恢复。

### 14.4 任务 D：renderer component / message renderer

**主改文件：**

- `src/provider-result-renderer.ts`
- `test/provider-result-renderer.test.ts`

**不得触碰：** extension delivery lifecycle、stream observer。

**依赖：** 可与任务 A/B/C 并行。

**验收命令：**

```bash
bun test test/provider-result-renderer.test.ts
```

**交付：** 可复用 component creator、message renderer 兼容、`setExpanded()` 展开 / 收起、action details 渲染。

### 14.5 任务 E：extension final card delivery / context filtering / replay

**主改文件：**

- `src/extension.ts`
- `src/types.ts`
- `test/extension.test.ts`

**不得触碰：** stream observer 状态机实现、docs。

**依赖：** 需要任务 D 的 renderer 入口；需要任务 A 的 result shape。建议在 A/D 完成后启动，或由主代理合并接口后分派。

**验收命令：**

```bash
bun test test/extension.test.ts --timeout 10000
```

**交付：** 移除 non-overlay final custom path；interactive 主路径使用 idle-gated display custom message，不用 `nextTurn`；注册 context hook；append custom entry；session_start / session_switch / session_tree replay；idle flush 插入成功关闭 overlay。

### 14.6 任务 F：docs / docs tests

**主改文件：**

- `README.md`
- `docs/runtime-compatibility.md`
- `test/docs.test.ts`

**不得触碰：** runtime implementation。

**依赖：** A-E 行为合同稳定后最后执行。

**验收命令：**

```bash
bun test test/docs.test.ts
```

**交付：** 删除旧 non-overlay final card 文案，记录 idle-gated display custom message + context filtering + UI-only custom entry replay 语义，更新 overlay lifecycle 描述。

## 15. 集成验证

完成实现和审查循环后执行：

```bash
bun test test/provider-tool-live-status.test.ts
bun test test/responses-stream-observer.test.ts
bun test test/extension.test.ts --timeout 10000
bun test test/provider-results.test.ts test/provider-result-renderer.test.ts test/docs.test.ts test/request-injection.test.ts
bun test
bun pm pack --dry-run
git diff --check
```

随后使用已链接插件在真实 OMP runtime 中验证：

- provider-native `web_search` 请求期间 overlay 出现；
- 多次搜索 lifecycle 都能在 overlay 中反映；
- completed 后 overlay 保留、折叠、延迟关闭；
- 请求结束并进入 idle flush 后 final card 立即出现在 chat transcript。
- 输入区不消失；
- 后续用户消息的 provider request 中不包含 final card 文本；
- 重启 / resume / tree navigation 后 TUI 不异常；
- final card 可从 UI-only custom entry replay（若当前 branch 包含对应 entry）；
- `image_generation` payload / interruption / saving 不回退。

## 16. 验收标准

- OpenAI Responses `web_search` 的 `in_progress`、`searching`、`completed` lifecycle event 均被 observer 识别。
- lifecycle event 只有 `item_id` 时不会被忽略，也不会渲染成 `unknown`。
- 同一 `item_id` 的 lifecycle 与 final `output_item.done` 合并为同一 overlay status。
- overlay completed 后完整显示不少于新默认 `completedCollapseMs`，折叠后延迟隐藏，最后才 auto-close。
- final `web_search` 回显在 idle flush 后立即插入 chat transcript，不等待下一轮用户消息。
- final 回显不调用 non-overlay `ctx.ui.custom`，不导致 editor 消失。
- interactive runtime 主路径不调用 `api.sendMessage(..., { deliverAs: "nextTurn" })`。
- interactive runtime 不在 streaming / prompt-in-flight 状态下用无 `deliverAs` 的 `api.sendMessage` 发送 final card。
- final 回显默认折叠，`Ctrl+O` 可展开详情。
- final 回显不进入 LLM context；context hook 过滤本插件 `uiOnly` display message。
- final 回显插入成功后关闭实时 overlay。
- final 回显插入失败不会伪装成功，不会错误关闭 overlay。
- UI-only custom entry replay 只针对当前 branch，按 `resultKey` 去重。
- `image_generation` 现有行为全部通过回归测试。
- Focused tests、full tests、pack dry-run、diff check 通过。
- 真实 OMP runtime 验证不再出现输入区消失和回显缺失。

## 17. 风险与约束

- `api.sendMessage` 的 display custom message 默认会进入 LLM context；必须用 `context` hook 过滤。没有过滤测试不得通过。
- 在 `message_end` / `agent_end` 期间 `ctx.isIdle()` 可能仍为 false；final delivery 必须等待 idle-gated flush，避免 `sendCustomMessage()` 默认 steer。
- `custom` entry replay 只能读取当前 branch，不能 replay 非当前分支旧结果。
- `appendEntry` 写入不等同于即时显示；即时显示仍依赖 display custom message path。
- `appendEntry` 会推进 session leaf；实现必须验证这不会破坏当前 turn 的 dedupe / replay。若发现副作用，必须改用最小可行 UI-only persistence 策略并补测试。
- Provider 的 stream event 格式可能随模型或中转站变化，归并逻辑必须容忍缺失 ID、缺失 query 和迟到 final item。
- Timer 增加状态复杂度，`clear()` / `dispose()` / `fail()` 后必须取消或失效所有 timer。
- 不能依赖 `response.id` 作为 search call ID；`response.id` 只能作为请求级上下文。
- 不能读取、修改或输出 `C:/Users/34404/.omp/agent/models.yml`。

## 18. 明确禁止清单

- 禁止把 final `web_search` 回显改回 `deliverAs: "nextTurn"` interactive 主路径。
- 禁止用 non-overlay `ctx.ui.custom` 展示长期 final card。
- 禁止用纯文本 `notify` / `showStatus` 替代插件自定义 card。
- 禁止在 streaming / prompt-in-flight 状态下用无 `deliverAs` 的 `api.sendMessage` 发送 final card。
- 禁止为了避免 TUI 异常而完全移除 final 回显。
- 禁止让 final 回显进入 LLM context。
- 禁止只写 `custom` entry 却不即时显示，然后宣称 final card 已显示。
- 禁止在 event 不完整时伪造 final provider result。
- 禁止吞掉 overlay / final UI 异常后宣称成功。
- 禁止修改 API key 或读取 `models.yml`。
