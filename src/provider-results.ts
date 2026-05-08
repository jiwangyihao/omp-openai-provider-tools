import * as crypto from "node:crypto";

export const PROVIDER_TOOL_RESULT_MESSAGE_TYPE = "openai-provider-tool-result";

interface ProviderUrlReference {
	url: string;
	title?: string;
}

export interface ProviderWebSearchResult {
	type: "web_search";
	id?: string;
	status?: string;
	actionType?: string;
	query?: string;
	queries: string[];
	citations: ProviderUrlReference[];
	sources: ProviderUrlReference[];
}

export type DisplayableProviderToolResult = ProviderWebSearchResult;

export interface ProviderToolResultMessage {
	customType: typeof PROVIDER_TOOL_RESULT_MESSAGE_TYPE;
	display: true;
	attribution: "agent";
	content: string;
	details: Record<string, unknown>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 0 ? normalized : undefined;
}

function uniqueReferences(references: ProviderUrlReference[]): ProviderUrlReference[] {
	const seen = new Set<string>();
	const result: ProviderUrlReference[] = [];
	for (const reference of references) {
		const key = `${reference.url}\u0000${reference.title ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(reference);
	}
	return result;
}

function referenceFromRecord(value: unknown): ProviderUrlReference | undefined {
	if (!isRecord(value)) return undefined;
	const url = cleanString(value.url);
	if (!url) return undefined;
	return {
		url,
		title: cleanString(value.title),
	};
}

function collectUrlCitations(items: unknown[]): ProviderUrlReference[] {
	const citations: ProviderUrlReference[] = [];
	for (const item of items) {
		if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
		for (const part of item.content) {
			if (!isRecord(part) || !Array.isArray(part.annotations)) continue;
			for (const annotation of part.annotations) {
				if (!isRecord(annotation) || annotation.type !== "url_citation") continue;
				const reference = referenceFromRecord(annotation);
				if (reference) citations.push(reference);
			}
		}
	}
	return uniqueReferences(citations);
}

function collectSources(item: UnknownRecord): ProviderUrlReference[] {
	if (!Array.isArray(item.sources)) return [];
	return uniqueReferences(item.sources.flatMap(source => {
		const reference = referenceFromRecord(source);
		return reference ? [reference] : [];
	}));
}

function collectQueries(action: unknown): { query?: string; queries: string[]; actionType?: string } {
	if (!isRecord(action)) return { queries: [] };
	const query = cleanString(action.query);
	const queries = Array.isArray(action.queries)
		? action.queries.flatMap(entry => {
				const value = cleanString(entry);
				return value ? [value] : [];
			})
		: [];
	if (query && !queries.includes(query)) queries.unshift(query);
	return {
		query,
		queries,
		actionType: cleanString(action.type),
	};
}

export function extractDisplayableProviderToolResults(message: unknown): DisplayableProviderToolResult[] {
	if (!isRecord(message)) return [];
	const providerPayload = message.providerPayload;
	if (!isRecord(providerPayload)) return [];
	if (providerPayload.type !== "openaiResponsesHistory") return [];
	if (!Array.isArray(providerPayload.items)) return [];

	const citations = collectUrlCitations(providerPayload.items);
	const results: DisplayableProviderToolResult[] = [];
	for (const item of providerPayload.items) {
		if (!isRecord(item) || item.type !== "web_search_call") continue;
		const action = collectQueries(item.action);
		results.push({
			type: "web_search",
			id: cleanString(item.id),
			status: cleanString(item.status),
			actionType: action.actionType,
			query: action.query,
			queries: action.queries,
			citations,
			sources: collectSources(item),
		});
	}
	return results;
}

export function providerToolResultKey(runtimeSessionId: string, result: DisplayableProviderToolResult): string {
	if (result.id) return `${runtimeSessionId}:${result.type}:${result.id}`;
	const fingerprint = crypto
		.createHash("sha256")
		.update(JSON.stringify({ type: result.type, actionType: result.actionType, queries: result.queries, citations: result.citations, sources: result.sources }))
		.digest("hex");
	return `${runtimeSessionId}:${result.type}:${fingerprint}`;
}

function appendReferences(lines: string[], label: string, references: ProviderUrlReference[]): void {
	if (references.length === 0) return;
	lines.push(`${label}:`);
	for (const reference of references.slice(0, 10)) {
		lines.push(`- ${reference.title ? `${reference.title}: ` : ""}${reference.url}`);
	}
	if (references.length > 10) {
		lines.push(`- ... ${references.length - 10} more`);
	}
}

export function buildProviderToolResultMessage(result: DisplayableProviderToolResult): ProviderToolResultMessage {
	const lines = ["OpenAI provider executed web_search."];
	if (result.id) lines.push(`Call: ${result.id}`);
	if (result.status) lines.push(`Status: ${result.status}`);
	if (result.actionType) lines.push(`Action: ${result.actionType}`);
	if (result.query) lines.push(`Query: ${result.query}`);
	if (!result.query && result.queries.length > 0) lines.push(`Queries: ${result.queries.join("; ")}`);
	appendReferences(lines, "Citations", result.citations);
	appendReferences(lines, "Sources", result.sources);

	return {
		customType: PROVIDER_TOOL_RESULT_MESSAGE_TYPE,
		display: true,
		attribution: "agent",
		content: lines.join("\n"),
		details: withoutUndefined({
			type: result.type,
			id: result.id,
			status: result.status,
			actionType: result.actionType,
			query: result.query,
			queries: result.queries,
			citations: result.citations,
			sources: result.sources,
		}),
	};
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
