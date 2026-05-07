import type { ProviderToolsEntry, ProviderToolType } from "./types";

type UnknownRecord = Record<string, unknown>;
type ProviderToolPayload = { type: ProviderToolType } & Record<string, unknown>;

export type InjectionResult =
	| { ok: true; ensured: ProviderToolType[]; added: ProviderToolType[] }
	| { ok: false; reason: string };

function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: UnknownRecord, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

export function isOpenAIResponsesPayload(payload: unknown): payload is UnknownRecord & { model: string } {
	return isRecord(payload) && typeof payload.model === "string" && payload.model.length > 0 && hasOwn(payload, "input") && !hasOwn(payload, "messages");
}

export function getEnabledProviderToolTypes(entry: ProviderToolsEntry): ProviderToolType[] {
	const enabled: ProviderToolType[] = [];
	if (entry.tools.web_search?.enabled === true) enabled.push("web_search");
	if (entry.tools.image_generation?.enabled === true) enabled.push("image_generation");
	return enabled;
}

function hasProviderTool(tools: readonly unknown[], type: ProviderToolType): boolean {
	return tools.some((tool) => isRecord(tool) && tool.type === type);
}

function buildProviderTool(type: ProviderToolType, entry: ProviderToolsEntry): ProviderToolPayload {
	if (type === "web_search") {
		const tool: ProviderToolPayload = { type };
		const searchContextSize = entry.tools.web_search?.search_context_size;
		if (searchContextSize) tool.search_context_size = searchContextSize;
		return tool;
	}

	const tool: ProviderToolPayload = { type };
	const config = entry.tools.image_generation;
	if (config?.output_format) tool.output_format = config.output_format;
	if (config?.quality) tool.quality = config.quality;
	if (config?.size) tool.size = config.size;
	if (config?.background) tool.background = config.background;
	if (config?.action) tool.action = config.action;
	return tool;
}

export function injectConfiguredTools(payload: unknown, entry: ProviderToolsEntry): InjectionResult {
	if (!isOpenAIResponsesPayload(payload)) {
		return { ok: false, reason: "Payload is not an OpenAI Responses request." };
	}

	const enabled = getEnabledProviderToolTypes(entry);
	if (enabled.length === 0) return { ok: true, ensured: [], added: [] };

	if (hasOwn(payload, "tools") && payload.tools !== undefined && !Array.isArray(payload.tools)) {
		return { ok: false, reason: "OpenAI Responses payload tools field must be an array when present." };
	}

	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	if (!Array.isArray(payload.tools)) payload.tools = tools;

	const ensured: ProviderToolType[] = [];
	const added: ProviderToolType[] = [];
	for (const type of enabled) {
		ensured.push(type);
		if (hasProviderTool(tools, type)) continue;
		tools.push(buildProviderTool(type, entry));
		added.push(type);
	}

	return { ok: true, ensured, added };
}