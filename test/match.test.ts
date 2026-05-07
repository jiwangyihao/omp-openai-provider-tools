import { describe, expect, it } from "bun:test";

import {
	baseUrlMatches,
	buildRequestTarget,
	findMatchingProvider,
	isOpenAIResponsesRequestPayload,
	normalizeBaseUrl,
} from "../src/match";
import type { ProviderToolsConfig, ProviderToolsEntry } from "../src/types";

function entry(name: string, match: ProviderToolsEntry["match"]): ProviderToolsEntry {
	return {
		name,
		match,
		tools: { web_search: { enabled: true } },
	};
}

describe("OpenAI Responses request payload recognition", () => {
	it("recognizes Responses payloads by model and input, not chat messages", () => {
		expect(isOpenAIResponsesRequestPayload({ model: "gpt-4.1", input: "hello" })).toBe(true);
		expect(isOpenAIResponsesRequestPayload({ model: "gpt-4.1", messages: [{ role: "user", content: "hello" }] })).toBe(false);
		expect(isOpenAIResponsesRequestPayload({ model: "gpt-4.1", input: "hello", messages: [] })).toBe(false);
	});
});

describe("request target building", () => {
	it("builds a target when payload model matches context model id", () => {
		expect(
			buildRequestTarget({
				payload: { model: "gpt-4.1", input: "hello" },
				contextModel: { id: "gpt-4.1", name: "GPT 4.1", provider: "OpenAI", baseUrl: "https://api.openai.com/v1" },
			}),
		).toEqual({
			api: "openai-responses",
			provider: "OpenAI",
			baseUrl: "https://api.openai.com/v1",
			modelId: "gpt-4.1",
			payloadModel: "gpt-4.1",
			modelName: "GPT 4.1",
		});
	});

	it("builds a target when payload model matches context model name", () => {
		expect(
			buildRequestTarget({
				payload: { model: "GPT 4.1", input: [] },
				contextModel: { id: "openai-main", name: "GPT 4.1", provider: "openai" },
			})?.modelName,
		).toBe("GPT 4.1");
	});

	it("returns undefined when payload model differs from context model and no event model is supplied", () => {
		expect(
			buildRequestTarget({
				payload: { model: "gpt-4.1", input: "hello" },
				contextModel: { id: "gpt-5", name: "GPT 5", provider: "openai" },
			}),
		).toBeUndefined();
	});

	it("uses event model with priority and its api/provider/baseUrl/model metadata", () => {
		expect(
			buildRequestTarget({
				payload: { model: "event-model", input: "hello" },
				contextModel: { id: "context-model", name: "Context", provider: "context-provider", baseUrl: "https://context.example.invalid/v1" },
				eventModel: {
					id: "event-model",
					name: "Event Model",
					api: "openai-responses",
					provider: "event-provider",
					baseUrl: "https://event.example.invalid/v1/",
				},
			}),
		).toEqual({
			api: "openai-responses",
			provider: "event-provider",
			baseUrl: "https://event.example.invalid/v1/",
			modelId: "event-model",
			payloadModel: "event-model",
			modelName: "Event Model",
		});
	});
});

describe("provider matching", () => {
	it("compares provider case-insensitively", () => {
		const config: ProviderToolsConfig = { version: 1, providers: [entry("official", { api: "openai-responses", provider: "OPENAI" })] };
		expect(findMatchingProvider(config, { api: "openai-responses", provider: "openai", modelId: "gpt-4.1", payloadModel: "gpt-4.1" })?.name).toBe("official");
	});

	it("normalizes base URLs by removing trailing slashes for equals matching", () => {
		expect(normalizeBaseUrl("https://api.example.invalid/v1///")).toBe("https://api.example.invalid/v1");
		expect(baseUrlMatches({ equals: "https://api.example.invalid/v1/" }, "https://api.example.invalid/v1///")).toBe(true);
	});

	it("matches normalized base URL prefixes", () => {
		expect(baseUrlMatches({ prefix: "https://gateway.example.invalid/v1/" }, "https://gateway.example.invalid/v1/openai/responses/")).toBe(true);
	});

	it("matches base URL host lowercased", () => {
		expect(baseUrlMatches({ host: "API.EXAMPLE.INVALID" }, "https://api.example.invalid/v1/")).toBe(true);
	});

	it("requires exact modelId and modelName matches", () => {
		const config: ProviderToolsConfig = {
			version: 1,
			providers: [
				entry("model-id", { api: "openai-responses", modelId: "gpt-4.1" }),
				entry("model-name", { api: "openai-responses", modelName: "GPT 4.1" }),
			],
		};
		expect(findMatchingProvider(config, { api: "openai-responses", modelId: "gpt-4.1-preview", payloadModel: "gpt-4.1-preview", modelName: "GPT 4.1" })?.name).toBe("model-name");
		expect(findMatchingProvider(config, { api: "openai-responses", modelId: "gpt-4.1", payloadModel: "gpt-4.1", modelName: "Other" })?.name).toBe("model-id");
	});

	it("matches modelId against the runtime context model id when payload uses the context model name", () => {
		const config: ProviderToolsConfig = {
			version: 1,
			providers: [entry("runtime-id", { api: "openai-responses", modelId: "openai-main" })],
		};
		const target = buildRequestTarget({
			payload: { model: "GPT 4.1", input: "hello" },
			contextModel: { id: "openai-main", name: "GPT 4.1", provider: "openai" },
		});

		expect(target).toBeDefined();
		expect(findMatchingProvider(config, target!)?.name).toBe("runtime-id");
	});

	it("matches modelId against the payload model when payload uses the context model name", () => {
		const config: ProviderToolsConfig = {
			version: 1,
			providers: [entry("payload-model", { api: "openai-responses", modelId: "GPT 4.1" })],
		};
		const target = buildRequestTarget({
			payload: { model: "GPT 4.1", input: "hello" },
			contextModel: { id: "openai-main", name: "GPT 4.1", provider: "openai" },
		});

		expect(target).toBeDefined();
		expect(findMatchingProvider(config, target!)?.name).toBe("payload-model");
	});

	it("treats all declared provider entry match fields as AND conditions", () => {
		const config: ProviderToolsConfig = {
			version: 1,
			providers: [entry("strict", { api: "openai-responses", provider: "openai", baseUrl: { host: "api.openai.com" }, modelId: "gpt-4.1" })],
		};
		expect(findMatchingProvider(config, { api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1", modelId: "gpt-4.1", payloadModel: "gpt-4.1" })?.name).toBe("strict");
		expect(findMatchingProvider(config, { api: "openai-responses", provider: "openai", baseUrl: "https://gateway.example.invalid/v1", modelId: "gpt-4.1", payloadModel: "gpt-4.1" })).toBeUndefined();
	});

	it("returns the first matching provider entry", () => {
		const config: ProviderToolsConfig = {
			version: 1,
			providers: [
				entry("first", { api: "openai-responses", provider: "openai" }),
				entry("second", { api: "openai-responses", provider: "openai" }),
			],
		};
		expect(findMatchingProvider(config, { api: "openai-responses", provider: "openai", modelId: "gpt-4.1", payloadModel: "gpt-4.1" })?.name).toBe("first");
	});
});