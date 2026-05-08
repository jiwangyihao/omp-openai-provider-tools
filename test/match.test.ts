import { describe, expect, it } from "bun:test";

import { buildRequestTarget, isOpenAIResponsesRequestPayload } from "../src/match";


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
