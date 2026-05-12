import { describe, expect, it } from "bun:test";

import {
	extractDisplayableProviderToolResults,
	normalizeProviderWebSearchQueryForIdentity,
	displayProviderWebSearchQuery,
	providerToolResultKey,
} from "../src/provider-results";

describe("provider web_search identity helpers", () => {
	it("normalizes identity queries without using display truncation", () => {
		expect(normalizeProviderWebSearchQueryForIdentity(" Foo\nbar\t baz ")).toBe("Foo bar baz");

		const left = `${"a".repeat(150)} left`;
		const right = `${"a".repeat(150)} right`;
		expect(normalizeProviderWebSearchQueryForIdentity(left)).not.toBe(
			normalizeProviderWebSearchQueryForIdentity(right),
		);
		expect(displayProviderWebSearchQuery(left).length).toBeLessThan(left.length);
	});

	it("keys distinct long query results by normalized identity rather than display text", () => {
		const sharedPrefix = "web search ".repeat(20);
		const left = `${sharedPrefix}left`;
		const right = `${sharedPrefix}right`;

		expect(displayProviderWebSearchQuery(left)).toBe(displayProviderWebSearchQuery(right));
		expect(providerToolResultKey("runtime", {
			type: "web_search",
			status: "completed",
			query: normalizeProviderWebSearchQueryForIdentity(left),
			queries: [normalizeProviderWebSearchQueryForIdentity(left)!],
			citations: [],
			sources: [],
		})).not.toBe(providerToolResultKey("runtime", {
			type: "web_search",
			status: "completed",
			query: normalizeProviderWebSearchQueryForIdentity(right),
			queries: [normalizeProviderWebSearchQueryForIdentity(right)!],
			citations: [],
			sources: [],
		}));
	});
});

describe("provider web_search result extraction", () => {
	it("uses normalized queries when extracting final web_search results", () => {
		const message = {
			providerPayload: {
				type: "openaiResponsesHistory",
				items: [
					{
						type: "web_search_call",
						id: "ws-1",
						status: "completed",
						action: { query: " Foo\nbar " },
					},
				],
			},
		};

		expect(extractDisplayableProviderToolResults(message)[0]?.queries).toEqual(["Foo bar"]);
	});

	it("extracts search action queries and separates page action details", () => {
		const message = {
			providerPayload: {
				type: "openaiResponsesHistory",
				items: [
					{
						type: "web_search_call",
						id: "ws-search",
						status: "completed",
						action: { type: "search", query: " Foo\nbar ", queries: [" Baz\tqux "] },
					},
					{
						type: "web_search_call",
						id: "ws-open",
						status: "completed",
						action: { type: "open_page", url: "https://example.invalid/page" },
					},
					{
						type: "web_search_call",
						id: "ws-find",
						status: "completed",
						action: { type: "find_in_page", pattern: "needle" },
					},
				],
			},
		};

		const results = extractDisplayableProviderToolResults(message);

		expect(results.map(result => result.id)).toEqual(["ws-search", "ws-open", "ws-find"]);
		expect(results[0]?.query).toBe("Foo bar");
		expect(results[0]?.queries).toEqual(["Foo bar", "Baz qux"]);
		expect(results[1]?.queries).toEqual([]);
		expect(results[1]?.actionDetails).toContainEqual({
			type: "open_page",
			label: "url",
			value: "https://example.invalid/page",
		});
		expect(results[2]?.queries).toEqual([]);
		expect(results[2]?.actionDetails).toContainEqual({
			type: "find_in_page",
			label: "pattern",
			value: "needle",
		});
	});

	it("retains statusless web_search results when action details are displayable", () => {
		const message = {
			providerPayload: {
				type: "openaiResponsesHistory",
				items: [
					{
						type: "web_search_call",
						action: { type: "open_page", url: "https://example.invalid/page" },
					},
				],
			},
		};

		const results = extractDisplayableProviderToolResults(message);

		expect(results).toHaveLength(1);
		expect(results[0]?.status).toBeUndefined();
		expect(results[0]?.actionDetails).toEqual([
			{ type: "open_page", label: "url", value: "https://example.invalid/page" },
		]);
	});

	it("does not treat non-final web_search statuses as successful final results", () => {
		for (const status of ["in_progress", "searching", "failed", "incomplete"]) {
			const message = {
				providerPayload: {
					type: "openaiResponsesHistory",
					items: [
						{
							type: "web_search_call",
							id: `ws-${status}`,
							status,
							action: { type: "search", query: `query for ${status}` },
						},
					],
				},
			};

			expect(extractDisplayableProviderToolResults(message)).toEqual([]);
		}
	});
});