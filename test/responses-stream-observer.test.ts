import { afterEach, describe, expect, it, mock } from "bun:test";

import {
	registerProviderToolRequest,
	consumeProviderToolRequestPolicy,
	installOpenAIResponsesImageInterruption,
	restoreOpenAIResponsesImageInterruptionForTests,
	wrapOpenAIResponsesEventIterable,
	wrapOpenAIResponsesStream,
} from "../src/stream-interruption";

type TrackerRecorder = {
	calls: string[];
	events: unknown[];
	tracker: {
		onEvent(event: unknown): void;
		fail(error: unknown): void;
		clear(): void;
	};
};

const encoder = new TextEncoder();

function sseEvent(event: Record<string, unknown>): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

async function responseText(stream: ReadableStream<Uint8Array>): Promise<string> {
	return await new Response(stream).text();
}

function trackerRecorder(): TrackerRecorder {
	const calls: string[] = [];
	const events: unknown[] = [];
	return {
		calls,
		events,
		tracker: {
			onEvent(event) {
				events.push(event);
			},
			fail() {
				calls.push("fail");
			},
			clear() {
				calls.push("clear");
			},
		},
	};
}

function delayedNeverStream(cancelled?: { value: boolean }): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		pull() {
			return new Promise(() => undefined);
		},
		cancel() {
			if (cancelled) cancelled.value = true;
		},
	});
}

async function readWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs: number,
): Promise<{ kind: "read"; text: string; done: boolean } | { kind: "timeout" }> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const result = await Promise.race([
		reader.read().then(read => ({
			kind: "read" as const,
			text: read.value ? new TextDecoder().decode(read.value) : "",
			done: Boolean(read.done),
		})),
		new Promise<{ kind: "timeout" }>(resolve => {
			timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
		}),
	]);
	if (timeout) clearTimeout(timeout);
	return result;
}

afterEach(() => {
	restoreOpenAIResponsesImageInterruptionForTests();
});

describe("OpenAI Responses stream observer", () => {
	it("observes web_search_call raw SSE events and forwards raw SSE unchanged", async () => {
		const recorder = trackerRecorder();
		const raw = sseEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1" } });

		const text = await responseText(wrapOpenAIResponsesStream(
			new Response(raw).body!,
			{ interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		));

		expect(text).toBe(raw);
		expect(recorder.events).toEqual([{ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1" } }]);
		expect(recorder.calls).toEqual([]);
	});

	it("preserves provider request policies registered after fetch starts", async () => {
		const originalFetch = globalThis.fetch;
		try {
			const recorder = trackerRecorder();
			const payload = { model: "gpt-5", input: "hello", stream: true };
			let releaseFetch!: () => void;
			const fetchStarted = new Promise<void>(resolve => {
				globalThis.fetch = (async () => {
					resolve();
					await new Promise<void>(release => { releaseFetch = release; });
					return new Response(sseEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-late" } }), {
						headers: { "content-type": "text/event-stream" },
					});
				}) as typeof fetch;
			});
			installOpenAIResponsesImageInterruption();

			const responsePromise = fetch("https://gateway.example.invalid/v1/responses", { method: "POST", body: JSON.stringify(payload) });
			await fetchStarted;
			registerProviderToolRequest(payload, {
				enabledTools: ["web_search"],
				interruptOnImageResult: false,
				liveTracker: recorder.tracker,
			});
			releaseFetch();

			const response = await responsePromise;
			await responseText(response.body!);

			expect(recorder.events).toEqual([{ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-late" } }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not send image_generation_call to live tracker but preserves image interruption", async () => {
		const recorder = trackerRecorder();
		const imageEvent = sseEvent({ type: "response.output_item.done", item: { type: "image_generation_call", id: "ig-1", result: "abc" } });
		const laterEvent = sseEvent({ type: "response.output_text.delta", delta: "SHOULD_NOT_PASS" });

		const text = await responseText(wrapOpenAIResponsesStream(
			new Response(imageEvent + laterEvent).body!,
			{ interruptOnImageResult: true, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		));

		expect(text).toBe(`${imageEvent}data: [DONE]\n\n`);
		expect(text).not.toContain("SHOULD_NOT_PASS");
		expect(recorder.events).toEqual([]);
		expect(recorder.calls).toEqual(["clear"]);
	});

	it("does not forward raw image_generation_call add or done events to live tracker", async () => {
		const recorder = trackerRecorder();
		const imageAdded = sseEvent({ type: "response.output_item.added", item: { type: "image_generation_call", id: "ig-1" } });
		const imageDone = sseEvent({ type: "response.output_item.done", item: { type: "image_generation_call", id: "ig-1" } });

		const text = await responseText(wrapOpenAIResponsesStream(
			new Response(imageAdded + imageDone).body!,
			{ interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		));

		expect(text).toBe(imageAdded + imageDone);
		expect(recorder.events).toEqual([]);
		expect(recorder.calls).toEqual([]);
	});

	it("isolates live tracker onEvent errors from raw SSE forwarding", async () => {
		const raw = sseEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1" } });

		const text = await responseText(wrapOpenAIResponsesStream(
			new Response(raw).body!,
			{
				interruptOnImageResult: false,
				keepaliveIntervalMs: undefined,
				liveTracker: {
					onEvent() {
						throw new Error("tracker failed");
					},
					fail() {},
					clear() {},
				},
			},
		));

		expect(text).toBe(raw);
	});

	it("keeps tracker alive for response.completed after observing a web_search event", async () => {
		const recorder = trackerRecorder();
		const webEvent = sseEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1", action: { query: "observed" } } });
		const completedEvent = sseEvent({ type: "response.completed", response: { id: "resp-1" } });

		const text = await responseText(wrapOpenAIResponsesStream(
			new Response(webEvent + completedEvent).body!,
			{ interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		));

		expect(text).toBe(webEvent + completedEvent);
		expect(recorder.events).toEqual([
			{ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1", action: { query: "observed" } } },
			{ type: "response.completed", response: { id: "resp-1" } },
		]);
		expect(recorder.calls).toEqual([]);
	});

	it("forwards raw web_search in_progress and completed lifecycle events with item_id while preserving SSE", async () => {
		const recorder = trackerRecorder();
		const inProgressEvent = { type: "response.web_search_call.in_progress", item_id: "ws-1", output_index: 0, sequence_number: 10 };
		const completedLifecycleEvent = { type: "response.web_search_call.completed", item_id: "ws-1", output_index: 0, sequence_number: 11 };
		const responseCompletedEvent = { type: "response.completed", response: { id: "resp-1" } };
		const raw = sseEvent(inProgressEvent) + sseEvent(completedLifecycleEvent) + sseEvent(responseCompletedEvent);

		const text = await responseText(wrapOpenAIResponsesStream(
			new Response(raw).body!,
			{ interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		));

		expect(text).toBe(raw);
		expect(recorder.events).toEqual([
			inProgressEvent,
			completedLifecycleEvent,
			responseCompletedEvent,
		]);
		expect(recorder.calls).toEqual([]);
	});

	it("forwards raw web_search searching lifecycle with only item_id and then response.completed", async () => {
		const recorder = trackerRecorder();
		const searchingEvent = { type: "response.web_search_call.searching", item_id: "ws-2" };
		const responseCompletedEvent = { type: "response.completed", response: { id: "resp-2" } };
		const raw = sseEvent(searchingEvent) + sseEvent(responseCompletedEvent);

		const text = await responseText(wrapOpenAIResponsesStream(
			new Response(raw).body!,
			{ interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		));

		expect(text).toBe(raw);
		expect(recorder.events).toEqual([
			searchingEvent,
			responseCompletedEvent,
		]);
		expect(recorder.calls).toEqual([]);
	});

	it("forwards SDK iterable web_search lifecycle events without altering yielded values", async () => {
		const recorder = trackerRecorder();
		const inProgressEvent = { type: "response.web_search_call.in_progress", item_id: "ws-3", output_index: 0, sequence_number: 1 };
		const responseCompletedEvent = { type: "response.completed", response: { id: "resp-3" } };
		const source = (async function* () {
			yield inProgressEvent;
			yield responseCompletedEvent;
		})();

		const iterator = wrapOpenAIResponsesEventIterable(
			source,
			{ interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		)[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toEqual({ value: inProgressEvent, done: false });
		await expect(iterator.next()).resolves.toEqual({ value: responseCompletedEvent, done: false });
		await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
		expect(recorder.events).toEqual([
			inProgressEvent,
			responseCompletedEvent,
		]);
		expect(recorder.calls).toEqual([]);
	});

	it("does not forward response.completed to a tracker before any web_search event was observed", async () => {
		const recorder = trackerRecorder();
		const raw = sseEvent({ type: "response.completed", response: { id: "resp-1" } });

		const text = await responseText(wrapOpenAIResponsesStream(
			new Response(raw).body!,
			{ interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		));

		expect(text).toBe(raw);
		expect(recorder.events).toEqual([]);
		expect(recorder.calls).toEqual([]);
	});

	it("fails then clears tracker on response.failed and forwards raw SSE", async () => {
		const recorder = trackerRecorder();
		const raw = sseEvent({ type: "response.failed", response: { id: "resp-1" }, error: { message: "failed" } });

		const text = await responseText(wrapOpenAIResponsesStream(
			new Response(raw).body!,
			{ interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		));

		expect(text).toBe(raw);
		expect(recorder.events).toEqual([{ type: "response.failed", response: { id: "resp-1" }, error: { message: "failed" } }]);
		expect(recorder.calls).toEqual(["fail", "clear"]);
	});

	it("fails then clears tracker on top-level error while forwarding raw SSE unchanged", async () => {
		const recorder = trackerRecorder();
		const raw = sseEvent({ type: "error", error: { message: "top-level error" } });

		const text = await responseText(wrapOpenAIResponsesStream(
			new Response(raw).body!,
			{ interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		));

		expect(text).toBe(raw);
		expect(recorder.events).toEqual([{ type: "error", error: { message: "top-level error" } }]);
		expect(recorder.calls).toEqual(["fail", "clear"]);
	});

	it("fails then clears tracker on raw stream read error and rethrows the original error", async () => {
		const recorder = trackerRecorder();
		const upstreamError = new Error("read failed");
		const body = new ReadableStream<Uint8Array>({
			pull() {
				throw upstreamError;
			},
		});

		await expect(responseText(wrapOpenAIResponsesStream(
			body,
			{ interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		))).rejects.toBe(upstreamError);
		expect(recorder.calls).toEqual(["fail", "clear"]);
	});

	it("clears tracker and cancels upstream reader on downstream cancel", async () => {
		const recorder = trackerRecorder();
		const cancelled = { value: false };
		const stream = wrapOpenAIResponsesStream(
			delayedNeverStream(cancelled),
			{ interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		);

		await stream.cancel("stop");

		expect(cancelled.value).toBe(true);
		expect(recorder.calls).toEqual(["clear"]);
	});

	it("clears SDK iterable tracker on upstream error and rethrows the original error", async () => {
		const recorder = trackerRecorder();
		const upstreamError = new Error("sdk failed");
		const failing = {
			async *[Symbol.asyncIterator]() {
				throw upstreamError;
			},
		} satisfies AsyncIterable<unknown>;

		await expect(wrapOpenAIResponsesEventIterable(
			failing,
			{ interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		)[Symbol.asyncIterator]().next()).rejects.toBe(upstreamError);
		expect(recorder.calls).toEqual(["fail", "clear"]);
	});

	it("keeps SDK iterable tracker alive after normal response.completed", async () => {
		const recorder = trackerRecorder();
		const webEvent = { type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1", action: { query: "sdk observed" } } };
		const completedEvent = { type: "response.completed", response: { id: "resp-1" } };
		const source = (async function* () {
			yield webEvent;
			yield completedEvent;
		})();

		const iterator = wrapOpenAIResponsesEventIterable(
			source,
			{ interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		)[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toEqual({ value: webEvent, done: false });
		await expect(iterator.next()).resolves.toEqual({ value: completedEvent, done: false });
		await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
		expect(recorder.events).toEqual([webEvent, completedEvent]);
		expect(recorder.calls).toEqual([]);
	});

	it("clears SDK iterable tracker and aborts on return", async () => {
		const recorder = trackerRecorder();
		let upstreamReturnCalled = false;
		const abortController = new AbortController();
		const source = {
			[Symbol.asyncIterator]() {
				return {
					next: () => new Promise<IteratorResult<unknown>>(() => undefined),
					async return() {
						upstreamReturnCalled = true;
						return { value: undefined, done: true };
					},
				};
			},
		} satisfies AsyncIterable<unknown>;

		const iterator = wrapOpenAIResponsesEventIterable(
			source,
			{ interruptOnImageResult: false, keepaliveIntervalMs: 1, liveTracker: recorder.tracker },
			abortController,
		)[Symbol.asyncIterator]();

		await iterator.return?.();

		expect(upstreamReturnCalled).toBe(true);
		expect(abortController.signal.aborted).toBe(true);
		expect(recorder.calls).toEqual(["clear"]);
	});

	it("clears SDK iterable tracker and aborts on throw", async () => {
		const recorder = trackerRecorder();
		let upstreamReturnCalled = false;
		const abortController = new AbortController();
		const source = {
			[Symbol.asyncIterator]() {
				return {
					next: () => new Promise<IteratorResult<unknown>>(() => undefined),
					async return() {
						upstreamReturnCalled = true;
						return { value: undefined, done: true };
					},
				};
			},
		} satisfies AsyncIterable<unknown>;

		const iterator = wrapOpenAIResponsesEventIterable(
			source,
			{ interruptOnImageResult: false, keepaliveIntervalMs: 1, liveTracker: recorder.tracker },
			abortController,
		)[Symbol.asyncIterator]();

		await expect(iterator.throw?.(new Error("consumer failed"))).rejects.toThrow("consumer failed");

		expect(upstreamReturnCalled).toBe(true);
		expect(abortController.signal.aborted).toBe(true);
		expect(recorder.calls).toEqual(["clear"]);
	});

	it("yields SDK top-level error event then fails and clears tracker", async () => {
		const recorder = trackerRecorder();
		const event = { type: "error", error: { message: "sdk top-level error" } };
		const source = (async function* () {
			yield event;
		})();

		const iterator = wrapOpenAIResponsesEventIterable(
			source,
			{ interruptOnImageResult: false, keepaliveIntervalMs: undefined, liveTracker: recorder.tracker },
		)[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toEqual({ value: event, done: false });
		expect(recorder.events).toEqual([event]);
		expect(recorder.calls).toEqual(["fail", "clear"]);
	});

	it("does not duplicate live observation when observeLiveEventsInIterable is false", async () => {
		const recorder = trackerRecorder();
		const event = { type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1" } };
		const source = (async function* () {
			yield event;
		})();

		const iterator = wrapOpenAIResponsesEventIterable(
			source,
			{
				interruptOnImageResult: false,
				keepaliveIntervalMs: undefined,
				liveTracker: recorder.tracker,
				observeLiveEventsInIterable: false,
			},
		)[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toEqual({ value: event, done: false });
		expect(recorder.events).toEqual([]);
		expect(recorder.calls).toEqual([]);
	});

	it("does not clear SDK iterable tracker on normal completion when live observation is disabled", async () => {
		const recorder = trackerRecorder();
		const event = { type: "response.completed", response: { id: "resp-1" } };
		const source = (async function* () {
			yield event;
		})();

		const iterator = wrapOpenAIResponsesEventIterable(
			source,
			{
				interruptOnImageResult: false,
				keepaliveIntervalMs: undefined,
				liveTracker: recorder.tracker,
				observeLiveEventsInIterable: false,
			},
		)[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toEqual({ value: event, done: false });
		await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
		expect(recorder.events).toEqual([]);
		expect(recorder.calls).toEqual([]);
	});

	it("does not duplicate SDK terminal cleanup when iterable live observation is disabled", async () => {
		const recorder = trackerRecorder();
		const event = { type: "error", error: { message: "sdk duplicate terminal" } };
		const source = (async function* () {
			yield event;
		})();

		const iterator = wrapOpenAIResponsesEventIterable(
			source,
			{
				interruptOnImageResult: false,
				keepaliveIntervalMs: undefined,
				liveTracker: recorder.tracker,
				observeLiveEventsInIterable: false,
			},
		)[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toEqual({ value: event, done: false });
		expect(recorder.events).toEqual([]);
		expect(recorder.calls).toEqual([]);
	});

	it("does not observe provider transport keepalives and does not let them postpone semantic image keepalive", async () => {
		const recorder = trackerRecorder();
		let interval: ReturnType<typeof setInterval> | undefined;
		try {
			const stream = wrapOpenAIResponsesStream(
				new ReadableStream<Uint8Array>({
					start(controller) {
						interval = setInterval(() => {
							controller.enqueue(encoder.encode(`:\n\n${sseEvent({ type: "keepalive" })}`));
						}, 5);
					},
					cancel() {
						if (interval) clearInterval(interval);
					},
				}),
				{ interruptOnImageResult: false, keepaliveIntervalMs: 20, liveTracker: recorder.tracker },
			);
			const reader = stream.getReader();
			let sawSemanticKeepalive = false;
			const deadline = Date.now() + 120;
			while (!sawSemanticKeepalive && Date.now() < deadline) {
				const next = await readWithTimeout(reader, 20);
				if (next.kind === "read" && !next.done) {
					sawSemanticKeepalive = next.text.includes("openai_provider_tools_keepalive");
				}
			}
			await reader.cancel().catch(() => undefined);

			expect(sawSemanticKeepalive).toBe(true);
			expect(recorder.events).toEqual([]);
		} finally {
			if (interval) clearInterval(interval);
		}
	});

	it("clears tracker when raw image interruption ends a combined provider-tool stream", async () => {
		const recorder = trackerRecorder();
		const webEvent = sseEvent({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1" } });
		const imageEvent = sseEvent({ type: "response.output_item.done", item: { type: "image_generation_call", id: "ig-1", result: "abc" } });

		const text = await responseText(wrapOpenAIResponsesStream(
			new Response(webEvent + imageEvent).body!,
			{
				enabledTools: ["web_search", "image_generation"],
				interruptOnImageResult: true,
				keepaliveIntervalMs: undefined,
				liveTracker: recorder.tracker,
			},
		));

		expect(text).toBe(`${webEvent}${imageEvent}data: [DONE]\n\n`);
		expect(recorder.events).toEqual([{ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1" } }]);
		expect(recorder.calls).toEqual(["clear"]);
	});

	it("clears tracker when SDK image interruption ends a combined provider-tool stream", async () => {
		const recorder = trackerRecorder();
		const abortController = new AbortController();
		const webEvent = { type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1" } };
		const imageEvent = { type: "response.output_item.done", item: { type: "image_generation_call", id: "ig-1", result: "abc" } };
		let upstreamReturnCalled = false;
		const source = {
			[Symbol.asyncIterator]() {
				let index = 0;
				const events = [webEvent, imageEvent];
				return {
					async next() {
						if (index >= events.length) return { value: undefined, done: true };
						return { value: events[index++], done: false };
					},
					async return() {
						upstreamReturnCalled = true;
						return { value: undefined, done: true };
					},
				};
			},
		} satisfies AsyncIterable<unknown>;

		const iterator = wrapOpenAIResponsesEventIterable(
			source,
			{
				enabledTools: ["web_search", "image_generation"],
				interruptOnImageResult: true,
				keepaliveIntervalMs: undefined,
				liveTracker: recorder.tracker,
			},
			abortController,
		)[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toEqual({ value: webEvent, done: false });
		await expect(iterator.next()).resolves.toEqual({ value: imageEvent, done: false });
		expect(abortController.signal.aborted).toBe(true);
		expect(upstreamReturnCalled).toBe(true);
		expect(recorder.events).toEqual([webEvent]);
		expect(recorder.calls).toEqual(["clear"]);
	});

	it("does not produce image synthetic keepalives for web_search-only policy", async () => {
		const recorder = trackerRecorder();
		const stream = wrapOpenAIResponsesStream(
			delayedNeverStream(),
			{
				enabledTools: ["web_search"],
				interruptOnImageResult: false,
				keepaliveIntervalMs: 1,
				liveTracker: recorder.tracker,
			},
		);
		const reader = stream.getReader();

		const first = await readWithTimeout(reader, 25);
		await reader.cancel().catch(() => undefined);

		expect(first.kind).toBe("timeout");
		expect(recorder.events).toEqual([]);
	});

	it("consumes identical payload policies through FIFO registry without count aggregation", () => {
		const payload = { model: "gpt-5", input: "hello", stream: true };
		const first = trackerRecorder();
		const second = trackerRecorder();

		registerProviderToolRequest(payload, {
			enabledTools: ["web_search"],
			interruptOnImageResult: false,
			liveTracker: first.tracker,
		});
		registerProviderToolRequest({ stream: true, input: "hello", model: "gpt-5" }, {
			enabledTools: ["web_search"],
			interruptOnImageResult: false,
			liveTracker: second.tracker,
		});

		expect(consumeProviderToolRequestPolicy(payload)?.liveTracker).toBe(first.tracker);
		expect(consumeProviderToolRequestPolicy(payload)?.liveTracker).toBe(second.tracker);
		expect(consumeProviderToolRequestPolicy(payload)).toBeUndefined();
	});

	it("fetch facade consumes FIFO policies and leaves the third identical response unwrapped", async () => {
		const originalFetch = globalThis.fetch;
		try {
			const first = trackerRecorder();
			const second = trackerRecorder();
			const payload = { model: "gpt-5", input: "hello", stream: true };
			let fetchCount = 0;
			globalThis.fetch = (async () => {
				fetchCount += 1;
				return new Response(sseEvent({
					type: "response.output_item.added",
					item: { type: "web_search_call", id: `ws-${fetchCount}` },
				}), { headers: { "content-type": "text/event-stream" } });
			}) as typeof fetch;
			installOpenAIResponsesImageInterruption();
			registerProviderToolRequest(payload, { enabledTools: ["web_search"], interruptOnImageResult: false, liveTracker: first.tracker });
			registerProviderToolRequest(payload, { enabledTools: ["web_search"], interruptOnImageResult: false, liveTracker: second.tracker });

			const firstResponse = await fetch("https://gateway.example.invalid/v1/responses", { method: "POST", body: JSON.stringify(payload) });
			const secondResponse = await fetch("https://gateway.example.invalid/v1/responses", { method: "POST", body: JSON.stringify(payload) });
			const thirdResponse = await fetch("https://gateway.example.invalid/v1/responses", { method: "POST", body: JSON.stringify(payload) });

			await responseText(firstResponse.body!);
			await responseText(secondResponse.body!);
			await responseText(thirdResponse.body!);

			expect(first.events).toEqual([{ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1" } }]);
			expect(second.events).toEqual([{ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-2" } }]);
			expect(first.events).not.toContainEqual({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-2" } });
			expect(second.events).not.toContainEqual({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1" } });
			expect(fetchCount).toBe(3);
			expect(thirdResponse.body).toBeDefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("fetch facade stores response policy that disables SDK iterable live observation after raw SSE observation", async () => {
		const originalFetch = globalThis.fetch;
		try {
			const recorder = trackerRecorder();
			const payload = { model: "gpt-5", input: "hello", stream: true };
			const event = { type: "response.output_item.added", item: { type: "web_search_call", id: "ws-1" } };
			class MockOpenAIStream implements AsyncIterable<unknown> {
				static fromSSEResponse(_response: Response, controller?: AbortController): AsyncIterable<unknown> & { controller?: AbortController } {
					return {
						controller,
						async *[Symbol.asyncIterator]() {
							yield event;
						},
					};
				}

				constructor(
					private readonly iteratorFactory: () => AsyncIterator<unknown>,
					readonly controller?: AbortController,
				) {}

				[Symbol.asyncIterator](): AsyncIterator<unknown> {
					return this.iteratorFactory();
				}
			}
			const originalFromSSEResponse = MockOpenAIStream.fromSSEResponse;
			mock.module("openai/core/streaming.mjs", () => ({ Stream: MockOpenAIStream }));
			globalThis.fetch = (async () => new Response(sseEvent(event), {
				headers: { "content-type": "text/event-stream" },
			})) as typeof fetch;
			installOpenAIResponsesImageInterruption();
			for (let attempt = 0; attempt < 10 && MockOpenAIStream.fromSSEResponse === originalFromSSEResponse; attempt += 1) {
				await new Promise(resolve => setTimeout(resolve, 0));
			}
			expect(MockOpenAIStream.fromSSEResponse).not.toBe(originalFromSSEResponse);
			registerProviderToolRequest(payload, { enabledTools: ["web_search"], interruptOnImageResult: false, liveTracker: recorder.tracker });

			const response = await fetch("https://gateway.example.invalid/v1/responses", { method: "POST", body: JSON.stringify(payload) });
			await responseText(response.body!);
			const sdkStream = MockOpenAIStream.fromSSEResponse(response);
			await sdkStream[Symbol.asyncIterator]().next();

			expect(recorder.events).toEqual([event]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
