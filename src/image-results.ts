import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const PROVIDER_IMAGE_MESSAGE_TYPE = "openai-provider-image-generation";

export interface ProviderImageGenerationResult {
	id?: string;
	result: string;
	revisedPrompt?: string;
	outputFormat?: "png" | "jpeg" | "webp";
	mimeType?: "image/png" | "image/jpeg" | "image/webp";
	size?: string;
	quality?: string;
}

export interface SaveImageLocations {
	outputDirectory?: string;
	artifactDirectory?: string;
	agentImageDirectory?: string;
}

export interface SavedImageResult {
	path: string;
	bytes: number;
	mimeType: "image/png" | "image/jpeg" | "image/webp";
	sha256: string;
	reusedExisting: boolean;
}

export interface SavedProviderImageResult {
	result: ProviderImageGenerationResult;
	saved: SavedImageResult;
}

export interface FailedProviderImageResult {
	result: ProviderImageGenerationResult;
	error: unknown;
}

export interface ProviderImageMessage {
	customType: typeof PROVIDER_IMAGE_MESSAGE_TYPE;
	display: true;
	attribution: "agent";
	content: string;
	details: Record<string, unknown>;
}

type SupportedMimeType = NonNullable<ProviderImageGenerationResult["mimeType"]>;
type SupportedOutputFormat = NonNullable<ProviderImageGenerationResult["outputFormat"]>;

const DATA_URI_PATTERN = /^data:([^;,]+);base64,(.*)$/is;
const MIME_BY_FORMAT: Record<SupportedOutputFormat, SupportedMimeType> = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
};
const EXTENSION_BY_MIME: Record<SupportedMimeType, "png" | "jpg" | "webp"> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
};

export function extractImageGenerationResults(message: unknown): ProviderImageGenerationResult[] {
	if (!isRecord(message)) return [];
	const providerPayload = message.providerPayload;
	if (!isRecord(providerPayload)) return [];
	if (providerPayload.type !== "openaiResponsesHistory") return [];
	if (!Array.isArray(providerPayload.items)) return [];

	const results: ProviderImageGenerationResult[] = [];
	for (const item of providerPayload.items) {
		if (!isRecord(item)) continue;
		if (item.type !== "image_generation_call") continue;
		if (typeof item.result !== "string") continue;

		const decoded = normalizeImageResultInput(item.result);
		const outputFormat = parseOutputFormat(item.output_format) ?? outputFormatFromMime(decoded.mimeType);
		const mimeType = decoded.mimeType ?? mimeFromOutputFormat(outputFormat);
		results.push({
			id: typeof item.id === "string" ? item.id : undefined,
			result: decoded.base64,
			revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
			outputFormat,
			mimeType,
			size: typeof item.size === "string" ? item.size : undefined,
			quality: typeof item.quality === "string" ? item.quality : undefined,
		});
	}

	return results;
}

export function imageResultKey(
	runtimeSessionId: string,
	result: Pick<ProviderImageGenerationResult, "id" | "result" | "mimeType">,
): string {
	if (result.id) {
		return `${runtimeSessionId}:provider:${result.id}`;
	}
	const decoded = decodeImageResult(result);
	return `${runtimeSessionId}:hash:${decoded.sha256}`;
}

export async function saveImageResult(
	result: ProviderImageGenerationResult,
	locations: SaveImageLocations,
): Promise<SavedImageResult> {
	const directory = locations.outputDirectory ?? locations.artifactDirectory ?? locations.agentImageDirectory;
	if (!directory) {
		throw new Error("No image output directory is available.");
	}

	const decoded = decodeImageResult(result);
	const extension = EXTENSION_BY_MIME[decoded.mimeType];
	const filePath = path.join(directory, `${decoded.sha256}.${extension}`);

	await fs.mkdir(directory, { recursive: true });
	try {
		await fs.access(filePath);
		return {
			path: filePath,
			bytes: decoded.bytes.byteLength,
			mimeType: decoded.mimeType,
			sha256: decoded.sha256,
			reusedExisting: true,
		};
	} catch (error) {
		if (!isNotFoundError(error)) throw error;
	}

	await fs.writeFile(filePath, decoded.bytes, { flag: "wx" });
	return {
		path: filePath,
		bytes: decoded.bytes.byteLength,
		mimeType: decoded.mimeType,
		sha256: decoded.sha256,
		reusedExisting: false,
	};
}

export function saveImageResultSync(
	result: ProviderImageGenerationResult,
	locations: SaveImageLocations,
): SavedImageResult {
	const directory = locations.outputDirectory ?? locations.artifactDirectory ?? locations.agentImageDirectory;
	if (!directory) {
		throw new Error("No image output directory is available.");
	}

	const decoded = decodeImageResult(result);
	const extension = EXTENSION_BY_MIME[decoded.mimeType];
	const filePath = path.join(directory, `${decoded.sha256}.${extension}`);

	fsSync.mkdirSync(directory, { recursive: true });
	try {
		fsSync.writeFileSync(filePath, decoded.bytes, { flag: "wx" });
		return {
			path: filePath,
			bytes: decoded.bytes.byteLength,
			mimeType: decoded.mimeType,
			sha256: decoded.sha256,
			reusedExisting: false,
		};
	} catch (error) {
		if (!isAlreadyExistsError(error)) throw error;
		return {
			path: filePath,
			bytes: decoded.bytes.byteLength,
			mimeType: decoded.mimeType,
			sha256: decoded.sha256,
			reusedExisting: true,
		};
	}
}

export function buildImageMessage(result: ProviderImageGenerationResult, saved: SavedImageResult): ProviderImageMessage {
	return buildImageSummaryMessage([{ result, saved }]);
}

export function buildImageSummaryMessage(savedResults: SavedProviderImageResult[]): ProviderImageMessage {
	const images = savedResults.map(({ result, saved }) => imageDetails(result, saved));
	const lines = [
		`OpenAI provider saved ${images.length === 1 ? "1 image_generation result" : `${images.length} image_generation results`}.`,
	];
	if (images.length === 1) {
		lines.push(`Image: ${images[0]?.path ?? "unknown"}`);
	} else {
		lines.push("Images:");
		for (const image of images) lines.push(`- ${image.path}`);
	}

	return {
		customType: PROVIDER_IMAGE_MESSAGE_TYPE,
		display: true,
		attribution: "agent",
		content: lines.join("\n"),
		details: withoutUndefined({
			path: images[0]?.path,
			mimeType: images[0]?.mimeType,
			images,
		}),
	};
}

export function buildImageErrorMessage(result: ProviderImageGenerationResult, error: unknown): ProviderImageMessage {
	return buildImageErrorSummaryMessage([{ result, error }]);
}

export function buildImageErrorSummaryMessage(failedResults: FailedProviderImageResult[]): ProviderImageMessage {
	const failures = failedResults.map(({ result, error }) => {
		const message = error instanceof Error ? error.message : String(error);
		return withoutUndefined({
			id: result.id,
			mimeType: result.mimeType,
			outputFormat: result.outputFormat,
			size: result.size,
			quality: result.quality,
			error: message,
		});
	});
	const lines = [
		`OpenAI provider returned ${failures.length === 1 ? "an image_generation result" : `${failures.length} image_generation results`}, but ${failures.length === 1 ? "it" : "they"} could not be saved.`,
	];
	for (const failure of failures) lines.push(`Error: ${failure.error}`);
	return {
		customType: PROVIDER_IMAGE_MESSAGE_TYPE,
		display: true,
		attribution: "agent",
		content: lines.join("\n"),
		details: { failures },
	};
}

function imageDetails(result: ProviderImageGenerationResult, saved: SavedImageResult): Record<string, unknown> {
	return withoutUndefined({
		id: result.id,
		path: saved.path,
		bytes: saved.bytes,
		mimeType: saved.mimeType,
		outputFormat: result.outputFormat,
		size: result.size,
		quality: result.quality,
		revisedPrompt: result.revisedPrompt,
		sha256: saved.sha256,
		reusedExisting: saved.reusedExisting,
	});
}

function decodeImageResult(result: Pick<ProviderImageGenerationResult, "result" | "mimeType" | "outputFormat">): {
	bytes: Buffer;
	mimeType: SupportedMimeType;
	sha256: string;
} {
	const normalized = normalizeImageResultInput(result.result);
	const base64 = normalized.base64;
	if (!base64) {
		throw new Error("Image result base64 is empty.");
	}
	if (!isValidBase64(base64)) {
		throw new Error("Image result base64 is invalid.");
	}

	const bytes = Buffer.from(base64, "base64");
	if (bytes.byteLength === 0) {
		throw new Error("Image result decoded to empty bytes.");
	}

	const mimeType = result.mimeType ?? normalized.mimeType ?? mimeFromOutputFormat(result.outputFormat) ?? inferMimeFromBytes(bytes);
	if (!mimeType) {
		throw new Error("Image result MIME type could not be inferred.");
	}

	return {
		bytes,
		mimeType,
		sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
	};
}

function normalizeImageResultInput(input: string): { base64: string; mimeType?: SupportedMimeType } {
	const trimmed = input.trim();
	const match = DATA_URI_PATTERN.exec(trimmed);
	if (match) {
		const mimeType = parseMimeType(match[1]);
		return { base64: stripBase64Whitespace(match[2] ?? ""), mimeType };
	}
	return { base64: stripBase64Whitespace(trimmed) };
}

function stripBase64Whitespace(input: string): string {
	return input.replace(/\s+/g, "");
}

function isValidBase64(input: string): boolean {
	if (!input) return false;
	if (input.length % 4 === 1) return false;
	return /^[A-Za-z0-9+/]*={0,2}$/.test(input);
}

function parseMimeType(value: unknown): SupportedMimeType | undefined {
	if (value === "image/png" || value === "image/jpeg" || value === "image/webp") return value;
	return undefined;
}

function parseOutputFormat(value: unknown): SupportedOutputFormat | undefined {
	if (value === "png" || value === "jpeg" || value === "webp") return value;
	return undefined;
}

function mimeFromOutputFormat(format: SupportedOutputFormat | undefined): SupportedMimeType | undefined {
	return format ? MIME_BY_FORMAT[format] : undefined;
}

function outputFormatFromMime(mimeType: SupportedMimeType | undefined): SupportedOutputFormat | undefined {
	if (mimeType === "image/png") return "png";
	if (mimeType === "image/jpeg") return "jpeg";
	if (mimeType === "image/webp") return "webp";
	return undefined;
}

function inferMimeFromBytes(bytes: Buffer): SupportedMimeType | undefined {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function isNotFoundError(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
	return isRecord(error) && error.code === "EEXIST";
}