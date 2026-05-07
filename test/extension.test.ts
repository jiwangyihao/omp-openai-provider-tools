import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import providerToolsExtension from "../src/extension";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

type RuntimeKind = "omp" | "pi" | "unknown";

const tempDirs: string[] = [];

const targetModel = {
	id: "gpt-5",
	name: "GPT 5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.example/v1",
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

function bothToolsConfig(): string {
	return providerConfig(`      web_search:
        enabled: true
      image_generation:
        enabled: true
`);
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

function registerExtension({ runtime = "omp", initialActiveTools = ["read", "web_search", "generate_image"] }: { runtime?: RuntimeKind; initialActiveTools?: any[] } = {}) {
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
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(next: any[]) {
			activeTools = next;
		},
		sendMessage(message: unknown, options?: unknown) {
			sentMessages.push({ message, options });
		},
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

	it("injects web_search into a matching Responses payload and does not set tool_choice", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		const extension = registerExtension();
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runBeforeProvider(extension, payload, context(cwd, homeDir));

		expect(payload.tools).toEqual([{ type: "web_search" }]);
		expect(payload).not.toHaveProperty("tool_choice");
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

		await runBeforeAgent(extension, context(cwd, homeDir));

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

	it("treats before-agent expected provider tools not covered by before-provider ensured tools as injection failure", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "omp", content: bothToolsConfig() });
		const extension = registerExtension();
		let aborted = false;
		const ctx = context(cwd, homeDir, { abort: () => { aborted = true; } });

		await runBeforeAgent(extension, ctx);
		expect(extension.activeTools()).toEqual(["read"]);
		await writeConfig({ cwd, runtime: "omp", content: webSearchOnlyConfig() });
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello" }, ctx);

		expect(aborted).toBe(true);
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
	});

	it("restores active tools and aborts when provider entry disappears after host-side removal", async () => {
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
		await runBeforeProvider(extension, { model: "gpt-5", input: "hello" }, ctx);

		expect(abortMessage).toContain("provider request no longer matched configured provider tools after host-side tool removal");
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(extension.warnings.join("\n")).toContain("provider request no longer matched configured provider tools after host-side tool removal");
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

		expect(abortMessage).toContain("provider request no longer matched configured provider tools after host-side tool removal");
		expect(extension.activeTools()).toEqual(["read", "web_search", "generate_image"]);
		expect(extension.warnings.join("\n")).toContain("provider request no longer matched configured provider tools after host-side tool removal");
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
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runBeforeProvider(extension, payload, context(cwd, homeDir));

		expect(payload.tools).toEqual([{ type: "web_search" }]);
	});

	it("loads Pi config, warns for unknown runtime identity, and injects when provider match succeeds", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		await writeConfig({ cwd, runtime: "pi", content: webSearchOnlyConfig() });
		const extension = registerExtension({ runtime: "unknown" });
		const payload: Record<string, unknown> = { model: "gpt-5", input: "hello" };

		await runBeforeProvider(extension, payload, context(cwd, homeDir));

		expect(payload.tools).toEqual([{ type: "web_search" }]);
		expect(extension.warnings.join("\n")).toContain("runtime identity is unknown");
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
});
