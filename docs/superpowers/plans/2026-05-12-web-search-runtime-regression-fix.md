# Web Search Runtime 回归修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。所有行为变更必须遵循 TDD：先写失败测试，验证红灯，再写最少实现，验证绿灯。

**目标：** 修复 provider-native `web_search` 在真实 OMP runtime 中的 overlay 漏计数、completed 后过快消失、最终回显缺失和 editor 消失问题。

**架构：** 先补齐 result extraction / identity / action detail 合同，再并行修复 stream observer 和 live overlay 状态机。最终回显改为 idle-gated display custom message + context hook filtering + UI-only custom entry replay，彻底移除 non-overlay `ctx.ui.custom` final card 路径。文档最后跟随稳定行为更新。

**技术栈：** TypeScript、Bun test、OMP/Pi extension API、OpenAI Responses SSE / SDK iterable wrapper、OMP custom message renderer、session `custom` entry。

---

## 规格与约束

- 当前权威规格：`C:/tmp/omp-openai-provider-tools/docs/superpowers/specs/2026-05-12-web-search-runtime-regression-fix-spec.md`
- 旧规格背景参考：`C:/tmp/omp-openai-provider-tools/docs/superpowers/specs/2026-05-11-web-search-overlay-reliability-design.md`
- 旧计划背景参考：`C:/tmp/omp-openai-provider-tools/docs/superpowers/plans/2026-05-11-web-search-overlay-reliability.md`
- 本计划 supersedes 旧计划中关于 final non-overlay custom card 的任务内容。
- 直接在 `master` / 当前工作树开发，不使用 worktree。
- 不读取或输出 `C:/Users/34404/.omp/agent/models.yml`。
- 不使用 non-overlay `ctx.ui.custom(..., { overlay: false })` 展示最终 `web_search` 回显。
- interactive runtime 主路径不得使用 `api.sendMessage(..., { deliverAs: "nextTurn" })`。
- streaming / prompt-in-flight 期间不得用无 `deliverAs` 的 `api.sendMessage` 发送 final card；必须等 idle-gated flush。
- 不使用纯文本 `notify` / `showStatus` / 短 widget 替代最终 `web_search` card。
- 新启动子代理时必须提供本计划完整路径和规格完整路径，并提供完整上下文。
- Review 子代理只读；实现子代理按文件边界分派，避免同时修改同一文件。

## 文件结构

- `src/provider-results.ts`
  - provider result extraction、shared query identity、action detail extraction、final completeness 判定。
- `src/responses-stream-observer.ts`
  - OpenAI Responses stream / SDK iterable 事件识别与转发，补齐 `web_search_call.in_progress/completed`。
- `src/provider-tool-live-status.ts`
  - live overlay 状态机、`item_id` placeholder、stable merge、completed timing、timer 安全。
- `src/provider-result-renderer.ts`
  - final card renderer、message renderer、component creator、`setExpanded()` 交互。
- `src/extension.ts`
  - final card delivery、idle-gated display custom message、context hook filtering、UI-only custom entry replay、overlay 关闭。
- `src/types.ts`
  - 测试 shim / minimal runtime-like 类型补充，避免用 `any` 扩散。
- `README.md`
  - 更新用户可见行为说明，删除旧 non-overlay final card 文案。
- `docs/runtime-compatibility.md`
  - 更新 runtime 兼容性和 fallback 边界。
- `test/provider-results.test.ts`
  - result extraction 和 identity 测试。
- `test/responses-stream-observer.test.ts`
  - lifecycle event / terminal event / raw SSE / image event 回归。
- `test/provider-tool-live-status.test.ts`
  - overlay 状态机、merge、timing、恢复性测试。
- `test/provider-result-renderer.test.ts`
  - renderer、component creator、`setExpanded()` 测试。
- `test/extension.test.ts`
  - final delivery、context filtering、custom entry replay、overlay close 集成测试。
- `test/docs.test.ts`
  - 文档一致性测试。
- `test/request-injection.test.ts`
  - 必须保留并运行，用于 provider-native payload injection 回归。

## 并发实施顺序

1. **任务 A 必须先完成或至少定义接口合同**：`ProviderToolResult` shape、action details 和 completeness 会被 renderer / extension 使用。
2. **任务 B、C、D 可在任务 A 合同稳定后并发**：分别主改 stream observer、live status、renderer。
3. **任务 E 依赖任务 A 和 D**：extension delivery 需要 result shape 和 renderer custom type。
4. **任务 F 最后执行**：文档依赖最终行为。
5. 每个开发任务完成后必须进行规格合规 review 和代码质量 review；Critical / Important 必须修复后才能继续。

---

### 任务 A：Result extraction、identity 与 action details

**文件：**

- 修改：`src/provider-results.ts`
- 测试：`test/provider-results.test.ts`

**边界：**

- 不修改 `src/extension.ts`、`src/provider-tool-live-status.ts`、`src/responses-stream-observer.ts`。
- 不修改 README / docs。

- [ ] **步骤 1：编写失败的 action detail / completeness 测试**

在 `test/provider-results.test.ts` 中新增或调整测试，覆盖以下行为：

```ts
it("extracts web_search action details without pretending they are queries", () => {
  const message = {
    providerPayload: {
      type: "openaiResponsesHistory",
      items: [
        { type: "web_search_call", id: "ws-search", status: "completed", action: { type: "search", query: " Foo\nbar ", queries: [" Baz\tqux "] } },
        { type: "web_search_call", id: "ws-open", status: "completed", action: { type: "open_page", url: "https://example.invalid/page" } },
        { type: "web_search_call", id: "ws-find", status: "completed", action: { type: "find_in_page", pattern: "needle" } },
      ],
    },
  };

  const results = extractDisplayableProviderToolResults(message);

  expect(results.map(result => result.id)).toEqual(["ws-search", "ws-open", "ws-find"]);
  expect(results[0]?.queries).toEqual(["Foo bar", "Baz qux"]);
  expect(results[1]?.queries).toEqual([]);
  expect(results[1]?.actionDetails).toContainEqual({ type: "open_page", label: "url", value: "https://example.invalid/page" });
  expect(results[2]?.actionDetails).toContainEqual({ type: "find_in_page", label: "pattern", value: "needle" });
});

it("keeps statusless web_search results when action details are displayable", () => {
  const message = {
    providerPayload: {
      type: "openaiResponsesHistory",
      items: [
        { type: "web_search_call", id: "ws-open", action: { type: "open_page", url: "https://example.invalid/page" } },
      ],
    },
  };

  expect(extractDisplayableProviderToolResults(message)).toHaveLength(1);
});

it("does not treat in-progress web_search calls as final results", () => {
  const message = {
    providerPayload: {
      type: "openaiResponsesHistory",
      items: [
        { type: "web_search_call", id: "ws-1", status: "in_progress", action: { type: "search", query: "not final" } },
      ],
    },
  };

  expect(extractDisplayableProviderToolResults(message)).toEqual([]);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
bun test test/provider-results.test.ts
```

预期：FAIL，原因是 `actionDetails` 不存在或 statusless action detail 未被保留。

- [ ] **步骤 3：实现最少 result shape 扩展**

在 `src/provider-results.ts` 中补充：

```ts
export interface ProviderWebSearchActionDetail {
  type: "search" | "open_page" | "find_in_page" | string;
  label: string;
  value: string;
}
```

并让 displayable result 包含：

```ts
actionDetails: ProviderWebSearchActionDetail[];
```

实现规则：

- `search.query` / `search.queries[]` 仍进入 `queries`。
- `open_page.url` 进入 `actionDetails`，不进入 `queries`。
- `find_in_page.pattern` 进入 `actionDetails`，不进入 `queries`。
- statusless 但有 `id` / query / source / citation / action detail 时保留。
- `in_progress` / `searching` / `failed` / `incomplete` 不作为成功 final result。

- [ ] **步骤 4：运行 provider results 测试验证通过**

运行：

```bash
bun test test/provider-results.test.ts
```

预期：PASS。

- [ ] **步骤 5：运行 renderer 相关现有测试防止 shape 破坏**

运行：

```bash
bun test test/provider-result-renderer.test.ts
```

预期：PASS 或只因任务 D 尚未实现的新 action details renderer 断言失败；不得出现导出 / 类型破坏。

---

### 任务 B：Stream observer lifecycle coverage

**文件：**

- 修改：`src/responses-stream-observer.ts`
- 测试：`test/responses-stream-observer.test.ts`

**边界：**

- 不修改 final card delivery、renderer、docs。
- 不修改 provider result extraction，除非只调整类型 import。

- [ ] **步骤 1：编写失败的 lifecycle observer 测试**

在 `test/responses-stream-observer.test.ts` 新增：

```ts
it("forwards web_search in_progress and completed lifecycle events with item_id", async () => {
  const observed: unknown[] = [];
  const stream = streamFromEvents([
    { type: "response.web_search_call.in_progress", item_id: "ws-1", output_index: 0, sequence_number: 10 },
    { type: "response.web_search_call.completed", item_id: "ws-1", output_index: 0, sequence_number: 11 },
    { type: "response.completed", response: { id: "resp-1" } },
  ]);

  await collectWrappedStream(stream, {
    liveTracker: { onEvent: event => observed.push(event) },
  });

  expect(observed.map(event => (event as { type?: string }).type)).toEqual([
    "response.web_search_call.in_progress",
    "response.web_search_call.completed",
    "response.completed",
  ]);
});

it("does not require lifecycle events to include an item", async () => {
  const observed: unknown[] = [];
  await collectWrappedStream(streamFromEvents([
    { type: "response.web_search_call.searching", item_id: "ws-2", output_index: 0, sequence_number: 1 },
  ]), {
    liveTracker: { onEvent: event => observed.push(event) },
  });

  expect(observed).toEqual([
    expect.objectContaining({ type: "response.web_search_call.searching", item_id: "ws-2" }),
  ]);
});
```

根据现有测试 helper 名称调整 `streamFromEvents` / `collectWrappedStream`，但测试意图必须保持。

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
bun test test/responses-stream-observer.test.ts
```

预期：FAIL，原因是 `in_progress` / `completed` 未转发或要求 `item`。

- [ ] **步骤 3：实现最少 lifecycle 转发**

在 `src/responses-stream-observer.ts` 中扩展 live event 判断：

```ts
const WEB_SEARCH_LIFECYCLE_EVENTS = new Set([
  "response.web_search_call.in_progress",
  "response.web_search_call.searching",
  "response.web_search_call.completed",
]);
```

规则：

- lifecycle event 有 `item_id` 即可转发；不要求 `event.item`。
- 看到 lifecycle event 后设置 saw-live-web-search，使后续 `response.completed` 能转发。
- `response.completed` 仍不直接 clear tracker。
- `image_generation_call` 仍不进入 live tracker。
- raw SSE 原样输出不变。

- [ ] **步骤 4：运行 observer 测试验证通过**

运行：

```bash
bun test test/responses-stream-observer.test.ts
```

预期：PASS。

---

### 任务 C：Live overlay 状态机与 completed timing

**文件：**

- 修改：`src/provider-tool-live-status.ts`
- 测试：`test/provider-tool-live-status.test.ts`

**边界：**

- 不修改 extension final card delivery。
- 不修改 docs。

- [ ] **步骤 1：编写失败的 `item_id` placeholder 测试**

在 `test/provider-tool-live-status.test.ts` 新增：

```ts
it("tracks item_id-only lifecycle events as hidden placeholders and merges final details", () => {
  const recorder = createUiRecorder({ hasUI: true });
  const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
  const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

  tracker?.onEvent({ type: "response.web_search_call.in_progress", item_id: "ws-1", output_index: 0, sequence_number: 1 });
  tracker?.onEvent({ type: "response.web_search_call.completed", item_id: "ws-1", output_index: 0, sequence_number: 2 });
  expect(recorder.customCalls).toHaveLength(0);

  tracker?.onEvent({
    type: "response.output_item.done",
    item: { type: "web_search_call", id: "ws-1", status: "completed", action: { query: "visible query" } },
  });

  const text = recorder.customCalls[0]?.component.render(120).join("\n") ?? "";
  expect(text).toContain("visible query");
  expect(text).toContain("completed");
  expect(text).not.toContain("unknown");
});
```

- [ ] **步骤 2：编写失败的新默认 timing 测试**

新增：

```ts
it("uses slower completed timing defaults so completed overlay remains visible", () => {
  const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
  expect(manager.optionsForTest?.completedCollapseMs ?? DEFAULT_COMPLETED_COLLAPSE_MS).toBeGreaterThanOrEqual(3_000);
  expect(manager.optionsForTest?.completedHideMs ?? DEFAULT_COMPLETED_HIDE_MS).toBeGreaterThanOrEqual(8_000);
  expect(manager.optionsForTest?.completedAutoCloseMs ?? DEFAULT_COMPLETED_AUTO_CLOSE_MS).toBeGreaterThanOrEqual(10_000);
});
```

若现有代码没有导出 defaults，不要为生产 API 过度暴露；可通过 fake scheduler 观察默认 timer delay。

- [ ] **步骤 3：运行测试验证失败**

运行：

```bash
bun test test/provider-tool-live-status.test.ts
```

预期：FAIL，原因是 lifecycle placeholder 不支持或默认时长仍为旧值。

- [ ] **步骤 4：实现最少状态机修复**

实现规则：

- lifecycle `item_id` 创建 hidden placeholder。
- 同 `item_id` 的后续事件合并同一 status。
- final `output_item.done` 带同 ID 时补充 query / source / action detail 并打开 overlay。
- 无 query / source / citation / action detail / error 的 placeholder 不渲染。
- 默认值改为 `completedCollapseMs = 3_000`、`completedHideMs = 8_000`、`completedAutoCloseMs = 10_000`。
- 选项名沿用 `completedAutoCloseMs`。

- [ ] **步骤 5：运行 live status 测试验证通过**

运行：

```bash
bun test test/provider-tool-live-status.test.ts
```

预期：PASS。

---

### 任务 D：Provider result renderer component 与 action details

**文件：**

- 修改：`src/provider-result-renderer.ts`
- 测试：`test/provider-result-renderer.test.ts`

**边界：**

- 不修改 extension delivery。
- 不修改 stream observer / live overlay。

- [ ] **步骤 1：编写失败的 component creator / setExpanded 测试**

在 `test/provider-result-renderer.test.ts` 新增：

```ts
it("creates a reusable provider result card component with setExpanded support", () => {
  const message = providerToolResultMessage({
    queries: ["search query"],
    actionDetails: [{ type: "open_page", label: "url", value: "https://example.invalid/page" }],
    sources: [{ url: "https://example.invalid/source" }],
  });

  const component = createProviderToolResultCardComponent(message, fakeTui, fakeTheme);

  const collapsed = component.render(120).join("\n");
  expect(collapsed).toContain("Ctrl+O");
  expect(collapsed).not.toContain("https://example.invalid/page");

  component.setExpanded?.(true);
  const expanded = component.render(120).join("\n");
  expect(expanded).toContain("search query");
  expect(expanded).toContain("https://example.invalid/page");
  expect(expanded).toContain("https://example.invalid/source");

  component.setExpanded?.(false);
  expect(component.render(120).join("\n")).not.toContain("https://example.invalid/page");
});
```

根据现有测试 helper 名称调整 `fakeTui` / `fakeTheme`。

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
bun test test/provider-result-renderer.test.ts
```

预期：FAIL，原因是 component creator 或 action details 渲染不存在。

- [ ] **步骤 3：实现 renderer 最少扩展**

实现：

- 导出 `createProviderToolResultCardComponent(message, tui, theme, keybindings?)`。
- `createProviderToolResultCardFactory(message)` 改为调用 component creator。
- component 支持 `setExpanded(expanded)`，用于 OMP `Ctrl+O` 全局展开。
- expanded 视图渲染 `actionDetails`。
- 保留现有 `handleInput` 支持，不作为唯一展开机制。

- [ ] **步骤 4：运行 renderer 测试验证通过**

运行：

```bash
bun test test/provider-result-renderer.test.ts
```

预期：PASS。

---

### 任务 E：Extension final card delivery、context filtering 与 replay

**文件：**

- 修改：`src/extension.ts`
- 修改：`src/types.ts`
- 测试：`test/extension.test.ts`

**边界：**

- 不修改 stream observer / live overlay 细节。
- 不修改 docs。

- [ ] **步骤 1：编写失败的 streaming-safe pending delivery 测试**

在 `test/extension.test.ts` 新增或改写旧 final echo 测试：

```ts
it("queues final web_search during streaming and flushes it only when idle", async () => {
  const extension = registerExtension();
  const recorder = uiRecorder();
  const ctx = context(cwd, homeDir, {
    hasUI: true,
    ui: recorder.ctxUi,
    isIdle: () => false,
    sessionManager: { getSessionId: () => "session-1" },
  });

  await runMessageEnd(extension, { type: "message_end", message: webSearchMessage("immediate echo") }, ctx);

  expect(recorder.customCalls.filter(call => call.options?.overlay === false)).toEqual([]);
  expect(extension.sentMessages).toHaveLength(0);

  const idleCtx = { ...ctx, isIdle: () => true };
  await runTurnEnd(extension, { type: "turn_end", message: webSearchMessage("immediate echo"), toolResults: [] }, idleCtx);

  expect(extension.sentMessages).toHaveLength(1);
  expect(extension.sentMessages[0]?.options).not.toMatchObject({ deliverAs: "nextTurn" });
  expect(extension.sentMessages[0]?.options).not.toMatchObject({ triggerTurn: true });
  expect(extension.sentMessages[0]?.message).toMatchObject({
    customType: "openai-provider-tool-result",
    display: true,
    details: expect.objectContaining({ uiOnly: true, resultKey: expect.any(String) }),
  });
});
```

该测试必须模拟真实 OMP 语义：`message_end` / `agent_end` 期间 runtime 仍可能 `isIdle() === false`，此时无 `deliverAs` 的 `api.sendMessage` 会走 steer，不能调用。

还必须新增一个 deferred idle retry 测试：`message_end` 入队后，第一次 `turn_end` 仍 `isIdle() === false`，不得发送、不关闭 overlay；随后由 fake scheduler / microtask 控制的 deferred flush 在 `isIdle()` 变 true 后发送 exactly once。agent_end fallback 也必须覆盖同样的非 idle → idle 路径。

- [ ] **步骤 2：编写失败的 context filtering 测试**

新增：

```ts
it("filters only this plugin's ui-only provider result custom messages from LLM context", async () => {
  const extension = registerExtension();
  const contextHandler = getHandler(extension, "context");
  const providerCard = providerToolResultCustomMessage({ uiOnly: true, resultKey: "r1" });
  const otherCustom = { role: "custom", customType: "other-plugin", content: "keep", display: true, timestamp: Date.now() };
  const unsafeSameType = providerToolResultCustomMessage({ uiOnly: false, resultKey: "r2" });

  const result = await contextHandler({ type: "context", messages: [providerCard, otherCustom, unsafeSameType] }, context(cwd, homeDir));

  expect(result.messages).toEqual([otherCustom, unsafeSameType]);
});
```

- [ ] **步骤 3：编写失败的 custom entry persistence / replay 测试**

新增：

```ts
it("persists final cards as ui-only custom entries and replays current-branch entries once after idle", async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const extension = registerExtension({ appendEntry: (customType, data) => appended.push({ customType, data }) });
  const sessionManager = {
    getSessionId: () => "session-1",
    getBranch: () => [
      { type: "custom", customType: "openai-provider-tool-result-ui", data: persistedProviderToolResult("r1") },
    ],
  };
  const ctx = context(cwd, homeDir, { hasUI: true, isIdle: () => true, sessionManager });

  await runSessionStart(extension, ctx);
  await runSessionStart(extension, ctx);

  expect(extension.sentMessages.filter(message => message.message?.details?.resultKey === "r1")).toHaveLength(1);

  await runMessageEnd(extension, { type: "message_end", message: webSearchMessage("persist me") }, ctx);
  await runTurnEnd(extension, { type: "turn_end", message: webSearchMessage("persist me"), toolResults: [] }, ctx);

  expect(appended).toContainEqual(expect.objectContaining({ customType: "openai-provider-tool-result-ui" }));
});
```

根据现有 extension test harness 调整 `extension.appendEntry` / `sentMessages` 访问方式。

- [ ] **步骤 4：运行测试验证失败**

运行：

```bash
bun test test/extension.test.ts --timeout 10000
```

预期：FAIL，原因是当前代码走 non-overlay custom，缺少 pending queue、idle-gated flush、context hook 和 replay。

- [ ] **步骤 5：实现 delivery / filtering / replay**

实现规则：

- `registerProviderToolsExtension` 注册 `context` 和 `turn_end` handler。
- `sendVisibleProviderToolResultMessage()` 不再调用 `ctx.ui.custom(..., { overlay: false })`。
- `message_end` / `agent_end` 只收集 pending final result；当 `ctx.isIdle() === false` 时不得调用无 `deliverAs` 的 `api.sendMessage`。
- `turn_end` 或其它 idle lifecycle 调用 flush；只有 `ctx.isIdle() === true` 时才发送 display custom message。
- 任一 flush 尝试如果 `ctx.isIdle() === false`，必须保留 pending 并安排后续 macrotask / timer retry；每次发送前都重新检查 idle。
- retry 必须带 generation / token，session switch / shutdown / branch 后旧 retry 不得发送旧 card。
- idle flush 的 display path 调用 `api.sendMessage(message, { triggerTurn: false })` 或不传 options；不得传 `deliverAs: "nextTurn"`。
- message details 带 `uiOnly: true`、`source`、`resultKey`、`message`。
- idle flush 成功启动 display message 后调用 `api.appendEntry(PROVIDER_TOOL_RESULT_ENTRY_TYPE, data)`。
- `context` handler 过滤本插件 uiOnly display messages。
- `session_start` / `session_switch` / `session_tree` replay 当前 branch 上的 custom entries，按 `resultKey` 去重，不重复 appendEntry；replay 也必须经过 idle-gated display path。
- 插入失败不关闭 overlay，不 notify/showStatus 伪装成功。

- [ ] **步骤 6：运行 extension 测试验证通过**

运行：

```bash
bun test test/extension.test.ts --timeout 10000
```

预期：PASS。

---

### 任务 F：文档与文档测试

**文件：**

- 修改：`README.md`
- 修改：`docs/runtime-compatibility.md`
- 修改：`test/docs.test.ts`

**边界：**

- 不修改实现代码。

- [ ] **步骤 1：编写失败的 docs 测试**

在 `test/docs.test.ts` 中新增 / 调整断言：

```ts
it("documents idle-gated ui-only web_search final card semantics", async () => {
  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
  const runtime = await fs.readFile(path.join(repoRoot, "docs/runtime-compatibility.md"), "utf8");
  const combined = `${readme}\n${runtime}`;

  expect(combined).toContain("display custom message");
  expect(combined).toContain("context hook");
  expect(combined).toContain("UI-only custom entry");
  expect(combined).toContain("response.web_search_call.in_progress");
  expect(combined).toContain("response.web_search_call.completed");
  expect(combined).not.toContain("non-overlay final web_search custom card remains editor-resident");
  expect(combined).not.toContain("ctx.ui.custom(..., { overlay: false }) is the preferred final web_search card path");
});
```

- [ ] **步骤 2：运行 docs 测试验证失败**

运行：

```bash
bun test test/docs.test.ts
```

预期：FAIL，原因是旧文案仍存在或新语义未记录。

- [ ] **步骤 3：更新 README 和 runtime compatibility**

更新内容：

- final `web_search` card 是 idle-gated display custom message + context hook filtering + UI-only custom entry replay。
- 不使用 non-overlay `ctx.ui.custom` 作为 final card。
- interactive runtime 不使用 `nextTurn` 主路径。
- overlay 支持 `response.web_search_call.in_progress/searching/completed`。
- completed overlay 的新展示、折叠、隐藏、auto-close 时序。
- `image_generation` 不使用 live overlay。

- [ ] **步骤 4：运行 docs 测试验证通过**

运行：

```bash
bun test test/docs.test.ts
```

预期：PASS。

---

## 最终验证

所有任务和 review 循环完成后运行：

```bash
bun test test/provider-tool-live-status.test.ts
bun test test/responses-stream-observer.test.ts
bun test test/extension.test.ts --timeout 10000
bun test test/provider-results.test.ts test/provider-result-renderer.test.ts test/docs.test.ts test/request-injection.test.ts
bun test
bun pm pack --dry-run
git diff --check
```

真实 OMP runtime 验证：

- linked plugin 路径仍指向 `C:/tmp/omp-openai-provider-tools`。
- 触发 provider-native `web_search` 后 overlay 出现。
- `in_progress` / `searching` / `completed` 都能反映在 overlay 状态中。
- completed 后 overlay 不立即消失。
- 请求结束并进入 idle flush 后 final card 立即显示在 chat transcript。
- 输入区不消失。
- 下一轮 provider request 不包含 final card 文本。
- 重启 / resume 后 TUI 正常；当前 branch 的 UI-only custom entry 可 replay final card。
- `image_generation` payload injection、keepalive、interruption、saving、context bridge 不回退。
