# Web Search Overlay 可靠性修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 全面修复 provider-native `web_search` live overlay 的条目级折叠 / 隐藏、临时 ID 归并、最终回显关闭和关闭后可恢复行为。

**架构：** 先建立共享 query identity helper，live overlay 和 final summary 复用同一规范化规则。随后改造 `ProviderToolLiveStatusManager` 为请求级 lifecycle + 条目级 visibility 状态机，再收窄 stream observer 与 extension 的关闭职责，最后更新文档和回归测试。

**技术栈：** TypeScript、Bun test、OMP/Pi extension API、OpenAI Responses SSE / SDK iterable wrapper。

---

## 规格与约束

- 规格文件：`C:/tmp/omp-openai-provider-tools/docs/superpowers/specs/2026-05-11-web-search-overlay-reliability-design.md`
- 直接在 `master` / 当前工作树开发，不使用 worktree。
- 本仓库已有未提交改动：最终 `web_search` custom card 相关代码、测试和文档。不得回退这些改动。
- 不读取或输出 `C:/Users/34404/.omp/agent/models.yml`。
- 不使用 `notify` / `showStatus` / 短 widget 替代最终 `web_search` 回显。
- 新启动子代理时必须提供本计划完整路径和规格完整路径；开发子代理任务提示词需超过 2000 字。

## 文件结构

- `src/provider-results.ts`
  - 新增并导出 web_search query identity helper。
  - final summary 解析继续保持职责，但 query 提取改为复用 helper。
- `src/provider-tool-live-status.ts`
  - 主状态机改造：requestPhase、stable key、final ID 绑定、ordinal、条目级 visibility、timer 安全、UI failure 可恢复。
- `src/responses-stream-observer.ts`
  - 保持 raw SSE / SDK iterable 原样转发；确认 terminal event 转发给 tracker，不承担 UI 关闭策略。
- `src/extension.ts`
  - 将 overlay 清理从 `message_end` / `agent_end` 的无条件 finally 收窄到完整 final result custom card 或允许 fallback 启动成功。
- `README.md`
  - 更新 live overlay 行为：条目级折叠 / 隐藏、final custom card 关闭、关闭后可重新出现。
- `docs/runtime-compatibility.md`
  - 更新 runtime capability 说明和关闭语义。
- `test/provider-tool-live-status.test.ts`
  - 状态机、归并、timer、恢复性测试。
- `test/responses-stream-observer.test.ts`
  - terminal event / raw SSE / image event 不进入 live tracker 回归。
- `test/extension.test.ts`
  - final custom card、fallback、非完整 lifecycle、不触发 steer、下一次请求重新打开。
- `test/provider-result-renderer.test.ts` 或新增 provider-results 测试
  - identity helper 与 final summary query 规范化测试。
- `test/docs.test.ts`
  - 文档描述一致性测试。

## 并发实施顺序

1. **任务 1 必须先完成**：共享 identity helper 是其他任务依赖的合同。
2. **任务 2、3、4 可在任务 1 后并发**：分别主改 live status、stream observer、extension。
3. **任务 5 最后执行**：文档依赖最终行为合同。
4. 每个开发任务完成后必须由 review 子代理审查；Critical / Important 必须修复后才能继续。

---

### 任务 1：共享 web_search identity helper

**文件：**
- 修改：`src/provider-results.ts:37-104`
- 测试：`test/provider-result-renderer.test.ts` 或新增 `test/provider-results.test.ts`

- [ ] **步骤 1：编写失败的 identity helper 测试**

在现有 provider result 相关测试中新增用例，优先新增 `test/provider-results.test.ts` 以避免 renderer 测试过载：

```ts
import { describe, expect, it } from "bun:test";

import {
  extractDisplayableProviderToolResults,
  normalizeProviderWebSearchQueryForIdentity,
  displayProviderWebSearchQuery,
} from "../src/provider-results";

describe("provider web_search identity helpers", () => {
  it("normalizes identity queries without using display truncation", () => {
    expect(normalizeProviderWebSearchQueryForIdentity(" Foo\nbar\t baz ")).toBe("Foo bar baz");

    const left = `${"a".repeat(150)} left`;
    const right = `${"a".repeat(150)} right`;
    expect(normalizeProviderWebSearchQueryForIdentity(left)).not.toBe(
      normalizeProviderWebSearchQueryForIdentity(right),
    );
    expect(displayProviderWebSearchQuery(left).length).toBeLessThan(left.length);
  });

  it("uses normalized queries when extracting final web_search results", () => {
    const message = {
      providerPayload: {
        type: "openaiResponsesHistory",
        items: [
          {
            type: "web_search_call",
            id: "ws-1",
            status: "completed",
            action: { query: " Foo\nbar " },
          },
        ],
      },
    };

    expect(extractDisplayableProviderToolResults(message)[0]?.queries).toEqual(["Foo bar"]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
bun test test/provider-results.test.ts
```

预期：FAIL，报错类似 `normalizeProviderWebSearchQueryForIdentity is not exported`。

- [ ] **步骤 3：实现 helper 并复用到 final summary 提取**

在 `src/provider-results.ts` 中新增：

```ts
const MAX_QUERY_DISPLAY_CHARS = 140;

export function normalizeProviderWebSearchQueryForIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function displayProviderWebSearchQuery(value: string): string {
  const normalized = normalizeProviderWebSearchQueryForIdentity(value) ?? "";
  const chars = [...normalized];
  if (chars.length <= MAX_QUERY_DISPLAY_CHARS) return normalized;
  return `${chars.slice(0, MAX_QUERY_DISPLAY_CHARS).join("")}…`;
}
```

把 `cleanString(action.query)` 和 `cleanString(entry)` 在 `collectQueries()` 中用于 query 的部分改为 `normalizeProviderWebSearchQueryForIdentity(...)`。`actionType` 仍可使用 `cleanString(action.type)`。

- [ ] **步骤 4：运行 identity 测试验证通过**

运行：

```bash
bun test test/provider-results.test.ts
```

预期：PASS。

- [ ] **步骤 5：运行相关 renderer 测试**

运行：

```bash
bun test test/provider-result-renderer.test.ts
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/provider-results.ts test/provider-results.test.ts test/provider-result-renderer.test.ts
git commit -m "test(provider): 覆盖 web_search 查询归一化"
```

如果当前工作流暂不提交，必须至少在任务报告中说明未提交原因，并保留 diff 供主代理统一提交。

---

### 任务 2：Live overlay 状态机与条目级折叠

**文件：**
- 修改：`src/provider-tool-live-status.ts:1-658`
- 测试：`test/provider-tool-live-status.test.ts`

- [ ] **步骤 1：编写失败的归并与隐藏测试**

在 `test/provider-tool-live-status.test.ts` 中新增测试：

```ts
it("merges temporary search ids into final ids without rendering unknown", () => {
  const scheduler = createScheduler();
  const recorder = createUiRecorder({ hasUI: true });
  const manager = createProviderToolLiveStatusManager({ throttleMs: 0, scheduler: scheduler.scheduler });
  const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

  tracker?.onEvent({
    type: "response.web_search_call.searching",
    item: { type: "web_search_call", id: "res_123" },
    query: " Foo\nbar ",
  });
  tracker?.onEvent({
    type: "response.output_item.done",
    item: {
      type: "web_search_call",
      id: "ws_abc",
      status: "completed",
      action: { query: "Foo bar" },
      sources: [{ url: "https://example.invalid" }],
    },
  });

  const text = recorder.customCalls[0]!.component.render(120).join("\n");
  expect(text).toContain("Foo bar");
  expect(text).toContain("ws_abc");
  expect(text).not.toContain("res_123");
  expect(text).not.toContain("unknown");
  expect((text.match(/web_search_call/g) ?? []).length).toBe(1);
});

it("keeps same-query final calls separate by final id", () => {
  const recorder = createUiRecorder({ hasUI: true });
  const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
  const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

  tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-1", status: "completed", action: { query: "same" } } });
  tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-2", status: "completed", action: { query: "same" } } });

  const text = recorder.customCalls[0]!.component.render(120).join("\n");
  expect(text).toContain("ws-1");
  expect(text).toContain("ws-2");
  expect((text.match(/web_search_call/g) ?? []).length).toBe(2);
});
```

- [ ] **步骤 2：编写失败的条目级折叠 / 隐藏 / 恢复测试**

继续新增：

```ts
it("collapses then hides completed calls before closing the overlay", () => {
  const scheduler = createScheduler();
  const recorder = createUiRecorder({ hasUI: true });
  const manager = createProviderToolLiveStatusManager({
    throttleMs: 0,
    completedCollapseMs: 1_000,
    completedHideMs: 2_000,
    completedAutoCloseMs: 3_000,
    scheduler: scheduler.scheduler,
  });
  const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

  tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-1", status: "completed", action: { query: "collapse me" } } });
  tracker?.onEvent({ type: "response.completed" });

  expect(recorder.customCalls[0]!.component.render(120).join("\n")).toContain("query");

  scheduler.runNextTimerByTimeout?.(1_000);
  const collapsed = recorder.customCalls[0]!.component.render(120).join("\n");
  expect(collapsed).toContain("collapse me");
  expect(collapsed).not.toContain("query  \"collapse me\"");

  scheduler.runNextTimerByTimeout?.(2_000);
  expect(recorder.customCalls[0]!.component.render(120).join("\n")).not.toContain("collapse me");

  scheduler.runActiveTimers();
  expect(recorder.doneResults).toEqual([undefined]);
});

it("opens a new overlay after auto-close, dispose, manual close, and render failure", () => {
  const scheduler = createScheduler();
  const recorder = createUiRecorder({ hasUI: true });
  const manager = createProviderToolLiveStatusManager({ throttleMs: 0, completedHideMs: 1, completedAutoCloseMs: 1, scheduler: scheduler.scheduler });

  manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui })?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-1", status: "completed", action: { query: "first" } } });
  scheduler.runActiveTimers();
  manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui })?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-2", action: { query: "second" } } });

  expect(recorder.customCalls.length).toBeGreaterThanOrEqual(2);
  expect(recorder.customCalls.at(-1)!.component.render(120).join("\n")).toContain("second");
});
```

如果 `createScheduler()` 没有 `runNextTimerByTimeout`，先在测试 helper 中新增一个按 timeout 执行第一个未清理 timer 的方法。

- [ ] **步骤 3：运行 live status 测试验证失败**

```bash
bun test test/provider-tool-live-status.test.ts
```

预期：FAIL，失败点应对应未归并、无折叠 / 隐藏、无法传入 `completedCollapseMs` / `completedHideMs` 等。

- [ ] **步骤 4：实现状态机最小改造**

在 `src/provider-tool-live-status.ts` 中：

- 引入 `normalizeProviderWebSearchQueryForIdentity` 与 `displayProviderWebSearchQuery`。
- 扩展 manager options：`completedCollapseMs?: number`、`completedHideMs?: number`，保留 `completedAutoCloseMs`。
- 替换 `disabled` 全局永久熔断为当前 tracker failure：`disableAfterOverlayFailure` 不再设置 manager 级 `disabled = true`，只关闭触发错误的 tracker；无 custom 时 no-op。
- 为 tracker 增加：`requestPhase`、`nextOrdinal`、`itemIdToStableKey`、per status `completionGeneration`。
- 实现 `normalizePatch(event)`、`findOrCreateStatus(patch)`、`completeStatus(status)`、`collapseStatus(stableKey, generation)`、`hideStatus(stableKey, generation)`。
- `response.completed`：设置 request completed，把可展示未失败 status 标记 completed，调度条目 timers，不直接 clear。
- snapshot：过滤 hidden status；collapsed status 生成简短摘要；不输出 `unknown`。

- [ ] **步骤 5：运行 live status 测试验证通过**

```bash
bun test test/provider-tool-live-status.test.ts
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/provider-tool-live-status.ts test/provider-tool-live-status.test.ts
git commit -m "fix(web_search): 修复实时 overlay 状态归并"
```

---

### 任务 3：Stream observer terminal event 与 image 回归保护

**文件：**
- 修改：`src/responses-stream-observer.ts:227-242`
- 测试：`test/responses-stream-observer.test.ts`

- [ ] **步骤 1：补充 response.completed 转发测试**

在 `test/responses-stream-observer.test.ts` 中确认或新增：

```ts
it("forwards response.completed to live tracker after web_search without clearing it", async () => {
  const recorder = trackerRecorder();
  const raw = sseEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1", action: { query: "done later" } } }) +
    sseEvent({ type: "response.completed", response: { id: "resp-1" } });

  const text = await responseText(wrapOpenAIResponsesStream(
    new Response(raw).body!,
    { interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
  ));

  expect(text).toBe(raw);
  expect(recorder.events.map(event => (event as any).type)).toEqual([
    "response.output_item.added",
    "response.completed",
  ]);
  expect(recorder.calls).toEqual([]);
});
```

- [ ] **步骤 2：补充 image 不进入 live tracker 回归测试**

确认已有测试覆盖；若没有，新增：

```ts
it("does not report image_generation_call as live web_search progress", async () => {
  const recorder = trackerRecorder();
  const raw = sseEvent({ type: "response.output_item.done", item: { type: "image_generation_call", id: "ig-1", result: "abc" } });

  await responseText(wrapOpenAIResponsesStream(
    new Response(raw).body!,
    { interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
  ));

  expect(recorder.events).toEqual([]);
  expect(recorder.calls).toEqual([]);
});
```

- [ ] **步骤 3：运行 stream observer 测试**

```bash
bun test test/responses-stream-observer.test.ts
```

预期：PASS。若 FAIL，修正 `observeEvent()`，但不要引入 UI 关闭逻辑。

- [ ] **步骤 4：检查 observer 代码边界**

确认 `responses-stream-observer.ts`：

- raw SSE 原样转发。
- `response.completed` 只转发给 tracker。
- `response.failed` / `error` 仍 `failTracker` + `clearTracker`。
- `image_generation_call` 不进入 live tracker。

- [ ] **步骤 5：Commit**

```bash
git add src/responses-stream-observer.ts test/responses-stream-observer.test.ts
git commit -m "test(stream): 固化 web_search 终止事件转发"
```

---

### 任务 4：Extension 最终回显关闭契约

**文件：**
- 修改：`src/extension.ts:482-565`、`src/extension.ts:910-937`
- 测试：`test/extension.test.ts`

- [ ] **步骤 1：编写失败的非完整 lifecycle 不关闭 overlay 测试**

在 `test/extension.test.ts` 中新增：

```ts
it("does not close live overlay on incomplete message_end or agent_end", async () => {
  const restoreFetch = installMockResponsesFetch(() => liveWebSearchEvent("still live", "response.output_item.added"));
  try {
    const cwd = await makeTempDir();
    const homeDir = await makeTempDir();
    const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
    const recorder = uiRecorder();
    const ctx = context(cwd, homeDir, { hasUI: true, ui: recorder.ctxUi, sessionManager: { getSessionId: () => "session-1" } });

    await createActiveLiveTracker(extension, ctx, "still live");
    const overlayCall = recorder.customCalls.find(call => isRecord(call.options) && call.options.overlay === true)!;

    await runMessageEnd(extension, { type: "message_end", message: {} }, ctx);
    expect(overlayCall.doneResults).toEqual([]);

    await runAgentEnd(extension, { message: { providerPayload: { type: "openaiResponsesHistory", items: [{ type: "web_search_call", id: "ws-1", status: "in_progress", action: { query: "still live" } }] } } }, ctx);
    expect(overlayCall.doneResults).toEqual([]);
  } finally {
    restoreFetch();
  }
});
```

- [ ] **步骤 2：编写失败的 final card 永不 resolve 仍关闭测试**

```ts
it("closes overlay when final custom card starts even if the card promise never resolves", async () => {
  const restoreFetch = installMockResponsesFetch(() => liveWebSearchEvent("card starts"));
  try {
    const cwd = await makeTempDir();
    const homeDir = await makeTempDir();
    const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
    const recorder = uiRecorder();
    const ctx = context(cwd, homeDir, { hasUI: true, ui: recorder.ctxUi, sessionManager: { getSessionId: () => "session-1" } });

    await createActiveLiveTracker(extension, ctx, "card starts");
    const overlayCall = recorder.customCalls.find(call => isRecord(call.options) && call.options.overlay === true)!;

    await runMessageEnd(extension, { type: "message_end", message: webSearchMessage("card starts") }, ctx);

    expect(recorder.cardCalls).toHaveLength(1);
    expect(overlayCall.doneResults).toEqual([undefined]);
  } finally {
    restoreFetch();
  }
});
```

- [ ] **步骤 3：编写 fallback 和 failure 测试**

新增：

```ts
it("uses non-triggering fallback only when custom UI is unavailable and closes overlay after fallback starts", async () => {
  const cwd = await makeTempDir();
  const homeDir = await makeTempDir();
  const extension = registerExtension();
  const recorder = uiRecorder();
  delete (recorder.ctxUi as any).custom;
  const ctx = context(cwd, homeDir, { hasUI: true, ui: recorder.ctxUi, sessionManager: { getSessionId: () => "session-1" } });

  await runMessageEnd(extension, { type: "message_end", message: webSearchMessage("fallback") }, ctx);

  expect(extension.sentMessages).toHaveLength(1);
  expect(extension.sentMessages[0]?.options).toEqual({ deliverAs: "nextTurn" });
  expect(JSON.stringify(extension.sentMessages[0]?.options)).not.toContain("triggerTurn");
});

it("does not close overlay or fallback to notify when final custom card throws", async () => {
  const restoreFetch = installMockResponsesFetch(() => liveWebSearchEvent("custom throws"));
  try {
    const cwd = await makeTempDir();
    const homeDir = await makeTempDir();
    const extension = registerExtension();
    const recorder = uiRecorder();
    const throwingUi = { ...recorder.ctxUi, custom() { throw new Error("custom failed"); } };
    const ctx = context(cwd, homeDir, { hasUI: true, ui: throwingUi, sessionManager: { getSessionId: () => "session-1" } });

    await createActiveLiveTracker(extension, ctx, "custom throws");
    await runMessageEnd(extension, { type: "message_end", message: webSearchMessage("custom throws") }, ctx);

    expect(extension.sentMessages).toHaveLength(0);
    expect(extension.warnings.join("\n")).toContain("OpenAI provider tool result message delivery failed");
  } finally {
    restoreFetch();
  }
});
```

该 failure 测试若难以复用现有 recorder，需要主改 extension 的子代理根据当前 helper shape 调整，但必须保留语义：支持 custom UI 时 custom 失败不得 fallback 到 sendMessage / notify。

- [ ] **步骤 4：运行 extension 测试验证失败**

```bash
bun test test/extension.test.ts --timeout 10000
```

预期：FAIL，失败点对应无条件 `finally clearLiveStatus()` 或等待 non-overlay Promise resolve。

- [ ] **步骤 5：实现 delivery started 结果**

把 `sendVisibleProviderToolResultMessage()` 改为返回 delivery 状态：

```ts
type ProviderToolResultDelivery = "none" | "started" | "failed";
```

实现策略：

- 有 `ctx.ui.custom`：同步调用 `ctx.ui.custom(createProviderToolResultCardFactory(message), { overlay: false })`。
  - 调用同步成功后立即认为 `started`，用 `consumePromiseLater` 观察 Promise reject，不等待 resolve。
  - 同步抛错返回 `failed`，记录 warning，不 fallback 到 `sendMessage`。
- 无 `ctx.ui.custom` 但有 `api.sendMessage`：调用 `api.sendMessage(message, { deliverAs: "nextTurn" })`，同步启动成功后返回 `started`，不得设置 `triggerTurn`。
- 无任何路径：返回 `none`。

让 `handleProviderToolResults()` 返回 boolean：是否启动了 final echo。`message_end` / `agent_end` 只在该 boolean 为 true 时调用 `clearLiveStatus()`。

- [ ] **步骤 6：移除无条件 finally clear**

改造：

```ts
api.on?.("message_end", (event, ctx) => {
  handleMessageEndImageResults(...);
  const echoed = handleMessageEndProviderToolResults(...);
  if (echoed) clearLiveStatus();
});
```

`agent_end` 同理。session switch / shutdown hooks 仍无条件 clear。

- [ ] **步骤 7：运行 extension 测试验证通过**

```bash
bun test test/extension.test.ts --timeout 10000
```

预期：PASS。

- [ ] **步骤 8：Commit**

```bash
git add src/extension.ts test/extension.test.ts
git commit -m "fix(web_search): 按最终回显关闭实时 overlay"
```

---

### 任务 5：文档与全量回归

**文件：**
- 修改：`README.md`
- 修改：`docs/runtime-compatibility.md`
- 修改：`test/docs.test.ts`

- [ ] **步骤 1：编写文档断言测试**

在 `test/docs.test.ts` 中增加对关键语义的断言：

```ts
expect(readme).toContain("completed 条目");
expect(readme).toContain("折叠");
expect(readme).toContain("隐藏");
expect(readme).toContain("再次打开");
expect(readme).toContain("final `web_search` custom card");
expect(runtimeCompatibility).toContain("非完整 `message_end` / `agent_end` 不关闭 overlay");
```

根据现有 docs 测试结构调整变量名。

- [ ] **步骤 2：运行文档测试验证失败**

```bash
bun test test/docs.test.ts
```

预期：FAIL，说明文档还没更新。

- [ ] **步骤 3：更新 README 中文 / 英文段落**

在 provider-native `web_search` realtime overlay 说明中写明：

- live `web_search_call` 事件打开 overlay。
- completed 条目短暂完整显示，随后折叠 / 隐藏。
- final `web_search` custom card 出现时关闭 overlay。
- 正常关闭、auto-close、手动关闭或 runtime dispose 后，下一次 provider-native `web_search` 可以再次打开 overlay。
- `image_generation` 不显示 live overlay。

- [ ] **步骤 4：更新 runtime compatibility 文档**

在 live status overlay 行写明：

- `response.completed` 不直接 clear，只进入 request completed 状态。
- final custom card 是关闭信号。
- 非完整 `message_end` / `agent_end` 不关闭 overlay。
- 缺少 custom overlay 能力 no-op；单次 UI failure 不永久禁用后续 tracker。

- [ ] **步骤 5：运行文档测试验证通过**

```bash
bun test test/docs.test.ts
```

预期：PASS。

- [ ] **步骤 6：运行聚焦回归测试**

```bash
bun test test/provider-results.test.ts test/provider-tool-live-status.test.ts test/responses-stream-observer.test.ts test/extension.test.ts test/provider-result-renderer.test.ts test/docs.test.ts --timeout 10000
```

预期：PASS。

- [ ] **步骤 7：运行全量验证**

```bash
bun test
bun pm pack --dry-run
git diff --check
```

预期：

- `bun test`：0 fail。
- `bun pm pack --dry-run`：exit 0。
- `git diff --check`：无 whitespace error；如果只有 CRLF warning，记录为 warning 而非失败。

- [ ] **步骤 8：Commit**

```bash
git add README.md docs/runtime-compatibility.md test/docs.test.ts
git commit -m "docs(web_search): 说明 overlay 生命周期"
```

---

## 最终验收清单

- [ ] `web_search` 流式事件能打开 overlay。
- [ ] completed 条目短暂完整展示后折叠 / 隐藏。
- [ ] 临时 `res_...` 与正式 `ws_...` 同 query 归并为同一 call。
- [ ] 同 query、不同正式 ID 的多个真实 call 不被误合并。
- [ ] overlay 文本不显示 `unknown`。
- [ ] final `web_search` custom card 启动成功后立即关闭 overlay，不等待非 overlay Promise resolve。
- [ ] 非完整 `message_end` / `agent_end` 不关闭 overlay。
- [ ] final card、auto-close、手动关闭、runtime dispose、单次 UI failure 后，新请求仍能重新打开 overlay。
- [ ] fallback 仅在无 custom UI 时使用，且 `deliverAs: "nextTurn"`，不设置 `triggerTurn`。
- [ ] `image_generation` keepalive、interruption、保存、回显和 context bridge 不回退。
- [ ] 文档与实现一致。
- [ ] 所有验收命令通过。
