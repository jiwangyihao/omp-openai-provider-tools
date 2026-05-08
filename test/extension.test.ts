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
	baseUrl: "https://api.openai.example/v1",
};

const imageCapableModel = {
	...targetModel,
	compat: {
		extraBody: {
			openai_provider_tools: {
				image_generation: true,
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

function providerConfig(tools: string): string {
	return `version: 1
providers:
  - name: target-provider
    match:
      api: openai-responses
      provider: openai
      modelId: gpt-5
    tools:
${tools}`;
}

async function writeConfig({ cwd, homeDir, runtime, content }: { cwd: string; homeDir?: string; runtime: "omp" | "pi"; content: string }) {
	const root = homeDir ? path.join(homeDir, `.${runtime}`, "agent") : path.join(cwd, `.${runtime}`);
	await fs.mkdir(root, { recursive: true });
	await fs.writeFile(path.join(root, "openai-provider-tools.yml"), content);
}

function webSearchOnlyConfig(): string {
	return providerConfig(`      web_search:
        enabled: true
`);
}

function imageOnlyConfig(): string {
	return providerConfig(`      image_generation:
        enabled: true
`);
}

function imageConfigWithOutput(directory: string): string {
	return `${providerConfig(`      image_generation:
        enabled: true
`)}    output:
      directory: ${JSON.stringify(directory)}
`;
}

function bothToolsConfig(): string {
	return providerConfig(`      web_search:
        enabled: true
      image_generation:
        enabled: true
`);
}

function mismatchedRequestScopedProviderConfig(): string {
	return `version: 1
providers:
  - name: context-provider
    match:
      api: openai-responses
      provider: openai
      modelId: gpt-5
    tools:
      web_search:
        enabled: true
      image_generation:
        enabled: true
  - name: request-provider
    match:
      api: openai-responses
      provider: other
      modelId: other-model
    tools:
      web_search:
        enabled: true
`;
}

function crossTargetBothToolsConfig(): string {
	return `version: 1
providers:
  - name: context-provider
    match:
      api: openai-responses
      provider: openai
      modelId: gpt-5
    tools:
      web_search:
        enabled: true
      image_generation:
        enabled: true
  - name: request-provider
    match:
      api: openai-responses
      provider: other
      modelId: other-model
    tools:
      web_search:
        enabled: true
      image_generation:
        enabled: true
`;
}

function noEnabledToolsConfig(): string {
	return providerConfig(`      web_search:
        enabled: false
      image_generation: {}
`);
}

function noMatchingProviderConfig(): string {
	return `version: 1
providers:
  - name: other-provider
    match:
      api: openai-responses
      provider: other
      modelId: other-model
    tools:
      web_search:
        enabled: true
`;
}

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

	it("does not inject or remove active tools when no config exists", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const extension = registerExtension();
		const ctx = context(cwd, homeDir);
		const payload = { model: "gpt-5", input: "hello" };

		await runBeforeAgent(extension, ctx);
		await runBeforeProvider(extension, payload, ctx);

		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(payload).toEqual({ model: "gpt-5", input: "hello" });
	});
	it("does not remove host-side tools or inject for chat-completions context even when model identity matches", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: { ...targetModel, api: "chat-completions" },
		});
		const chatPayload: Record<string, unknown> = { model: "gpt-5", messages: [{ role: "user", content: "hello" }] };

		await runBeforeAgent(extension, ctx);
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		await runBeforeProvider(extension, chatPayload, ctx);

		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(chatPayload.tools).toBeUndefined();
	});

	it("does not remove host tools or inject when matching model identity lacks explicit Responses api", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: { id: targetModel.id, name: targetModel.name, provider: targetModel.provider, baseUrl: targetModel.baseUrl },
		});
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runBeforeAgent(extension, ctx);
		await runBeforeProvider(extension, payload, ctx);

		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(payload.tools).toBeUndefined();
	});
	it("does not inject request-scoped Responses tools when matching host-side tools remain active", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: { id: targetModel.id, name: targetModel.name, provider: targetModel.provider, baseUrl: targetModel.baseUrl },
		});
		const requestModel = { ...targetModel };
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };
		await runSessionStart(extension, ctx);

		await runBeforeProvider(extension, payload, ctx, { requestModel });

		expect(payload.tools).toBeUndefined();
		expect(extension.warnings.join("\n")).toContain("active host-side tools remain");
		expect(extension.sentMessages.some(({ message }) => String((message as any).content ?? message).includes("active host-side tools remain"))).toBe(true);
	});
	it("injects request-scoped Responses tools when matching host-side tools are already inactive", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
		const ctx = context(cwd, homeDir, {
			model: { id: targetModel.id, name: targetModel.name, provider: targetModel.provider, baseUrl: targetModel.baseUrl },
		});
		const requestModel = { ...targetModel };
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };
		await runSessionStart(extension, ctx);

		await runBeforeProvider(extension, payload, ctx, { requestModel });

		expect(payload.tools).toEqual([{ type: "web_search" }]);
		expect(payload).not.toHaveProperty("tool_choice");
	});

	it("does not inject image_generation unless the request model opts in", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: imageOnlyConfig() });
		const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
		const ctx = context(cwd, homeDir);
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		await runBeforeAgent(extension, ctx);
		await runBeforeProvider(extension, payload, ctx, { requestModel: targetModel });

		expect(extension.activeTools()).toEqual(["read", "generate_image"]);
		expect(payload.tools).toBeUndefined();
	});

	it("injects image_generation when the request model opts in", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: imageOnlyConfig() });
		const extension = registerExtension({ initialActiveTools: ["read"] });
		const ctx = context(cwd, homeDir, { model: imageCapableModel });
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, payload, ctx, { requestModel: imageCapableModel });

		expect(payload.tools).toEqual([{ type: "image_generation" }]);
	});

	it("injects image_generation when opt-in marker is numeric one", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: imageOnlyConfig() });
		const extension = registerExtension({ initialActiveTools: ["read"] });
		const numericOptInModel = {
			...targetModel,
			compat: {
				extraBody: {
					openai_provider_tools_image_generation: 1,
				},
			},
		};
		const ctx = context(cwd, homeDir, { model: numericOptInModel });
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, payload, ctx, { requestModel: numericOptInModel });

		expect(payload.tools).toEqual([{ type: "image_generation" }]);
	});

	it("restores and aborts when request model loses image_generation opt-in after host-side removal", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: imageOnlyConfig() });
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
		expect(extension.activeTools()).toEqual(["read", "web_search"]);
		await runBeforeProvider(extension, payload, ctx, { requestModel: targetModel });

		expect(abortMessage).toContain("enabled fewer provider tools");
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(payload.tools).toBeUndefined();
	});
	it("mutates request-scoped provider payload synchronously when host tools are inactive", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension({ initialActiveTools: ["read"] });
		const ctx = context(cwd, homeDir, {
			model: { id: targetModel.id, name: targetModel.name, provider: targetModel.provider, baseUrl: targetModel.baseUrl },
		});
		const requestModel = { ...targetModel };
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		const result = getHandler(extension, "before_provider_request")(
			{ type: "before_provider_request", payload, requestModel },
			ctx,
		);

		expect(payload.tools).toEqual([{ type: "web_search" }]);
		await result;
	});
	it("does not inject request-scoped tools when active tool inspection is asynchronous", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension({
			getActiveTools: () => Promise.resolve(["read"]),
		});
		const ctx = context(cwd, homeDir, {
			model: { id: targetModel.id, name: targetModel.name, provider: targetModel.provider, baseUrl: targetModel.baseUrl },
		});
		const requestModel = { ...targetModel };
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		const result = getHandler(extension, "before_provider_request")(
			{ type: "before_provider_request", payload, requestModel },
			ctx,
		);

		expect(payload.tools).toBeUndefined();
		await result;
		expect(payload.tools).toBeUndefined();
		expect(extension.warnings.join("\n")).toContain("active tool inspection is asynchronous");
	});

	it("consumes rejected asynchronous active tool inspection", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension({
			getActiveTools: () => Promise.reject(new Error("boom")),
		});
		const ctx = context(cwd, homeDir, {
			model: { id: targetModel.id, name: targetModel.name, provider: targetModel.provider, baseUrl: targetModel.baseUrl },
		});
		const requestModel = { ...targetModel };
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		const result = getHandler(extension, "before_provider_request")(
			{ type: "before_provider_request", payload, requestModel },
			ctx,
		);

		expect(payload.tools).toBeUndefined();
		await result;
		await Promise.resolve();
		expect(payload.tools).toBeUndefined();
		expect(extension.warnings.join("\n")).toContain("OpenAI provider tools active tool inspection failed: boom");
	});
	it("does not inject request-scoped Responses tools when active tool API is unavailable", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension({ activeToolMethods: false });
		const ctx = context(cwd, homeDir, {
			model: { id: targetModel.id, name: targetModel.name, provider: targetModel.provider, baseUrl: targetModel.baseUrl },
		});
		const requestModel = { ...targetModel };
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };
		await runSessionStart(extension, ctx);

		await runBeforeProvider(extension, payload, ctx, { requestModel });

		expect(payload.tools).toBeUndefined();
		expect(extension.warnings.join("\n")).toContain("active tool control API is unavailable");
		expect(extension.sentMessages.some(({ message }) => String((message as any).content ?? message).includes("active tool control API is unavailable"))).toBe(true);
	});

	it("does not inject image_generation when matching model identity lacks explicit Responses api", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: imageOnlyConfig() });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: { id: targetModel.id, name: targetModel.name, provider: targetModel.provider, baseUrl: targetModel.baseUrl },
		});
		const payload: Record<string, unknown> = { model: "gpt-5", input: "create image" };

		await runBeforeAgent(extension, ctx);
		await runBeforeProvider(extension, payload, ctx);

		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(payload.tools).toBeUndefined();
	});

	it("injects web_search into a matching Responses payload and does not set tool_choice", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir);
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, payload, ctx);

		expect(payload.tools).toEqual([{ type: "web_search" }]);
		expect(payload).not.toHaveProperty("tool_choice");
	});

	it("mutates provider payload synchronously after config is preloaded", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension({ initialActiveTools: [] });
		const ctx = context(cwd, homeDir);
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		const result = getHandler(extension, "before_provider_request")(
			{ type: "before_provider_request", payload },
			ctx,
		);

		expect(payload.tools).toEqual([{ type: "web_search" }]);
		await result;
	});

	it("removes only host-side web_search when only web search provider tool is enabled", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();

		await runBeforeAgent(extension, context(cwd, homeDir));

		expect(extension.activeTools()).toEqual(["read", "generate_image"]);
	});

	it("removes only host-side generate_image when only image generation provider tool is enabled", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: imageOnlyConfig() });
		const extension = registerExtension();

		await runBeforeAgent(extension, context(cwd, homeDir, { model: imageCapableModel }));

		expect(extension.activeTools()).toEqual(["read", "web_search"]);
	});

	it("removes and injects nothing when a matching config has no enabled provider tools", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: noEnabledToolsConfig() });
		const extension = registerExtension();
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runBeforeAgent(extension, context(cwd, homeDir));
		await runBeforeProvider(extension, payload, context(cwd, homeDir));

		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(payload.tools).toBeUndefined();
	});

	it("restores active tools and aborts when payload.tools is non-array after host-side removal", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		let aborted = false;
		const ctx = context(cwd, homeDir, { abort: () => { aborted = true; } });

		await runBeforeAgent(extension, ctx);
		expect(extension.activeTools()).toEqual(["read", "generate_image"]);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello", tools: "bad" }, ctx);

		expect(aborted).toBe(true);
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
	});

	it("aborts synchronously when injection fails after host-side removal", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		let setActiveToolsCalls = 0;
		const extension = registerExtension({
			setActiveTools() {
				setActiveToolsCalls++;
				if (setActiveToolsCalls === 1) return undefined;
				return new Promise(() => {});
			},
		});
		let abortMessage = "";
		const ctx = context(cwd, homeDir, {
			abort: (message: string) => {
				abortMessage = message;
			},
		});

		await runBeforeAgent(extension, ctx);
		const result = getHandler(extension, "before_provider_request")(
			{ type: "before_provider_request", payload: { model: "gpt-5", input: "hello", tools: "bad" } },
			ctx,
		);

		expect(setActiveToolsCalls).toBe(2);
		expect(abortMessage).toContain("OpenAI Responses payload tools field must be an array");
		void result;
	});

	it("restores active tools and warns when injection fails without abort support", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir);

		await runBeforeAgent(extension, ctx);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello", tools: "bad" }, ctx);

		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(extension.warnings.join("\n")).toContain("provider tools");
	});

	it("uses preloaded config when the config file changes before provider request", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: bothToolsConfig() });
		const extension = registerExtension();
		let aborted = false;
		const ctx = context(cwd, homeDir, { model: imageCapableModel, abort: () => { aborted = true; } });

		await runBeforeAgent(extension, ctx);
		expect(extension.activeTools()).toEqual(["read"]);
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };
		await runBeforeProvider(extension, payload, ctx);

		expect(aborted).toBe(false);
		expect(payload.tools).toEqual([{ type: "web_search" }, { type: "image_generation" }]);
		expect(extension.activeTools()).toEqual(["read"]);
	});

	it("uses the preloaded provider entry when the config file changes before provider request", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		let abortMessage = "";
		const ctx = context(cwd, homeDir, {
			abort: (message: string) => {
				abortMessage = message;
			},
		});

		await runBeforeAgent(extension, ctx);
		expect(extension.activeTools()).toEqual(["read", "generate_image"]);
		await writeConfig({ cwd, runtime: "omp", content: noMatchingProviderConfig() });
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };
		await runBeforeProvider(extension, payload, ctx);

		expect(abortMessage).toBe("");
		expect(payload.tools).toEqual([{ type: "web_search" }]);
		expect(extension.activeTools()).toEqual(["read", "generate_image"]);
	});

	it("clears cached config before a failed lifecycle reload", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir);
		const firstPayload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, firstPayload, ctx);
		expect(firstPayload.tools).toEqual([{ type: "web_search" }]);

		await writeConfig({ cwd, runtime: "omp", content: "version: 1\nproviders: invalid\n" });
		const rejectingCtx = context(cwd, homeDir, {
			ui: {
				notify: () => Promise.reject(new Error("notify failed")),
			},
		});
		await expect(runSessionStart(extension, rejectingCtx)).rejects.toThrow("notify failed");
		const secondPayload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runBeforeProvider(extension, secondPayload, rejectingCtx);
		expect(secondPayload.tools).toBeUndefined();
	});

	it("clears incompatible targets on session_start so a later before-agent can remove host tools", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, { abort: () => {} });

		await runBeforeAgent(extension, ctx);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello", tools: "bad" }, ctx);
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);

		await runSessionStart(extension, ctx);
		await runBeforeAgent(extension, ctx);

		expect(extension.activeTools()).toEqual(["read", "generate_image"]);
	});

	it("restores and warns on agent_end when no provider request follows host-side removal", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir);

		await runBeforeAgent(extension, ctx);
		expect(extension.activeTools()).toEqual(["read", "generate_image"]);
		await runAgentEnd(extension, { message: { content: "done" } }, ctx);

		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(extension.warnings.join("\n")).toContain("provider request was not observed after host-side tool removal");
		expect(extension.sentMessages.some(({ message }) => String((message as any).content ?? message).includes("provider request was not observed after host-side tool removal"))).toBe(true);
	});

	it("warns and marks target incompatible when active tool APIs are unavailable", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension({ activeToolMethods: false });
		const ctx = context(cwd, homeDir);
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runBeforeAgent(extension, ctx);
		await runBeforeProvider(extension, payload, ctx);

		expect(payload.tools).toBeUndefined();
		expect(extension.warnings.join("\n")).toContain("active tool control API is unavailable");
		expect(extension.sentMessages.some(({ message }) => String((message as any).content ?? message).includes("active tool control API is unavailable"))).toBe(true);
	});

	it("warns and marks target incompatible when active tool removal fails", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension({ setActiveTools: () => { throw new Error("boom"); } });
		const ctx = context(cwd, homeDir);
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runBeforeAgent(extension, ctx);
		await runBeforeProvider(extension, payload, ctx);

		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(payload.tools).toBeUndefined();
		expect(extension.warnings.join("\n")).toContain("active tool removal failed");
		expect(extension.sentMessages.some(({ message }) => String((message as any).content ?? message).includes("active tool removal failed"))).toBe(true);
	});

	it("restores and aborts when request-scoped target injects fewer provider tools than a pending removal expected", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: mismatchedRequestScopedProviderConfig() });
		const extension = registerExtension();
		let abortMessage = "";
		const ctx = context(cwd, homeDir, {
			model: imageCapableModel,
			abort: (message: string) => {
				abortMessage = message;
			},
		});
		const requestModel = { ...targetModel, id: "other-model", provider: "other" };
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runBeforeAgent(extension, ctx);
		expect(extension.activeTools()).toEqual(["read"]);
		await runBeforeProvider(extension, payload, ctx, { requestModel });

		expect(abortMessage).toContain("provider request target differed after host-side tool removal");
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(payload.tools).toBeUndefined();
	});

	it("restores and aborts when a different request target could inject the same tools as a pending removal", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: crossTargetBothToolsConfig() });
		const extension = registerExtension();
		let abortMessage = "";
		const ctx = context(cwd, homeDir, {
			model: imageCapableModel,
			abort: (message: string) => {
				abortMessage = message;
			},
		});
		const requestModel = { ...imageCapableModel, id: "other-model", provider: "other" };
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runBeforeAgent(extension, ctx);
		expect(extension.activeTools()).toEqual(["read"]);
		await runBeforeProvider(extension, payload, ctx, { requestModel });

		expect(abortMessage).toContain("provider request target differed after host-side tool removal");
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(payload.tools).toBeUndefined();
		expect(extension.warnings.join("\n")).toContain("provider request target differed after host-side tool removal");
	});

	it("restores and aborts before returning for an incompatible different request target", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: crossTargetBothToolsConfig() });
		const extension = registerExtension();
		let abortMessage = "";
		const ctxA = context(cwd, homeDir, {
			model: imageCapableModel,
			abort: (message: string) => {
				abortMessage = message;
			},
		});
		const ctxB = context(cwd, homeDir, {
			model: { ...imageCapableModel, id: "other-model", provider: "other" },
			abort: (message: string) => {
				abortMessage = message;
			},
		});

		await runBeforeAgent(extension, ctxB);
		await runBeforeProvider(extension, { model: "other-model", input: "hello", tools: "bad" }, ctxB);
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		abortMessage = "";

		await runBeforeAgent(extension, ctxA);
		expect(extension.activeTools()).toEqual(["read"]);
		await runBeforeProvider(extension, { model: "other-model", input: "hello" }, ctxB);

		expect(abortMessage).toContain("provider request target differed after host-side tool removal");
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
	});

	it("restores and aborts when payload and context mismatch after host-side removal", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		let abortMessage = "";
		const ctx = context(cwd, homeDir, {
			abort: (message: string) => {
				abortMessage = message;
			},
		});
		const payload: Record<string, unknown> = { model: "other-model", input: "hello" };

		await runBeforeAgent(extension, ctx);
		expect(extension.activeTools()).toEqual(["read", "generate_image"]);
		await runBeforeProvider(extension, payload, ctx);

		expect(abortMessage).toContain("provider request target could not be verified after host-side tool removal");
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(payload.tools).toBeUndefined();
	});

	it("restores active tools and aborts when request-scoped model changes target after host-side removal", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		let abortMessage = "";
		const ctx = context(cwd, homeDir, {
			abort: (message: string) => {
				abortMessage = message;
			},
		});
		const requestModel = { ...targetModel, id: "other-model", provider: "other" };

		await runBeforeAgent(extension, ctx);
		expect(extension.activeTools()).toEqual(["read", "generate_image"]);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello" }, ctx, { requestModel });

		expect(abortMessage).toContain("provider request target differed after host-side tool removal");
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(extension.warnings.join("\n")).toContain("provider request target differed after host-side tool removal");
	});

	it("does not inject when payload and context model mismatch", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		const payload: Record<string, unknown> = { model: "other-model", input: "hello" };

		await runBeforeProvider(extension, payload, context(cwd, homeDir));

		expect(payload.tools).toBeUndefined();
	});

	it("loads Pi config and injects when fake Pi runtime metadata is present", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "pi", content: webSearchOnlyConfig() });
		const extension = registerExtension({ runtime: "pi" });
		const ctx = context(cwd, homeDir);
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, payload, ctx);

		expect(payload.tools).toEqual([{ type: "web_search" }]);
	});

	it("loads Pi config, visibly warns for unknown runtime identity, and injects when provider match succeeds", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "pi", content: webSearchOnlyConfig() });
		const extension = registerExtension({ runtime: "unknown" });
		const ctx = context(cwd, homeDir);
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, payload, ctx);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello" }, ctx);

		expect(payload.tools).toEqual([{ type: "web_search" }]);
		expect(extension.warnings.join("\n")).toContain("runtime identity is unknown");
		expect(extension.sentMessages.filter(({ message }) => String((message as any).content ?? message).includes("runtime identity is unknown"))).toHaveLength(1);
	});

	it("does not remove host-side tools on the next before-agent for a target marked incompatible", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, { abort: () => {} });

		await runBeforeAgent(extension, ctx);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello", tools: "bad" }, ctx);
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);

		await runBeforeAgent(extension, ctx);

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
		expect(extension.sentMessages[0]?.options).toEqual({ deliverAs: "nextTurn" });
		const message = extension.sentMessages[0]?.message as any;
		expect(message.display).toBe(true);
		expect(message.customType).toBe("openai-provider-image-generation");
		expect(message.content).toContain(path.join(artifactsDir, files[0] ?? ""));
		expect(message.content).not.toContain(ONE_BY_ONE_PNG);
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
		await writeConfig({ cwd, runtime: "omp", content: imageConfigWithOutput(badOutputDir) });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: imageCapableModel,
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
		await writeConfig({ cwd, runtime: "omp", content: imageConfigWithOutput(outputDir) });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: imageCapableModel,
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
		await writeConfig({ cwd, runtime: "omp", content: imageConfigWithOutput(outputDir) });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: imageCapableModel,
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
		await writeConfig({ cwd, runtime: "omp", content: imageConfigWithOutput(outputDir) });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: imageCapableModel,
			sessionManager: {
				getSessionId: () => "session-1",
				getArtifactsDir: () => artifactsDir,
			},
		});

		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello" }, ctx);
		await runAgentEnd(extension, { message: imageGenerationMessage("img-1") }, ctx);
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		await runSessionStart(extension, ctx);
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello" }, ctx);
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

	it("sends a visible error message when saving an image result fails", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const outputParentFile = path.join(cwd, "not-a-directory");
		const badOutputDir = path.join(outputParentFile, "images");
		await fs.writeFile(outputParentFile, "file blocks directory creation");
		await writeConfig({ cwd, runtime: "omp", content: imageConfigWithOutput(badOutputDir) });
		const extension = registerExtension();
		const ctx = context(cwd, homeDir, {
			model: imageCapableModel,
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
		await writeConfig({ cwd, runtime: "omp", content: imageConfigWithOutput(badOutputDir) });
		const extension = registerExtension({ sendMessage: false });
		const ctx = context(cwd, homeDir, {
			model: imageCapableModel,
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
