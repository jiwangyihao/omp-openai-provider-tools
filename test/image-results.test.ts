import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	PROVIDER_IMAGE_MESSAGE_TYPE,
	buildImageErrorMessage,
	buildImageMessage,
	extractImageGenerationResults,
	imageResultKey,
	saveImageResult,
	type ProviderImageGenerationResult,
} from "../src/image-results";

const ONE_BY_ONE_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const ONE_BY_ONE_JPEG =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEP/EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EFBABAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-results-"));
	tempDirs.push(dir);
	return dir;
}

function imageResult(overrides: Partial<ProviderImageGenerationResult> = {}): ProviderImageGenerationResult {
	return {
		id: "ig_1",
		result: ONE_BY_ONE_PNG,
		mimeType: "image/png",
		outputFormat: "png",
		...overrides,
	};
}

describe("image_generation_call extraction", () => {
	it("extracts only image generation calls with string results from OpenAI Responses history", () => {
		const results = extractImageGenerationResults({
			role: "assistant",
			providerPayload: {
				type: "openaiResponsesHistory",
				items: [
					{ type: "web_search_call", result: "ignored" },
					{
						id: "ig_png",
						type: "image_generation_call",
						result: `data:image/png;base64,${ONE_BY_ONE_PNG}`,
						revised_prompt: "A tiny PNG.",
						output_format: "png",
						size: "1024x1024",
						quality: "high",
					},
					{ type: "image_generation_call", result: 123 },
					{ id: "missing_result", type: "image_generation_call" },
				],
			},
		});

		expect(results).toEqual([
			{
				id: "ig_png",
				result: ONE_BY_ONE_PNG,
				revisedPrompt: "A tiny PNG.",
				outputFormat: "png",
				mimeType: "image/png",
				size: "1024x1024",
				quality: "high",
			},
		]);
	});

	it("ignores messages without OpenAI Responses history items", () => {
		expect(extractImageGenerationResults({ providerPayload: { type: "other", items: [] } })).toEqual([]);
		expect(extractImageGenerationResults({ providerPayload: { type: "openaiResponsesHistory", items: "nope" } })).toEqual([]);
		expect(extractImageGenerationResults(null)).toEqual([]);
	});

	it("supports data URIs and pure base64 while inferring MIME from data URI or output_format", () => {
		const results = extractImageGenerationResults({
			providerPayload: {
				type: "openaiResponsesHistory",
				items: [
					{ type: "image_generation_call", result: `data:image/png;base64,${ONE_BY_ONE_PNG}` },
					{ type: "image_generation_call", result: ONE_BY_ONE_JPEG, output_format: "jpeg" },
				],
			},
		});

		expect(results.map((result) => result.mimeType)).toEqual(["image/png", "image/jpeg"]);
		expect(results.map((result) => result.outputFormat)).toEqual(["png", "jpeg"]);
		expect(results[0]?.result).toBe(ONE_BY_ONE_PNG);
		expect(results[1]?.result).toBe(ONE_BY_ONE_JPEG);
	});
});

describe("image result persistence", () => {
	it("saves decoded bytes to outputDirectory before artifactDirectory before agentImageDirectory", async () => {
		const dir = await makeTempDir();
		const outputDirectory = path.join(dir, "configured-output");
		const artifactDirectory = path.join(dir, "artifact-output");
		const agentImageDirectory = path.join(dir, "agent-output");

		const saved = await saveImageResult(imageResult(), { outputDirectory, artifactDirectory, agentImageDirectory });

		expect(saved.path.startsWith(outputDirectory)).toBe(true);
		expect(saved.path.endsWith(".png")).toBe(true);
		expect(saved.mimeType).toBe("image/png");
		expect(saved.bytes).toBe(Buffer.from(ONE_BY_ONE_PNG, "base64").byteLength);
		expect(saved.reusedExisting).toBe(false);
		expect(await fs.readFile(saved.path)).toEqual(Buffer.from(ONE_BY_ONE_PNG, "base64"));

		await expect(fs.stat(artifactDirectory)).rejects.toThrow();
		await expect(fs.stat(agentImageDirectory)).rejects.toThrow();
	});

	it("falls back from artifactDirectory to agentImageDirectory when higher priority locations are absent", async () => {
		const dir = await makeTempDir();
		const artifactSaved = await saveImageResult(imageResult(), { artifactDirectory: path.join(dir, "artifact") });
		const agentSaved = await saveImageResult(imageResult(), { agentImageDirectory: path.join(dir, "agent") });

		expect(artifactSaved.path.startsWith(path.join(dir, "artifact"))).toBe(true);
		expect(agentSaved.path.startsWith(path.join(dir, "agent"))).toBe(true);
	});

	it("uses SHA-256 of decoded bytes for stable filenames and reuses an existing same-hash file", async () => {
		const dir = await makeTempDir();
		const expectedHash = crypto.createHash("sha256").update(Buffer.from(ONE_BY_ONE_PNG, "base64")).digest("hex");

		const first = await saveImageResult(imageResult(), { outputDirectory: dir });
		await fs.writeFile(first.path, Buffer.from("sentinel"));
		const second = await saveImageResult(imageResult(), { outputDirectory: dir });

		expect(path.basename(first.path)).toBe(`${expectedHash}.png`);
		expect(second).toEqual({ ...first, bytes: Buffer.from(ONE_BY_ONE_PNG, "base64").byteLength, reusedExisting: true });
		expect(await fs.readFile(first.path, "utf8")).toBe("sentinel");
	});

	it("uses jpg extension for jpeg output and webp extension for webp output", async () => {
		const dir = await makeTempDir();
		const jpeg = await saveImageResult(imageResult({ result: ONE_BY_ONE_JPEG, mimeType: "image/jpeg", outputFormat: "jpeg" }), {
			outputDirectory: path.join(dir, "jpeg"),
		});
		const webp = await saveImageResult(imageResult({ mimeType: "image/webp", outputFormat: "webp" }), {
			outputDirectory: path.join(dir, "webp"),
		});

		expect(jpeg.path.endsWith(".jpg")).toBe(true);
		expect(webp.path.endsWith(".webp")).toBe(true);
	});

	it("strips whitespace before base64 decoding and throws on invalid decoded bytes", async () => {
		const dir = await makeTempDir();
		const spaced = await saveImageResult(imageResult({ result: ` data:image/png;base64,\n${ONE_BY_ONE_PNG.slice(0, 12)} \n${ONE_BY_ONE_PNG.slice(12)} ` }), {
			outputDirectory: dir,
		});
		expect(spaced.bytes).toBe(Buffer.from(ONE_BY_ONE_PNG, "base64").byteLength);

		await expect(saveImageResult(imageResult({ result: "not-base64!" }), { outputDirectory: dir })).rejects.toThrow(
			/invalid|empty/i,
		);
	});
});

describe("image result keys and messages", () => {
	it("uses provider id in the session-scoped key when present and a stable result hash when absent", () => {
		const withId = imageResultKey("session-1", imageResult({ id: "ig_123" }));
		const withoutId = imageResultKey("session-1", imageResult({ id: undefined }));
		const withoutIdAgain = imageResultKey("session-1", imageResult({ id: undefined }));

		expect(withId).toBe("session-1:provider:ig_123");
		expect(withoutId).toBe(withoutIdAgain);
		expect(withoutId).toStartWith("session-1:hash:");
		expect(withoutId).not.toContain(ONE_BY_ONE_PNG);
	});

	it("builds a visible custom message with path, bytes, mime, details, and no base64 content", () => {
		const message = buildImageMessage(
			imageResult({ revisedPrompt: "A tiny PNG.", size: "1024x1024", quality: "high" }),
			{ path: "C:/tmp/provider-image.png", bytes: 68, mimeType: "image/png", sha256: "abc123", reusedExisting: false },
		);

		expect(message).toMatchObject({
			customType: PROVIDER_IMAGE_MESSAGE_TYPE,
			display: true,
			attribution: "agent",
			details: {
				id: "ig_1",
				path: "C:/tmp/provider-image.png",
				bytes: 68,
				mimeType: "image/png",
				outputFormat: "png",
				size: "1024x1024",
				quality: "high",
				reusedExisting: false,
			},
		});
		expect(message.content).toContain("C:/tmp/provider-image.png");
		expect(message.content).toContain("68 bytes");
		expect(message.content).toContain("image/png");
		expect(message.content).toContain("A tiny PNG.");
		expect(message.content).not.toContain(ONE_BY_ONE_PNG);
		expect(JSON.stringify(message.details)).not.toContain(ONE_BY_ONE_PNG);
	});

	it("builds a visible error message without base64", () => {
		const message = buildImageErrorMessage(imageResult({ result: `data:image/png;base64,${ONE_BY_ONE_PNG}` }), new Error("disk full"));

		expect(message.customType).toBe(PROVIDER_IMAGE_MESSAGE_TYPE);
		expect(message.display).toBe(true);
		expect(message.content).toContain("disk full");
		expect(message.content).not.toContain(ONE_BY_ONE_PNG);
		expect(JSON.stringify(message.details)).not.toContain(ONE_BY_ONE_PNG);
	});
});