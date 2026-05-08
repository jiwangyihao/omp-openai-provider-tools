import type { RuntimeModelLike } from "./types";
import { isOpenAIResponsesPayload } from "./request-injection";

export interface RequestTarget {
	api: "openai-responses";
	provider?: string;
	baseUrl?: string;
	modelId: string;
	payloadModel: string;
	modelName?: string;
}

export const isOpenAIResponsesRequestPayload = isOpenAIResponsesPayload;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
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
		modelId: stringOrUndefined(model.id) ?? payload.model,
		payloadModel: payload.model,
		modelName: stringOrUndefined(model.name),
	};
}
