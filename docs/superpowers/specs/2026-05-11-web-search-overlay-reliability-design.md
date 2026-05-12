# Provider Tool Web Search Overlay 全面修复设计

**日期：** 2026-05-11

## 背景

`omp-openai-provider-tools` 已经为 provider-native `web_search` 实现了实时 overlay 和最终 UI-only 回显。当前实现能在流式 `web_search_call` 事件到达时打开 overlay，并在 `message_end` / `agent_end` 最终回显路径中关闭 overlay。

但实际使用中暴露出 3 类问题：

1. completed 的搜索条目只会触发整个 overlay 的 auto-close，不会在 overlay 内按条目折叠或隐藏。
2. overlay 中的搜索条目与最终 summary 不一致，尤其会显示类似 `res...unknown` 的临时 ID 或 placeholder ID。
3. 某些关闭路径后 overlay 不再出现，用户期望是：新的 `web_search` 流式事件再次触发 overlay；最终 `web_search` 回显触发 overlay 消失。

本规格用于全面修复 provider-native `web_search` live overlay 的生命周期、条目归并和最终回显一致性。当前阶段只定义设计，不实施代码修改。

## 目标

- `web_search` 流式事件触发 overlay 出现；最终 `web_search` 回显触发 overlay 消失。
- completed 搜索条目在短暂展示后从 overlay 中折叠或隐藏，而不是只能等待整个 overlay 关闭。
- overlay 中展示的搜索条目与最终 summary 使用同一套归并语义，避免同一次搜索被拆成 `res...unknown` / `ws...` 等多个条目。
- overlay 被最终回显、auto-close、手动关闭或 runtime dispose 关闭后，后续新的 provider request / 新的 `web_search` 流式事件仍能重新打开 overlay。
- 错误路径隔离：单次 overlay UI 失败不能永久禁用整个插件会话的后续 overlay。
- 保持 UI-only：实时 overlay 和最终 card 都不写入 LLM 上下文，不触发 steer。
- 不影响 `image_generation` 的 keepalive、可选 interruption、图片保存、最终回显和后续编辑上下文桥。

## 非目标

- 不修改 OMP / Pi runtime 源码。
- 不引入 host-side 搜索或额外 search provider。
- 不把 provider 内部原始搜索结果写入 LLM 上下文。
- 不为 `image_generation` 增加实时 overlay。
- 不改变 provider-native tool 注入规则、active tool conflict 处理或 `tool_choice` 策略。
- 不重新设计最终 provider result custom card 的视觉样式；只保证它能作为 overlay 生命周期的关闭信号。
- 不用 `notify`、`showStatus` 或短状态 widget 替代最终 `web_search` 回显。

## 现状根因

### 条目级 completed 折叠缺失

当前 `ProviderToolLiveTracker` 只有 tracker 级 `pendingAutoClose`。当所有状态 completed 时，`scheduleAutoClose()` 最终调用 `clear()` 关闭整个 overlay。`LiveToolStatus` 没有 `completedAt`、`collapseAfter`、`hideAfter`、`visibility` 等条目级字段，`renderProviderToolLiveOverlay()` 也不会按 completed 时间过滤单个 call。

结果是：completed 条目在 overlay 内一直完整显示，直到整个 overlay 关闭。

### 流式状态与最终 summary 使用不同身份体系

当前 overlay 使用 `getStatusId(item, event)`：

1. 优先使用 `item.id`。
2. 没有 `item.id` 时使用 `${eventType}:${query}`。
3. 没有 query 时退化到 `unknown`。

最终 summary 则只解析 `providerPayload.items[]` 中的最终 `web_search_call`。如果 provider 的流式事件先发出临时事件或临时 ID，再在最终 history 中保留正式 call ID，overlay 会把同一次搜索拆成多个状态。

典型事件序列：

```json
{ "type": "response.web_search_call.searching", "item": { "type": "web_search_call", "id": "res_123" }, "query": "foo" }
{ "type": "response.output_item.done", "item": { "type": "web_search_call", "id": "ws_abc", "status": "completed", "action": { "query": "foo" } } }
```

当前 overlay 会显示 `res_123` 和 `ws_abc` 两个条目；最终 summary 只显示 `ws_abc`。

### Overlay 关闭后的可恢复性不足

当前 close 路径会把当前 tracker 置为 ended，这对单个请求是正确的。但有两个风险：

- `disableAfterOverlayFailure()` 设置 manager 级 `disabled = true`，一次 `ctx.ui.custom` 或 `requestRender()` 失败会让同一 manager 后续所有 tracker 都不再显示 overlay。
- `message_end` / `agent_end` 的 `finally { clearLiveStatus(); }` 会无条件清理 active tracker。如果 runtime 发送的 lifecycle 事件并不对应最终 provider result 回显，overlay 可能被提前关闭；同一请求后续流式事件不会让该 tracker 重新打开。

## 设计原则

1. **请求级生命周期，条目级展示状态。** tracker 生命周期表示一次 provider request；call 状态表示每个 provider web search 调用。
2. **共享身份规范化。** live overlay 和 final summary 必须复用同一组 web_search query normalization / identity helper，禁止各自实现不同规则。
3. **稳定 ID 优先，ordinal 兜底。** 能用最终 `web_search_call.id` 时使用最终 ID；临时 ID 只能绑定到尚未拥有正式 ID 的 pending status；无法确认时使用请求内 ordinal 参与稳定 key，避免相同 query 的两个真实 call 被误合并。
4. **最终 custom card 是权威关闭信号。** 成功启动插件侧 final `web_search` custom card（`ctx.ui.custom(..., { overlay: false })`）后立即关闭 overlay；单纯 `response.completed` 只进入 completed 展示 / 条目折叠 / overlay auto-close 流程。
5. **关闭不等于永久禁用。** 手动关闭、最终回显关闭、auto-close 和 runtime dispose 都只关闭当前 tracker；后续新请求可再次打开 overlay。
6. **错误隔离。** 单个 overlay 组件失败最多禁用当前 tracker；缺少 `ui.custom` 时 no-op；不做全局永久熔断。
7. **不显示低置信 placeholder。** 没有 query、source、error 或可归并的正式 ID 时，不创建可渲染条目。

## 共享身份 helper 合同

新增或明确一组纯函数，由 `src/provider-results.ts` 或独立小模块拥有，live overlay 与 final summary 必须复用：

```ts
export function normalizeProviderWebSearchQueryForIdentity(value: unknown): string | undefined;
export function displayProviderWebSearchQuery(value: string): string;
```

语义：

- `normalizeProviderWebSearchQueryForIdentity()` 用于身份归并和 fingerprint：
  - 只接受非空 string。
  - `trim()` 后把所有空白（空格、换行、制表符）折叠为单个半角空格。
  - 保留完整未截断内容。
  - 大小写敏感，避免 provider 把大小写不同的查询视为不同调用时被误合并。
- `displayProviderWebSearchQuery()` 用于 UI 展示：
  - 基于 normalized query。
  - 可以截断到 UI 限制长度。
  - 绝不能把截断后的字符串用于 identity。

测试必须覆盖：

- `" Foo\nbar "` 与 `"Foo bar"` 归一到同一 identity。
- 两个 query 只在 140 字符之后不同，不得被 identity 合并。
- live overlay 与 final summary 使用同一 normalization 结果。

## 数据模型

### Tracker 级状态

```ts
type RequestPhase = "streaming" | "completed" | "failed" | "closed";

interface LiveTrackerState {
  requestPhase: RequestPhase;
  requestStartedAt: number;
  requestCompletedAt?: number;
  nextOrdinal: number;
}
```

说明：

- `response.completed` 设置 `requestPhase = "completed"` 和 `requestCompletedAt`，但不直接关闭 overlay。
- `response.failed` / top-level `error` / upstream error / cancel 设置 failed 或 closed，并清理当前 tracker。
- auto-close 条件必须同时满足：`requestPhase === "completed"` 且没有 renderable calls。

### `LiveToolStatus`

扩展当前内部状态：

```ts
type Phase = "queued" | "searching" | "completed" | "failed";
type Visibility = "visible" | "collapsed" | "hidden";

type ProviderIdKind = "temporary" | "final" | "unknown";

interface LiveToolStatus {
  stableKey: string;
  ordinal: number;
  displayId?: string;
  finalProviderItemId?: string;
  providerItemIds: Set<string>;
  providerIdKind: ProviderIdKind;
  phase: Phase;
  visibility: Visibility;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  collapseAfter?: number;
  hideAfter?: number;
  completionGeneration: number;
  queries: string[];
  status?: string;
  sourceCount?: number;
  error?: string;
}
```

说明：

- `stableKey` 是内部归并 key，不直接展示给用户。
- `ordinal` 是请求内递增序号，参与内容 fingerprint 兜底。
- `displayId` 只在可信时展示，例如最终 `ws_...` 或 provider 明确稳定 ID。
- `finalProviderItemId` 表示最终 `web_search_call` item ID；一个 status 一旦绑定 final ID，不能再被同 query 的另一个 final item 复用。
- `providerItemIds` 记录观察到的所有 provider item ID，用于后续归并。
- `providerIdKind` 用于禁止展示 `res_...`、`resp_...`、`unknown` 等低置信 ID。
- `completionGeneration` 或 `completedAt` 用作 timer 回调校验 token，避免 stale timer 隐藏新状态。

### `LiveOverlaySnapshot`

对 renderer 暴露精简后的 snapshot：

```ts
interface LiveOverlayCallSnapshot {
  id?: string;
  ordinal: number;
  phase: Phase;
  visibility: "visible" | "collapsed";
  queries: string[];
  sourceCount?: number;
  error?: string;
  updatedAt: number;
  completedAt?: number;
}
```

隐藏条目不进入 `snapshot.calls`。折叠条目只显示一行摘要，不显示完整 query 列表。

## 归并规则

### 事件归一化

新增内部函数将所有 live 事件转为统一 patch：

```ts
interface WebSearchLivePatch {
  providerItemId?: string;
  providerIdKind: "temporary" | "final" | "unknown";
  eventType: string;
  streamOrdinal: number;
  phase?: Phase;
  queryCandidates: string[];
  normalizedQueries: string[];
  sourceCount?: number;
  error?: string;
  isFinalItem: boolean;
  isRequestCompleted: boolean;
}
```

来源字段：

- `item.id` → `providerItemId`。
- `item.action.query`、`item.action.queries[]`、`item.query`、`event.query` → `queryCandidates`。
- 每个 query 通过 `normalizeProviderWebSearchQueryForIdentity()` 得到 `normalizedQueries`。
- `item.sources[]`、`item.action.sources[]`、`item.results[]` → `sourceCount`。
- `response.output_item.done` 或 `item.status === "completed"` → `isFinalItem = true`。
- `response.completed` → `isRequestCompleted = true`。

`providerIdKind` 判定：

- `ws_...`、`web_search...` 或 runtime 已知最终 `web_search_call` item ID 形态 → `final`。
- `res_...`、`resp_...` 或仅 response ID → `temporary`。
- 缺失或无法分类 → `unknown`。

### Stable key 选择顺序

1. 如果 `providerItemId` 已经映射到某个 status，使用该 status。
2. 如果 patch 是 final item 且带新的 final `providerItemId`：
   - 若能通过唯一 normalized query 匹配到一个尚未绑定 `finalProviderItemId` 的 pending / temporary status，则归并到该 status，并把 `finalProviderItemId` 更新为该 ID。
   - 若相同 query 已存在绑定了不同 `finalProviderItemId` 的 status，必须创建新 status。
3. 如果 patch 不是 final item 且带 query，优先匹配唯一的未完成、未绑定 final ID、query 相同的 status。
4. 如果同一 normalized query 有多个候选，不做猜测归并；创建新 status，并用 `streamOrdinal` 区分。
5. 如果没有 query/source/error，仅记录为不可渲染 pending patch，不进入 overlay snapshot。
6. 如果仍无法匹配，创建新 status：
   - final ID 可用时 `stableKey = id:${providerItemId}`。
   - 否则 `stableKey = content:${normalizedQuery}:${streamOrdinal}`。

### ID 展示规则

- 默认不展示 `res_...`、`resp_...` 或 `unknown` 这类低置信 ID。
- 如果存在 final `web_search_call` item ID，展示短 ID。
- 如果没有 final ID，展示 `search #N` 或不展示 ID，只展示 query。
- renderer 不应输出 `unknown`；测试必须断言 overlay 文本不包含 `unknown`。

## 请求完成规则

`response.completed` 是请求级 terminal event：

1. 设置 `requestPhase = "completed"` 和 `requestCompletedAt`。
2. 将当前 tracker 内所有非 terminal、可展示的 web_search call 标记为 `completed`。
3. 为这些 call 设置 `completedAt`、`collapseAfter`、`hideAfter` 和新的 `completionGeneration`。
4. 保持已有 `failed` call 为 failed。
5. 立即 render completed 状态，但不直接关闭 overlay。
6. 后续由条目级 collapse / hide timer 和 overlay auto-close 收敛。

如果流式过程中只有 searching 事件而没有逐条 `output_item.done`，收到 `response.completed` 后仍必须让该条目进入 completed，并按条目级折叠 / 隐藏时序收敛。

## 条目级 completed 折叠 / 隐藏

引入三个可配置时长，默认值可在 manager options 中覆盖：

```ts
completedCollapseMs = 1_500;
completedHideMs = 3_000;
completedOverlayAutoCloseMs = 4_000;
```

行为：

1. 单个 call 进入 completed 后，立即显示完整 completed 状态。
2. `completedCollapseMs` 后，该 call 从完整行折叠为一行摘要，例如：

   ```text
   └ web_search completed · "foo" · sources 3
   ```

3. `completedHideMs` 后，该 call 从 overlay 中隐藏。
4. 如果 `requestPhase === "completed"` 且所有 call 都 hidden，overlay 自动关闭。
5. 如果 final provider result custom card 先出现，立即关闭 overlay，取消所有条目级 timer。
6. 如果某个 completed call 已折叠，但同一请求又出现新的 searching call，overlay 重新渲染并显示新 call；旧 completed call 保持折叠或隐藏。

### Timer 安全规则

实现可以使用每 status timer，也可以使用 tracker 级最早 deadline timer；但必须满足：

- timer 回调执行前重新查找对应 status，并确认 tracker 未 ended。
- 回调必须校验 `phase === "completed"`，且 `completionGeneration` 或 `completedAt` 与创建 timer 时一致。
- status 被合并、重新进入 searching、进入 failed、被隐藏、final card close、clear、dispose、fail 时，相关 timer 必须取消或失效。
- timer 失效不得隐藏新创建或已复用的 status。

## Overlay 生命周期

### 打开

- 只有当流式事件包含可展示的 query、source、error 或可归并到已有可展示 status 时才打开 overlay。
- `image_generation_call` 不打开 overlay。
- queryless placeholder 事件只参与后续归并，不直接渲染。
- `typeof ui.custom !== "function"` 表示 runtime 缺少 overlay 能力：直接 no-op，不 warning，不设置 disabled。

### 更新

- overlay 已打开时，后续状态变化调用 `requestRender()`。
- `requestRender()` 抛错或 reject：结束当前 tracker、取消 timer、记录 warning；不设置全局永久 `disabled`。
- 每个 tracker 最多记录一次 UI failure warning；如果需要避免日志刷屏，只能做日志限流，不能改变 overlay 可重试语义。
- 如果当前 tracker 因最终回显或 auto-close ended，来自同一 tracker 的迟到事件忽略。

### 关闭

- final provider result custom card 启动成功：立即关闭当前 active overlay。
- `response.completed`：不立即关闭，只触发 completed 状态和条目级折叠 / 隐藏。
- auto-close：仅关闭当前 tracker。
- 手动 `q` / `esc`：关闭当前 tracker，并忽略同一 tracker 的迟到事件。
- runtime `dispose()`：关闭当前 tracker，但不污染 manager。
- session switch / shutdown / branch：关闭所有 active tracker。

### 重新出现

- 后续新的 `before_provider_request` 会创建新的 tracker。
- 新 tracker 不受之前正常关闭影响。
- final card、auto-close、手动关闭、runtime dispose、单次 UI failure 后，同一 manager 的新 tracker 都必须能再次打开 overlay。
- 单次 UI failure 不阻断后续新 tracker；如果 runtime 永久不支持 custom overlay，则每次 no-op，但不污染 manager 状态。

## 最终回显一致性

最终 summary 仍由 `providerPayload.type === "openaiResponsesHistory"` 提取。为保持一致性：

- overlay 的归并 key 应尽量收敛到最终 `web_search_call.id`。
- final result card 关闭 overlay 前，不需要把 final card 内容反向写入 overlay；但相同 query 的临时状态不得在关闭前显示为另一条独立 call。
- message_end 中如果没有完整 provider result，不应把 overlay 作为最终完成信号清掉；只有完成的 provider result custom card 启动成功后才关闭 overlay。
- agent_end 作为兜底，若能提取完整 provider result，则启动 final custom card 并关闭 overlay；如果不能提取，不应错误地把实时 overlay 当成最终结果。
- 非 overlay final card 的 Promise 可能长期不 resolve，关闭 overlay 的时机是 custom card 调用同步启动成功，而不是等待 Promise resolve。
- 如果 custom card 同步抛错或无法启动，不得用 `notify` / `showStatus` 伪装成功回显，也不得把 `message_end` / `agent_end` 本身当成关闭信号；overlay 按 completed 折叠 / 隐藏 / auto-close 或当前 tracker failure 语义收敛。

### fallback 约束

`ctx.ui.custom(..., { overlay: false })` 是最终 `web_search` 回显的首选且唯一交互 UI path。只有 runtime 完全没有 custom UI 能力时，才允许使用现有兼容 fallback：`api.sendMessage(message, { deliverAs: "nextTurn" })`。

fallback 规则：

- fallback 只用于旧 runtime / headless 兼容，不得在支持 custom UI 的 runtime 中替代失败的 custom card。
- fallback 必须非触发式：`deliverAs: "nextTurn"`，不得设置 `triggerTurn: true`。
- fallback 启动成功后可以作为最终回显关闭 overlay；但如果 fallback promise reject，记录 warning，不得触发 steer。

## 文件职责

### `src/provider-results.ts` 或 `src/provider-web-search-identity.ts`

- 拥有共享 web_search query normalization 和 identity/fingerprint helper。
- final summary 与 live overlay 必须复用这些 helper。
- 不负责 UI 状态、timer 或 overlay 生命周期。

### `src/provider-tool-live-status.ts`

- 维护 tracker 与 overlay 状态机。
- 实现事件归一化、stable key 归并、条目级 visibility、条目 timer 和 renderer snapshot。
- 保证 close / dispose / fail / clear 幂等。
- 移除或收窄全局永久 `disabled` 行为。
- 只依赖共享 helper，不重新定义 identity normalization。

### `src/responses-stream-observer.ts`

- 继续原样转发 raw SSE / SDK iterable 事件。
- 保证只把 displayable 或 lifecycle 必要事件转发给 tracker。
- 不在 stream observer 中做 UI 关闭决策；关闭由 tracker 和 extension lifecycle 控制。
- 保持 image keepalive / interruption 路径不回退。

### `src/extension.ts`

- 将 overlay 关闭信号从「所有 `message_end` / `agent_end`」收窄为「完整 provider result final custom card 或允许的 fallback 成功启动」。
- lifecycle hooks（session switch / shutdown / branch）仍无条件清理。
- 保持 provider result final card UI-only，不进入 LLM 上下文。
- 不等待非 overlay custom card 的长期 Promise resolve 才关闭 overlay。

### 测试文件

- `test/provider-tool-live-status.test.ts`：覆盖状态机、归并、折叠 / 隐藏、可恢复性。
- `test/responses-stream-observer.test.ts`：覆盖 live event 转发与 terminal event 行为。
- `test/extension.test.ts`：覆盖最终 card 关闭 overlay、非完整 message_end / agent_end 不提前关闭、新请求重新打开、fallback 非触发式。
- `test/provider-results.test.ts` 或现有相关测试：覆盖共享 identity helper。
- `test/docs.test.ts`：覆盖 README 和 runtime compatibility 文档中的行为描述。

## 并发实施边界

后续使用子代理开发时按以下边界拆分，减少冲突：

1. **Identity helper 任务（优先或与 live status 同一子代理执行）**
   - 主改：`src/provider-results.ts` 或新增 `src/provider-web-search-identity.ts`。
   - 测试：对应 provider results / identity 测试。
   - 输出共享函数合同，其他任务不得重新实现 query normalization。
2. **Live status manager 任务**
   - 主改：`src/provider-tool-live-status.ts`。
   - 测试：`test/provider-tool-live-status.test.ts`。
   - 负责状态机、visibility、timer、归并、可恢复性。
3. **Stream observer 任务**
   - 主改：`src/responses-stream-observer.ts`。
   - 测试：`test/responses-stream-observer.test.ts`。
   - 只负责事件转发和 terminal event 传递，不做 UI 关闭策略。
4. **Extension lifecycle 任务**
   - 主改：`src/extension.ts`。
   - 测试：`test/extension.test.ts`。
   - 只通过 live status manager 的公开 close/clear API 关闭 overlay，不重新实现 live 状态机。
5. **Docs 任务**
   - 主改：`README.md`、`docs/runtime-compatibility.md`、`test/docs.test.ts`。
   - 必须最后执行或在行为合同稳定后执行，禁止重新定义实现行为。

如果多个任务必须触碰同一文件，以该文件对应任务为主改，其他任务只补测试或调用公开接口。

## 测试策略

### 单元测试：identity helper

新增或调整测试：

- `" Foo\nbar "` 与 `"Foo bar"` 归一到同一 identity。
- 两个 query 只在展示截断长度之后不同，不得被 identity 合并。
- final summary 和 live overlay 使用同一 normalized query。

### 单元测试：live status manager

新增或调整测试：

- completed call 在 `completedCollapseMs` 后折叠，在 `completedHideMs` 后隐藏。
- 多个 call 中，一个 completed 隐藏后，仍显示仍在 searching 的 call。
- call hidden 但 `requestPhase !== "completed"` 时 overlay 不 auto-close；收到 `response.completed` 后才按条件 close。
- 全部 completed 且全部 hidden 后关闭 overlay。
- `response.web_search_call.searching` 临时 ID 与 `response.output_item.done` 正式 ID 通过相同 query 归并为一个 call。
- 两个不同 final `web_search_call.id` 使用相同 query 时，不得合并成一个 call。
- overlay 文本不包含 `unknown`。
- queryless placeholder 不打开 overlay，但后续带 query 的 done 事件能归并并打开 overlay。
- 只有 searching 事件后收到 `response.completed` 时，该条目进入 completed，并按 collapse / hide / auto-close 时序收敛。
- 重复 completed 更新后，旧 timer 不隐藏新状态。
- status merge 后，旧 timer 不泄漏、不误隐藏已合并状态。
- 手动关闭当前 tracker 后，同 manager 新 tracker 仍能打开 overlay。
- completed hide / auto-close 关闭当前 tracker 后，同 manager 新 tracker 仍能打开 overlay。
- runtime `dispose()` 当前 overlay 后，同 manager 新 tracker 仍能打开 overlay。
- `requestRender()` 抛错只关闭当前 tracker；后续新 tracker 仍能打开 overlay。
- 迟到事件不得重新打开已关闭的旧 tracker。

### 单元测试：stream observer

新增或调整测试：

- `response.completed` 在已有 web_search 事件后仍转发给 tracker，但不调用 `clear()`。
- `response.failed` / top-level `error` 仍 fail + clear。
- raw SSE 原样转发。
- image-only event 不进入 live tracker。
- SDK iterable 路径与 raw SSE 路径不会重复 terminal event。

### 集成测试：extension

新增或调整测试：

- `message_end` 含完整 completed `web_search_call` 时：启动 final custom card，并关闭 overlay。
- `message_end` 不含 providerPayload 或只有 `web_search_call.status = "in_progress"` 时：不显示 final card，也不关闭 overlay。
- `agent_end` 不含 providerPayload 或只有 incomplete result 时：不显示 final card，也不关闭 overlay。
- `agent_end` 含完整 result 时作为兜底：启动 final custom card，并关闭 overlay。
- final card 的 `ctx.ui.custom(..., { overlay: false })` 返回永不 resolve 的 Promise 时，overlay 仍在调用成功后立即关闭。
- custom card 同步抛错时，不使用 notify / showStatus 伪装成功；overlay 不因 `message_end` / `agent_end` 本身被关闭。
- 没有 custom UI 能力时，fallback `sendMessage(..., { deliverAs: "nextTurn" })` 成功启动后关闭 overlay，且不得设置 `triggerTurn: true`。
- fallback promise reject 时记录 warning，不触发 steer。
- final card 关闭 overlay 后，下一次 `before_provider_request` + live web_search event 能重新打开 overlay。
- completed overlay 在 final card 之前保留，条目按时间折叠 / 隐藏。
- UI-only 断言保持：实时 overlay 不调用 `sendMessage`，final custom card 不触发 steer。

### 必须保留的 `image_generation` 回归验证

由于本次会修改 `responses-stream-observer.ts` 和 `extension.ts`，必须保留或运行以下回归：

- web_search-only 请求不注册 image keepalive。
- combined `web_search` + `image_generation` stream 仍能触发 image interruption。
- `image_generation_call` 不进入 live tracker，但 raw stream 被正确截断并追加 `[DONE]`。
- `message_end` / `agent_end` 图片保存与最终回显仍通过。
- image result 仍作为 image attachment / context bridge 进入后续编辑上下文。

### 文档测试

- README 中文 / 英文段落描述：
  - live event 打开 overlay。
  - completed 条目短暂展示后折叠 / 隐藏。
  - final `web_search` custom card 关闭 overlay。
  - overlay 正常关闭后后续搜索可再次打开。
  - `image_generation` 无 live overlay。
- runtime compatibility 描述与实现一致。

## 验收标准

- 用户触发 provider-native `web_search` 时，流式事件能打开 overlay。
- 同一次搜索不会因临时 ID / 正式 ID 不同而在 overlay 中显示成多条。
- 同一请求内两个正式 `web_search_call` 使用相同 query 但不同 ID 时，overlay 不得合并成一条。
- overlay 文本不显示 `unknown` 作为 call ID。
- completed 条目在短暂展示后折叠或隐藏；仍在进行的条目不受影响。
- 最终 `web_search` custom card 出现时，overlay 立即关闭。
- overlay 被 final card、auto-close、手动关闭或 dispose 关闭后，下一次 provider-native `web_search` 能重新出现。
- 单次 overlay UI 异常不会永久禁用本会话后续 overlay。
- 非完整 `message_end` / `agent_end` 不提前关闭 overlay。
- `image_generation` 行为、provider-native tool 注入、host-side conflict 处理、最终 image 保存 / 回显不回退。
- 实现完成后至少运行并通过：
  - `bun test test/provider-tool-live-status.test.ts`
  - `bun test test/responses-stream-observer.test.ts`
  - `bun test test/extension.test.ts`
  - `bun test test/provider-result-renderer.test.ts test/docs.test.ts`
  - `bun test`
  - `bun pm pack --dry-run`
  - `git diff --check`

## 风险与约束

- Provider 的流式事件格式可能随模型或中转站变化。归并规则必须容忍缺失 ID、缺失 query 和迟到 final item。
- 条目级 timer 增加状态机复杂度，必须保证 `clear()` / `dispose()` / `fail()` 后没有 timer 泄漏。
- 不能依赖 `response.id` 作为 search call ID；`response.id` 只能作为请求级上下文。
- 最终回显仍受 runtime 是否保留 `providerPayload` 影响；缺失 final history 时只能保持实时 overlay 的临时语义，不能伪造最终结果。
- 非 overlay final card 是长期占用 editor 的预期行为，不应被本次修复改成 auto-close。
