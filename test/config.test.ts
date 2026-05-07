import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	detectRuntimeKind,
	expandHome,
	getConfigPaths,
	loadAvailableProviderToolsConfig,
	loadProviderToolsConfig,
	validateProviderToolsConfig,
} from "../src/config";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-provider-config-"));
	tempDirs.push(dir);
	return dir;
}

async function writeConfig(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf8");
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function validConfig(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		providers: [
			{
				name: "official-openai",
				match: {
					api: "openai-responses",
					provider: "openai",
					baseUrl: { host: "api.openai.com" },
				},
				tools: {
					web_search: { enabled: true, search_context_size: "high" },
					image_generation: {
						enabled: true,
						output_format: "png",
						quality: "auto",
						background: "auto",
						action: "generate",
					},
				},
				output: { directory: "~/provider-tool-images" },
			},
		],
		...overrides,
	};
}

describe("provider tools config validation", () => {
	it("accepts a valid version 1 config with OpenAI Responses provider tools", () => {
		const result = validateProviderToolsConfig(validConfig());

		expect(result.ok).toBe(true);
		expect(result.warnings).toEqual([]);
		expect(result.config?.providers[0]).toMatchObject({
			name: "official-openai",
			match: { api: "openai-responses", provider: "openai", baseUrl: { host: "api.openai.com" } },
			tools: {
				web_search: { enabled: true, search_context_size: "high" },
				image_generation: { enabled: true, output_format: "png" },
			},
		});
	});

	it.each([
		["invalid version", { ...validConfig(), version: 2 }, "version"],
		["non-array providers", { ...validConfig(), providers: {} }, "providers"],
		["missing provider name", { ...validConfig(), providers: [{ ...validConfig().providers[0], name: undefined }] }, "name"],
		["missing match", { ...validConfig(), providers: [{ ...validConfig().providers[0], match: undefined }] }, "match"],
		[
			"non Responses API",
			{ ...validConfig(), providers: [{ ...validConfig().providers[0], match: { api: "chat-completions" } }] },
			"openai-responses",
		],
		["missing tools", { ...validConfig(), providers: [{ ...validConfig().providers[0], tools: undefined }] }, "tools"],
	])("rejects %s", (_name, input, expectedWarning) => {
		const result = validateProviderToolsConfig(input);

		expect(result.ok).toBe(false);
		expect(result.config).toBeUndefined();
		expect(result.warnings.join("\n")).toContain(expectedWarning);
	});

	it("rejects unknown top-level, provider, match, and tool fields with warnings", () => {
		const base = validConfig();
		const result = validateProviderToolsConfig({
			...base,
			unexpected: true,
			providers: [
				{
					...base.providers[0],
					providerExtra: true,
					match: { ...base.providers[0].match, extraMatch: true },
					tools: { web_search: { enabled: true, unexpectedToolField: true } },
				},
			],
		});

		expect(result.ok).toBe(false);
		expect(result.warnings.join("\n")).toContain("unknown top-level field");
		expect(result.warnings.join("\n")).toContain("unknown provider field");
		expect(result.warnings.join("\n")).toContain("unknown match field");
		expect(result.warnings.join("\n")).toContain("unknown tool field");
	});

	it.each([
		["missing selector", {}],
		["multiple selectors", { equals: "https://api.openai.com/v1", prefix: "https://api.openai.com" }],
		["unknown selector", { path: "/v1" }],
	])("rejects baseUrl with %s", (_name, baseUrl) => {
		const base = validConfig();
		const result = validateProviderToolsConfig({
			...base,
			providers: [{ ...base.providers[0], match: { ...base.providers[0].match, baseUrl } }],
		});

		expect(result.ok).toBe(false);
		expect(result.warnings.join("\n")).toContain("baseUrl");
	});

	it.each([
		["web_search", "search_context_size", "maximum"],
		["image_generation", "output_format", "gif"],
		["image_generation", "quality", "ultra"],
		["image_generation", "background", "checkerboard"],
		["image_generation", "action", "inpaint"],
	])("rejects invalid %s parameter %s", (toolName, field, value) => {
		const base = validConfig();
		const result = validateProviderToolsConfig({
			...base,
			providers: [
				{
					...base.providers[0],
					tools: { [toolName]: { enabled: true, [field]: value } },
				},
			],
		});

		expect(result.ok).toBe(false);
		expect(result.warnings.join("\n")).toContain(String(field));
	});
});

describe("provider tools config paths and loading", () => {
	it("expands home directories", () => {
		expect(expandHome("~/provider-tool-images", "/home/example")).toBe(path.join("/home/example", "provider-tool-images"));
		expect(expandHome("/tmp/provider-tool-images", "/home/example")).toBe("/tmp/provider-tool-images");
	});

	it("returns OMP and Pi user/project config paths", () => {
		const cwd = path.join("workspace", "project");
		const homeDir = path.join("home", "agent");

		expect(getConfigPaths({ cwd, homeDir, runtime: "omp" })).toMatchObject({
			project: path.join(cwd, ".omp", "openai-provider-tools.yml"),
			user: path.join(homeDir, ".omp", "agent", "openai-provider-tools.yml"),
		});
		expect(getConfigPaths({ cwd, homeDir, runtime: "pi" })).toMatchObject({
			project: path.join(cwd, ".pi", "openai-provider-tools.yml"),
			user: path.join(homeDir, ".pi", "agent", "openai-provider-tools.yml"),
		});
	});

	it("merges project providers before user providers for OMP and normalizes output.directory", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const paths = getConfigPaths({ cwd, homeDir, runtime: "omp" });
		await writeConfig(paths.project, `version: 1\nproviders:\n  - name: project\n    match:\n      api: openai-responses\n    tools:\n      web_search:\n        enabled: true\n    output:\n      directory: ~/project-images\n`);
		await writeConfig(paths.user, `version: 1\nproviders:\n  - name: user\n    match:\n      api: openai-responses\n    tools:\n      image_generation:\n        enabled: true\n`);

		const loaded = await loadProviderToolsConfig({ cwd, homeDir, runtime: "omp" });

		expect(loaded.config.providers.map((provider) => provider.name)).toEqual(["project", "user"]);
		expect(loaded.config.providers[0].output?.directory).toBe(path.join(homeDir, "project-images"));
		expect(loaded.warnings).toEqual([]);
	});

	it("reads Pi config paths for Pi runtime", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const piPaths = getConfigPaths({ cwd, homeDir, runtime: "pi" });
		const ompPaths = getConfigPaths({ cwd, homeDir, runtime: "omp" });
		await writeConfig(piPaths.user, `version: 1\nproviders:\n  - name: pi-user\n    match:\n      api: openai-responses\n    tools:\n      web_search:\n        enabled: true\n`);
		await writeConfig(ompPaths.user, `version: 1\nproviders:\n  - name: omp-user\n    match:\n      api: openai-responses\n    tools:\n      web_search:\n        enabled: true\n`);

		const loaded = await loadProviderToolsConfig({ cwd, homeDir, runtime: "pi" });

		expect(loaded.config.providers.map((provider) => provider.name)).toEqual(["pi-user"]);
	});

	it("skips malformed YAML and invalid config with warnings", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const paths = getConfigPaths({ cwd, homeDir, runtime: "omp" });
		await writeConfig(paths.project, `version: 1\nproviders:\n  - name: [broken\n`);
		await writeConfig(paths.user, `version: 2\nproviders: []\n`);

		const loaded = await loadProviderToolsConfig({ cwd, homeDir, runtime: "omp" });

		expect(loaded.config).toEqual({ version: 1, providers: [] });
		expect(loaded.warnings.join("\n")).toContain("failed to parse");
		expect(loaded.warnings.join("\n")).toContain("version");
	});

	it("loads all available configs in deterministic order for unknown runtime", async () => {
		const cwd = await makeTempDir();
		const homeDir = await makeTempDir();
		const ompPaths = getConfigPaths({ cwd, homeDir, runtime: "omp" });
		const piPaths = getConfigPaths({ cwd, homeDir, runtime: "pi" });
		await writeConfig(piPaths.project, `version: 1\nproviders:\n  - name: pi-project\n    match: { api: openai-responses }\n    tools: { web_search: { enabled: true } }\n`);
		await writeConfig(ompPaths.project, `version: 1\nproviders:\n  - name: omp-project\n    match: { api: openai-responses }\n    tools: { web_search: { enabled: true } }\n`);
		await writeConfig(piPaths.user, `version: 1\nproviders:\n  - name: pi-user\n    match: { api: openai-responses }\n    tools: { web_search: { enabled: true } }\n`);
		await writeConfig(ompPaths.user, `version: 1\nproviders:\n  - name: omp-user\n    match: { api: openai-responses }\n    tools: { web_search: { enabled: true } }\n`);

		const loaded = await loadAvailableProviderToolsConfig({ cwd, homeDir, runtime: "unknown" });

		expect(loaded.config.providers.map((provider) => provider.name)).toEqual([
			"pi-project",
			"omp-project",
			"pi-user",
			"omp-user",
		]);
		expect(loaded.warnings.join("\n")).toContain("runtime identity");
	});
});

describe("runtime detection", () => {
	it("detects explicit Pi runtime", () => {
		expect(detectRuntimeKind({ runtime: { name: "pi" } }, {})).toBe("pi");
	});

	it.each(["oh-my-pi", "omp"])("detects OMP runtime metadata %s", (name) => {
		expect(detectRuntimeKind({ runtime: { name } }, {})).toBe("omp");
	});

	it("detects capability metadata without guessing unknown as OMP", () => {
		expect(detectRuntimeKind({ capabilities: { pi: true } }, {})).toBe("pi");
		expect(detectRuntimeKind({}, { runtime: { capabilities: { omp: true } } })).toBe("omp");
		expect(detectRuntimeKind({}, {})).toBe("unknown");
	});
});
