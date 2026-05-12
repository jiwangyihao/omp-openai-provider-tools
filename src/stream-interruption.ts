import {
	DEFAULT_IMAGE_GENERATION_KEEPALIVE_INTERVAL_MS,
	tryEnqueueChunk,
	wrapOpenAIResponsesEventIterable,
	wrapOpenAIResponsesStream,
} from "./responses-stream-observer";
import type { JsonRecord, RequestObservationPolicy } from "./responses-stream-observer";

type FetchLike = typeof fetch;

const requestPolicies = new Map<string, RequestObservationPolicy[]>();
const responsePolicies = new WeakMap<Response, RequestObservationPolicy>();

let installed = false;
let originalFetch: FetchLike | undefined;
let wrappedFetch: FetchLike | undefined;

type FromSSEResponse = (response: Response, controller?: AbortController, client?: unknown, synthesizeEventData?: unknown) => unknown;
type OpenAIStreamConstructor = new (iterator: () => AsyncIterator<unknown>, controller?: AbortController, client?: unknown) => AsyncIterable<unknown>;
let streamModulePatch: { Stream: OpenAIStreamConstructor & { fromSSEResponse: FromSSEResponse }; original: FromSSEResponse } | undefined;

export {
	DEFAULT_IMAGE_GENERATION_KEEPALIVE_INTERVAL_MS,
	tryEnqueueChunk,
	wrapOpenAIResponsesEventIterable,
	wrapOpenAIResponsesStream,
};
export type { RequestObservationPolicy };
export type RequestPolicy = RequestObservationPolicy;

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

export function registerProviderToolRequest(payload: unknown, policy: Partial<RequestObservationPolicy> = {}): void {
	const key = stableStringify(payload);
	const queue = requestPolicies.get(key) ?? [];
	const imageKeepaliveEnabled = policy.enabledTools?.includes("image_generation") ?? false;
	queue.push({
		interruptOnImageResult: imageKeepaliveEnabled && Boolean(policy.interruptOnImageResult),
		keepaliveIntervalMs: imageKeepaliveEnabled
			? policy.keepaliveIntervalMs ?? DEFAULT_IMAGE_GENERATION_KEEPALIVE_INTERVAL_MS
			: policy.keepaliveIntervalMs,
		liveTracker: policy.liveTracker,
		enabledTools: policy.enabledTools,
		observeLiveEventsInIterable: policy.observeLiveEventsInIterable,
	});
	requestPolicies.set(key, queue);
}

export function consumeProviderToolRequestPolicy(payload: unknown): RequestObservationPolicy | undefined {
	const key = stableStringify(payload);
	const queue = requestPolicies.get(key);
	const policy = queue?.shift();
	if (!queue || queue.length === 0) requestPolicies.delete(key);
	return policy;
}

export function registerInterruptibleImageGenerationRequest(payload: unknown): void {
	registerImageGenerationRequest(payload, { interruptOnImageResult: true });
}

export function registerImageGenerationRequest(payload: unknown, policy: Partial<RequestObservationPolicy> = {}): void {
	registerProviderToolRequest(payload, { ...policy, enabledTools: ["image_generation"] });
}

export function consumeImageGenerationRequestPolicy(payload: unknown): RequestObservationPolicy | undefined {
	return consumeProviderToolRequestPolicy(payload);
}

export function clearInterruptibleImageGenerationRequests(): void {
	requestPolicies.clear();
}

export function wrapImageGenerationStream(body: ReadableStream<Uint8Array>, policy: RequestObservationPolicy): ReadableStream<Uint8Array> {
	return wrapOpenAIResponsesStream(body, policy);
}

export function wrapImageGenerationEventIterable<T>(source: AsyncIterable<T>, policy: RequestObservationPolicy, controller?: AbortController): AsyncIterable<T | JsonRecord> {
	return wrapOpenAIResponsesEventIterable(source, policy, controller);
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
	if (installed && globalThis.fetch === wrappedFetch) {
		void patchRuntimeOpenAIStream();
		return;
	}
	if (installed && originalFetch && globalThis.fetch !== wrappedFetch) {
		// Test suites and embedding runtimes may replace fetch after a previous install.
		originalFetch = globalThis.fetch.bind(globalThis) as FetchLike;
	} else if (installed) {
		void patchRuntimeOpenAIStream();
		return;
	}

	originalFetch = globalThis.fetch.bind(globalThis) as FetchLike;
	wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const payload = await responsesRequestPayload(input, init);
		const response = await originalFetch!(input, init);
		const policy = payload ? consumeProviderToolRequestPolicy(payload) : undefined;
		if (!policy || !response.body) return response;
		const wrappedResponse = new Response(wrapOpenAIResponsesStream(response.body, policy), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
		responsePolicies.set(wrappedResponse, { ...policy, observeLiveEventsInIterable: false });
		return wrappedResponse;
	}) as FetchLike;
	globalThis.fetch = wrappedFetch;

	void patchRuntimeOpenAIStream();

	installed = true;
}
async function patchRuntimeOpenAIStream(): Promise<void> {
	const OpenAIStream = await loadRuntimeOpenAIStream();
	if (!OpenAIStream || !installed) return;
	if (streamModulePatch?.Stream === OpenAIStream && OpenAIStream.fromSSEResponse !== streamModulePatch.original) return;
	streamModulePatch = { Stream: OpenAIStream, original: OpenAIStream.fromSSEResponse.bind(OpenAIStream) as FromSSEResponse };
	OpenAIStream.fromSSEResponse = ((response: Response, controller?: AbortController, client?: unknown, synthesizeEventData?: unknown) => {
		const policy = responsePolicy(response);
		const stream = streamModulePatch!.original(response, controller, client, synthesizeEventData) as AsyncIterable<unknown> & { controller?: AbortController };
		if (!policy) return stream;
		return new OpenAIStream(
			() => wrapOpenAIResponsesEventIterable(stream, policy, stream.controller ?? controller)[Symbol.asyncIterator](),
			stream.controller ?? controller,
			client,
		);
	}) as FromSSEResponse;
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

function responsePolicy(response: Response): RequestObservationPolicy | undefined {
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
