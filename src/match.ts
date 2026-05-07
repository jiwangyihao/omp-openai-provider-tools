import type { BaseUrlMatch, ProviderToolsConfig, ProviderToolsEntry, RuntimeModelLike } from "./types";
import { isOpenAIResponsesPayload } from "./request-injection";

export interface RequestTarget {
	api: "openai-responses";
	provider?: string;
	baseUrl?: string;
	modelId: string;
	modelName?: string;
}

export const isOpenAIResponsesRequestPayload = isOpenAIResponsesPayload;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function normalizeBaseUrl(value: string): string {
	return value.replace(/\/+$/g, "");
}

function normalizedHost(value: string): string | undefined {
	try {
		return new URL(value).host.toLowerCase();
	} catch {
		return undefined;
	}
}

export function baseUrlMatches(match: BaseUrlMatch, targetBaseUrl: string | undefined): boolean {
	if (!targetBaseUrl) return false;

	if ("equals" in match) return normalizeBaseUrl(targetBaseUrl) === normalizeBaseUrl(match.equals);
	if ("prefix" in match) return normalizeBaseUrl(targetBaseUrl).startsWith(normalizeBaseUrl(match.prefix));

	const targetHost = normalizedHost(targetBaseUrl);
	return targetHost !== undefined && targetHost === match.host.toLowerCase();
}

function requestedModelMatchesContext(payloadModel: string, contextModel: RuntimeModelLike): boolean {
	return payloadModel === contextModel.id || payloadModel === contextModel.name;
}

function stringOrUndefined(value: unknown): string | undefined {
	return isNonEmptyString(value) ? value : undefined;
}

export function buildRequestTarget({
	payload,
	contextModel,
	eventModel,
}: {
	payload: unknown;
	contextModel?: RuntimeModelLike;
	eventModel?: RuntimeModelLike;
}): RequestTarget | undefined {
	if (!isOpenAIResponsesPayload(payload)) return undefined;

	const model = eventModel ?? contextModel;
	if (!model) return undefined;
	if (!eventModel && !requestedModelMatchesContext(payload.model, model)) return undefined;

	return {
		api: "openai-responses",
		provider: stringOrUndefined(model.provider),
		baseUrl: stringOrUndefined(model.baseUrl),
		modelId: payload.model,
		modelName: stringOrUndefined(model.name),
	};
}

function entryMatchesTarget(entry: ProviderToolsEntry, target: RequestTarget): boolean {
	const match = entry.match;
	if (match.api !== target.api) return false;
	if (match.provider !== undefined && match.provider.toLowerCase() !== target.provider?.toLowerCase()) return false;
	if (match.modelId !== undefined && match.modelId !== target.modelId) return false;
	if (match.modelName !== undefined && match.modelName !== target.modelName) return false;
	if (match.baseUrl !== undefined && !baseUrlMatches(match.baseUrl, target.baseUrl)) return false;
	return true;
}

export function findMatchingProvider(config: ProviderToolsConfig, target: RequestTarget): ProviderToolsEntry | undefined {
	return config.providers.find((entry) => entryMatchesTarget(entry, target));
}