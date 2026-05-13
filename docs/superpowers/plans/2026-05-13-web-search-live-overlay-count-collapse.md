# Web Search Live Overlay 计数与折叠实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 provider-native `web_search` live overlay 的标题计数和 completed 项折叠策略：标题显示 overlay 生命周期内累计可展示 call 总数，completed 只在累计 call 数大于 3 时按旧项优先折叠。

**架构：** 在 `LiveTracker` 内维护累计可展示 status ID 集合，并把 `totalCalls` 写入 `LiveOverlaySnapshot`。新增统一的 completed 可见性协调逻辑，按「非 completed 永远展开、最近 completed 优先展开、旧 completed 优先折叠」规则更新 `visibility`。渲染层只消费 snapshot，不参与状态推断。

**技术栈：** TypeScript、Bun test、OMP/Pi extension runtime。

---

## 文件结构

- 修改：`src/provider-tool-live-status.ts`
  - 增加 `LiveOverlaySnapshot.totalCalls`。
  - 维护 `seenDisplayableStatusIds`。
  - 增加 / 调整 completed 折叠协调逻辑。
  - 标题 `calls N` 改用累计总数。
- 修改：`test/provider-tool-live-status.test.ts`
  - 添加标题累计计数测试。
  - 添加 3 个及以下 completed 不折叠测试。
  - 添加第 4 个 call 到达后折叠最旧 completed 测试。
  - 添加 searching / queued / failed 不被折叠测试。
- 修改：`README.md`
  - 更新 live overlay completed timing 描述。
- 修改：`docs/runtime-compatibility.md`
  - 更新 live overlay 能力说明。
- 修改：`test/docs.test.ts`
  - 增加文档片段断言。
- 已创建规格：`docs/superpowers/specs/2026-05-13-web-search-live-overlay-count-collapse-spec.md`
- 创建本计划：`docs/superpowers/plans/2026-05-13-web-search-live-overlay-count-collapse.md`

## 任务 1：标题累计计数

**文件：**
- 修改：`test/provider-tool-live-status.test.ts`
- 修改：`src/provider-tool-live-status.ts`

- [ ] **步骤 1：编写失败的测试**

在 `describe("provider tool live status", () => { ... })` 内新增测试：

```ts
it("keeps header call count cumulative after completed calls hide", () => {
	const scheduler = createScheduler();
	const recorder = createUiRecorder({ hasUI: true });
	const manager = createProviderToolLiveStatusManager({
		throttleMs: 0,
		completedCollapseMs: 1_000,
		completedHideMs: 2_000,
		completedAutoCloseMs: 0,
		scheduler: scheduler.scheduler,
	});
	const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

	for (const id of ["ws-1", "ws-2", "ws-3", "ws-4"]) {
		tracker?.onEvent({
			type: "response.output_item.done",
			item: { type: "web_search_call", id, status: "completed", action: { query: id } },
		});
	}

	expect(recorder.customCalls[0]!.component.render(120).join("\n")).toContain("calls 4");
	scheduler.runNextTimerByTimeout(2_000);
	const afterHide = recorder.customCalls[0]!.component.render(120).join("\n");

	expect(afterHide).toContain("calls 4");
	expect(afterHide).not.toContain("calls 0");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
bun test test/provider-tool-live-status.test.ts -t "keeps header call count cumulative after completed calls hide"
```

预期：FAIL。失败原因应为标题显示 `calls 0` 或其他小于 4 的当前可见数量。

- [ ] **步骤 3：实现累计计数**

在 `src/provider-tool-live-status.ts` 中：

1. 扩展 `LiveOverlaySnapshot`：

```ts
export interface LiveOverlaySnapshot {
	phase: LiveOverlayPhase;
	calls: LiveOverlayCallSnapshot[];
	totalCalls: number;
	startedAt: number;
	updatedAt: number;
}
```

2. 修改 `renderProviderToolLiveOverlay()` 标题计数：

```ts
const totalCalls = snapshot.totalCalls ?? snapshot.calls.length;
lines.push(truncateToWidth(
	`phase ${color(theme, phaseToken, snapshot.phase)}  calls ${totalCalls}  elapsed ${elapsedSeconds}s`,
	normalizedWidth,
));
```

3. 在 `LiveTracker` 类字段中增加：

```ts
private readonly seenDisplayableStatusIds = new Set<string>();
```

4. 增加方法：

```ts
private rememberDisplayableStatuses(): void {
	for (const status of this.statuses.values()) {
		if (statusHasVisibleDetails(status)) this.seenDisplayableStatusIds.add(status.id);
	}
}
```

5. 在 `snapshot()` 开头调用：

```ts
this.rememberDisplayableStatuses();
```

6. `snapshot()` 返回对象增加：

```ts
totalCalls: this.seenDisplayableStatusIds.size,
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
bun test test/provider-tool-live-status.test.ts -t "keeps header call count cumulative after completed calls hide"
```

预期：PASS。

## 任务 2：3 个及以下 completed 不折叠

**文件：**
- 修改：`test/provider-tool-live-status.test.ts`
- 修改：`src/provider-tool-live-status.ts`

- [ ] **步骤 1：编写失败的测试**

新增测试：

```ts
it("keeps up to three completed calls expanded after collapse timers fire", () => {
	const scheduler = createScheduler();
	const recorder = createUiRecorder({ hasUI: true });
	const manager = createProviderToolLiveStatusManager({
		throttleMs: 0,
		completedCollapseMs: 1_000,
		completedHideMs: 0,
		completedAutoCloseMs: 0,
		scheduler: scheduler.scheduler,
	});
	const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

	for (const id of ["ws-1", "ws-2", "ws-3"]) {
		tracker?.onEvent({
			type: "response.output_item.done",
			item: { type: "web_search_call", id, status: "completed", action: { query: id } },
		});
	}

	scheduler.runNextTimerByTimeout(1_000);
	const text = recorder.customCalls[0]!.component.render(120).join("\n");

	expect(text).toContain("calls 3");
	expect(text).toContain("│ query  \"ws-1\"");
	expect(text).toContain("│ query  \"ws-2\"");
	expect(text).toContain("│ query  \"ws-3\"");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
bun test test/provider-tool-live-status.test.ts -t "keeps up to three completed calls expanded after collapse timers fire"
```

预期：FAIL。当前实现会在 collapse timer 到期后折叠 completed 项，导致 `│ query ...` 消失。

- [ ] **步骤 3：实现折叠门槛**

在 `LiveTracker` 中增加常量或方法：

```ts
const MAX_EXPANDED_LIVE_CALLS = 3;
```

在 `scheduleCompletedTimers()` 的 collapse timer 回调中，把直接折叠改成调用协调方法：

```ts
this.reconcileCompletedVisibility();
this.renderNow();
```

新增最小协调方法，先只覆盖门槛：

```ts
private displayableStatusCount(): number {
	let count = 0;
	for (const status of this.statuses.values()) {
		if (statusHasVisibleDetails(status)) count += 1;
	}
	return count;
}

private reconcileCompletedVisibility(): void {
	this.rememberDisplayableStatuses();
	if (this.displayableStatusCount() <= MAX_EXPANDED_LIVE_CALLS) {
		for (const status of this.statuses.values()) {
			if (status.phase === "completed" && status.visibility === "collapsed") {
				status.visibility = "full";
			}
		}
		return;
	}
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
bun test test/provider-tool-live-status.test.ts -t "keeps up to three completed calls expanded after collapse timers fire"
```

预期：PASS。

## 任务 3：超过 3 个时折叠较旧 completed

**文件：**
- 修改：`test/provider-tool-live-status.test.ts`
- 修改：`src/provider-tool-live-status.ts`

- [ ] **步骤 1：编写失败的测试**

新增测试：

```ts
it("collapses the oldest completed call once a fourth displayable call appears", () => {
	const scheduler = createScheduler();
	const recorder = createUiRecorder({ hasUI: true });
	const manager = createProviderToolLiveStatusManager({
		throttleMs: 0,
		completedCollapseMs: 1_000,
		completedHideMs: 0,
		completedAutoCloseMs: 0,
		scheduler: scheduler.scheduler,
	});
	const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

	for (const id of ["ws-1", "ws-2", "ws-3"]) {
		tracker?.onEvent({
			type: "response.output_item.done",
			item: { type: "web_search_call", id, status: "completed", action: { query: id } },
		});
	}
	scheduler.runNextTimerByTimeout(1_000);

	tracker?.onEvent({
		type: "response.output_item.done",
		item: { type: "web_search_call", id: "ws-4", status: "completed", action: { query: "ws-4" } },
	});
	const text = recorder.customCalls[0]!.component.render(120).join("\n");

	expect(text).toContain("calls 4");
	expect(text).toContain("└ updated");
	expect(text).toContain("ws-1");
	expect(text).not.toContain("│ query  \"ws-1\"");
	expect(text).toContain("│ query  \"ws-2\"");
	expect(text).toContain("│ query  \"ws-3\"");
	expect(text).toContain("│ query  \"ws-4\"");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
bun test test/provider-tool-live-status.test.ts -t "collapses the oldest completed call once a fourth displayable call appears"
```

预期：FAIL。当前实现不会在第 4 个 call 到达时重新选择旧 completed 折叠。

- [ ] **步骤 3：实现完整协调规则**

把 `reconcileCompletedVisibility()` 扩展为：

```ts
private reconcileCompletedVisibility(): void {
	this.rememberDisplayableStatuses();
	const displayable = [...this.statuses.values()].filter(statusHasVisibleDetails);
	if (displayable.length <= MAX_EXPANDED_LIVE_CALLS) {
		for (const status of displayable) {
			if (status.phase === "completed" && status.visibility !== "hidden") status.visibility = "full";
		}
		return;
	}

	const nonCompleted = displayable.filter(status => status.phase !== "completed" && status.visibility !== "hidden");
	const completed = displayable
		.filter(status => status.phase === "completed" && status.visibility !== "hidden")
		.sort((left, right) => right.updatedAt - left.updatedAt || right.ordinal - left.ordinal);
	const completedToKeepFull = new Set<LiveToolStatus>();
	const remainingSlots = Math.max(0, MAX_EXPANDED_LIVE_CALLS - nonCompleted.length);
	for (const status of completed.slice(0, remainingSlots)) completedToKeepFull.add(status);

	for (const status of completed) {
		status.visibility = completedToKeepFull.has(status) ? "full" : "collapsed";
	}
}
```

在每次 status 更新后调用：

```ts
this.reconcileCompletedVisibility();
```

放置点：`handleEvent()` 中每次 `upsertStatus()` 后、`scheduleRender()` / `renderNow()` 前。避免在 `status.visibility = "full"` 后被旧 timer 覆盖。

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
bun test test/provider-tool-live-status.test.ts -t "collapses the oldest completed call once a fourth displayable call appears"
```

预期：PASS。

## 任务 4：非 completed 项永远展开

**文件：**
- 修改：`test/provider-tool-live-status.test.ts`
- 修改：`src/provider-tool-live-status.ts`

- [ ] **步骤 1：编写失败的测试**

新增测试：

```ts
it("keeps non-completed calls expanded and collapses older completed calls first", () => {
	const scheduler = createScheduler();
	const recorder = createUiRecorder({ hasUI: true });
	const manager = createProviderToolLiveStatusManager({
		throttleMs: 0,
		completedCollapseMs: 1_000,
		completedHideMs: 0,
		completedAutoCloseMs: 0,
		scheduler: scheduler.scheduler,
	});
	const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

	for (const id of ["done-a", "done-b", "done-c"]) {
		tracker?.onEvent({
			type: "response.output_item.done",
			item: { type: "web_search_call", id, status: "completed", action: { query: id } },
		});
	}
	scheduler.runNextTimerByTimeout(1_000);
	tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "active-1", status: "searching", action: { query: "active-1" } } });
	tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "active-2", status: "searching", action: { query: "active-2" } } });

	const text = recorder.customCalls[0]!.component.render(140).join("\n");

	expect(text).toContain("calls 5");
	expect(text).toContain("│ query  \"active-1\"");
	expect(text).toContain("│ query  \"active-2\"");
	expect(text).toContain("│ query  \"done-c\"");
	expect(text).not.toContain("│ query  \"done-a\"");
	expect(text).not.toContain("│ query  \"done-b\"");
	expect(text).toContain("done-a");
	expect(text).toContain("done-b");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
bun test test/provider-tool-live-status.test.ts -t "keeps non-completed calls expanded and collapses older completed calls first"
```

预期：FAIL，当前实现没有按非 completed 优先保留展开。

- [ ] **步骤 3：修正排序和显示顺序**

如果任务 3 的协调规则未满足本测试，调整 `reconcileCompletedVisibility()`：

- `nonCompleted` 不改变 `visibility`。
- completed 展开名额只由 `MAX_EXPANDED_LIVE_CALLS - nonCompleted.length` 决定。
- completed 排序使用 `updatedAt desc`，再用 `ordinal desc` 打破同时间戳。

无需改 `snapshot()` 的排序；它继续按 `updatedAt desc` 显示。

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
bun test test/provider-tool-live-status.test.ts -t "keeps non-completed calls expanded and collapses older completed calls first"
```

预期：PASS。

## 任务 5：文档更新

**文件：**
- 修改：`README.md`
- 修改：`docs/runtime-compatibility.md`
- 修改：`test/docs.test.ts`

- [ ] **步骤 1：编写失败的文档测试**

在 `test/docs.test.ts` 的 live overlay 文档测试 `requiredSnippets` 中增加：

```ts
"header calls count is cumulative across the overlay lifetime",
"completed calls collapse only after more than 3 displayable calls",
"non-completed calls stay expanded while older completed calls collapse first",
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
bun test test/docs.test.ts -t "documents web_search live overlay lifecycle"
```

预期：FAIL，提示新增片段不存在。

- [ ] **步骤 3：更新文档**

在 `README.md` 的 live overlay 说明中加入英文片段，保持双语文档现有风格：

```markdown
  - The header calls count is cumulative across the overlay lifetime: completed collapse, hide, and max visible rows do not reduce it.
  - Completed calls collapse only after more than 3 displayable calls. Non-completed calls stay expanded while older completed calls collapse first.
```

在 `docs/runtime-compatibility.md` 的 `Live status overlay UI` 行中加入同样语义：

```markdown
The header calls count is cumulative across the overlay lifetime. Completed calls collapse only after more than 3 displayable calls; non-completed calls stay expanded while older completed calls collapse first.
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
bun test test/docs.test.ts -t "documents web_search live overlay lifecycle"
```

预期：PASS。

## 任务 6：回归验证

**文件：**
- 验证：`src/provider-tool-live-status.ts`
- 验证：`test/provider-tool-live-status.test.ts`
- 验证：`README.md`
- 验证：`docs/runtime-compatibility.md`
- 验证：`test/docs.test.ts`

- [ ] **步骤 1：运行 live overlay 测试**

运行：

```bash
bun test test/provider-tool-live-status.test.ts --timeout 10000
```

预期：全部通过，输出包含 `0 fail`。

- [ ] **步骤 2：运行文档测试**

运行：

```bash
bun test test/docs.test.ts --timeout 10000
```

预期：全部通过，输出包含 `0 fail`。

- [ ] **步骤 3：运行相关集成测试**

运行：

```bash
bun test test/provider-tool-live-status.test.ts test/extension.test.ts test/docs.test.ts --timeout 10000
```

预期：全部通过，输出包含 `0 fail`。

- [ ] **步骤 4：运行全量测试**

运行：

```bash
bun test --timeout 10000
```

预期：全部通过，输出包含 `0 fail`。

- [ ] **步骤 5：运行源码类型检查**

运行：

```bash
bun x tsc --noEmit --pretty false --ignoreConfig --skipLibCheck --types bun-types --target ES2022 --module ESNext --moduleResolution Bundler --strict src/provider-tool-live-status.ts
```

预期：exit 0，无输出。

- [ ] **步骤 6：运行打包 dry run**

运行：

```bash
bun pm pack --dry-run
```

预期：exit 0，确认没有意外新增临时文件。

- [ ] **步骤 7：运行 diff 检查**

运行：

```bash
git diff --check
```

预期：无输出。

- [ ] **步骤 8：运行插件 doctor**

运行：

```bash
omp plugin doctor
```

预期：`Summary: 5 ok, 0 warnings, 0 errors`。
