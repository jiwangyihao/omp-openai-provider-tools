type JsonRecord = Record<string, unknown>;

type FetchLike = typeof fetch;

const INTERRUPT_DONE_EVENT = "data: [DONE]\n\n";
const requestKeys = new Map<string, number>();

let installed = false;
let originalFetch: FetchLike | undefined;
let wrappedFetch: FetchLike | undefined;

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
	const key = stableStringify(payload);
	requestKeys.set(key, (requestKeys.get(key) ?? 0) + 1);
}

export function clearInterruptibleImageGenerationRequests(): void {
	requestKeys.clear();
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
		const shouldInterrupt = await shouldInterruptRequest(input, init);
		const response = await originalFetch!(input, init);
		if (!shouldInterrupt || !response.body) return response;
		return new Response(interruptAfterImageGenerationResult(response.body), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}) as FetchLike;
	globalThis.fetch = wrappedFetch;
	installed = true;
}

export function restoreOpenAIResponsesImageInterruptionForTests(): void {
	if (installed && originalFetch) {
		globalThis.fetch = originalFetch;
	}
	installed = false;
	originalFetch = undefined;
	wrappedFetch = undefined;
	requestKeys.clear();
}

async function shouldInterruptRequest(input: RequestInfo | URL, init?: RequestInit): Promise<boolean> {
	if (!isResponsesRequest(input)) return false;
	const payload = await requestPayload(input, init);
	if (!payload) return false;
	const key = stableStringify(payload);
	const count = requestKeys.get(key) ?? 0;
	if (count <= 0) return false;
	if (count === 1) requestKeys.delete(key);
	else requestKeys.set(key, count - 1);
	return true;
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

function interruptAfterImageGenerationResult(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";
	let interrupted = false;

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (interrupted) return;
			for (;;) {
				const { value, done } = await reader.read();
				if (done) {
					if (buffer.length > 0) controller.enqueue(encoder.encode(buffer));
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
					controller.enqueue(encoder.encode(`${rawEvent}\n\n`));
					emitted = true;
					if (isImageGenerationResultDoneEvent(rawEvent)) {
						interrupted = true;
						controller.enqueue(encoder.encode(INTERRUPT_DONE_EVENT));
						await reader.cancel().catch(() => undefined);
						controller.close();
						return;
					}
				}
				if (emitted) return;
			}
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => undefined);
		},
	});
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
