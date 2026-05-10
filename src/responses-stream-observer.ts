import type { ProviderToolLiveTracker } from "./provider-tool-live-status";
import type { ProviderToolType } from "./types";

export type JsonRecord = Record<string, unknown>;

const INTERRUPT_DONE_EVENT = "data: [DONE]\n\n";
export const DEFAULT_IMAGE_GENERATION_KEEPALIVE_INTERVAL_MS = 60_000;
const KEEPALIVE_EVENT_TYPE = "response.function_call_arguments.delta";
const KEEPALIVE_ITEM_ID = "openai_provider_tools_keepalive";

export interface RequestObservationPolicy {
	enabledTools?: readonly ProviderToolType[];
	interruptOnImageResult: boolean;
	keepaliveIntervalMs: number | undefined;
	liveTracker?: ProviderToolLiveTracker;
	observeLiveEventsInIterable?: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function tryEnqueueChunk(
	controller: ReadableStreamDefaultController<Uint8Array>,
	chunk: Uint8Array,
	markFinished: () => void,
): boolean {
	try {
		controller.enqueue(chunk);
		return true;
	} catch (error) {
		if (isClosedControllerError(error)) {
			markFinished();
			return false;
		}
		throw error;
	}
}

function isClosedControllerError(error: unknown): boolean {
	if (!(error instanceof TypeError)) return false;
	const message = error.message.toLowerCase();
	return message.includes("controller is already closed") || (message.includes("invalid state") && message.includes("closed"));
}

export function wrapOpenAIResponsesStream(body: ReadableStream<Uint8Array>, policy: RequestObservationPolicy): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";
	let finished = false;
	let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
	let keepaliveController: ReadableStreamDefaultController<Uint8Array> | undefined;
	let lastSyntheticKeepaliveAt = Date.now();

	const clearKeepalive = () => {
		if (keepaliveTimer) clearTimeout(keepaliveTimer);
		keepaliveTimer = undefined;
	};
	const finish = () => {
		finished = true;
		clearKeepalive();
	};
	const failAndClearTracker = (error: unknown) => {
		failTracker(policy.liveTracker, error);
		clearTracker(policy.liveTracker);
	};
	const imageKeepaliveEnabled = policy.enabledTools === undefined || policy.enabledTools.includes("image_generation");
	const emitSyntheticKeepalive = (): boolean => {
		if (finished || !keepaliveController) return false;
		lastSyntheticKeepaliveAt = Date.now();
		return tryEnqueueChunk(keepaliveController, encoder.encode(imageGenerationKeepaliveEvent()), finish);
	};
	const scheduleKeepalive = () => {
		clearKeepalive();
		if (!imageKeepaliveEnabled || finished || policy.keepaliveIntervalMs === undefined || policy.keepaliveIntervalMs <= 0) return;
		const delayMs = Math.max(0, policy.keepaliveIntervalMs - (Date.now() - lastSyntheticKeepaliveAt));
		keepaliveTimer = setTimeout(() => {
			if (emitSyntheticKeepalive()) scheduleKeepalive();
		}, delayMs);
	};

	return new ReadableStream<Uint8Array>({
		start(controller) {
			keepaliveController = controller;
			scheduleKeepalive();
		},
		async pull(controller) {
			if (finished) return;
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) {
						finish();
						if (buffer.length > 0 && !tryEnqueueChunk(controller, encoder.encode(buffer), finish)) return;
						controller.close();
						return;
					}
					buffer += decoder.decode(value, { stream: true });
					let emitted = false;
					for (;;) {
						const delimiter = findEventDelimiter(buffer);
						if (!delimiter) break;
						const rawEvent = buffer.slice(0, delimiter.index);
						buffer = buffer.slice(delimiter.index + delimiter.length);
						const event = parseSseEvent(rawEvent);
						observeEvent(policy, event, true);
						if (!tryEnqueueChunk(controller, encoder.encode(`${rawEvent}\n\n`), finish)) return;
						emitted = true;
						if (policy.interruptOnImageResult && isImageGenerationResultDoneEvent(rawEvent)) {
							clearTracker(policy.liveTracker);
							finish();
							if (!tryEnqueueChunk(controller, encoder.encode(INTERRUPT_DONE_EVENT), finish)) return;
							await reader.cancel().catch(() => undefined);
							controller.close();
							return;
						}
					}
					if (emitted) return;
				}
			} catch (error) {
				finish();
				failAndClearTracker(error);
				throw error;
			}
		},
		async cancel(reason) {
			finish();
			clearTracker(policy.liveTracker);
			await reader.cancel(reason).catch(() => undefined);
		},
	});
}

export function wrapOpenAIResponsesEventIterable<T>(source: AsyncIterable<T>, policy: RequestObservationPolicy, controller?: AbortController): AsyncIterable<T | JsonRecord> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<T | JsonRecord> {
			const iterator = source[Symbol.asyncIterator]();
			let finished = false;
			let upstreamNext: Promise<IteratorResult<T>> | undefined;
			let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
			let lastSyntheticKeepaliveAt = Date.now();
			const imageKeepaliveEnabled = policy.enabledTools === undefined || policy.enabledTools.includes("image_generation");

			const abort = () => {
				controller?.abort();
			};
			const finish = () => {
				finished = true;
				if (keepaliveTimer) clearTimeout(keepaliveTimer);
				keepaliveTimer = undefined;
			};
			const finishAndClear = () => {
				finish();
				clearTracker(policy.liveTracker);
			};
			const failAndClear = (error: unknown) => {
				failTracker(policy.liveTracker, error);
				clearTracker(policy.liveTracker);
			};

			const nextUpstream = (): Promise<IteratorResult<T>> => {
				upstreamNext ??= iterator.next();
				return upstreamNext;
			};

			const nextKeepalive = () => new Promise<IteratorResult<JsonRecord>>(resolve => {
				if (!imageKeepaliveEnabled || policy.keepaliveIntervalMs === undefined || policy.keepaliveIntervalMs <= 0) return;
				const delayMs = Math.max(0, policy.keepaliveIntervalMs - (Date.now() - lastSyntheticKeepaliveAt));
				keepaliveTimer = setTimeout(() => {
					keepaliveTimer = undefined;
					lastSyntheticKeepaliveAt = Date.now();
					if (!finished) resolve({ value: imageGenerationKeepaliveObject(), done: false });
				}, delayMs);
			});

			return {
				async next(): Promise<IteratorResult<T | JsonRecord>> {
					if (finished) return { value: undefined, done: true };
					const upstreamResult = nextUpstream().then(
						result => ({ source: "upstream" as const, result }),
						error => ({ source: "upstreamError" as const, error }),
					);
					const keepaliveResult = nextKeepalive().then(result => ({ source: "keepalive" as const, result }));
					const outcome = await Promise.race([upstreamResult, keepaliveResult]);
					if (keepaliveTimer) clearTimeout(keepaliveTimer);
					keepaliveTimer = undefined;
					if (outcome.source === "upstreamError") {
						upstreamNext = undefined;
						finish();
						failAndClear(outcome.error);
						throw outcome.error;
					}
					if (outcome.source === "upstream") upstreamNext = undefined;
					const result = outcome.result;
					if (result.done) {
						finishAndClear();
						return result;
					}
						if (outcome.source === "upstream" && policy.observeLiveEventsInIterable !== false) observeEvent(policy, result.value, true);
						if (policy.interruptOnImageResult && isImageGenerationResultDoneObject(result.value)) {
							finishAndClear();
							abort();
							void iterator.return?.();
						}
					return result;
				},
				async return(value?: unknown): Promise<IteratorResult<T | JsonRecord>> {
					finishAndClear();
					abort();
					void iterator.return?.();
					return { value: value as T | JsonRecord, done: true };
				},
				async throw(error?: unknown): Promise<IteratorResult<T | JsonRecord>> {
					finishAndClear();
					abort();
					void iterator.return?.();
					throw error;
				},
			};
		},
	};
}

function observeEvent(policy: RequestObservationPolicy, event: unknown, shouldCallOnEvent: boolean): void {
	if (!isRecord(event)) return;
	if (shouldCallOnEvent && shouldObserveLiveEvent(event)) {
		callTrackerOnEvent(policy.liveTracker, event);
	}
	const type = event.type;
	if (type === "response.completed") {
		return;
	} else if (type === "response.failed" || type === "error") {
		failTracker(policy.liveTracker, event.error ?? event);
		clearTracker(policy.liveTracker);
	}
}

function shouldObserveLiveEvent(event: JsonRecord): boolean {
	const type = event.type;
	if (type === "response.completed" || type === "response.failed" || type === "error") return true;
	if (type === "response.web_search_call.searching") return true;
	if (type !== "response.output_item.added" && type !== "response.output_item.done") return false;
	const item = event.item;
	return isRecord(item) && item.type === "web_search_call";
}

function callTrackerOnEvent(tracker: ProviderToolLiveTracker | undefined, event: unknown): void {
	try {
		tracker?.onEvent(event);
	} catch {
		// Live status is best-effort and must not affect provider streams.
	}
}

function failTracker(tracker: ProviderToolLiveTracker | undefined, error: unknown): void {
	try {
		tracker?.fail(error);
	} catch {
		// Live status is best-effort and must not affect provider streams.
	}
}

function clearTracker(tracker: ProviderToolLiveTracker | undefined): void {
	try {
		tracker?.clear();
	} catch {
		// Live status is best-effort and must not affect provider streams.
	}
}

function imageGenerationKeepaliveObject(): JsonRecord {
	return {
		type: KEEPALIVE_EVENT_TYPE,
		item_id: KEEPALIVE_ITEM_ID,
		delta: "",
	};
}

function imageGenerationKeepaliveEvent(): string {
	return `data: ${JSON.stringify(imageGenerationKeepaliveObject())}\n\n`;
}

function findEventDelimiter(value: string): { index: number; length: number } | undefined {
	const lf = value.indexOf("\n\n");
	const crlf = value.indexOf("\r\n\r\n");
	if (lf === -1 && crlf === -1) return undefined;
	if (lf === -1) return { index: crlf, length: 4 };
	if (crlf === -1) return { index: lf, length: 2 };
	return crlf < lf ? { index: crlf, length: 4 } : { index: lf, length: 2 };
}

function parseSseEvent(rawEvent: string): unknown | undefined {
	const data = rawEvent
		.split(/\r?\n/)
		.filter(line => line.startsWith("data:"))
		.map(line => line.slice("data:".length).trimStart())
		.join("\n");
	if (!data || data === "[DONE]") return undefined;
	return parseJson(data);
}

function parseJson(value: string): unknown | undefined {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function isImageGenerationResultDoneEvent(rawEvent: string): boolean {
	const event = parseSseEvent(rawEvent);
	return isImageGenerationResultDoneObject(event);
}

function isImageGenerationResultDoneObject(event: unknown): boolean {
	if (!isRecord(event) || event.type !== "response.output_item.done") return false;
	const item = event.item;
	return isRecord(item) && item.type === "image_generation_call" && typeof item.result === "string" && item.result.length > 0;
}
