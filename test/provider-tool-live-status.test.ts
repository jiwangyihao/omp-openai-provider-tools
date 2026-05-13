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

function createUiRecorder(options: { hasUI?: boolean; throwOnCustom?: boolean; throwOnRequestRender?: boolean | (() => boolean); throwOnWidget?: boolean; useFourArgFactory?: boolean; tui?: { requestRender?: () => void } } = {}) {
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
			const tui = options.tui ?? { requestRender() { const shouldThrow = typeof options.throwOnRequestRender === "function" ? options.throwOnRequestRender() : options.throwOnRequestRender; if (shouldThrow) throw new Error("requestRender failed"); call.requestRenderCalls++; } };
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
		runNextTimerByTimeout(timeout: number) {
			const handle = scheduled.find(entry => !entry.cleared && entry.timeout === timeout);
			if (!handle) throw new Error(`No active timer scheduled for ${timeout}ms`);
			handle.cleared = true;
			handle.handler();
		},
		runActiveTimers() {
			for (const handle of [...scheduled]) {
				if (!handle.cleared) {
					handle.cleared = true;
					handle.handler();
				}
			}
		},
	};
}

function activeTimeouts(scheduler: ReturnType<typeof createScheduler>): number[] {
	return scheduler.scheduled.filter(entry => !entry.cleared).map(entry => entry.timeout);
}

describe("provider tool live status", () => {
	it("ignores response.completed before any web_search_call instead of creating placeholder overlay state", () => {
		const scheduler = createScheduler();
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0, scheduler: scheduler.scheduler });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.completed", response: { id: "resp-unknown" } });
		scheduler.runActiveTimers();

		expect(recorder.customCalls).toEqual([]);
		expect(recorder.doneResults).toEqual([]);
	});

	it("shows queryless placeholder calls while waiting for provider details", () => {
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-placeholder", status: "searching" } });
		expect(recorder.customCalls).toHaveLength(1);
		expect(recorder.customCalls[0]!.component.render(100).join("\n")).toContain("waiting for provider query");

		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-placeholder", status: "completed", action: { query: "real provider query" } } });

		expect(recorder.customCalls[0]!.component.render(100).join("\n")).toContain("real provider query");
		expect(recorder.customCalls[0]!.component.render(100).join("\n")).not.toContain("waiting for provider query");
	});

	it("keeps overlay alive when runtime requestRender is an unbound method", () => {
		class Runtime {
			#renderRequested = false;

			requestRender() {
				this.#renderRequested = true;
			}

			get renderRequested() {
				return this.#renderRequested;
			}
		}
		const runtime = new Runtime();
		const recorder = createUiRecorder({ hasUI: true, tui: runtime });
		const warnings: unknown[] = [];
		const manager = createProviderToolLiveStatusManager({
			throttleMs: 0,
			logger: { warn: (...args: unknown[]) => { warnings.push(args); } },
		});
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-unbound", status: "searching" } });
		expect(recorder.customCalls).toHaveLength(1);
		recorder.customCalls[0]!.component.render(120);
		expect(recorder.doneResults).toEqual([]);

		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-unbound", status: "completed", action: { query: "unbound render" } } });

		expect(runtime.renderRequested).toBe(true);
		expect(recorder.doneResults).toEqual([]);
		tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-unbound", status: "searching", action: { query: "unbound render again" } } });
		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-unbound", status: "completed", action: { query: "unbound render again" } } });
		expect(warnings).toEqual([]);
		expect(recorder.doneResults).toEqual([]);
	});


	it("renders action-only final web_search calls in the live overlay", () => {
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-open-page", status: "completed", action: { type: "open_page", url: "https://example.invalid/page" } } });

		expect(recorder.customCalls).toHaveLength(1);
		const text = recorder.customCalls[0]!.component.render(120).join("\n");
		expect(text).toContain("open_page url: https://example.invalid/page");
		expect(text).not.toContain("waiting for provider query");
	});
	it("tracks item_id-only lifecycle events as hidden placeholders and merges final details", () => {
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.web_search_call.in_progress", item_id: "ws-lifecycle", output_index: 0, sequence_number: 1 });
		expect(recorder.customCalls).toHaveLength(1);
		expect(recorder.customCalls[0]!.component.render(120).join("\n")).toContain("waiting for provider query");
		tracker?.onEvent({ type: "response.web_search_call.searching", item_id: "ws-lifecycle", output_index: 0, sequence_number: 2 });
		tracker?.onEvent({ type: "response.web_search_call.completed", item_id: "ws-lifecycle", output_index: 0, sequence_number: 3 });

		tracker?.onEvent({
			type: "response.output_item.done",
			item: { type: "web_search_call", id: "ws-lifecycle", status: "completed", action: { query: "visible lifecycle query" } },
		});

		expect(recorder.customCalls).toHaveLength(1);
		const text = recorder.customCalls[0]!.component.render(120).join("\n");
		expect(text).toContain("visible lifecycle query");
		expect(text).toContain("completed");
		expect(text).not.toContain("unknown");
		expect((text.match(/web_search_call/g) ?? []).length).toBe(1);
	});

	it("merges idless final output items into request-local lifecycle placeholders", () => {
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.web_search_call.searching", output_index: 4, sequence_number: 10 });
		expect(recorder.customCalls).toHaveLength(1);

		tracker?.onEvent({
			type: "response.output_item.done",
			output_index: 4,
			sequence_number: 11,
			item: { type: "web_search_call", status: "completed", action: { query: "request local query" } },
		});

		expect(recorder.customCalls).toHaveLength(1);
		const text = recorder.customCalls[0]!.component.render(120).join("\n");
		expect(text).toContain("search #1");
		expect(text).not.toContain("search #2");
		expect(text).toContain("request local query");
		expect(text).toContain("completed");
	});

	it("uses slower completed timing defaults while preserving short test overrides", () => {
		const defaultScheduler = createScheduler();
		const defaultRecorder = createUiRecorder({ hasUI: true });
		const defaultManager = createProviderToolLiveStatusManager({ throttleMs: 0, scheduler: defaultScheduler.scheduler });
		const defaultTracker = defaultManager.createTracker({ enabledTools: ["web_search"], ui: defaultRecorder.ui });

		defaultTracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-default", status: "completed", action: { query: "default timing" } } });
		defaultTracker?.onEvent({ type: "response.completed" });
		expect(activeTimeouts(defaultScheduler)).toContain(3_000);
		expect(activeTimeouts(defaultScheduler)).toContain(8_000);
		expect(activeTimeouts(defaultScheduler).some(timeout => timeout < 3_000)).toBe(false);
		defaultScheduler.runNextTimerByTimeout(8_000);
		expect(activeTimeouts(defaultScheduler)).not.toContain(10_000);

		const overrideScheduler = createScheduler();
		const overrideRecorder = createUiRecorder({ hasUI: true });
		const overrideManager = createProviderToolLiveStatusManager({
			throttleMs: 0,
			completedCollapseMs: 11,
			completedHideMs: 22,
			completedAutoCloseMs: 33,
			scheduler: overrideScheduler.scheduler,
		});
		const overrideTracker = overrideManager.createTracker({ enabledTools: ["web_search"], ui: overrideRecorder.ui });

		overrideTracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-override", status: "completed", action: { query: "override timing" } } });
		overrideTracker?.onEvent({ type: "response.completed" });

		expect(activeTimeouts(overrideScheduler)).toContain(11);
		expect(activeTimeouts(overrideScheduler)).toContain(22);
		overrideScheduler.runNextTimerByTimeout(22);
		expect(activeTimeouts(overrideScheduler)).not.toContain(33);
	});

	it("keeps completed auto-close when a late queryless output item arrives", () => {
		const scheduler = createScheduler();
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0, completedCollapseMs: 11, completedHideMs: 22, completedAutoCloseMs: 33, scheduler: scheduler.scheduler });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-complete", status: "completed", action: { query: "auto close remains" } } });
		tracker?.onEvent({ type: "response.completed" });
		scheduler.runNextTimerByTimeout(22);
		expect(activeTimeouts(scheduler)).not.toContain(33);

		tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-queryless", status: "searching" } });

		expect(activeTimeouts(scheduler)).toContain(11);
	});

	it("does not display request or unknown ids as overlay identities", () => {
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.web_search_call.searching", item_id: "res_hidden", query: "request id query" });
		tracker?.onEvent({ type: "response.web_search_call.searching", item_id: "resp_hidden", query: "response id query" });
		tracker?.onEvent({ type: "response.web_search_call.searching", item_id: "unknown", sources: [{}] });

		const text = recorder.customCalls[0]!.component.render(160).join("\n");
		expect(text).toContain("request id query");
		expect(text).toContain("response id query");
		expect(text).toContain("sources 1");
		expect(text).not.toContain("res_hidden");
		expect(text).not.toContain("resp_hidden");
		expect(text).not.toContain("unknown");
	});

	it("allows new trackers to open after render failure, manual close, auto-close, and dispose", () => {
		let requestRenderShouldThrow = false;
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0, completedCollapseMs: 1, completedHideMs: 2, completedAutoCloseMs: 3, scheduler: createScheduler().scheduler });

		const failing = createUiRecorder({ hasUI: true, throwOnRequestRender: () => requestRenderShouldThrow, useFourArgFactory: true });
		const failingTracker = manager.createTracker({ enabledTools: ["web_search"], ui: failing.ui });
		failingTracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-fail", query: "first failure" } });
		requestRenderShouldThrow = true;
		failingTracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-fail-2", query: "render fails" } });
		expect(failing.doneResults).toEqual([undefined]);

		const afterFailure = createUiRecorder({ hasUI: true });
		manager.createTracker({ enabledTools: ["web_search"], ui: afterFailure.ui })?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-after-failure", query: "after failure" } });
		expect(afterFailure.customCalls).toHaveLength(1);
		expect(afterFailure.customCalls[0]!.component.render(120).join("\n")).toContain("after failure");

		const manual = createUiRecorder({ hasUI: true });
		const manualTracker = manager.createTracker({ enabledTools: ["web_search"], ui: manual.ui });
		manualTracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-manual", query: "manual close" } });
		manual.customCalls[0]!.component.handleInput?.("q");
		expect(manual.doneResults).toEqual([undefined]);

		const afterManual = createUiRecorder({ hasUI: true });
		manager.createTracker({ enabledTools: ["web_search"], ui: afterManual.ui })?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-after-manual", query: "after manual" } });
		expect(afterManual.customCalls[0]!.component.render(120).join("\n")).toContain("after manual");

		const autoScheduler = createScheduler();
		const autoManager = createProviderToolLiveStatusManager({ throttleMs: 0, completedCollapseMs: 1, completedHideMs: 2, completedAutoCloseMs: 3, scheduler: autoScheduler.scheduler });
		const auto = createUiRecorder({ hasUI: true });
		const autoTracker = autoManager.createTracker({ enabledTools: ["web_search"], ui: auto.ui });
		autoTracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-auto", status: "completed", action: { query: "auto close" } } });
		autoTracker?.onEvent({ type: "response.completed" });
		autoTracker?.clear();
		expect(auto.doneResults).toEqual([undefined]);

		const afterAuto = createUiRecorder({ hasUI: true });
		autoManager.createTracker({ enabledTools: ["web_search"], ui: afterAuto.ui })?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-after-auto", query: "after auto" } });
		expect(afterAuto.customCalls[0]!.component.render(120).join("\n")).toContain("after auto");

		const dispose = createUiRecorder({ hasUI: true });
		const disposeTracker = manager.createTracker({ enabledTools: ["web_search"], ui: dispose.ui });
		disposeTracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-dispose", query: "dispose" } });
		dispose.customCalls[0]!.component.dispose?.();
		expect(dispose.doneResults).toEqual([]);

		const afterDispose = createUiRecorder({ hasUI: true });
		manager.createTracker({ enabledTools: ["web_search"], ui: afterDispose.ui })?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-after-dispose", query: "after dispose" } });
		expect(afterDispose.customCalls[0]!.component.render(120).join("\n")).toContain("after dispose");
	});

	it("keeps queryless completed placeholders visible until request completion clears them", () => {
		const scheduler = createScheduler();
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0, scheduler: scheduler.scheduler });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-placeholder", status: "completed" } });
		expect(recorder.customCalls).toHaveLength(1);
		expect(recorder.customCalls[0]!.component.render(120).join("\n")).toContain("waiting for provider query");
		tracker?.onEvent({ type: "response.completed", response: { id: "resp-placeholder" } });
		scheduler.runActiveTimers();

		expect(recorder.doneResults).toEqual([undefined]);
	});

	it("shows queryless added placeholder until response.completed closes it", () => {
		const scheduler = createScheduler();
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0, scheduler: scheduler.scheduler });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-placeholder", status: "searching" } });
		expect(recorder.customCalls).toHaveLength(1);
		tracker?.onEvent({ type: "response.completed", response: { id: "resp-placeholder" } });
		scheduler.runActiveTimers();

		expect(recorder.doneResults).toEqual([undefined]);
	});

	it("merges temporary search ids into final ids without rendering unknown", () => {
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
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
		expect(text).toContain("ws-1");
		expect(text).not.toContain("│ query  \"ws-1\"");
		expect(text).toContain("│ query  \"ws-2\"");
		expect(text).toContain("│ query  \"ws-3\"");
		expect(text).toContain("│ query  \"ws-4\"");
	});

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

	it("keeps three displayable calls visible after completed hide timers fire", () => {
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

		for (const id of ["ws-1", "ws-2", "ws-3", "ws-4", "ws-5"]) {
			tracker?.onEvent({
				type: "response.output_item.done",
				item: { type: "web_search_call", id, status: "completed", action: { query: id } },
			});
		}

		scheduler.runActiveTimers();
		const text = recorder.customCalls[0]!.component.render(160).join("\n");

		expect(text).toContain("calls 5");
		expect((text.match(/web_search_call/g) ?? []).length).toBe(3);
		expect(text).toContain("ws-3");
		expect(text).toContain("ws-4");
		expect(text).toContain("ws-5");
		expect(text).not.toContain("ws-1");
		expect(text).not.toContain("ws-2");
	});

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

		const initial = recorder.customCalls[0]!.component.render(120).join("\n");
		expect(initial).toContain("calls 1");
		expect(initial).toContain("│ query  \"collapse me\"");

		scheduler.runNextTimerByTimeout(1_000);
		const afterCollapseTimer = recorder.customCalls[0]!.component.render(120).join("\n");
		expect(afterCollapseTimer).toContain("collapse me");
		expect(afterCollapseTimer).toContain("│ query  \"collapse me\"");

		scheduler.runNextTimerByTimeout(2_000);
		expect(recorder.customCalls[0]!.component.render(120).join("\n")).toContain("collapse me");

		scheduler.runActiveTimers();
		expect(recorder.doneResults).toEqual([undefined]);
	});

	it("waits for completed entries to hide before auto-closing after response.completed", () => {
		const scheduler = createScheduler();
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({
			throttleMs: 0,
			completedCollapseMs: 1_000,
			completedHideMs: 5_000,
			completedAutoCloseMs: 3_000,
			scheduler: scheduler.scheduler,
		});
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.web_search_call.searching", item: { type: "web_search_call", id: "res_live" }, query: "later completed" });
		tracker?.onEvent({ type: "response.completed" });

		expect(() => scheduler.runNextTimerByTimeout(3_000)).toThrow("No active timer scheduled");
		expect(recorder.doneResults).toEqual([]);
		expect(recorder.customCalls[0]!.component.render(120).join("\n")).toContain("later completed");
		scheduler.runNextTimerByTimeout(5_000);
		expect(() => scheduler.runNextTimerByTimeout(3_000)).toThrow("No active timer scheduled");
		expect(recorder.doneResults).toEqual([]);
	});

	it("does not merge new temporary searches into completed final calls with the same query", () => {
		const scheduler = createScheduler();
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0, completedCollapseMs: 1_500, scheduler: scheduler.scheduler });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-1", status: "completed", action: { query: "same" } } });
		tracker?.onEvent({ type: "response.web_search_call.searching", item: { type: "web_search_call", id: "res_2" }, query: "same" });

		const text = recorder.customCalls[0]!.component.render(120).join("\n");
		expect(text).toContain("ws-1");
		expect(text).toContain("search #");
		expect(text).toContain("searching");
		expect(text).toContain("completed");
		expect(text).not.toContain("res_2");

		scheduler.runNextTimerByTimeout(1_500);
		const collapsed = recorder.customCalls[0]!.component.render(120).join("\n");
		expect(collapsed).toContain("ws-1");
		expect(collapsed).toContain("search #");
	});

	it("does not auto-close while a later completed call is still visible", () => {
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

		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-1", status: "completed", action: { query: "first" } } });
		scheduler.runNextTimerByTimeout(2_000);
		expect(recorder.customCalls[0]!.component.render(120).join("\n")).toContain("first");

		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-2", status: "completed", action: { query: "second" } } });
		expect(recorder.customCalls[0]!.component.render(120).join("\n")).toContain("second");
		expect(() => scheduler.runNextTimerByTimeout(3_000)).toThrow("No active timer scheduled");
		expect(recorder.doneResults).toEqual([]);
		expect(recorder.customCalls[0]!.component.render(120).join("\n")).toContain("second");
	});

	it("auto-closes after the last done-only completed call hides", () => {
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

		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-only", status: "completed", action: { query: "done only" } } });
		expect(recorder.customCalls[0]!.component.render(120).join("\n")).toContain("done only");
		scheduler.runNextTimerByTimeout(2_000);
		const hiddenText = recorder.customCalls[0]!.component.render(120).join("\n");
		expect(hiddenText).toContain("done only");
		expect(hiddenText).not.toContain("pending");
		tracker?.onEvent({ type: "response.completed" });
		expect(recorder.doneResults).toEqual([]);
	});

	it("cancels pending auto-close when a new searching event starts", () => {
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

		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-old", status: "completed", action: { query: "old" } } });
		tracker?.onEvent({ type: "response.completed" });
		scheduler.runNextTimerByTimeout(2_000);
		tracker?.onEvent({ type: "response.web_search_call.searching", item: { type: "web_search_call", id: "res_new" }, query: "new live" });
		expect(scheduler.cleared.some(handle => (handle as { timeout?: number }).timeout === 3_000)).toBe(false);
		expect(recorder.customCalls[0]!.component.render(120).join("\n")).toContain("new live");
		expect(() => scheduler.runNextTimerByTimeout(3_000)).toThrow("No active timer scheduled");
		expect(recorder.doneResults).toEqual([]);
	});

	it("keeps tracker alive for queryless pending placeholders before request completion", () => {
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

		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-old", status: "completed", action: { query: "old" } } });
		tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-pending", status: "searching" } });
		scheduler.runNextTimerByTimeout(2_000);
		expect(() => scheduler.runNextTimerByTimeout(3_000)).toThrow("No active timer scheduled");
		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-pending", status: "completed", action: { query: "late query" } } });
		expect(recorder.customCalls[0]!.component.render(120).join("\n")).toContain("late query");
	});

	it("shows repeated completed events for the same final id after the previous entry hid", () => {
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

		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-repeat", status: "completed", action: { query: "repeat" } } });
		scheduler.runNextTimerByTimeout(2_000);
		expect(recorder.customCalls[0]!.component.render(120).join("\n")).toContain("repeat");

		tracker?.onEvent({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws-repeat", status: "completed", action: { query: "repeat" } } });
		const text = recorder.customCalls[0]!.component.render(120).join("\n");
		expect(text).toContain("ws-repeat");
		expect(text).toContain("repeat");
	});

	it("ignores image generation calls even when web_search live status is enabled", () => {
		const recorder = createUiRecorder({ hasUI: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0 });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.output_item.added", item: { type: "image_generation_call", id: "ig-1", status: "in_progress" } });
		tracker?.onEvent({ type: "response.output_item.done", item: { type: "image_generation_call", id: "ig-1", status: "completed", result: "abc" } });

		expect(recorder.customCalls).toEqual([]);
		expect(recorder.widgetCalls).toEqual([]);
	});
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

		tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1", action: { query: "throttled" } } });
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
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0, completedCollapseMs: 1_000, completedHideMs: 3_000, completedAutoCloseMs: 1_500, scheduler: scheduler.scheduler });
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
		expect(scheduler.scheduled.some(entry => !entry.cleared && entry.timeout === 3_000)).toBe(true);

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
		const disposedManager = createProviderToolLiveStatusManager({ throttleMs: 0, completedHideMs: 3_000, completedAutoCloseMs: 1_500, scheduler: disposedScheduler.scheduler });
		const disposedTracker = disposedManager.createTracker({ enabledTools: ["web_search"], ui: disposed.ui });
		disposedTracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1", query: "dispose" } });
		disposedTracker?.onEvent({ type: "response.completed" });
		expect(disposedScheduler.scheduled.some(entry => !entry.cleared && entry.timeout === 3_000)).toBe(true);
		disposed.customCalls[0]!.component.dispose?.();
		expect(disposedScheduler.cleared.length).toBeGreaterThan(0);
		disposedScheduler.runActiveTimers();
		expect(disposed.doneResults).toEqual([]);

		const failingScheduler = createScheduler();
		let requestRenderShouldThrow = false;
		const failing = createUiRecorder({ hasUI: true, throwOnRequestRender: () => requestRenderShouldThrow, useFourArgFactory: true });
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0, completedHideMs: 3_000, completedAutoCloseMs: 1_500, scheduler: failingScheduler.scheduler });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: failing.ui });
		tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-2", query: "disable" } });
		tracker?.onEvent({ type: "response.completed" });
		expect(failingScheduler.scheduled.some(entry => !entry.cleared && entry.timeout === 3_000)).toBe(true);
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

	it("closes the mounted overlay when requestRender fails", () => {
		let requestRenderShouldThrow = false;
		const recorder = createUiRecorder({ hasUI: true, throwOnRequestRender: () => requestRenderShouldThrow, useFourArgFactory: true });
		const warnings: unknown[][] = [];
		const manager = createProviderToolLiveStatusManager({ throttleMs: 0, logger: { warn: (...args: unknown[]) => warnings.push(args) } });
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: recorder.ui });

		tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1", query: "first" } });
		requestRenderShouldThrow = true;
		tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-2", query: "second" } });

		expect(warnings.length).toBeGreaterThan(0);
		expect(recorder.doneResults).toHaveLength(1);
		expect(recorder.doneResults[0]).toBeUndefined();
	});

	it("warns, closes only the current tracker, and allows future overlays when custom opening fails", () => {
		const throwing = createUiRecorder({ hasUI: true, throwOnCustom: true });
		const later = createUiRecorder({ hasUI: true });
		const warnings: unknown[][] = [];
		const manager = createProviderToolLiveStatusManager({
			throttleMs: 0,
			logger: { warn: (...args: unknown[]) => warnings.push(args) },
		});
		const tracker = manager.createTracker({ enabledTools: ["web_search"], ui: throwing.ui });

		expect(() => {
			tracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1", action: { query: "throws" } } });
		}).not.toThrow();
		expect(warnings.length).toBeGreaterThan(0);

		const laterTracker = manager.createTracker({ enabledTools: ["web_search"], ui: later.ui });
		laterTracker?.onEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-2", action: { query: "recovered" } } });
		expect(later.customCalls).toHaveLength(1);
		expect(later.customCalls[0]!.component.render(100).join("\n")).toContain("recovered");
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
