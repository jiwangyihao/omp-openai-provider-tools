import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const PROVIDER_IMAGE_MESSAGE_TYPE = "openai-provider-image-generation";

const DEFAULT_LOCAL_FALLBACK_TOOLS = ["web_search", "generate_image"];

type UnknownRecord = Record<string, unknown>;

type ModelLike = {
	api?: unknown;
	provider?: unknown;
	baseUrl?: unknown;
};

type SessionManagerLike = {
	getArtifactsDir(): string | null;
};

export type ImageOutputFormat = "png" | "jpeg" | "jpg" | "webp";

export interface ProviderToolInjectionOptions {
	enableWebSearch?: boolean;
	enableImageGeneration?: boolean;
	webSearchContextSize?: "low" | "medium" | "high";
	imageOutputFormat?: Exclude<ImageOutputFormat, "jpg">;
}

export interface ProviderToolInjectionResult {
	injectedWebSearch: boolean;
	injectedImageGeneration: boolean;
}

export interface ProviderImageGenerationResult {
	id?: string;
	result: string;
	revisedPrompt?: string;
	outputFormat?: ImageOutputFormat;
	mimeType: string;
	size?: string;
	quality?: string;
}

export interface SavedImageResult {
	path: string;
	bytes: number;
	reusedExisting: boolean;
}

export interface SaveImageContext {
	cwd: string;
	sessionManager: SessionManagerLike;
}

export interface ProviderImageMessage {
	customType: typeof PROVIDER_IMAGE_MESSAGE_TYPE;
	content: string;
	display: true;
	attribution: "agent";
	details: {
		id?: string;
		path: string;
		bytes: number;
		mimeType: string;
		outputFormat?: ImageOutputFormat;
		size?: string;
		quality?: string;
		revisedPrompt?: string;
		reusedExisting: boolean;
	};
}

function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}


export function shouldEnableForModel(model: unknown): boolean {
	if (!isRecord(model)) return false;
	const candidate = model as ModelLike;
	if (candidate.api !== "openai-responses") return false;

	return false;
}

export function removeLocalFallbackTools(
	activeTools: readonly string[],
	fallbackTools: readonly string[] = DEFAULT_LOCAL_FALLBACK_TOOLS,
): string[] {
	const fallbackSet = new Set(fallbackTools.map(tool => tool.toLowerCase()));
	return activeTools.filter(tool => !fallbackSet.has(tool.toLowerCase()));
}

export function injectOpenAIResponsesProviderTools(
	payload: unknown,
	options: ProviderToolInjectionOptions = {},
): ProviderToolInjectionResult {
	const result: ProviderToolInjectionResult = { injectedWebSearch: false, injectedImageGeneration: false };
	if (!isRecord(payload) || !Array.isArray(payload.tools)) return result;

	const tools = payload.tools as unknown[];
	const hasToolType = (type: string) => tools.some(tool => isRecord(tool) && tool.type === type);

	if (options.enableWebSearch !== false && !hasToolType("web_search")) {
		tools.push({
			type: "web_search",
			search_context_size: options.webSearchContextSize ?? "high",
		});
		result.injectedWebSearch = true;
	}

	if (options.enableImageGeneration !== false && !hasToolType("image_generation")) {
		tools.push({
			type: "image_generation",
			output_format: options.imageOutputFormat ?? "png",
		});
		result.injectedImageGeneration = true;
	}

	return result;
}

function stripDataUri(value: string): { base64: string; mimeType?: string } {
	const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
	if (!match) return { base64: value.replace(/\s+/g, "") };
	return { base64: match[2]?.replace(/\s+/g, "") ?? "", mimeType: match[1] };
}

function normalizeOutputFormat(value: unknown, mimeType: string | undefined): ImageOutputFormat | undefined {
	if (typeof value === "string") {
		const normalized = value.toLowerCase();
		if (normalized === "png" || normalized === "jpeg" || normalized === "jpg" || normalized === "webp") return normalized;
	}
	if (mimeType === "image/png") return "png";
	if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpeg";
	if (mimeType === "image/webp") return "webp";
	return undefined;
}

function mimeTypeForFormat(format: ImageOutputFormat | undefined, explicitMimeType: string | undefined): string {
	if (explicitMimeType?.startsWith("image/")) return explicitMimeType;
	if (format === "jpeg" || format === "jpg") return "image/jpeg";
	if (format === "webp") return "image/webp";
	return "image/png";
}

function extensionForFormat(format: ImageOutputFormat | undefined, mimeType: string): string {
	if (format === "jpeg" || format === "jpg" || mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
	if (format === "webp" || mimeType === "image/webp") return "webp";
	return "png";
}

export function extractImageGenerationResults(message: unknown): ProviderImageGenerationResult[] {
	if (!isRecord(message)) return [];
	const providerPayload = message.providerPayload;
	if (!isRecord(providerPayload) || providerPayload.type !== "openaiResponsesHistory" || !Array.isArray(providerPayload.items)) {
		return [];
	}

	const results: ProviderImageGenerationResult[] = [];
	for (const item of providerPayload.items) {
		if (!isRecord(item) || item.type !== "image_generation_call") continue;
		const rawResult = asString(item.result);
		if (!rawResult) continue;
		const stripped = stripDataUri(rawResult);
		if (!stripped.base64) continue;
		const outputFormat = normalizeOutputFormat(item.output_format, stripped.mimeType);
		results.push({
			id: asString(item.id),
			result: stripped.base64,
			revisedPrompt: asString(item.revised_prompt),
			outputFormat,
			mimeType: mimeTypeForFormat(outputFormat, stripped.mimeType),
			size: asString(item.size),
			quality: asString(item.quality),
		});
	}
	return results;
}

export function imageResultKey(result: ProviderImageGenerationResult): string {
	return result.id ? `id:${result.id}` : `sha256:${createHash("sha256").update(result.result).digest("hex")}`;
}

export async function saveImageResult(result: ProviderImageGenerationResult, ctx: SaveImageContext): Promise<SavedImageResult> {
	const bytes = Buffer.from(result.result, "base64");
	if (bytes.byteLength === 0) {
		throw new Error("Provider image_generation_call result was empty after base64 decoding.");
	}

	const baseDir = ctx.sessionManager.getArtifactsDir() ?? path.join(ctx.cwd, ".omp", "provider-tool-images");
	await fs.mkdir(baseDir, { recursive: true });

	const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
	const extension = extensionForFormat(result.outputFormat, result.mimeType);
	const filePath = path.join(baseDir, `provider-image-${digest}.${extension}`);

	try {
		await fs.writeFile(filePath, bytes, { flag: "wx" });
		return { path: filePath, bytes: bytes.byteLength, reusedExisting: false };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return { path: filePath, bytes: bytes.byteLength, reusedExisting: true };
		}
		throw error;
	}
}

export function buildImageMessage(result: ProviderImageGenerationResult, saved: SavedImageResult): ProviderImageMessage {
	const lines = [
		"Provider-native image generation completed.",
		`Saved image: ${saved.path}`,
		`MIME type: ${result.mimeType}`,
		`Bytes: ${saved.bytes}`,
	];
	if (result.size) lines.push(`Size: ${result.size}`);
	if (result.quality) lines.push(`Quality: ${result.quality}`);
	if (result.revisedPrompt) lines.push("", "Revised prompt:", result.revisedPrompt);

	return {
		customType: PROVIDER_IMAGE_MESSAGE_TYPE,
		content: lines.join("\n"),
		display: true,
		attribution: "agent",
		details: {
			id: result.id,
			path: saved.path,
			bytes: saved.bytes,
			mimeType: result.mimeType,
			outputFormat: result.outputFormat,
			size: result.size,
			quality: result.quality,
			revisedPrompt: result.revisedPrompt,
			reusedExisting: saved.reusedExisting,
		},
	};
}
