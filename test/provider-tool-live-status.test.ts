import { describe, expect, it } from "bun:test";

import {
	createProviderToolLiveStatusManager,
	renderProviderToolLiveOverlay,
	type ProviderToolLiveUiSink,
	type OverlayComponentLike,
} from "../src/provider-tool-live-status";

type WidgetCall = {
	key: string;
	content: string[] | undefined;
	options?: { placement?: "aboveEditor" | "belowEditor" };
};

type CustomCall = {
	options?: { overlay?: boolean };
	component: OverlayComponentLike;
	requestRenderCalls: number;
};

function createTestTheme() {
	return {
		fg(token: string, value: string) {
			return `[${token}:${value}]`;
		},
	};
}

function createUiRecorder(options: { hasUI?: boolean; throwOnCustom?: boolean; throwOnRequestRender?: boolean | (() => boolean); throwOnWidget?: boolean; useFourArgFactory?: boolean } = {}) {
	const widgetCalls: WidgetCall[] = [];
	const customCalls: CustomCall[] = [];
	const doneResults: unknown[] = [];
	const ui: ProviderToolLiveUiSink = {
		hasUI: options.hasUI,
		setWidget(key, content, widgetOptions) {
			if (options.throwOnWidget) {
				throw new Error("setWidget failed");
			}
			widgetCalls.push({ key, content, options: widgetOptions });
		},
		custom(factory, customOptions) {
			if (options.throwOnCustom) {
				throw new Error("custom failed");
			}
			const call: CustomCall = {
				options: customOptions,
				component: undefined as unknown as OverlayComponentLike,
				requestRenderCalls: 0,
			};
			const tui = { requestRender() { const shouldThrow = typeof options.throwOnRequestRender === "function" ? options.throwOnRequestRender() : options.throwOnRequestRender; if (shouldThrow) throw new Error("requestRender failed"); call.requestRenderCalls++; } };
			const done = (result: unknown) => doneResults.push(result);
			const component = options.useFourArgFactory
				? factory(tui, createTestTheme(), {}, done)
				: factory(tui, createTestTheme(), done);
			call.component = component as OverlayComponentLike;
			customCalls.push(call);
			return Promise.resolve(undefined);
		},
	};
	return { widgetCalls, customCalls, doneResults, ui };
}

function createScheduler() {
	const scheduled: Array<{ handler: () => void; timeout: number; cleared: boolean }> = [];
	const cleared: unknown[] = [];
	return {
		scheduled,
		cleared,
		scheduler: {
			setTimeout(handler: () => void, timeout: number) {
				const handle = { handler, timeout, cleared: false };
				scheduled.push(handle);
				return handle as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimeout(handle: ReturnType<typeof setTimeout>) {
				cleared.push(handle);
				(handle as unknown as { cleared?: boolean }).cleared = true;
			},
		},
		runActiveTimers() {
			for (const handle of [...scheduled]) {
				if (!handle.cleared) {
					handle.handler();
				}
			}
		},
	};
}

describe("provider tool live status", () => {
	it("opens an automatic dashboard overlay for web_search progress instead of a short widget", () => {
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		expect(tracker).toBeDefined();
		tracker?.onEvent({
			type: "response.output_item.added",
			item: {
				type: "web_search_call",
				id: "ws-1",
				status: "searching",
				action: { type: "search", query: "provider native overlay style" },
			},
		});

		expect(recorder.customCalls).toHaveLength(1);
		expect(recorder.customCalls[0]?.options).toEqual({ overlay: true });
		expect(recorder.widgetCalls).toEqual([]);
		const lines = recorder.customCalls[0]!.component.render(96);
		const text = lines.join("\n");
		expect(text).toContain("OpenAI provider web_search");
		expect(text).toContain("provider native overlay style");
		expect(text).toContain("searching");
		expect(text).toContain("esc/q close");
		expect(lines.length).toBeGreaterThanOrEqual(6);
	});

	it("renders an OMP-style dashboard overlay snapshot", () => {
		const lines = renderProviderToolLiveOverlay(
			{
				phase: "searching",
				startedAt: 1_000,
				updatedAt: 3_500,
				calls: [{
					id: "ws-1",
					phase: "searching",
					queries: ["first query", "second query"],
					sourceCount: 2,
					updatedAt: 3_500,
				}],
			},
			100,
			createTestTheme(),
			{ now: () => 4_000 },
		);

		const text = lines.join("\n");
		expect(lines[0]).toContain("[accent:");
		expect(lines[0]).toContain("[borderMuted:");
		expect(lines[0]).toContain("[dim:");
		expect(text).toContain("OpenAI provider web_search");
		expect(text).toContain("live overlay");
		expect(text).toContain("searching");
		expect(text).toContain("sources 2");
		expect(text).toContain("first query");
		expect(text).toContain("second query");
		expect(text).toContain("esc/q close");
	});

	it("does not create a tracker or render when only image_generation is enabled", () => {
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
		const tracker = manager.createTracker({ enabledTools: ["image_generation"], ui: recorder.ui });

		expect(tracker).toBeUndefined();
		expect(recorder.customCalls).toEqual([]);
		expect(recorder.widgetCalls).toEqual([]);
	});

	it("cancels pending throttled overlay render on response.completed and closes the overlay", () => {
		const scheduler = createScheduler();
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 250, scheduler: scheduler.scheduler });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1" } });
		expect(scheduler.scheduled).toHaveLength(1);
		expect(recorder.customCalls).toEqual([]);

		tracker?.onEvent({ type: "response.completed" });
		expect(scheduler.cleared.length).toBeGreaterThan(0);
		expect(recorder.customCalls).toHaveLength(1);
		expect(recorder.customCalls[0]!.component.render(100).join("\n")).toContain("completed");
		expect(recorder.doneResults).toEqual([]);
		expect(recorder.widgetCalls).toEqual([]);

		scheduler.runActiveTimers();
		expect(recorder.doneResults).toEqual([undefined]);
	});

	it("keeps a completed search visible briefly before auto-closing the overlay", () => {
		const scheduler = createScheduler();
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0, completedAutoCloseMs: 1_500, scheduler: scheduler.scheduler });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({
			type: "response.output_item.added",
			item: { type: "web_search_call", id: "ws-1", query: "auto close" },
		});
		tracker?.onEvent({
			type: "response.output_item.done",
			item: { type: "web_search_call", id: "ws-1", status: "completed", query: "auto close", sources: [{ url: "https://example.invalid" }] },
		});

		expect(recorder.customCalls).toHaveLength(1);
		expect(recorder.customCalls[0]!.component.render(100).join("\n")).toContain("completed");
		expect(recorder.doneResults).toEqual([]);
		expect(scheduler.scheduled.at(-1)?.timeout).toBe(1_500);

		scheduler.runActiveTimers();

		expect(recorder.doneResults).toEqual([undefined]);
	});

	it("closes the automatic overlay on auto-close, failed, clear, and keyboard input", () => {
		const scheduler = createScheduler();
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0, scheduler: scheduler.scheduler });

		const completed = createUiRecorder({ hasUI: true });
		const completedTracker = manager.createTracker({ enabledTools: ["web_search"], ui: completed.ui });
		completedTracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1", query: "done" } });
		completedTracker?.onEvent({ type: "response.completed" });
		expect(completed.doneResults).toEqual([]);
		scheduler.runActiveTimers();
		expect(completed.doneResults).toEqual([undefined]);

		const failed = createUiRecorder({ hasUI: true });
		const failedTracker = manager.createTracker({ enabledTools: ["web_search"], ui: failed.ui });
		failedTracker?.onEvent({ type: "response.failed", error: { message: "rate limited" } });
		expect(failed.customCalls).toHaveLength(1);
		expect(failed.customCalls[0]!.component.render(80).join("\n")).toContain("failed");
		expect(failed.customCalls[0]!.component.render(80).join("\n")).toContain("rate limited");
		expect(failed.doneResults).toEqual([undefined]);

		const manual = createUiRecorder({ hasUI: true });
		const manualTracker = manager.createTracker({ enabledTools: ["web_search"], ui: manual.ui });
		manualTracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-2", query: "manual" } });
		manualTracker?.clear();
		expect(manual.doneResults).toEqual([undefined]);

		const keyboard = createUiRecorder({ hasUI: true });
		const keyboardTracker = manager.createTracker({ enabledTools: ["web_search"], ui: keyboard.ui });
		keyboardTracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-3", query: "keyboard" } });
		keyboard.customCalls[0]!.component.handleInput?.("q");
		keyboard.customCalls[0]!.component.handleInput?.("escape");
		expect(keyboard.doneResults).toEqual([undefined]);
	});

	it("cleans pending timers when the runtime disposes or disables the overlay", () => {
		const disposedScheduler = createScheduler();
		const disposed = createUiRecorder({ hasUI: true });
		const disposedManager = createProviderToolLiveStatusManager({ throttleMs: 0, completedAutoCloseMs: 1_500, scheduler: disposedScheduler.scheduler });
		const disposedTracker = disposedManager.createTracker({ enabledTools: ["web_search"], ui: disposed.ui });
		disposedTracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1", query: "dispose" } });
		disposedTracker?.onEvent({ type: "response.completed" });
		expect(disposedScheduler.scheduled.at(-1)?.timeout).toBe(1_500);
		disposed.customCalls[0]!.component.dispose?.();
		expect(disposedScheduler.cleared.length).toBeGreaterThan(0);
		disposedScheduler.runActiveTimers();
		expect(disposed.doneResults).toEqual([]);

		const failingScheduler = createScheduler();
		let requestRenderShouldThrow = false;
		const failing = createUiRecorder({ hasUI: true, throwOnRequestRender: () => requestRenderShouldThrow, useFourArgFactory: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0, completedAutoCloseMs: 1_500, scheduler: failingScheduler.scheduler });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: failing.ui });
		tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-2", query: "disable" } });
		tracker?.onEvent({ type: "response.completed" });
		expect(failingScheduler.scheduled.at(-1)?.timeout).toBe(1_500);
		requestRenderShouldThrow = true;
		tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-3", query: "throws" } });
		expect(failingScheduler.cleared.length).toBeGreaterThan(0);
		failingScheduler.runActiveTimers();
		expect(failing.doneResults).toEqual([]);
	});

	it("no-ops without custom overlay capability and does not fall back to the short widget", () => {
		const recorder = createUiRecorder({ hasUI: false });
		delete recorder.ui.custom;
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		expect(() => {
			tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1", query: "rpc" } });
			tracker?.clear();
		}).not.toThrow();
		expect(recorder.customCalls).toEqual([]);
		expect(recorder.widgetCalls).toEqual([]);
	});

	it("clearAll closes only active overlays once", () => {
		const manuallyCleared = createUiRecorder({ hasUI: true });
		const completed = createUiRecorder({ hasUI: true });
		const stillActive = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
		const manualTracker = manager.createTracker({ enabledTools: ["web_search"], ui: manuallyCleared.ui });
		const completedTracker = manager.createTracker({ enabledTools: ["web_search"], ui: completed.ui });
		manager.createTracker({ enabledTools: ["web_search"], ui: stillActive.ui })?.onEvent({
			type: "response.output_item.added",
			item: { type: "web_search_call", id: "ws-3", query: "active" },
		});

		manualTracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1", query: "manual" } });
		completedTracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-2", query: "complete" } });
		manualTracker?.clear();
		completedTracker?.onEvent({ type: "response.completed" });
		manager.clearAll();

		expect(manuallyCleared.doneResults).toEqual([undefined]);
		expect(completed.doneResults).toEqual([undefined]);
		expect(stillActive.doneResults).toEqual([undefined]);
		expect(stillActive.widgetCalls).toEqual([]);
	});

	it("updates an already-open overlay by requesting render instead of opening duplicates", () => {
		const recorder = createUiRecorder({ hasUI: true, useFourArgFactory: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1", query: "first" } });
		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-1", status: "completed", query: "first", sources: [{ url: "https://example.invalid" }] } });

		expect(recorder.customCalls).toHaveLength(1);
		expect(recorder.customCalls[0]?.requestRenderCalls).toBeGreaterThan(0);
		const text = recorder.customCalls[0]!.component.render(100).join("\n");
		expect(text).toContain("completed");
		expect(text).toContain("sources 1");
	});

	it("warns, disables future UI updates, and does not throw when custom overlay opening fails", () => {
		const throwing = createUiRecorder({ hasUI: true, throwOnCustom: true });
		const later = createUiRecorder({ hasUI: true });
		const warnings: unknown[][] = [];
		const manager = createProviderToolLiveStatusManager({
			throttleMs: 0,
			logger: { warn: (...args: unknown[]) => warnings.push(args) },
		});
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: throwing.ui });

		expect(() => {
			tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1" } });
		}).not.toThrow();
		expect(warnings.length).toBeGreaterThan(0);

		const laterTracker = manager.createTracker({ enabledTools: ["web_search"], ui: later.ui });
		laterTracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-2" } });
		manager.clearAll();
		expect(later.customCalls).toEqual([]);
		expect(later.widgetCalls).toEqual([]);
	});

	it("truncates each query to one line and shows at most three deduplicated queries", () => {
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });
		const longQuery = `${"a".repeat(90)}\n${"b".repeat(90)}`;

		tracker?.onEvent({
			type: "response.output_item.added",
			item: {
				type: "web_search_call",
				id: "ws-1",
				action: { query: "primary query", queries: [longQuery, "second query", "primary query", "fourth query"] },
			},
		});

		const text = recorder.customCalls[0]!.component.render(160).join("\n");
		expect(text).toContain("primary query");
		expect(text).toContain("second query");
		expect(text).not.toContain("fourth query");
		expect(text).toContain("…");
		for (const line of text.split("\n").filter(line => line.includes("query"))) {
			expect(line).not.toContain("\r");
			expect(line).not.toContain("\t");
		}
	});
});
