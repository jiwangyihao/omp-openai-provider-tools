import type { HostSideToolName, ProviderToolType } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeActiveToolNames(tools: unknown): string[] {
	if (!Array.isArray(tools)) return [];

	const names: string[] = [];
	for (const tool of tools) {
		if (typeof tool === "string" && tool.length > 0) {
			names.push(tool);
			continue;
		}
		if (isRecord(tool) && typeof tool.name === "string" && tool.name.length > 0) {
			names.push(tool.name);
		}
	}
	return names;
}

export function enabledProviderToolsToHostTools(providerToolTypes: readonly ProviderToolType[]): HostSideToolName[] {
	const hostTools: HostSideToolName[] = [];
	for (const type of providerToolTypes) {
		if (type === "web_search") hostTools.push("web_search");
		if (type === "image_generation") hostTools.push("generate_image");
	}
	return hostTools;
}

export function removeHostSideTools(
	toolNames: readonly string[],
	hostToolsToRemove: readonly string[],
): { removed: boolean; toolNames: string[] } {
	if (hostToolsToRemove.length === 0) return { removed: false, toolNames: [...toolNames] };

	const remove = new Set(hostToolsToRemove);
	const next = toolNames.filter((toolName) => !remove.has(toolName));
	return { removed: next.length !== toolNames.length, toolNames: next };
}
