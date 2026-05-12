import * as crypto from "node:crypto";

export const PROVIDER_TOOL_RESULT_MESSAGE_TYPE = "openai-provider-tool-result";

interface ProviderUrlReference {
	url: string;
	title?: string;
}

export interface ProviderWebSearchActionDetail {
	type: "search" | "open_page" | "find_in_page" | string;
	label: string;
	value: string;
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
	actionDetails: ProviderWebSearchActionDetail[];
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

const MAX_QUERY_DISPLAY_CHARS = 140;

export function normalizeProviderWebSearchQueryForIdentity(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
	return normalized.length > 0 ? normalized : undefined;
}

export function displayProviderWebSearchQuery(value: string): string {
	const normalized = normalizeProviderWebSearchQueryForIdentity(value) ?? "";
	const chars = [...normalized];
	if (chars.length <= MAX_QUERY_DISPLAY_CHARS) return normalized;
	return `${chars.slice(0, MAX_QUERY_DISPLAY_CHARS).join("")}…`;
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

function collectActionDetails(action: unknown): { query?: string; queries: string[]; actionType?: string; actionDetails: ProviderWebSearchActionDetail[] } {
	if (!isRecord(action)) return { queries: [], actionDetails: [] };
	const actionType = cleanString(action.type);
	const query = normalizeProviderWebSearchQueryForIdentity(action.query);
	const queries = Array.isArray(action.queries)
		? action.queries.flatMap(entry => {
				const value = normalizeProviderWebSearchQueryForIdentity(entry);
				return value ? [value] : [];
			})
		: [];
	if (query && !queries.includes(query)) queries.unshift(query);

	const actionDetails: ProviderWebSearchActionDetail[] = [];
	if (actionType === "open_page") {
		const url = cleanString(action.url);
		if (url) actionDetails.push({ type: actionType, label: "url", value: url });
	} else if (actionType === "find_in_page") {
		const pattern = cleanString(action.pattern);
		if (pattern) actionDetails.push({ type: actionType, label: "pattern", value: pattern });
	}

	return {
		query,
		queries,
		actionType,
		actionDetails,
	};
}

function isSuccessfulFinalStatus(status: string | undefined): boolean {
	return status === "completed" || status === "complete" || status === "succeeded" || status === "success";
}

function isKnownNonFinalStatus(status: string | undefined): boolean {
	return status === "in_progress" || status === "searching" || status === "failed" || status === "incomplete";
}

function isDisplayableStatuslessResult(result: ProviderWebSearchResult): boolean {
	return Boolean(
		result.id ||
		result.query ||
		result.queries.length > 0 ||
		result.citations.length > 0 ||
		result.sources.length > 0 ||
		result.actionType ||
		result.actionDetails.length > 0,
	);
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
		const action = collectActionDetails(item.action);
		const result: ProviderWebSearchResult = {
			type: "web_search",
			id: cleanString(item.id),
			status: cleanString(item.status),
			actionType: action.actionType,
			query: action.query,
			queries: action.queries,
			citations,
			sources: collectSources(item),
			actionDetails: action.actionDetails,
		};
		if (isKnownNonFinalStatus(result.status)) continue;
		if (!isSuccessfulFinalStatus(result.status) && !isDisplayableStatuslessResult(result)) continue;
		results.push(result);
	}
	return results;
}

export function providerToolResultKey(runtimeSessionId: string, result: DisplayableProviderToolResult): string {
	if (result.id) return `${runtimeSessionId}:${result.type}:${result.id}`;
	const fingerprint = crypto
		.createHash("sha256")
		.update(JSON.stringify({ type: result.type, actionType: result.actionType, queries: result.queries, citations: result.citations, sources: result.sources, actionDetails: result.actionDetails }))
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
	return buildProviderToolResultSummaryMessage([result]);
}

export function buildProviderToolResultSummaryMessage(results: DisplayableProviderToolResult[]): ProviderToolResultMessage {
	const queries = uniqueStrings(results.flatMap(result => result.queries.length > 0 ? result.queries : result.query ? [result.query] : []));
	const citations = uniqueReferences(results.flatMap(result => result.citations));
	const sources = uniqueReferences(results.flatMap(result => result.sources));
	const actionDetails = results.flatMap(result => result.actionDetails);
	const summary = `OpenAI provider completed web_search (${results.length === 1 ? "1 call" : `${results.length} calls`}).`;

	return {
		customType: PROVIDER_TOOL_RESULT_MESSAGE_TYPE,
		display: true,
		attribution: "agent",
		content: "",
		details: withoutUndefined({
			summary,
			type: "web_search",
			queries,
			citations,
			sources,
			actionDetails,
			results,
		}),
	};
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
