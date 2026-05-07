import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildImageMessage,
	extractImageGenerationResults,
	injectOpenAIResponsesProviderTools,
	removeLocalFallbackTools,
	saveImageResult,
	shouldEnableForModel,
} from "../src/provider-tools";

const ONE_BY_ONE_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-provider-tools-"));
	tempDirs.push(dir);
	return dir;
}

describe("provider tool injection", () => {
	it("adds provider-executed web search and image generation tools without forcing tool_choice", () => {
		const payload: Record<string, unknown> = {
			model: "gpt-5.5-Sys",
			stream: true,
			store: false,
			tools: [{ type: "function", name: "read" }],
		};

		const result = injectOpenAIResponsesProviderTools(payload);

		expect(result).toEqual({ injectedWebSearch: true, injectedImageGeneration: true });
		expect(payload.tools).toEqual([
			{ type: "function", name: "read" },
			{ type: "web_search", search_context_size: "high" },
			{ type: "image_generation", output_format: "png" },
		]);
		expect(payload).not.toHaveProperty("tool_choice");
	});

	it("does not duplicate provider tools already present", () => {
		const payload: Record<string, unknown> = {
			model: "gpt-5.5-Sys",
			tools: [
				{ type: "web_search", search_context_size: "low" },
				{ type: "image_generation", output_format: "png", size: "1024x1024" },
			],
		};

		const result = injectOpenAIResponsesProviderTools(payload);

		expect(result).toEqual({ injectedWebSearch: false, injectedImageGeneration: false });
		expect(payload.tools).toHaveLength(2);
	});

	it("leaves non-object and tool-less payloads untouched", () => {
		expect(injectOpenAIResponsesProviderTools(null)).toEqual({ injectedWebSearch: false, injectedImageGeneration: false });
		expect(injectOpenAIResponsesProviderTools({ model: "gpt-5.5-Sys" })).toEqual({
			injectedWebSearch: false,
			injectedImageGeneration: false,
		});
	});
});

describe("target model selection and local fallback removal", () => {
	it("does not enable provider tools without explicit configuration", () => {
		expect(shouldEnableForModel({ api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1" })).toBe(
			false,
		);
		expect(
			shouldEnableForModel({
				api: "openai-responses",
				provider: "compatible-example",
				baseUrl: "https://gateway.example.invalid/v1",
			}),
		).toBe(false);
		expect(
			shouldEnableForModel({
				api: "openai-responses",
				provider: "compatible-example",
				baseUrl: "https://another-gateway.example.invalid/v1",
			}),
		).toBe(false);
	});

	it("removes host-side web and image fallbacks without disturbing other tools", () => {
		expect(removeLocalFallbackTools(["read", "web_search", "generate_image", "edit"])).toEqual(["read", "edit"]);
	});
});

describe("image generation extraction and persistence", () => {
	it("extracts native image_generation_call results from assistant provider payload", () => {
		const results = extractImageGenerationResults({
			role: "assistant",
			providerPayload: {
				type: "openaiResponsesHistory",
				items: [
					{ type: "web_search_call", status: "completed" },
					{
						id: "ig_1",
						type: "image_generation_call",
						status: "completed",
						result: `data:image/png;base64,${ONE_BY_ONE_PNG}`,
						revised_prompt: "A red square.",
						output_format: "png",
						size: "1024x1024",
					},
					{ type: "image_generation_call", status: "failed" },
				],
			},
		});

		expect(results).toEqual([
			{
				id: "ig_1",
				result: ONE_BY_ONE_PNG,
				revisedPrompt: "A red square.",
				outputFormat: "png",
				mimeType: "image/png",
				size: "1024x1024",
				quality: undefined,
			},
		]);
	});

	it("saves generated image bytes to the session artifact directory", async () => {
		const dir = await makeTempDir();
		const saved = await saveImageResult(
			{
				id: "ig_1",
				result: ONE_BY_ONE_PNG,
				outputFormat: "png",
				mimeType: "image/png",
			},
			{
				cwd: dir,
				sessionManager: {
					getArtifactsDir: () => path.join(dir, "session-artifacts"),
				},
			},
		);

		expect(saved.path.endsWith(".png")).toBe(true);
		expect(saved.bytes).toBe(Buffer.from(ONE_BY_ONE_PNG, "base64").byteLength);
		expect(await fs.readFile(saved.path)).toEqual(Buffer.from(ONE_BY_ONE_PNG, "base64"));
	});

	it("builds a context-safe custom message that exposes the saved file path without embedding base64", () => {
		const message = buildImageMessage(
			{
				id: "ig_1",
				result: ONE_BY_ONE_PNG,
				revisedPrompt: "A red square.",
				outputFormat: "png",
				mimeType: "image/png",
				size: "1024x1024",
			},
			{ path: "C:/tmp/session-artifacts/provider-image-abc.png", bytes: 68, reusedExisting: false },
		);

		expect(message.customType).toBe("openai-provider-image-generation");
		expect(message.display).toBe(true);
		expect(message.attribution).toBe("agent");
		expect(message.content).toContain("C:/tmp/session-artifacts/provider-image-abc.png");
		expect(message.content).toContain("A red square.");
		expect(message.content).not.toContain(ONE_BY_ONE_PNG);
		expect(message.details).toMatchObject({ id: "ig_1", mimeType: "image/png", bytes: 68 });
	});
});
