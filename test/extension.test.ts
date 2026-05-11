import { afterEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import providerToolsExtension from "../src/extension";
import { tryEnqueueChunk, wrapImageGenerationEventIterable, wrapImageGenerationStream } from "../src/stream-interruption";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

type RuntimeKind = "omp" | "pi" | "unknown";

const tempDirs: string[] = [];
const ONE_BY_ONE_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";


const targetModel = {
	id: "gpt-5",
	name: "GPT 5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
};

const imageCapableModel = {
	...targetModel,
	compat: {
		openaiProviderTools: {
			imageGeneration: true,
		},
	},
};

const customProviderModel = {
	...targetModel,
	provider: "custom-openai-compatible",
	baseUrl: "https://gateway.example.invalid/v1",
};

const providerToolsEnabledModel = {
	...customProviderModel,
	compat: {
		openaiProviderTools: {
			enabled: true,
		},
	},
};

const providerToolsImageModel = {
	...customProviderModel,
	compat: {
		openaiProviderTools: {
			enabled: true,
			imageGeneration: true,
		},
	},
};

const providerToolsInterruptImageModel = {
	...customProviderModel,
	compat: {
		openaiProviderTools: {
			enabled: true,
			imageGeneration: true,
			experimental: {
				interruptImageStreamOnResult: true,
			},
		},
	},
};

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-provider-tools-extension-"));
	tempDirs.push(dir);
	return dir;
}

function imageModelWithOutput(directory: string) {
	return {
		...providerToolsImageModel,
		compat: {
			openaiProviderTools: {
				...providerToolsImageModel.compat.openaiProviderTools,
				outputDirectory: directory,
			},
		},
	};
}

const unsupportedExtraBodyImageModel = {
	...targetModel,
	compat: {
		extraBody: {
			openai_provider_tools_image_generation: 1,
		},
	},
};

function registerExtension({
	runtime = "omp",
	initialActiveTools = ["read", "web_search", "generate_image"],
	sendMessage = true,
	activeToolMethods = true,
	setActiveTools,
	getActiveTools,
}: {
	runtime?: RuntimeKind;
	initialActiveTools?: any[];
	sendMessage?: boolean;
	activeToolMethods?: boolean;
	setActiveTools?: (next: any[]) => unknown | Promise<unknown>;
	getActiveTools?: () => any[] | Promise<any[]>;
} = {}) {
	const handlers = new Map<string, Handler[]>();
	const warnings: unknown[][] = [];
	const sentMessages: Array<{ message: unknown; options: unknown }> = [];
	const renderers = new Map<string, Function>();
	let activeTools = initialActiveTools;
	let label: string | undefined;
	const api: any = {
		logger: {
			debug() {},
			warn(...args: unknown[]) {
				warnings.push(args);
			},
			error() {},
		},
		runtime: runtime === "unknown" ? undefined : { name: runtime },
		on(event: string, handler: Handler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		setLabel(value: string) {
			label = value;
		},
		...(activeToolMethods
			? {
				getActiveTools() {
					return getActiveTools ? getActiveTools() : activeTools;
				},
				async setActiveTools(next: any[]) {
					if (setActiveTools) {
						await setActiveTools(next);
					} else {
						activeTools = next;
					}
				},
			}
			: {}),
		...(sendMessage
			? {
				sendMessage(message: unknown, options?: unknown) {
					sentMessages.push({ message, options });
				},
			}
			: {}),
		registerMessageRenderer(customType: string, renderer: Function) {
			renderers.set(customType, renderer);
		},
	};
	providerToolsExtension(api);
	return { activeTools: () => activeTools, handlers, label: () => label, sentMessages, warnings, renderers };
}

function getHandler(extension: ReturnType<typeof registerExtension>, name: string): Handler {
	const handler = extension.handlers.get(name)?.[0];
	if (!handler) throw new Error(`${name} handler missing`);
	return handler;
}

function getHandlerFromMap(handlers: Map<string, Handler[]>, name: string): Handler {
	const handler = handlers.get(name)?.[0];
	if (!handler) throw new Error(`${name} handler missing`);
	return handler;
}

function context(cwd: string, homeDir: string, overrides: Record<string, unknown> = {}) {
	const notifications: Array<{ message: unknown; type?: unknown }> = [];
	return { cwd, homeDir, model: targetModel, __notifications: notifications, ui: { notify(message: unknown, type?: unknown) { notifications.push({ message, type }); } }, ...overrides };
}

async function runBeforeAgent(extension: ReturnType<typeof registerExtension>, ctx: any) {
	return getHandler(extension, "before_agent_start")({ type: "before_agent_start" }, ctx);
}

async function runBeforeProvider(extension: ReturnType<typeof registerExtension>, payload: Record<string, unknown>, ctx: any, eventOverrides: Record<string, unknown> = {}) {
	return getHandler(extension, "before_provider_request")({ type: "before_provider_request", payload, ...eventOverrides }, ctx);
}

async function runAgentEnd(extension: ReturnType<typeof registerExtension>, event: unknown, ctx: any) {
	return getHandler(extension, "agent_end")(event, ctx);
}


async function runSessionStart(extension: ReturnType<typeof registerExtension>, ctx: any) {
	return getHandler(extension, "session_start")({ type: "session_start" }, ctx);
}

function imageGenerationMessage(id = "img-1", result = ONE_BY_ONE_PNG) {
	return {
		providerPayload: {
			type: "openaiResponsesHistory",
			items: [
				{
					type: "image_generation_call",
					id,
					result,
					output_format: "png",
					revised_prompt: "tiny transparent pixel",
				},
			],
		},
	};
}

function messageText(message: any): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap(part => part?.type === "text" ? [part.text] : []).join("\n");
}

function messageImages(message: any): Array<{ type: string; data: string; mimeType: string }> {
	return Array.isArray(message.content) ? message.content.filter(part => part?.type === "image") : [];
}


function sseEvent(event: Record<string, unknown>): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

async function responseText(response: Response): Promise<string> {
	return await response.text();
}

type TestOverlayComponent = { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void };

function uiRecorder() {
	const widgetCalls: Array<{ key: string; content: string[] | undefined; options?: unknown }> = [];
	const customCalls: Array<{ args: unknown[]; options?: unknown; component?: TestOverlayComponent; doneResults: unknown[]; requestRenderCalls: number }> = [];
	const notifications: Array<{ message: unknown; type?: unknown }> = [];
	const theme = { fg(_token: string, value: string) { return value; } };
	return {
		widgetCalls,
		notifications,
		customCalls,
		ctxUi: {
			notify(message: unknown, type?: unknown) { notifications.push({ message, type }); },
			setWidget(key: string, content: string[] | undefined, options?: unknown) {
				widgetCalls.push({ key, content, options });
			},
			custom(factory: Function, options?: unknown) {
				const call = { args: [factory, options], options, component: undefined as TestOverlayComponent | undefined, doneResults: [] as unknown[], requestRenderCalls: 0 };
				const component = factory({ requestRender() { call.requestRenderCalls++; } }, theme, {}, (result: unknown) => call.doneResults.push(result));
				call.component = component as TestOverlayComponent;
				customCalls.push(call);
				return Promise.resolve(undefined);
			},
		},
	};
}

function ctxNotifications(ctx: any): Array<{ message: unknown; type?: unknown }> {
	return Array.isArray(ctx.__notifications) ? ctx.__notifications : [];
}

async function runMessageEnd(extension: ReturnType<typeof registerExtension>, event: unknown, ctx: any) {
	return getHandler(extension, "message_end")(event, ctx);
}

async function runSessionLifecycle(extension: ReturnType<typeof registerExtension>, hook: string, ctx: any) {
	return getHandler(extension, hook)({ type: hook }, ctx);
}

function liveWebSearchEvent(query: string, eventType = "response.output_item.done"): string {
	return sseEvent({
		type: eventType,
		item: {
			type: "web_search_call",
			id: "ws-1",
			status: eventType === "response.output_item.done" ? "completed" : "searching",
			action: { type: "search", query },
		},
	});
}

function installMockResponsesFetch(bodyFactory: () => BodyInit | ReadableStream<Uint8Array>) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(bodyFactory(), {
		headers: { "content-type": "text/event-stream" },
	})) as typeof fetch;
	return () => {
		globalThis.fetch = originalFetch;
	};
}

async function createActiveLiveTracker(
	extension: ReturnType<typeof registerExtension>,
	ctx: any,
	query = "latest OMP provider tools",
	requestModel: any = targetModel,
) {
	const payload: Record<string, unknown> = { model: requestModel.id ?? "gpt-5", input: `search ${query}`, stream: true };
	await runBeforeProvider(extension, payload, ctx, { requestModel });
	const response = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		body: JSON.stringify(payload),
	});
	await responseText(response);
	return payload;
}

async function readChunkWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number) {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const result = await Promise.race([
		reader.read().then(read => ({ kind: "read" as const, read })),
		new Promise<{ kind: "timeout" }>(resolve => {
			timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
		}),
	]);
	if (timeout) clearTimeout(timeout);
	return result;
}


function webSearchMessage(query = "latest OMP provider tools") {
	return {
		providerPayload: {
			type: "openaiResponsesHistory",
			items: [
				{
					type: "web_search_call",
					id: "ws-1",
					status: "completed",
					action: { type: "search", query },
				},
				{
					type: "message",
					role: "assistant",
					content: [
						{
							type: "output_text",
							text: "OMP provider tools are available.",
							annotations: [
								{
									type: "url_citation",
									title: "OMP provider tools",
									url: "https://example.invalid/omp-provider-tools",
									start_index: 0,
									end_index: 3,
								},
							],
						},
					],
				},
			],
		},
	};
}

async function directoryEntries(directory: string): Promise<string[]> {
	return (await fs.readdir(directory)).sort();
}

describe("OpenAI provider tools extension", () => {
	it("registers session_start, before_agent_start, before_provider_request, and agent_end handlers without runtime package imports", async () => {
		const extension = registerExtension();

		expect(extension.label()).toBe("OpenAI Provider Tools");
		expect(extension.handlers.has("session_start")).toBe(true);
		expect(extension.handlers.has("before_agent_start")).toBe(true);
		expect(extension.handlers.has("before_provider_request")).toBe(true);
		expect(extension.handlers.has("agent_end")).toBe(true);

		const source = await fs.readFile(path.join(import.meta.dir, "../src/extension.ts"), "utf8");
		expect(source).not.toContain("@oh-my-pi/");
		expect(source).not.toContain("@mariozechner/");
	});

	it("opens provider-native web_search live overlay without realtime messages", async () => {
		const restoreFetch = installMockResponsesFetch(() => liveWebSearchEvent("latest OMP provider tools"));
		try {
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
			const recorder = uiRecorder();
			const ctx = context(cwd, homeDir, { hasUI: true, ui: recorder.ctxUi });
			const payload: Record<string, unknown> = { model: "gpt-5", input: "hello", stream: true };

			await runBeforeProvider(extension, payload, ctx, { requestModel: targetModel });
			await responseText(await fetch("https://api.openai.com/v1/responses", {
				method: "POST",
				body: JSON.stringify(payload),
			}));

			expect(payload.tools).toEqual([{ type: "web_search" }]);
			expect(recorder.customCalls).toHaveLength(1);
			expect(recorder.customCalls[0]?.options).toEqual({ overlay: true });
			expect(recorder.customCalls[0]?.component?.render(100).join("\n")).toContain("latest OMP provider tools");
			expect(recorder.widgetCalls).toEqual([]);
			expect(extension.sentMessages).toHaveLength(0);
		} finally {
			restoreFetch();
		}
	});

	it("does not create a live overlay for image_generation only requests", async () => {
		const restoreFetch = installMockResponsesFetch(() => sseEvent({
			type: "response.output_item.done",
			item: { type: "image_generation_call", id: "ig-1", result: ONE_BY_ONE_PNG, output_format: "png" },
		}));
		try {
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const extension = registerExtension({ initialActiveTools: ["read"] });
			const recorder = uiRecorder();
			const imageOnlyModel = {
				...customProviderModel,
				compat: { openaiProviderTools: { imageGeneration: true } },
			};
			const ctx = context(cwd, homeDir, { model: imageOnlyModel, hasUI: true, ui: recorder.ctxUi });
			const payload: Record<string, unknown> = { model: "gpt-5.5-Sys", input: "hello", stream: true };

			await runBeforeProvider(extension, payload, ctx, { requestModel: imageOnlyModel });
			await responseText(await fetch("https://gateway.example.invalid/v1/responses", {
				method: "POST",
				body: JSON.stringify(payload),
			}));

			expect(payload.tools).toEqual([{ type: "image_generation" }]);
			expect(recorder.customCalls).toEqual([]);
			expect(recorder.widgetCalls).toEqual([]);
		} finally {
			restoreFetch();
		}
	});

	it("clears active live overlay on message_end after final echo handling", async () => {
		const restoreFetch = installMockResponsesFetch(() => liveWebSearchEvent("message end cleanup"));
		try {
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
			const recorder = uiRecorder();
			const ctx = context(cwd, homeDir, { hasUI: true, ui: recorder.ctxUi, sessionManager: { getSessionId: () => "session-1" } });
			await createActiveLiveTracker(extension, ctx, "message end cleanup");
			const beforeMessages = extension.sentMessages.length;

			await runMessageEnd(extension, { type: "message_end", message: webSearchMessage() }, ctx);

			expect(recorder.notifications).toHaveLength(1);
			expect(recorder.customCalls.at(-1)?.doneResults).toEqual([undefined]);
			expect(recorder.widgetCalls).toEqual([]);
		} finally {
			restoreFetch();
		}
	});

	it("keeps completed live overlay visible until provider result echo closes it", async () => {
		const restoreFetch = installMockResponsesFetch(() => liveWebSearchEvent("echo closes overlay"));
		try {
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
			const recorder = uiRecorder();
			const ctx = context(cwd, homeDir, { hasUI: true, ui: recorder.ctxUi, sessionManager: { getSessionId: () => "session-1" } });
			await createActiveLiveTracker(extension, ctx, "echo closes overlay");

			expect(recorder.customCalls).toHaveLength(1);
			expect(recorder.customCalls[0]?.component?.render(100).join("\n")).toContain("completed");
			expect(recorder.customCalls[0]?.doneResults).toEqual([]);

			await runMessageEnd(extension, { type: "message_end", message: webSearchMessage("echo closes overlay") }, ctx);

			expect(recorder.notifications).toHaveLength(1);
			expect(recorder.customCalls[0]?.doneResults).toEqual([undefined]);
			expect(recorder.widgetCalls).toEqual([]);
		} finally {
			restoreFetch();
		}
	});

	it("clears active live overlay on agent_end after final echo handling", async () => {
		const restoreFetch = installMockResponsesFetch(() => liveWebSearchEvent("agent end cleanup"));
		try {
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
			const recorder = uiRecorder();
			const ctx = context(cwd, homeDir, { hasUI: true, ui: recorder.ctxUi, sessionManager: { getSessionId: () => "session-1" } });
			await createActiveLiveTracker(extension, ctx, "agent end cleanup");

			await runAgentEnd(extension, { message: webSearchMessage() }, ctx);

			expect(recorder.notifications).toHaveLength(1);
			expect(recorder.customCalls.at(-1)?.doneResults).toEqual([undefined]);
			expect(recorder.widgetCalls).toEqual([]);
		} finally {
			restoreFetch();
		}
	});

	it("clears active live overlay on session lifecycle hooks", async () => {
		for (const hook of ["session_before_switch", "session_switch", "session_branch", "session_shutdown"]) {
			const restoreFetch = installMockResponsesFetch(() => liveWebSearchEvent(`${hook} cleanup`));
			try {
				const cwd = await makeTempDir();
				const homeDir = await makeTempDir();
				const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
				const recorder = uiRecorder();
				const ctx = context(cwd, homeDir, { hasUI: true, ui: recorder.ctxUi });
				await createActiveLiveTracker(extension, ctx, `${hook} cleanup`);

				await runSessionLifecycle(extension, hook, ctx);

				expect(recorder.customCalls.at(-1)?.doneResults).toEqual([undefined]);
				expect(recorder.widgetCalls).toEqual([]);
			} finally {
				restoreFetch();
			}
		}
	});

	it("clears active live overlay on session_start while preserving image state cleanup", async () => {
		const restoreFetch = installMockResponsesFetch(() => liveWebSearchEvent("session start cleanup"));
		try {
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const artifactsDir = path.join(cwd, "artifacts");
			const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
			const recorder = uiRecorder();
			const ctx = context(cwd, homeDir, {
				hasUI: true,
				ui: recorder.ctxUi,
				sessionManager: { getArtifactsDir: () => artifactsDir },
			});
			await runAgentEnd(extension, { message: imageGenerationMessage("img-1") }, ctx);
			await createActiveLiveTracker(extension, ctx, "session start cleanup");

			await runSessionStart(extension, ctx);
			await runAgentEnd(extension, { message: imageGenerationMessage("img-1") }, ctx);

			expect(recorder.customCalls.at(-1)?.doneResults).toEqual([undefined]);
			expect(recorder.widgetCalls).toEqual([]);
			expect(extension.sentMessages).toHaveLength(2);
		} finally {
			restoreFetch();
		}
	});

	it("does not open live overlay when only setWidget exists", async () => {
		const restoreFetch = installMockResponsesFetch(() => liveWebSearchEvent("rpc capability probing"));
		try {
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
			const recorder = uiRecorder();
			const ctx = context(cwd, homeDir, { hasUI: false, ui: { notify() {}, setWidget: recorder.ctxUi.setWidget } });

			await createActiveLiveTracker(extension, ctx, "rpc capability probing");

			expect(recorder.customCalls).toEqual([]);
			expect(recorder.widgetCalls).toEqual([]);
			expect(extension.sentMessages).toHaveLength(0);
		} finally {
			restoreFetch();
		}
	});

	it("no-ops live overlay when custom is unavailable", async () => {
		const restoreFetch = installMockResponsesFetch(() => liveWebSearchEvent("missing overlay capability"));
		try {
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
			const ctx = context(cwd, homeDir, {
				hasUI: true,
				ui: { notify() {} },
			});

			await expect(createActiveLiveTracker(extension, ctx, "missing overlay capability")).resolves.toBeDefined();

			expect(extension.sentMessages).toHaveLength(0);
		} finally {
			restoreFetch();
		}
	});

	it("does not register image keepalive for web_search only live status streams", async () => {
		const originalFetch = globalThis.fetch;
		try {
			let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
			globalThis.fetch = (async () => new Response(
				new ReadableStream<Uint8Array>({
					start(createdController) {
						controller = createdController;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			)) as typeof fetch;
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
			const recorder = uiRecorder();
			const ctx = context(cwd, homeDir, { hasUI: true, ui: recorder.ctxUi });
			const payload: Record<string, unknown> = { model: "gpt-5", input: "hello", stream: true };

			await runBeforeProvider(extension, payload, ctx, { requestModel: targetModel });
			const response = await fetch("https://api.openai.com/v1/responses", {
				method: "POST",
				body: JSON.stringify(payload),
			});
			const reader = response.body?.getReader();
			expect(reader).toBeDefined();
			const firstRead = await readChunkWithTimeout(reader!, 25);
			controller?.close();
			await reader!.cancel().catch(() => undefined);

			expect(firstRead.kind).toBe("timeout");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("keeps live overlay and image interruption working for combined web_search and image_generation streams", async () => {
		const restoreFetch = installMockResponsesFetch(() =>
			liveWebSearchEvent("combined live image interruption") +
			sseEvent({ type: "response.output_item.done", item: { type: "image_generation_call", id: "ig-1", result: ONE_BY_ONE_PNG, output_format: "png" } }) +
			sseEvent({ type: "response.output_text.delta", delta: "SHOULD_NOT_PASS" }),
		);
		try {
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const extension = registerExtension({ initialActiveTools: ["read"] });
			const recorder = uiRecorder();
			const ctx = context(cwd, homeDir, { model: providerToolsInterruptImageModel, hasUI: true, ui: recorder.ctxUi });
			const payload: Record<string, unknown> = { model: "gpt-5", input: "hello", stream: true };

			await runBeforeProvider(extension, payload, ctx, { requestModel: providerToolsInterruptImageModel });
			const text = await responseText(await fetch("https://gateway.example.invalid/v1/responses", {
				method: "POST",
				body: JSON.stringify(payload),
			}));

			expect(payload.tools).toEqual([{ type: "web_search" }, { type: "image_generation" }]);
			expect(recorder.customCalls[0]?.component?.render(100).join("\n")).toContain("combined live image interruption");
			expect(recorder.widgetCalls).toEqual([]);
			expect(text).toContain("data: [DONE]");
			expect(text).not.toContain("SHOULD_NOT_PASS");
		} finally {
			restoreFetch();
		}
	});

	it("does not inject or remove active tools for custom providers without config or opt-in", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, { model: customProviderModel });
		const payload = { model: "gpt-5", input: "hello" };

		await runBeforeAgent(extension, ctx);
		await runBeforeProvider(extension, payload, ctx, { requestModel: customProviderModel });

		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(payload).toEqual({ model: "gpt-5", input: "hello" });
	});
	it("does not remove host-side tools or inject for chat-completions context even when model identity matches", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: { ...targetModel, api: "chat-completions" },
		});
		const chatPayload: Record<string, unknown> = { model: "gpt-5", messages: [{ role: "user", content: "hello" }] };

		await runBeforeAgent(extension, ctx);
		await runBeforeProvider(extension, chatPayload, ctx);

		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(chatPayload.tools).toBeUndefined();
	});

	it("does not inject request-scoped Responses tools when matching host-side tools remain active", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension();
		const ctx = context(cwd, homeDir);
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, payload, ctx, { requestModel: targetModel });

		expect(payload.tools).toBeUndefined();
		expect(extension.warnings.join("\n")).toContain("active host-side tools remain");
		expect(ctxNotifications(ctx).some(({ message }) => String((message as any).message ?? message).includes("active host-side tools remain"))).toBe(true);
	});

	it("injects web_search for official OpenAI Responses from model metadata", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
		const ctx = context(cwd, homeDir);
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, payload, ctx, { requestModel: targetModel });

		expect(payload.tools).toEqual([{ type: "web_search" }]);
		expect(payload).not.toHaveProperty("tool_choice");
	});

	it("mutates provider payload synchronously from model metadata", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
		const ctx = context(cwd, homeDir);
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		const result = getHandler(extension, "before_provider_request")(
			{ type: "before_provider_request", payload, requestModel: targetModel },
			ctx,
		);

		expect(payload.tools).toEqual([{ type: "web_search" }]);
		await result;
	});

	it("does not inject provider tools for custom providers without provider opt-in", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
		const ctx = context(cwd, homeDir, { model: customProviderModel });
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, payload, ctx, { requestModel: customProviderModel });

		expect(payload.tools).toBeUndefined();
	});

	it("does not treat provider named openai on a custom baseUrl as official OpenAI", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
		const gatewayNamedOpenAIModel = {
			...targetModel,
			baseUrl: "https://gateway.example.invalid/v1",
		};
		const ctx = context(cwd, homeDir, { model: gatewayNamedOpenAIModel });
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, payload, ctx, { requestModel: gatewayNamedOpenAIModel });

		expect(payload.tools).toBeUndefined();
	});

	it("injects web_search for custom providers with compat.openaiProviderTools enabled", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
		const ctx = context(cwd, homeDir, { model: providerToolsEnabledModel });
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, payload, ctx, { requestModel: providerToolsEnabledModel });

		expect(payload.tools).toEqual([{ type: "web_search" }]);
	});

	it("injects image_generation only when compat.openaiProviderTools imageGeneration is enabled", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension({ initialActiveTools: ["read"] });
		const ctx = context(cwd, homeDir, { model: providerToolsImageModel });
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, payload, ctx, { requestModel: providerToolsImageModel });

		expect(payload.tools).toEqual([{ type: "web_search" }, { type: "image_generation" }]);
	});

	it("injects only image_generation when custom provider model keeps imageGeneration opt-in without provider-level enabled", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension({ initialActiveTools: ["read"] });
		const modelLevelImageOnlyModel = {
			...customProviderModel,
			compat: {
				openaiProviderTools: {
					imageGeneration: true,
				},
			},
		};
		const ctx = context(cwd, homeDir, { model: modelLevelImageOnlyModel });
		const payload: Record<string, unknown> = { model: "gpt-5.5-Sys", input: "hello" };

		await runBeforeProvider(extension, payload, ctx, { requestModel: modelLevelImageOnlyModel });

		expect(payload.tools).toEqual([{ type: "image_generation" }]);
	});

	it("does not inject image_generation for unsupported extraBody image markers", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
		const ctx = context(cwd, homeDir, { model: unsupportedExtraBodyImageModel });
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, payload, ctx, { requestModel: unsupportedExtraBodyImageModel });

		expect(payload.tools).toEqual([{ type: "web_search" }]);
	});

	it("restores and aborts when request model loses image_generation opt-in after host-side removal", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension();
		let abortMessage = "";
		const ctx = context(cwd, homeDir, {
			model: imageCapableModel,
			abort: (message: string) => {
				abortMessage = message;
			},
		});
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runBeforeAgent(extension, ctx);
		expect(extension.activeTools()).toEqual(["read"]);
		await runBeforeProvider(extension, payload, ctx, { requestModel: targetModel });

		expect(abortMessage).toContain("enabled fewer provider tools");
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(payload.tools).toBeUndefined();
	});

	it("does not inject request-scoped tools when active tool inspection is asynchronous", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension({
			getActiveTools: () => Promise.resolve(["read"]),
		});
		const ctx = context(cwd, homeDir);
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		const result = getHandler(extension, "before_provider_request")(
			{ type: "before_provider_request", payload, requestModel: targetModel },
			ctx,
		);

		expect(payload.tools).toBeUndefined();
		await result;
		expect(payload.tools).toBeUndefined();
		expect(extension.warnings.join("\n")).toContain("active tool inspection is asynchronous");
	});

	it("does not inject request-scoped Responses tools when active tool API is unavailable", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension({ activeToolMethods: false });
		const ctx = context(cwd, homeDir);
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };
		await runSessionStart(extension, ctx);

		await runBeforeProvider(extension, payload, ctx, { requestModel: targetModel });

		expect(payload.tools).toBeUndefined();
		expect(extension.warnings.join("\n")).toContain("active tool control API is unavailable");
		expect(ctxNotifications(ctx).some(({ message }) => String((message as any).message ?? message).includes("active tool control API is unavailable"))).toBe(true);
	});

	it("restores active tools and aborts when payload.tools is non-array after host-side removal", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension();
		let aborted = false;
		const ctx = context(cwd, homeDir, { abort: () => { aborted = true; } });

		await runBeforeAgent(extension, ctx);
		expect(extension.activeTools()).toEqual(["read", "generate_image"]);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello", tools: "bad" }, ctx);

		expect(aborted).toBe(true);
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
	});

	it("restores and warns on agent_end when no provider request follows host-side removal", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension();
		const ctx = context(cwd, homeDir);

		await runBeforeAgent(extension, ctx);
		expect(extension.activeTools()).toEqual(["read", "generate_image"]);
		await runAgentEnd(extension, { message: { content: "done" } }, ctx);

		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(extension.warnings.join("\n")).toContain("provider request was not observed after host-side tool removal");
		expect(ctxNotifications(ctx).some(({ message }) => String((message as any).message ?? message).includes("provider request was not observed after host-side tool removal"))).toBe(true);
	});

	it("restores and aborts when a different request target follows host-side removal", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension();
		let abortMessage = "";
		const ctx = context(cwd, homeDir, {
			abort: (message: string) => {
				abortMessage = message;
			},
		});
		const otherModel = { ...providerToolsEnabledModel, id: "other-model" };

		await runBeforeAgent(extension, ctx);
		expect(extension.activeTools()).toEqual(["read", "generate_image"]);
		await runBeforeProvider(extension, { model: "other-model", input: "hello" }, ctx, { requestModel: otherModel });

		expect(abortMessage).toContain("provider request target differed after host-side tool removal");
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
	});

	it("echoes provider-native web_search results through ctx.ui.notify without steering", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension();
		const recorder = uiRecorder();
		const ctx = context(cwd, homeDir, {
			ui: recorder.ctxUi,
			sessionManager: {
				getSessionId: () => "session-1",
			},
		});

		await runAgentEnd(extension, { message: webSearchMessage() }, ctx);

		expect(extension.sentMessages).toHaveLength(0);
		expect(recorder.notifications).toHaveLength(1);
		expect(recorder.notifications[0]?.type).toBe("info");
		const message = String(recorder.notifications[0]?.message ?? "");
		expect(message).toContain("OpenAI provider completed web_search (1 call).");
		expect(message).toContain("latest OMP provider tools");
		expect(message).toContain("1 citation");
		expect(message).not.toContain("OMP provider tools are available.");
	});

	it("logs provider-native web_search summary delivery failures without throwing", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const ctx = context(cwd, homeDir, {
			sessionManager: {
				getSessionId: () => "session-1",
			},
		});
		(ctx as any).ui = {};

		// registerExtension does not expose api; exercise failure through a local extension instance.
		const handlers = new Map<string, Handler[]>();
		const warnings: unknown[][] = [];
		const failingApi: any = {
			logger: { debug() {}, warn: (...args: unknown[]) => warnings.push(args), error() {} },
			runtime: { name: "omp" },
			on(event: string, handler: Handler) {
				const existing = handlers.get(event) ?? [];
				existing.push(handler);
				handlers.set(event, existing);
			},
			setLabel() {},
			getActiveTools() { return ["read", "web_search", "generate_image"]; },
			async setActiveTools() {},
			sendMessage() { return Promise.reject(new Error("send failed")); },
			registerMessageRenderer() {},
		};
		providerToolsExtension(failingApi);

		expect(() => getHandlerFromMap(handlers, "agent_end")({ message: webSearchMessage() }, ctx)).not.toThrow();
		await Promise.resolve();
		await Promise.resolve();
		expect(warnings.join("\n")).toContain("OpenAI provider tool result notification delivery failed");
	});

	it("echoes provider-native web_search at message_end before agent_end and deduplicates later", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			sessionManager: {
				getSessionId: () => "session-1",
			},
		});
		const message = webSearchMessage();

		getHandler(extension, "message_end")({ type: "message_end", message }, ctx);

		expect(extension.sentMessages).toHaveLength(0);
		expect(ctxNotifications(ctx)).toHaveLength(1);
		expect(String(ctxNotifications(ctx)[0]?.message ?? "")).toContain("latest OMP provider tools");
		await runAgentEnd(extension, { message }, ctx);

		expect(extension.sentMessages).toHaveLength(0);
		expect(ctxNotifications(ctx)).toHaveLength(1);
		await runAgentEnd(extension, { message }, ctx);

		expect(extension.sentMessages).toHaveLength(0);
		expect(ctxNotifications(ctx)).toHaveLength(1);
	});

	it("does not let incomplete message_end web_search echoes suppress final agent_end details", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			sessionManager: {
				getSessionId: () => "session-1",
			},
		});
		const partial = webSearchMessage();
		((partial.providerPayload.items[0] as any).status) = "in_progress";
		const completed = webSearchMessage();

		getHandler(extension, "message_end")({ type: "message_end", message: partial }, ctx);
		expect(extension.sentMessages).toHaveLength(0);

		await runAgentEnd(extension, { message: completed }, ctx);

		expect(extension.sentMessages).toHaveLength(0);
		expect(ctxNotifications(ctx)).toHaveLength(1);
		expect(String(ctxNotifications(ctx)[0]?.message ?? "")).toContain("latest OMP provider tools");
	});

	it("saves an image_generation_call result and sends a visible message without base64", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const artifactsDir = path.join(cwd, "artifacts");
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => artifactsDir,
			},
		});

		await runAgentEnd(extension, { messages: [imageGenerationMessage()] }, ctx);

		const files = await directoryEntries(artifactsDir);
		expect(files).toHaveLength(1);
		expect(files[0]?.endsWith(".png")).toBe(true);
		expect(extension.sentMessages).toHaveLength(1);
		expect(extension.sentMessages[0]?.options).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
		const message = extension.sentMessages[0]?.message as any;
		expect(message.display).toBe(true);
		expect(message.customType).toBe("openai-provider-image-generation");
		expect(messageText(message)).toContain("OpenAI provider generated 1 image.");
		expect(messageText(message)).toContain(path.join(artifactsDir, files[0] ?? ""));
		expect(messageText(message)).not.toContain(ONE_BY_ONE_PNG);
		expect(messageImages(message)).toEqual([{ type: "image", data: ONE_BY_ONE_PNG, mimeType: "image/png" }]);
	});

	it("normalizes provider-native image_generation replay items after saving them", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const artifactsDir = path.join(cwd, "artifacts");
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => artifactsDir,
			},
		});
		const message: any = {
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "sub2api-openai-image",
				dt: true,
				items: [
					{ type: "reasoning", encrypted_content: "opaque", summary: [] },
					{ type: "image_generation_call", status: "generating", action: "generate", background: "opaque", output_format: "png", quality: "high" },
					{ type: "image_generation_call", id: "img-1", status: "completed", action: "generate", result: ONE_BY_ONE_PNG, output_format: "png", quality: "high" },
				],
			},
		};

		getHandler(extension, "message_end")({ type: "message_end", message }, ctx);

		expect(await directoryEntries(artifactsDir)).toHaveLength(1);
		expect(message.providerPayload.items).toEqual([
			{ type: "reasoning", encrypted_content: "opaque", summary: [] },
			{ type: "image_generation_call", id: "img-1" },
		]);
	});

	it("keeps failed image results retryable after normalizing unsafe replay items", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const outputParentFile = path.join(cwd, "not-a-directory");
		const badOutputDir = path.join(outputParentFile, "images");
		await fs.writeFile(outputParentFile, "file blocks directory creation");
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: imageModelWithOutput(badOutputDir),
			sessionManager: {
				getSessionId: () => "session-1",
			},
		});
		const message: any = imageGenerationMessage();

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello" }, ctx);
		getHandler(extension, "message_end")({ type: "message_end", message }, ctx);
		await fs.rm(outputParentFile, { force: true });
		await runAgentEnd(extension, { message }, ctx);

		expect(message.providerPayload.items).toEqual([{ type: "image_generation_call", id: "img-1" }]);
		expect(await directoryEntries(badOutputDir)).toHaveLength(1);
		expect(extension.sentMessages).toHaveLength(2);
	});

	it("normalizes unsafe replayed image_generation_call items in outgoing provider payload", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension({ initialActiveTools: ["read"] });
		const ctx = context(cwd, homeDir, { model: providerToolsImageModel });
		const payload: Record<string, unknown> = {
			model: "gpt-5.5-Sys",
			input: [
				{ role: "user", content: [{ type: "input_text", text: "next" }] },
				{ type: "image_generation_call", status: "generating", action: "generate", output_format: "png", quality: "high" },
				{ type: "image_generation_call", id: "img-1", status: "completed", action: "generate", result: ONE_BY_ONE_PNG, output_format: "png" },
			],
		};

		await runBeforeProvider(extension, payload, ctx, { requestModel: providerToolsImageModel });

		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "next" }] },
			{ type: "image_generation_call", id: "img-1" },
		]);
		expect(payload.tools).toEqual([{ type: "web_search" }, { type: "image_generation" }]);
	});

	it("saves an image_generation_call result from message_end before agent_end", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const artifactsDir = path.join(cwd, "artifacts");
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => artifactsDir,
			},
		});

		const result = getHandler(extension, "message_end")({ type: "message_end", message: imageGenerationMessage() }, ctx);

		const files = fsSync.readdirSync(artifactsDir);
		expect(result).toBeUndefined();

		expect(files).toHaveLength(1);
		expect(files[0]?.endsWith(".png")).toBe(true);
		expect(extension.sentMessages).toHaveLength(1);
		const message = extension.sentMessages[0]?.message as any;
		expect(messageText(message)).toContain("OpenAI provider generated 1 image.");
		expect(messageText(message)).toContain(path.join(artifactsDir, files[0] ?? ""));
		expect(message.details.path).toBe(path.join(artifactsDir, files[0] ?? ""));
		expect(messageText(message)).not.toContain(ONE_BY_ONE_PNG);
	});


	it("uses preloaded asynchronous session artifact directory for synchronous message_end image saving", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const artifactsDir = path.join(cwd, "async-artifacts");
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			sessionManager: {
				getSessionId: async () => "async-session-1",
				getArtifactsDir: async () => artifactsDir,
			},
		});

		await runSessionStart(extension, ctx);
		const result = getHandler(extension, "message_end")({ type: "message_end", message: imageGenerationMessage() }, ctx);

		const files = fsSync.readdirSync(artifactsDir);
		expect(result).toBeUndefined();
		expect(files).toHaveLength(1);
		expect(extension.sentMessages).toHaveLength(1);
		const message = extension.sentMessages[0]?.message as any;
		expect(messageText(message)).toContain("OpenAI provider generated 1 image.");
		expect(messageText(message)).toContain(path.join(artifactsDir, files[0] ?? ""));
		expect(message.details.path).toBe(path.join(artifactsDir, files[0] ?? ""));
	});

	it("retries image saving on agent_end when message_end save fails before marking seen", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const outputParentFile = path.join(cwd, "not-a-directory");
		const badOutputDir = path.join(outputParentFile, "images");
		const artifactsDir = path.join(cwd, "artifacts");
		await fs.writeFile(outputParentFile, "file blocks directory creation");
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: imageModelWithOutput(badOutputDir),
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => artifactsDir,
			},
		});

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello" }, ctx);
		getHandler(extension, "message_end")({ type: "message_end", message: imageGenerationMessage() }, ctx);
		await fs.rm(outputParentFile, { force: true });
		await runAgentEnd(extension, { message: imageGenerationMessage() }, ctx);

		const files = await directoryEntries(badOutputDir);
		expect(files).toHaveLength(1);
		expect(extension.sentMessages).toHaveLength(2);
		const savedMessage = extension.sentMessages[1]?.message as any;
		expect(messageText(savedMessage)).toContain("OpenAI provider generated 1 image.");
		expect(messageText(savedMessage)).toContain(path.join(badOutputDir, files[0] ?? ""));
		expect(savedMessage.details.path).toBe(path.join(badOutputDir, files[0] ?? ""));
	});
	it("reports malformed id-less image results and continues with later valid results", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const artifactsDir = path.join(cwd, "artifacts");
		const invalidResult = "not valid base64!!!";
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => artifactsDir,
			},
		});

		await expect(runAgentEnd(extension, {
			message: {
				providerPayload: {
					type: "openaiResponsesHistory",
					items: [
						{ type: "image_generation_call", result: invalidResult, output_format: "png" },
						{ type: "image_generation_call", id: "img-2", result: ONE_BY_ONE_PNG, output_format: "png" },
					],
				},
			},
		}, ctx)).resolves.toBeUndefined();

		const files = await directoryEntries(artifactsDir);
		expect(files).toHaveLength(1);
		expect(extension.sentMessages).toHaveLength(2);
		const errorMessage = extension.sentMessages[0]?.message as any;
		expect(errorMessage.display).toBe(true);
		expect(errorMessage.content).toMatch(/could not be saved|base64 is invalid/i);
		expect(errorMessage.content).not.toContain(invalidResult);
		const savedMessage = extension.sentMessages[1]?.message as any;
		expect(messageText(savedMessage)).toContain("OpenAI provider generated 1 image.");
		expect(messageText(savedMessage)).toContain(path.join(artifactsDir, files[0] ?? ""));
		expect(savedMessage.details.path).toBe(path.join(artifactsDir, files[0] ?? ""));
		expect(messageText(savedMessage)).not.toContain(ONE_BY_ONE_PNG);
		expect(messageImages(savedMessage)).toEqual([{ type: "image", data: ONE_BY_ONE_PNG, mimeType: "image/png" }]);
	});

	it("deduplicates the same image result within one session", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const artifactsDir = path.join(cwd, "artifacts");
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => artifactsDir,
			},
		});

		await runAgentEnd(extension, { message: imageGenerationMessage("img-1") }, ctx);
		await runAgentEnd(extension, { message: imageGenerationMessage("img-1") }, ctx);

		expect(await directoryEntries(artifactsDir)).toHaveLength(1);
		expect(extension.sentMessages).toHaveLength(1);
	});

	it("resets image result deduplication on session_start", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const artifactsDir = path.join(cwd, "artifacts");
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			sessionManager: {
				getArtifactsDir: () => artifactsDir,
			},
		});

		await runAgentEnd(extension, { message: imageGenerationMessage("img-1") }, ctx);
		await runSessionStart(extension, ctx);
		await runAgentEnd(extension, { message: imageGenerationMessage("img-1") }, ctx);

		expect(await directoryEntries(artifactsDir)).toHaveLength(1);
		expect(extension.sentMessages).toHaveLength(2);
	});

	it("prefers configured output.directory over the session artifact directory", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const outputDir = path.join(cwd, "configured-output");
		const artifactsDir = path.join(cwd, "artifacts");
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: imageModelWithOutput(outputDir),
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => artifactsDir,
			},
		});
		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello" }, ctx);

		await runAgentEnd(extension, imageGenerationMessage(), ctx);

		expect(await directoryEntries(outputDir)).toHaveLength(1);
		await expect(fs.stat(artifactsDir)).rejects.toThrow();
		const message = extension.sentMessages[0]?.message as any;
		expect(messageText(message)).toContain("OpenAI provider generated 1 image.");
		expect(messageText(message)).toContain(outputDir);
		expect(message.details.path).toContain(outputDir);
	});

	it("clears configured image output directory on session_start", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const outputDir = path.join(cwd, "configured-output");
		const artifactsDir = path.join(cwd, "artifacts");
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: imageModelWithOutput(outputDir),
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => artifactsDir,
			},
		});

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello" }, ctx);
		await runAgentEnd(extension, { message: imageGenerationMessage("img-1") }, ctx);
		await runSessionStart(extension, ctx);
		await runAgentEnd(extension, { message: imageGenerationMessage("img-2") }, ctx);

		expect(await directoryEntries(outputDir)).toHaveLength(1);
		expect(await directoryEntries(artifactsDir)).toHaveLength(1);
		const secondMessage = extension.sentMessages[1]?.message as any;
		expect(messageText(secondMessage)).toContain("OpenAI provider generated 1 image.");
		expect(messageText(secondMessage)).toContain(artifactsDir);
		expect(secondMessage.details.path).toContain(artifactsDir);
		expect(messageText(secondMessage)).not.toContain(outputDir);
	});

	it("clears previous image output directory for requests without image generation enabled", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const outputDir = path.join(cwd, "configured-output");
		const artifactsDir = path.join(cwd, "artifacts");
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: imageModelWithOutput(outputDir),
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => artifactsDir,
			},
		});

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello" }, ctx);
		await runAgentEnd(extension, { message: imageGenerationMessage("img-1") }, ctx);
		await runSessionStart(extension, context(cwd, homeDir, {
			model: targetModel,
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => artifactsDir,
			},
		}));
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello" }, context(cwd, homeDir, {
			model: targetModel,
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => artifactsDir,
			},
		}));
		await runAgentEnd(extension, { message: imageGenerationMessage("img-2") }, ctx);

		expect(await directoryEntries(outputDir)).toHaveLength(1);
		expect(await directoryEntries(artifactsDir)).toHaveLength(1);
		const secondMessage = extension.sentMessages[1]?.message as any;
		expect(messageText(secondMessage)).toContain("OpenAI provider generated 1 image.");
		expect(messageText(secondMessage)).toContain(artifactsDir);
		expect(secondMessage.details.path).toContain(artifactsDir);
		expect(messageText(secondMessage)).not.toContain(outputDir);
	});

	it("uses the agent default image directory when no artifact directory is available", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			sessionManager: {
				getSessionId: () => "session-1",
			},
		});
		const defaultDir = path.join(homeDir, ".omp", "agent", "provider-tool-images");

		await runAgentEnd(extension, { message: imageGenerationMessage() }, ctx);

		expect(await directoryEntries(defaultDir)).toHaveLength(1);
		const message = extension.sentMessages[0]?.message as any;
		expect(messageText(message)).toContain("OpenAI provider generated 1 image.");
		expect(messageText(message)).toContain(defaultDir);
		expect(message.details.path).toContain(defaultDir);
	});

	it("uses Pi agent default image directory from context model runtime metadata", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension({ runtime: "unknown" });
		const ctx = context(cwd, homeDir, {
			model: {
				...targetModel,
				runtime: { kind: "pi" },
			},
			sessionManager: {
				getSessionId: () => "session-1",
			},
		});
		const piDefaultDir = path.join(homeDir, ".pi", "agent", "provider-tool-images");
		const ompDefaultDir = path.join(homeDir, ".omp", "agent", "provider-tool-images");

		await runAgentEnd(extension, { message: imageGenerationMessage() }, ctx);

		expect(await directoryEntries(piDefaultDir)).toHaveLength(1);
		await expect(fs.stat(ompDefaultDir)).rejects.toThrow();
		const message = extension.sentMessages[0]?.message as any;
		expect(messageText(message)).toContain("OpenAI provider generated 1 image.");
		expect(messageText(message)).toContain(piDefaultDir);
		expect(message.details.path).toContain(piDefaultDir);
	});

	it("sends a visible error message when saving an image result fails", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const outputParentFile = path.join(cwd, "not-a-directory");
		const badOutputDir = path.join(outputParentFile, "images");
		await fs.writeFile(outputParentFile, "file blocks directory creation");
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: imageModelWithOutput(badOutputDir),
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => path.join(cwd, "artifacts"),
			},
		});
		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello" }, ctx);

		await runAgentEnd(extension, { message: imageGenerationMessage() }, ctx);

		expect(extension.sentMessages).toHaveLength(1);
		const message = extension.sentMessages[0]?.message as any;
		expect(message.display).toBe(true);
		expect(message.content).toContain("could not be saved");
		expect(message.content).not.toContain(ONE_BY_ONE_PNG);
	});

	it("shortens and combines image_generation result display while preserving saved metadata", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const artifactsDir = path.join(cwd, "artifacts");
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => artifactsDir,
			},
		});

		await runAgentEnd(extension, { messages: [imageGenerationMessage("img-1"), imageGenerationMessage("img-2")] }, ctx);

		expect(extension.sentMessages).toHaveLength(1);
		const message = extension.sentMessages[0]?.message as any;
		expect(messageText(message)).toContain("OpenAI provider generated 2 images.");
		expect(messageText(message)).not.toContain("Images:");
		expect(messageText(message)).not.toContain("MIME:");
		expect(messageText(message)).not.toContain("Bytes:");
		expect(messageImages(message)).toHaveLength(2);
		expect(message.details.images).toHaveLength(2);
	});

	it("combines provider-native web_search echoes into one short end-of-turn summary", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension();
		const message = webSearchMessage() as any;
		message.providerPayload.items.unshift({
			type: "web_search_call",
			id: "ws-2",
			status: "completed",
			action: { type: "search", query: "provider native image_generation" },
		});
		const ctx = context(cwd, homeDir, {
			sessionManager: {
				getSessionId: () => "session-1",
			},
		});

		await runAgentEnd(extension, { message }, ctx);

		expect(extension.sentMessages).toHaveLength(0);
		expect(ctxNotifications(ctx)).toHaveLength(1);
		const sent = ctxNotifications(ctx)[0]!;
		expect(String(sent.message)).toContain("OpenAI provider completed web_search (2 calls).");
		expect(String(sent.message)).toContain("provider native image_generation");
		expect(String(sent.message)).toContain("latest OMP provider tools");
		expect(String(sent.message)).not.toContain("Call:");
		expect(String(sent.message)).not.toContain("Status:");
	});


	it("injects progress keepalives for provider-native image_generation streams before the OMP idle watchdog", async () => {
		const originalFetch = globalThis.fetch;
		try {
			let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
			globalThis.fetch = (async () => new Response(
				new ReadableStream<Uint8Array>({
					start(createdController) {
						controller = createdController;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			)) as typeof fetch;
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const extension = registerExtension({ initialActiveTools: ["read"] });
			const keepaliveImageModel = {
				...providerToolsImageModel,
				compat: {
					openaiProviderTools: {
						...providerToolsImageModel.compat.openaiProviderTools,
						imageGenerationKeepaliveIntervalMs: 1,
					},
				},
			};
			const ctx = context(cwd, homeDir, { model: keepaliveImageModel });
			const payload: Record<string, unknown> = { model: "gpt-5", input: "hello", stream: true };

			await runBeforeProvider(extension, payload, ctx, { requestModel: keepaliveImageModel });
			const response = await fetch("https://gateway.example.invalid/v1/responses", {
				method: "POST",
				body: JSON.stringify(payload),
			});
			const reader = response.body?.getReader();
			expect(reader).toBeDefined();
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const firstRead = await Promise.race([
				reader!.read().then(result => ({ kind: "read" as const, result })),
				new Promise<{ kind: "timeout" }>(resolve => {
					timeout = setTimeout(() => resolve({ kind: "timeout" }), 25);
				}),
			]);
			if (timeout) clearTimeout(timeout);
			controller?.close();
			await reader!.cancel().catch(() => undefined);

			expect(firstRead.kind).toBe("read");
			if (firstRead.kind !== "read") return;
			expect(firstRead.result.done).toBe(false);
			const text = new TextDecoder().decode(firstRead.result.value);
			expect(text).toContain("response.function_call_arguments.delta");
			expect(text).toContain("openai_provider_tools_keepalive");
			expect(text).not.toContain("data: [DONE]");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
	it("emits plugin keepalives even when provider sends only transport keepalives", async () => {
		let interval: ReturnType<typeof setInterval> | undefined;
		try {
			const wrappedBody = wrapImageGenerationStream(
				new ReadableStream<Uint8Array>({
					start(controller) {
						interval = setInterval(() => controller.enqueue(new TextEncoder().encode(":\n\n")), 5);
					},
					cancel() {
						if (interval) clearInterval(interval);
					},
				}),
				{ interruptOnImageResult: false, keepaliveIntervalMs: 20 },
			);
			const reader = wrappedBody.getReader();
			let sawKeepalive = false;
			const deadline = Date.now() + 90;
			while (!sawKeepalive && Date.now() < deadline) {
				let timeout: ReturnType<typeof setTimeout> | undefined;
				const next = await Promise.race([
					reader.read().then(result => ({ kind: "read" as const, result })),
					new Promise<{ kind: "timeout" }>(resolve => {
						timeout = setTimeout(() => resolve({ kind: "timeout" }), 15);
					}),
				]);
				if (timeout) clearTimeout(timeout);
				if (next.kind === "read" && !next.result.done) {
					const text = new TextDecoder().decode(next.result.value);
					sawKeepalive = text.includes("openai_provider_tools_keepalive");
				}
			}
			await reader.cancel().catch(() => undefined);

			expect(sawKeepalive).toBe(true);
		} finally {
			if (interval) clearInterval(interval);
		}
	});

	it("treats a closed keepalive stream controller as terminal instead of throwing", () => {
		let finished = false;
		const closedController = {
			enqueue() {
				throw new TypeError("Invalid state: Controller is already closed");
			},
		} as unknown as ReadableStreamDefaultController<Uint8Array>;

		expect(tryEnqueueChunk(closedController, new Uint8Array([1]), () => { finished = true; })).toBe(false);
		expect(finished).toBe(true);
	});

	it("clears image_generation keepalive timers when upstream stream reads fail", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		const handles: unknown[] = [];
		const cleared: unknown[] = [];
		(globalThis as any).setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
			void handler;
			void args;
			const handle = { timeout };
			handles.push(handle);
			return handle;
		}) as typeof setTimeout;
		(globalThis as any).clearTimeout = ((handle?: unknown) => {
			cleared.push(handle);
		}) as typeof clearTimeout;
		try {
			const upstreamError = new Error("upstream failed");
			const body = {
				getReader() {
					return {
						async read() {
							throw upstreamError;
						},
						async cancel() {},
					};
				},
			} as unknown as ReadableStream<Uint8Array>;

			const reader = wrapImageGenerationStream(body, {
				interruptOnImageResult: false,
				keepaliveIntervalMs: 60_000,
			}).getReader();

			await expect(reader.read()).rejects.toThrow("upstream failed");
			expect(handles).toHaveLength(1);
			expect(cleared).toEqual(handles);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	});

	it("injects progress keepalives into SDK event iterables before OMP idle checks", async () => {
		async function* stalledEvents() {
			await new Promise(() => undefined);
		}

		const stream = wrapImageGenerationEventIterable(stalledEvents(), {
			interruptOnImageResult: false,
			keepaliveIntervalMs: 1,
		});
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const first = await Promise.race([
			stream[Symbol.asyncIterator]().next().then(result => ({ kind: "read" as const, result })),
			new Promise<{ kind: "timeout" }>(resolve => {
				timeout = setTimeout(() => resolve({ kind: "timeout" }), 25);
			}),
		]);
		if (timeout) clearTimeout(timeout);

		expect(first.kind).toBe("read");
		if (first.kind !== "read") return;
		expect(first.result.done).toBe(false);
		expect(first.result.value).toMatchObject({
			type: "response.function_call_arguments.delta",
			item_id: "openai_provider_tools_keepalive",
			delta: "",
		});
	});

	it("does not hang SDK iterator return after a synthetic keepalive wins the race", async () => {
		let upstreamReturnCalled = false;
		const abortController = new AbortController();
		const source = {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						return new Promise<IteratorResult<unknown>>(() => undefined);
					},
					async return() {
						upstreamReturnCalled = true;
						return new Promise<IteratorResult<unknown>>(() => undefined);
					},
				};
			},
		} satisfies AsyncIterable<unknown>;
		const iterator = wrapImageGenerationEventIterable(source, {
			interruptOnImageResult: false,
			keepaliveIntervalMs: 1,
		}, abortController)[Symbol.asyncIterator]();

		const first = await iterator.next();
		expect(first.done).toBe(false);
		expect(first.value).toMatchObject({ item_id: "openai_provider_tools_keepalive" });

		let timeout: ReturnType<typeof setTimeout> | undefined;
		const returned = await Promise.race([
			iterator.return!().then(result => ({ kind: "returned" as const, result })),
			new Promise<{ kind: "timeout" }>(resolve => {
				timeout = setTimeout(() => resolve({ kind: "timeout" }), 25);
			}),
		]);
		if (timeout) clearTimeout(timeout);

		expect(returned.kind).toBe("returned");
		expect(abortController.signal.aborted).toBe(true);
		expect(upstreamReturnCalled).toBe(true);
	});

	it("does not emit provider-tool-looking keepalive events into SDK Streams", async () => {
		async function* stalledEvents() {
			await new Promise(() => undefined);
		}

		const stream = wrapImageGenerationEventIterable(stalledEvents(), {
			interruptOnImageResult: false,
			keepaliveIntervalMs: 1,
		});
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const first = await Promise.race([
			stream[Symbol.asyncIterator]().next().then(result => ({ kind: "read" as const, result })),
			new Promise<{ kind: "timeout" }>(resolve => {
				timeout = setTimeout(() => resolve({ kind: "timeout" }), 25);
			}),
		]);
		if (timeout) clearTimeout(timeout);

		expect(first.kind).toBe("read");
		if (first.kind !== "read") return;
		expect(first.result.value).toMatchObject({
			type: "response.function_call_arguments.delta",
			item_id: "openai_provider_tools_keepalive",
			delta: "",
		});
		expect(JSON.stringify(first.result.value)).not.toContain("image_generation_call");
		expect(JSON.stringify(first.result.value)).not.toContain("web_search_call");
	});

	it("emits SDK keepalives on schedule even when provider yields non-progress events", async () => {
		async function* providerKeepalives() {
			for (;;) {
				await new Promise(resolve => setTimeout(resolve, 5));
				yield {
					type: "response.image_generation_call.generating",
					item_id: "ig-1",
				};
			}
		}

		const stream = wrapImageGenerationEventIterable(providerKeepalives(), {
			interruptOnImageResult: false,
			keepaliveIntervalMs: 20,
		});
		const iterator = stream[Symbol.asyncIterator]();
		let sawKeepalive = false;
		const deadline = Date.now() + 90;
		while (!sawKeepalive && Date.now() < deadline) {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const next = await Promise.race([
				iterator.next().then(result => ({ kind: "read" as const, result })),
				new Promise<{ kind: "timeout" }>(resolve => {
					timeout = setTimeout(() => resolve({ kind: "timeout" }), 15);
				}),
			]);
			if (timeout) clearTimeout(timeout);
			if (next.kind === "read" && !next.result.done) {
				sawKeepalive = next.result.value !== null && typeof next.result.value === "object" && !Array.isArray(next.result.value) && (next.result.value as Record<string, unknown>).item_id === "openai_provider_tools_keepalive";
			}
		}
		await iterator.return?.();

		expect(sawKeepalive).toBe(true);
	});


	it("does not throw when image_generation keepalive races with downstream cancellation", async () => {
		const originalFetch = globalThis.fetch;
		const uncaughtErrors: unknown[] = [];
		const onUncaught = (error: unknown) => {
			uncaughtErrors.push(error);
		};
		process.on("uncaughtException", onUncaught);
		try {
			globalThis.fetch = (async () => new Response(
				new ReadableStream<Uint8Array>(),
				{ headers: { "content-type": "text/event-stream" } },
			)) as typeof fetch;
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const extension = registerExtension({ initialActiveTools: ["read"] });
			const keepaliveImageModel = {
				...providerToolsImageModel,
				compat: {
					openaiProviderTools: {
						...providerToolsImageModel.compat.openaiProviderTools,
						imageGenerationKeepaliveIntervalMs: 1,
					},
				},
			};
			const ctx = context(cwd, homeDir, { model: keepaliveImageModel });
			const payload: Record<string, unknown> = { model: "gpt-5", input: "hello", stream: true };

			await runBeforeProvider(extension, payload, ctx, { requestModel: keepaliveImageModel });
			const response = await fetch("https://gateway.example.invalid/v1/responses", {
				method: "POST",
				body: JSON.stringify(payload),
			});
			const reader = response.body!.getReader();
			await new Promise(resolve => setTimeout(resolve, 5));
			await reader.cancel().catch(() => undefined);
			await new Promise(resolve => setTimeout(resolve, 5));

			expect(uncaughtErrors).toEqual([]);
		} finally {
			process.off("uncaughtException", onUncaught);
			globalThis.fetch = originalFetch;
		}
	});
	it("interrupts opt-in OpenAI Responses streams after an image_generation result event", async () => {
		const originalFetch = globalThis.fetch;
		try {
			const imageEvent = sseEvent({
				type: "response.output_item.done",
				item: { type: "image_generation_call", id: "ig-1", result: ONE_BY_ONE_PNG, output_format: "png" },
			});
			globalThis.fetch = (async () => new Response(
				sseEvent({ type: "response.created", response: { id: "resp-1" } }) +
				imageEvent +
				sseEvent({ type: "response.output_text.delta", delta: "SHOULD_NOT_PASS" }),
				{ headers: { "content-type": "text/event-stream" } },
			)) as typeof fetch;
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const extension = registerExtension({ initialActiveTools: ["read"] });
			const ctx = context(cwd, homeDir, { model: providerToolsInterruptImageModel });
			const payload: Record<string, unknown> = { model: "gpt-5", input: "hello", stream: true };

			await runBeforeProvider(extension, payload, ctx, { requestModel: providerToolsInterruptImageModel });
			const response = await fetch("https://gateway.example.invalid/v1/responses", {
				method: "POST",
				body: JSON.stringify(payload),
			});

			const text = await responseText(response);
			expect(text).toContain(imageEvent);
			expect(text).toContain("data: [DONE]");
			expect(text).not.toContain("SHOULD_NOT_PASS");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("interrupts each registered image_generation request when identical payloads are retried", async () => {
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = (async () => new Response(
				sseEvent({
					type: "response.output_item.done",
					item: { type: "image_generation_call", id: "ig-1", result: ONE_BY_ONE_PNG, output_format: "png" },
				}) +
				sseEvent({ type: "response.output_text.delta", delta: "SHOULD_NOT_PASS" }),
				{ headers: { "content-type": "text/event-stream" } },
			)) as typeof fetch;
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const extension = registerExtension({ initialActiveTools: ["read"] });
			const ctx = context(cwd, homeDir, { model: providerToolsInterruptImageModel });
			const payload: Record<string, unknown> = { model: "gpt-5", input: "hello", stream: true };

			await runBeforeProvider(extension, payload, ctx, { requestModel: providerToolsInterruptImageModel });
			await runBeforeProvider(extension, payload, ctx, { requestModel: providerToolsInterruptImageModel });

			const first = await responseText(await fetch("https://gateway.example.invalid/v1/responses", {
				method: "POST",
				body: JSON.stringify(payload),
			}));
			const second = await responseText(await fetch("https://gateway.example.invalid/v1/responses", {
				method: "POST",
				body: JSON.stringify(payload),
			}));

			expect(first).toContain("data: [DONE]");
			expect(first).not.toContain("SHOULD_NOT_PASS");
			expect(second).toContain("data: [DONE]");
			expect(second).not.toContain("SHOULD_NOT_PASS");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not interrupt image_generation streams without explicit experimental opt-in", async () => {
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = (async () => new Response(
				sseEvent({
					type: "response.output_item.done",
					item: { type: "image_generation_call", id: "ig-1", result: ONE_BY_ONE_PNG, output_format: "png" },
				}) +
				sseEvent({ type: "response.output_text.delta", delta: "SHOULD_PASS" }),
				{ headers: { "content-type": "text/event-stream" } },
			)) as typeof fetch;
			const cwd = await makeTempDir();
			const homeDir = await makeTempDir();
			const extension = registerExtension({ initialActiveTools: ["read"] });
			const ctx = context(cwd, homeDir, { model: providerToolsImageModel });
			const payload: Record<string, unknown> = { model: "gpt-5", input: "hello", stream: true };

			await runBeforeProvider(extension, payload, ctx, { requestModel: providerToolsImageModel });
			const response = await fetch("https://gateway.example.invalid/v1/responses", {
				method: "POST",
				body: JSON.stringify(payload),
			});

			const text = await responseText(response);
			expect(text).toContain("SHOULD_PASS");
			expect(text).not.toContain("data: [DONE]");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("registers a folded image renderer for provider image messages", () => {
		const extension = registerExtension();

		const renderer = extension.renderers.get("openai-provider-image-generation");
		expect(renderer).toBeDefined();
	});

	it("logs image save failures when visible messaging is unavailable", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const outputParentFile = path.join(cwd, "not-a-directory");
		const badOutputDir = path.join(outputParentFile, "images");
		await fs.writeFile(outputParentFile, "file blocks directory creation");
		const extension = registerExtension({ sendMessage: false });
		const ctx = context(cwd, homeDir, {
			model: imageModelWithOutput(badOutputDir),
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => path.join(cwd, "artifacts"),
			},
		});
		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello" }, ctx);

		await expect(runAgentEnd(extension, { message: imageGenerationMessage() }, ctx)).resolves.toBeUndefined();

		expect(extension.sentMessages).toHaveLength(0);
		expect(extension.warnings.join("\n")).toContain("OpenAI provider image result could not be saved");
	});
});
