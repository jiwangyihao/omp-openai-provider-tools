type JsonRecord = Record<string, unknown>;

type FetchLike = typeof fetch;

const INTERRUPT_DONE_EVENT = "data: [DONE]\n\n";
const DEFAULT_IMAGE_GENERATION_KEEPALIVE_INTERVAL_MS = 60_000;
const KEEPALIVE_EVENT_TYPE = "response.function_call_arguments.delta";
const KEEPALIVE_ITEM_ID = "openai_provider_tools_keepalive";
const requestPolicies = new Map<string, RequestPolicyEntry>();
const responsePolicies = new WeakMap<Response, RequestPolicy>();

export interface RequestPolicy {
	interruptOnImageResult: boolean;
	keepaliveIntervalMs: number | undefined;
}

interface RequestPolicyEntry extends RequestPolicy {
	count: number;
}

let installed = false;
let originalFetch: FetchLike | undefined;
let wrappedFetch: FetchLike | undefined;

type FromSSEResponse = (response: Response, controller?: AbortController, client?: unknown, synthesizeEventData?: unknown) => unknown;
type OpenAIStreamConstructor = new (iterator: () => AsyncIterator<unknown>, controller?: AbortController, client?: unknown) => AsyncIterable<unknown>;
let streamModulePatch: { Stream: OpenAIStreamConstructor & { fromSSEResponse: FromSSEResponse }; original: FromSSEResponse } | undefined;

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(entry => entry === undefined ? "null" : stableStringify(entry)).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function registerInterruptibleImageGenerationRequest(payload: unknown): void {
	registerImageGenerationRequest(payload, { interruptOnImageResult: true });
}

export function registerImageGenerationRequest(payload: unknown, policy: Partial<RequestPolicy> = {}): void {
	const key = stableStringify(payload);
	const existing = requestPolicies.get(key);
	requestPolicies.set(key, {
		interruptOnImageResult: Boolean(policy.interruptOnImageResult ?? existing?.interruptOnImageResult ?? false),
		keepaliveIntervalMs: policy.keepaliveIntervalMs ?? existing?.keepaliveIntervalMs ?? DEFAULT_IMAGE_GENERATION_KEEPALIVE_INTERVAL_MS,
		count: (existing?.count ?? 0) + 1,
	});
}

export function consumeImageGenerationRequestPolicy(payload: unknown): RequestPolicy | undefined {
	const key = stableStringify(payload);
	const policy = requestPolicies.get(key);
	if (!policy) return undefined;
	if (policy.count <= 1) requestPolicies.delete(key);
	else policy.count -= 1;
	return { interruptOnImageResult: policy.interruptOnImageResult, keepaliveIntervalMs: policy.keepaliveIntervalMs };
}

export function clearInterruptibleImageGenerationRequests(): void {
	requestPolicies.clear();
}

async function loadRuntimeOpenAIStream(): Promise<(OpenAIStreamConstructor & { fromSSEResponse: FromSSEResponse }) | undefined> {
	try {
		const module = await import("openai/core/streaming.mjs");
		const stream = (module as { Stream?: OpenAIStreamConstructor & { fromSSEResponse?: FromSSEResponse } }).Stream;
		if (typeof stream?.fromSSEResponse === "function") return stream as OpenAIStreamConstructor & { fromSSEResponse: FromSSEResponse };
	} catch {
		// Some runtimes do not expose the OpenAI SDK to extension-local resolution.
	}
	return undefined;
}

export function installOpenAIResponsesImageInterruption(): void {
	if (installed && globalThis.fetch === wrappedFetch) return;
	if (installed && originalFetch && globalThis.fetch !== wrappedFetch) {
		// Test suites and embedding runtimes may replace fetch after a previous install.
		installed = false;
		originalFetch = undefined;
		wrappedFetch = undefined;
	}
	if (installed) return;

	originalFetch = globalThis.fetch.bind(globalThis) as FetchLike;
	wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const payload = await responsesRequestPayload(input, init);
		const policy = payload ? consumeImageGenerationRequestPolicy(payload) : undefined;
		const response = await originalFetch!(input, init);
		if (!policy || !response.body) return response;
		const wrappedResponse = new Response(wrapImageGenerationStream(response.body, policy), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
		responsePolicies.set(wrappedResponse, policy);
		return wrappedResponse;
	}) as FetchLike;
	globalThis.fetch = wrappedFetch;

	void loadRuntimeOpenAIStream().then((OpenAIStream) => {
		if (!OpenAIStream || !installed) return;
		if (!streamModulePatch || streamModulePatch.Stream !== OpenAIStream) {
			streamModulePatch = { Stream: OpenAIStream, original: OpenAIStream.fromSSEResponse.bind(OpenAIStream) as FromSSEResponse };
		}
		OpenAIStream.fromSSEResponse = ((response: Response, controller?: AbortController, client?: unknown, synthesizeEventData?: unknown) => {
			const policy = responsePolicy(response);
			const stream = streamModulePatch!.original(response, controller, client, synthesizeEventData) as AsyncIterable<unknown> & { controller?: AbortController };
			if (!policy) return stream;
			return new OpenAIStream(
				() => wrapImageGenerationEventIterable(stream, policy, stream.controller ?? controller)[Symbol.asyncIterator](),
				stream.controller ?? controller,
				client,
			);
		}) as FromSSEResponse;
	});

	installed = true;
}

export function restoreOpenAIResponsesImageInterruptionForTests(): void {
	if (installed && originalFetch) {
		globalThis.fetch = originalFetch;
	}
	if (streamModulePatch) {
		streamModulePatch.Stream.fromSSEResponse = streamModulePatch.original;
	}
	installed = false;
	originalFetch = undefined;
	wrappedFetch = undefined;
	streamModulePatch = undefined;
	requestPolicies.clear();
}

async function responsesRequestPayload(input: RequestInfo | URL, init?: RequestInit): Promise<unknown | undefined> {
	if (!isResponsesRequest(input)) return undefined;
	return requestPayload(input, init);
}
function responsePolicy(response: Response): RequestPolicy | undefined {
	return responsePolicies.get(response);
}

function isResponsesRequest(input: RequestInfo | URL): boolean {
	const url = requestUrl(input);
	if (!url) return false;
	try {
		const parsed = new URL(url);
		return parsed.pathname.endsWith("/responses");
	} catch {
		return url.endsWith("/responses");
	}
}

function requestUrl(input: RequestInfo | URL): string | undefined {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (typeof Request !== "undefined" && input instanceof Request) return input.url;
	return undefined;
}

async function requestPayload(input: RequestInfo | URL, init?: RequestInit): Promise<unknown | undefined> {
	const body = init?.body;
	if (typeof body === "string") return parseJson(body);
	if (body instanceof Uint8Array) return parseJson(new TextDecoder().decode(body));
	if (typeof Request !== "undefined" && input instanceof Request) {
		try {
			return parseJson(await input.clone().text());
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function parseJson(value: string): unknown | undefined {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
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

export function wrapImageGenerationStream(body: ReadableStream<Uint8Array>, policy: RequestPolicy): ReadableStream<Uint8Array> {
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
	const emitSyntheticKeepalive = (): boolean => {
		if (finished || !keepaliveController) return false;
		lastSyntheticKeepaliveAt = Date.now();
		return tryEnqueueChunk(keepaliveController, encoder.encode(imageGenerationKeepaliveEvent()), finish);
	};
	const scheduleKeepalive = () => {
		clearKeepalive();
		if (finished || policy.keepaliveIntervalMs === undefined || policy.keepaliveIntervalMs <= 0) return;
		const delayMs = Math.max(0, policy.keepaliveIntervalMs - (Date.now() - lastSyntheticKeepaliveAt));
		keepaliveTimer = setTimeout(() => {
			if (emitSyntheticKeepalive()) scheduleKeepalive();
		}, delayMs);
	};
	const finish = () => {
		finished = true;
		clearKeepalive();
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
					scheduleKeepalive();
					buffer += decoder.decode(value, { stream: true });
					let emitted = false;
					for (;;) {
						const delimiter = findEventDelimiter(buffer);
						if (!delimiter) break;
						const rawEvent = buffer.slice(0, delimiter.index);
						buffer = buffer.slice(delimiter.index + delimiter.length);
						if (!tryEnqueueChunk(controller, encoder.encode(`${rawEvent}\n\n`), finish)) return;
						emitted = true;
						if (policy.interruptOnImageResult && isImageGenerationResultDoneEvent(rawEvent)) {
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
				throw error;
			}
		},
		async cancel(reason) {
			finish();
			await reader.cancel(reason).catch(() => undefined);
		},
	});
}

export function wrapImageGenerationEventIterable<T>(source: AsyncIterable<T>, policy: RequestPolicy, controller?: AbortController): AsyncIterable<T | JsonRecord> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<T | JsonRecord> {
			const iterator = source[Symbol.asyncIterator]();
			let finished = false;
			let upstreamNext: Promise<IteratorResult<T>> | undefined;
			let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
			let lastSyntheticKeepaliveAt = Date.now();

			const abort = () => {
				controller?.abort();
			};
			const finish = () => {
				finished = true;
				if (keepaliveTimer) clearTimeout(keepaliveTimer);
				keepaliveTimer = undefined;
			};

			const nextUpstream = (): Promise<IteratorResult<T>> => {
				upstreamNext ??= iterator.next();
				return upstreamNext;
			};

			const nextKeepalive = () => new Promise<IteratorResult<JsonRecord>>(resolve => {
				if (policy.keepaliveIntervalMs === undefined || policy.keepaliveIntervalMs <= 0) return;
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
						throw outcome.error;
					}
					if (outcome.source === "upstream") upstreamNext = undefined;
					const result = outcome.result;
					if (result.done) {
						finish();
						return result;
					}
					if (policy.interruptOnImageResult && isImageGenerationResultDoneObject(result.value)) {
						abort();
						void iterator.return?.();
					}
					return result;
				},
				async return(value?: unknown): Promise<IteratorResult<T | JsonRecord>> {
					finish();
					abort();
					void iterator.return?.();
					return { value: value as T | JsonRecord, done: true };
				},
				async throw(error?: unknown): Promise<IteratorResult<T | JsonRecord>> {
					finish();
					abort();
					void iterator.return?.();
					throw error;
				},
			};
		},
	};
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

function isImageGenerationResultDoneEvent(rawEvent: string): boolean {
	const data = rawEvent
		.split(/\r?\n/)
		.filter(line => line.startsWith("data:"))
		.map(line => line.slice("data:".length).trimStart())
		.join("\n");
	if (!data || data === "[DONE]") return false;
	const event = parseJson(data);
	if (!isRecord(event) || event.type !== "response.output_item.done") return false;
	const item = event.item;
	return isRecord(item) && item.type === "image_generation_call" && typeof item.result === "string" && item.result.length > 0;
}

function isImageGenerationResultDoneObject(event: unknown): boolean {
	if (!isRecord(event) || event.type !== "response.output_item.done") return false;
	const item = event.item;
	return isRecord(item) && item.type === "image_generation_call" && typeof item.result === "string" && item.result.length > 0;
}
