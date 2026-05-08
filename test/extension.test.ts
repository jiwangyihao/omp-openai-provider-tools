import { afterEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import providerToolsExtension from "../src/extension";

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
	};
	providerToolsExtension(api);
	return { activeTools: () => activeTools, handlers, label: () => label, sentMessages, warnings };
}

function getHandler(extension: ReturnType<typeof registerExtension>, name: string): Handler {
	const handler = extension.handlers.get(name)?.[0];
	if (!handler) throw new Error(`${name} handler missing`);
	return handler;
}

function context(cwd: string, homeDir: string, overrides: Record<string, unknown> = {}) {
	return { cwd, homeDir, model: targetModel, ...overrides };
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

function webSearchMessage() {
	return {
		providerPayload: {
			type: "openaiResponsesHistory",
			items: [
				{
					type: "web_search_call",
					id: "ws-1",
					status: "completed",
					action: { type: "search", query: "latest OMP provider tools" },
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
		expect(extension.sentMessages.some(({ message }) => String((message as any).content ?? message).includes("active host-side tools remain"))).toBe(true);
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
		expect(extension.sentMessages.some(({ message }) => String((message as any).content ?? message).includes("active tool control API is unavailable"))).toBe(true);
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
		expect(extension.sentMessages.some(({ message }) => String((message as any).content ?? message).includes("provider request was not observed after host-side tool removal"))).toBe(true);
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

	it("echoes provider-native web_search results as a visible custom message", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			sessionManager: {
				getSessionId: () => "session-1",
			},
		});

		getHandler(extension, "message_end")({ type: "message_end", message: webSearchMessage() }, ctx);

		expect(extension.sentMessages).toHaveLength(1);
		expect(extension.sentMessages[0]?.options).toEqual({ deliverAs: "nextTurn" });
		const message = extension.sentMessages[0]?.message as any;
		expect(message.display).toBe(true);
		expect(message.customType).toBe("openai-provider-tool-result");
		expect(message.content).toContain("web_search");
		expect(message.content).toContain("latest OMP provider tools");
		expect(message.content).toContain("https://example.invalid/omp-provider-tools");
		expect(message.content).not.toContain("OMP provider tools are available.");
	});

	it("deduplicates provider-native web_search echoes across message_end and agent_end", async () => {
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
		await runAgentEnd(extension, { message }, ctx);

		expect(extension.sentMessages).toHaveLength(1);
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
		expect(extension.sentMessages[0]?.options).toEqual({ deliverAs: "followUp" });
		const message = extension.sentMessages[0]?.message as any;
		expect(message.display).toBe(true);
		expect(message.customType).toBe("openai-provider-image-generation");
		expect(message.content).toContain(path.join(artifactsDir, files[0] ?? ""));
		expect(message.content).not.toContain(ONE_BY_ONE_PNG);
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
		expect(message.content).toContain(path.join(artifactsDir, files[0] ?? ""));
		expect(message.content).not.toContain(ONE_BY_ONE_PNG);
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
		expect(message.content).toContain(path.join(artifactsDir, files[0] ?? ""));
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
		expect(savedMessage.content).toContain(path.join(badOutputDir, files[0] ?? ""));
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
		expect(savedMessage.content).toContain(path.join(artifactsDir, files[0] ?? ""));
		expect(savedMessage.content).not.toContain(ONE_BY_ONE_PNG);
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
		expect(message.content).toContain(outputDir);
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
		expect(secondMessage.content).toContain(artifactsDir);
		expect(secondMessage.content).not.toContain(outputDir);
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
		expect(secondMessage.content).toContain(artifactsDir);
		expect(secondMessage.content).not.toContain(outputDir);
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
		expect(message.content).toContain(defaultDir);
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
		expect(message.content).toContain(piDefaultDir);
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
