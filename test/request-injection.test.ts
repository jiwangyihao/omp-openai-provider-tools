import { describe, expect, it } from "bun:test";

import {
	getEnabledProviderToolTypes,
	injectConfiguredTools,
	isOpenAIResponsesPayload,
} from "../src/request-injection";
import type { ProviderToolsEntry } from "../src/types";

function providerEntry(tools: ProviderToolsEntry["tools"]): ProviderToolsEntry {
	return {
		name: "configured-provider",
		match: { api: "openai-responses" },
		tools,
	};
}

describe("OpenAI Responses payload detection", () => {
	it("recognizes Responses payloads and rejects chat-completions style payloads", () => {
		expect(isOpenAIResponsesPayload({ model: "gpt-4.1", input: "hello" })).toBe(true);
		expect(isOpenAIResponsesPayload({ model: "gpt-4.1", messages: [{ role: "user", content: "hello" }] })).toBe(false);
		expect(isOpenAIResponsesPayload({ model: "gpt-4.1", input: "hello", messages: [] })).toBe(false);
	});
});

describe("enabled provider tool selection", () => {
	it("returns only tools with enabled true", () => {
		expect(
			getEnabledProviderToolTypes(
				providerEntry({
					web_search: { enabled: true },
					image_generation: { enabled: false },
				}),
			),
		).toEqual(["web_search"]);
	});
});

describe("configured provider tool injection", () => {
	it("creates payload.tools when missing", () => {
		const payload: Record<string, unknown> = { model: "gpt-4.1", input: "hello" };
		const result = injectConfiguredTools(payload, providerEntry({ web_search: { enabled: true } }));

		expect(result).toEqual({ ok: true, ensured: ["web_search"], added: ["web_search"] });
		expect(payload.tools).toEqual([{ type: "web_search" }]);
	});

	it("appends only missing enabled provider-native tools to existing arrays", () => {
		const payload: Record<string, unknown> = {
			model: "gpt-4.1",
			input: "hello",
			tools: [{ type: "function", name: "read" }, { type: "web_search" }],
		};

		const result = injectConfiguredTools(
			payload,
			providerEntry({
				web_search: { enabled: true, search_context_size: "high" },
				image_generation: { enabled: true, output_format: "png" },
			}),
		);

		expect(result).toEqual({ ok: true, ensured: ["web_search", "image_generation"], added: ["image_generation"] });
		expect(payload.tools).toEqual([
			{ type: "function", name: "read" },
			{ type: "web_search" },
			{ type: "image_generation", output_format: "png" },
		]);
	});

	it("returns ok false and does not mutate non-array payload.tools", () => {
		const payload: Record<string, unknown> = { model: "gpt-4.1", input: "hello", tools: { type: "web_search" } };
		const before = structuredClone(payload);

		expect(injectConfiguredTools(payload, providerEntry({ web_search: { enabled: true } }))).toEqual({
			ok: false,
			reason: "OpenAI Responses payload tools field must be an array when present.",
		});
		expect(payload).toEqual(before);
	});

	it("counts existing provider-native tools as ensured but not added and does not overwrite params", () => {
		const payload: Record<string, unknown> = {
			model: "gpt-4.1",
			input: "hello",
			tools: [{ type: "web_search", search_context_size: "low", extra: "preserved" }],
		};

		expect(injectConfiguredTools(payload, providerEntry({ web_search: { enabled: true, search_context_size: "high" } }))).toEqual({
			ok: true,
			ensured: ["web_search"],
			added: [],
		});
		expect(payload.tools).toEqual([{ type: "web_search", search_context_size: "low", extra: "preserved" }]);
	});

	it("does not set or change tool_choice", () => {
		const missingChoice: Record<string, unknown> = { model: "gpt-4.1", input: "hello" };
		injectConfiguredTools(missingChoice, providerEntry({ web_search: { enabled: true } }));
		expect(missingChoice).not.toHaveProperty("tool_choice");

		const existingChoice: Record<string, unknown> = { model: "gpt-4.1", input: "hello", tool_choice: "auto" };
		injectConfiguredTools(existingChoice, providerEntry({ web_search: { enabled: true } }));
		expect(existingChoice.tool_choice).toBe("auto");
	});

	it("does not inject when config omits enabled true or sets enabled false", () => {
		const payload: Record<string, unknown> = { model: "gpt-4.1", input: "hello" };

		expect(
			injectConfiguredTools(
				payload,
				providerEntry({
					web_search: {},
					image_generation: { enabled: false },
				}),
			),
		).toEqual({ ok: true, ensured: [], added: [] });
		expect(payload).not.toHaveProperty("tools");
	});

	it("web_search emits only type and optional search_context_size", () => {
		const payload: Record<string, unknown> = { model: "gpt-4.1", input: "hello" };
		injectConfiguredTools(
			payload,
			providerEntry({
				web_search: { enabled: true, search_context_size: "medium" },
			}),
		);

		expect(payload.tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
	});

	it("image_generation emits only allowed configured params", () => {
		const payload: Record<string, unknown> = { model: "gpt-4.1", input: "hello" };
		injectConfiguredTools(
			payload,
			providerEntry({
				image_generation: {
					enabled: true,
					output_format: "webp",
					quality: "high",
					size: "1024x1024",
					background: "transparent",
					action: "generate",
				},
			}),
		);

		expect(payload.tools).toEqual([
			{
				type: "image_generation",
				output_format: "webp",
				quality: "high",
				size: "1024x1024",
				background: "transparent",
				action: "generate",
			},
		]);
	});
});