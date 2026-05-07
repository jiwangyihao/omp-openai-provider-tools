import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import type {
	BaseUrlMatch,
	ExtensionApiLike,
	ExtensionContextLike,
	ImageGenerationToolConfig,
	ProviderToolsConfig,
	ProviderToolsEntry,
	WebSearchToolConfig,
} from "./types";

export type RuntimeKind = "omp" | "pi" | "unknown";

export interface ValidationResult {
	ok: boolean;
	config?: ProviderToolsConfig;
	warnings: string[];
}

export interface LoadedConfig {
	config: ProviderToolsConfig;
	warnings: string[];
	paths: string[];
}

export interface ConfigPaths {
	project: string;
	user: string;
	ordered: string[];
}

type UnknownRecord = Record<string, unknown>;
type RuntimeMetadata = { name?: unknown; kind?: unknown; capabilities?: unknown };

const TOP_LEVEL_FIELDS = new Set(["version", "providers"]);
const PROVIDER_FIELDS = new Set(["name", "match", "tools", "output"]);
const MATCH_FIELDS = new Set(["api", "provider", "modelId", "modelName", "baseUrl"]);
const TOOLS_FIELDS = new Set(["web_search", "image_generation"]);
const WEB_SEARCH_FIELDS = new Set(["enabled", "search_context_size"]);
const IMAGE_GENERATION_FIELDS = new Set(["enabled", "output_format", "quality", "size", "background", "action"]);
const OUTPUT_FIELDS = new Set(["directory"]);

const WEB_SEARCH_CONTEXT_SIZES = new Set(["low", "medium", "high"]);
const IMAGE_OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const IMAGE_QUALITIES = new Set(["low", "medium", "high", "auto"]);
const IMAGE_BACKGROUNDS = new Set(["transparent", "opaque", "auto"]);
const IMAGE_ACTIONS = new Set(["auto", "generate", "edit"]);

function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function warnUnknownFields(value: UnknownRecord, allowed: Set<string>, label: string, warnings: string[]): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			warnings.push(`unknown ${label} field: ${key}`);
		}
	}
}

export function expandHome(input: string, homeDir: string): string {
	if (input === "~") {
		return homeDir;
	}
	if (input.startsWith("~/") || input.startsWith("~\\")) {
		return path.join(homeDir, input.slice(2));
	}
	return input;
}

export function getConfigPaths({ cwd, homeDir, runtime }: { cwd: string; homeDir: string; runtime: Exclude<RuntimeKind, "unknown"> }): ConfigPaths {
	const runtimeDir = runtime === "pi" ? ".pi" : ".omp";
	const project = path.join(cwd, runtimeDir, "openai-provider-tools.yml");
	const user = path.join(homeDir, runtimeDir, "agent", "openai-provider-tools.yml");
	return { project, user, ordered: [project, user] };
}

function normalizeRuntimeName(value: unknown): RuntimeKind {
	if (typeof value !== "string") {
		return "unknown";
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "pi" || normalized === "pi-family" || normalized === "mariozechner-pi") {
		return "pi";
	}
	if (normalized === "omp" || normalized === "oh-my-pi" || normalized === "oh my pi") {
		return "omp";
	}
	return "unknown";
}

function detectFromCapabilities(value: unknown): RuntimeKind {
	if (!isRecord(value)) {
		return "unknown";
	}
	const keys = Object.keys(value).map((key) => key.toLowerCase());
	if (keys.some((key) => key === "pi" || key.startsWith("pi.") || key.includes("pi-family"))) {
		return "pi";
	}
	if (keys.some((key) => key === "omp" || key.includes("oh-my-pi") || key.startsWith("omp."))) {
		return "omp";
	}
	return "unknown";
}

function metadataCandidates(api: unknown, ctx: unknown): RuntimeMetadata[] {
	const candidates: RuntimeMetadata[] = [];
	for (const value of [api, ctx]) {
		if (!isRecord(value)) {
			continue;
		}
		if (isRecord(value.runtime)) {
			candidates.push(value.runtime);
		}
		if (isRecord(value.model) && isRecord(value.model.runtime)) {
			candidates.push(value.model.runtime);
		}
		candidates.push(value as RuntimeMetadata);
	}
	return candidates;
}

export function detectRuntimeKind(api: ExtensionApiLike | unknown, ctx: ExtensionContextLike | unknown): RuntimeKind {
	for (const candidate of metadataCandidates(api, ctx)) {
		const byName = normalizeRuntimeName(candidate.name);
		if (byName !== "unknown") {
			return byName;
		}
		const byKind = normalizeRuntimeName(candidate.kind);
		if (byKind !== "unknown") {
			return byKind;
		}
	}
	for (const candidate of metadataCandidates(api, ctx)) {
		const byCapability = detectFromCapabilities(candidate.capabilities);
		if (byCapability !== "unknown") {
			return byCapability;
		}
	}
	return "unknown";
}

function validateBaseUrl(value: unknown, warnings: string[]): BaseUrlMatch | undefined {
	if (!isRecord(value)) {
		warnings.push("baseUrl must be an object");
		return undefined;
	}
	const keys = ["equals", "prefix", "host"].filter((key) => Object.hasOwn(value, key));
	const unknownKeys = Object.keys(value).filter((key) => !["equals", "prefix", "host"].includes(key));
	for (const key of unknownKeys) {
		warnings.push(`unknown baseUrl field: ${key}`);
	}
	if (keys.length !== 1 || unknownKeys.length > 0) {
		warnings.push("baseUrl must specify exactly one of equals, prefix, or host");
		return undefined;
	}
	const key = keys[0] as "equals" | "prefix" | "host";
	if (!isNonEmptyString(value[key])) {
		warnings.push(`baseUrl.${key} must be a non-empty string`);
		return undefined;
	}
	return { [key]: value[key] } as BaseUrlMatch;
}

function validateMatch(value: unknown, warnings: string[]): ProviderToolsEntry["match"] | undefined {
	if (!isRecord(value)) {
		warnings.push("provider match must be an object");
		return undefined;
	}
	warnUnknownFields(value, MATCH_FIELDS, "match", warnings);
	if (value.api !== "openai-responses") {
		warnings.push("match.api must be openai-responses");
		return undefined;
	}
	const match: ProviderToolsEntry["match"] = { api: "openai-responses" };
	for (const key of ["provider", "modelId", "modelName"] as const) {
		if (value[key] !== undefined) {
			if (!isNonEmptyString(value[key])) {
				warnings.push(`match.${key} must be a non-empty string`);
				continue;
			}
			match[key] = value[key];
		}
	}
	if (value.baseUrl !== undefined) {
		const baseUrl = validateBaseUrl(value.baseUrl, warnings);
		if (baseUrl) {
			match.baseUrl = baseUrl;
		}
	}
	return match;
}

function validateWebSearchTool(value: unknown, warnings: string[]): WebSearchToolConfig | undefined {
	if (!isRecord(value)) {
		warnings.push("tools.web_search must be an object");
		return undefined;
	}
	warnUnknownFields(value, WEB_SEARCH_FIELDS, "tool", warnings);
	const tool: WebSearchToolConfig = {};
	if (value.enabled !== undefined) {
		if (typeof value.enabled !== "boolean") {
			warnings.push("web_search.enabled must be boolean");
		} else {
			tool.enabled = value.enabled;
		}
	}
	if (value.search_context_size !== undefined) {
		if (!WEB_SEARCH_CONTEXT_SIZES.has(String(value.search_context_size))) {
			warnings.push("web_search.search_context_size must be low, medium, or high");
		} else {
			tool.search_context_size = value.search_context_size as WebSearchToolConfig["search_context_size"];
		}
	}
	return tool;
}

function validateImageGenerationTool(value: unknown, warnings: string[]): ImageGenerationToolConfig | undefined {
	if (!isRecord(value)) {
		warnings.push("tools.image_generation must be an object");
		return undefined;
	}
	warnUnknownFields(value, IMAGE_GENERATION_FIELDS, "tool", warnings);
	const tool: ImageGenerationToolConfig = {};
	if (value.enabled !== undefined) {
		if (typeof value.enabled !== "boolean") {
			warnings.push("image_generation.enabled must be boolean");
		} else {
			tool.enabled = value.enabled;
		}
	}
	const enumFields = [
		["output_format", IMAGE_OUTPUT_FORMATS, "png, jpeg, or webp"],
		["quality", IMAGE_QUALITIES, "low, medium, high, or auto"],
		["background", IMAGE_BACKGROUNDS, "transparent, opaque, or auto"],
		["action", IMAGE_ACTIONS, "auto, generate, or edit"],
	] as const;
	for (const [field, allowed, description] of enumFields) {
		if (value[field] !== undefined) {
			if (!allowed.has(String(value[field]))) {
				warnings.push(`image_generation.${field} must be ${description}`);
			} else {
				(tool as UnknownRecord)[field] = value[field];
			}
		}
	}
	if (value.size !== undefined) {
		if (!isNonEmptyString(value.size)) {
			warnings.push("image_generation.size must be a non-empty string");
		} else {
			tool.size = value.size;
		}
	}
	return tool;
}

function validateTools(value: unknown, warnings: string[]): ProviderToolsEntry["tools"] | undefined {
	if (!isRecord(value)) {
		warnings.push("provider tools must be an object");
		return undefined;
	}
	warnUnknownFields(value, TOOLS_FIELDS, "tools", warnings);
	const tools: ProviderToolsEntry["tools"] = {};
	if (value.web_search !== undefined) {
		const webSearch = validateWebSearchTool(value.web_search, warnings);
		if (webSearch) {
			tools.web_search = webSearch;
		}
	}
	if (value.image_generation !== undefined) {
		const imageGeneration = validateImageGenerationTool(value.image_generation, warnings);
		if (imageGeneration) {
			tools.image_generation = imageGeneration;
		}
	}
	return tools;
}

function validateOutput(value: unknown, warnings: string[]): ProviderToolsEntry["output"] | undefined {
	if (!isRecord(value)) {
		warnings.push("provider output must be an object");
		return undefined;
	}
	warnUnknownFields(value, OUTPUT_FIELDS, "output", warnings);
	const output: ProviderToolsEntry["output"] = {};
	if (value.directory !== undefined) {
		if (!isNonEmptyString(value.directory)) {
			warnings.push("output.directory must be a non-empty string");
		} else {
			output.directory = value.directory;
		}
	}
	return output;
}

function validateProvider(value: unknown, index: number, warnings: string[]): ProviderToolsEntry | undefined {
	if (!isRecord(value)) {
		warnings.push(`providers[${index}] must be an object`);
		return undefined;
	}
	warnUnknownFields(value, PROVIDER_FIELDS, "provider", warnings);
	if (!isNonEmptyString(value.name)) {
		warnings.push(`providers[${index}].name must be a non-empty string`);
	}
	const match = validateMatch(value.match, warnings);
	const tools = validateTools(value.tools, warnings);
	const entry: ProviderToolsEntry = {
		name: isNonEmptyString(value.name) ? value.name : "",
		match: match ?? { api: "openai-responses" },
		tools: tools ?? {},
	};
	if (value.output !== undefined) {
		const output = validateOutput(value.output, warnings);
		if (output) {
			entry.output = output;
		}
	}
	return entry;
}

export function validateProviderToolsConfig(input: unknown): ValidationResult {
	const warnings: string[] = [];
	if (!isRecord(input)) {
		return { ok: false, warnings: ["config must be an object"] };
	}
	warnUnknownFields(input, TOP_LEVEL_FIELDS, "top-level", warnings);
	if (input.version !== 1) {
		warnings.push("version must be 1");
	}
	if (!Array.isArray(input.providers)) {
		warnings.push("providers must be an array");
		return { ok: false, warnings };
	}
	const providers = input.providers.map((provider, index) => validateProvider(provider, index, warnings)).filter(Boolean) as ProviderToolsEntry[];
	if (warnings.length > 0) {
		return { ok: false, warnings };
	}
	return { ok: true, config: { version: 1, providers }, warnings };
}

function normalizeConfig(config: ProviderToolsConfig, homeDir: string): ProviderToolsConfig {
	const providers = config.providers.map((provider) => {
		const tools: ProviderToolsEntry["tools"] = {};
		if (provider.tools.web_search) {
			tools.web_search = { ...provider.tools.web_search };
		}
		if (provider.tools.image_generation) {
			tools.image_generation = { ...provider.tools.image_generation };
		}

		return {
			...provider,
			match: { ...provider.match },
			tools,
			output: provider.output?.directory ? { directory: expandHome(provider.output.directory, homeDir) } : provider.output ? { ...provider.output } : undefined,
		};
	});

	return { version: 1, providers };
}

async function readConfigFile(filePath: string, homeDir: string): Promise<{ config?: ProviderToolsConfig; warning?: string; exists: boolean }> {
	let source: string;
	try {
		source = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			return { exists: false };
		}
		return { exists: true, warning: `${filePath}: failed to read config: ${error instanceof Error ? error.message : String(error)}` };
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(source);
	} catch (error) {
		return { exists: true, warning: `${filePath}: failed to parse YAML: ${error instanceof Error ? error.message : String(error)}` };
	}
	const validation = validateProviderToolsConfig(parsed);
	if (!validation.ok || !validation.config) {
		return { exists: true, warning: `${filePath}: invalid config: ${validation.warnings.join("; ")}` };
	}
	return { exists: true, config: normalizeConfig(validation.config, homeDir) };
}

async function loadConfigFiles(paths: string[], homeDir: string, warnings: string[] = []): Promise<LoadedConfig> {
	const providers: ProviderToolsEntry[] = [];
	const readPaths: string[] = [];
	for (const filePath of paths) {
		const result = await readConfigFile(filePath, homeDir);
		if (!result.exists) {
			continue;
		}
		readPaths.push(filePath);
		if (result.warning) {
			warnings.push(result.warning);
			continue;
		}
		if (result.config) {
			providers.push(...result.config.providers);
		}
	}
	return { config: { version: 1, providers }, warnings, paths: readPaths };
}

export async function loadProviderToolsConfig({
	cwd,
	homeDir,
	runtime,
}: {
	cwd: string;
	homeDir: string;
	runtime: Exclude<RuntimeKind, "unknown">;
}): Promise<LoadedConfig> {
	const paths = getConfigPaths({ cwd, homeDir, runtime });
	return loadConfigFiles(paths.ordered, homeDir);
}

export async function loadAvailableProviderToolsConfig({
	cwd,
	homeDir,
	runtime,
}: {
	cwd: string;
	homeDir: string;
	runtime: RuntimeKind;
}): Promise<LoadedConfig> {
	if (runtime !== "unknown") {
		return loadProviderToolsConfig({ cwd, homeDir, runtime });
	}
	const omp = getConfigPaths({ cwd, homeDir, runtime: "omp" });
	const pi = getConfigPaths({ cwd, homeDir, runtime: "pi" });
	return loadConfigFiles(
		[pi.project, omp.project, pi.user, omp.user],
		homeDir,
		["runtime identity is unknown; loading both Pi and OMP provider tools configs in deterministic order"],
	);
}
