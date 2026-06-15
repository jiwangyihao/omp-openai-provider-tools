import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { PROVIDER_IMAGE_MESSAGE_TYPE } from "./image-results";

interface ComponentLike {
	render(width: number): string[];
	invalidate(): void;
}

interface ContainerLike extends ComponentLike {
	addChild(component: ComponentLike): void;
}


interface TuiLike {
	Container: new () => ContainerLike;
	Box: new (paddingX?: number, paddingY?: number, bgFn?: (text: string) => string) => ContainerLike;
	Spacer: new (height?: number) => ComponentLike;
	Text: new (text?: string, paddingX?: number, paddingY?: number, customBgFn?: (text: string) => string) => ComponentLike;
	Image?: new (
		base64Data: string,
		mimeType: string,
		theme: { fallbackColor: (text: string) => string },
		options?: { maxWidthCells?: number; maxHeightCells?: number; filename?: string },
	) => ComponentLike;
}

interface RuntimeImageComponent extends ComponentLike {
	setToolResultImages?: (toolCallId: string, images: RuntimeImageContent[]) => void;
}

interface RuntimeImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

interface RuntimePiLike {
	VERSION?: string;
	AssistantMessageComponent?: new (message?: unknown) => RuntimeImageComponent;
}

interface RendererApiLike {
	registerMessageRenderer?: (customType: string, renderer: (message: unknown, options: { expanded: boolean }, theme: unknown) => ComponentLike | undefined) => void;
	logger?: { warn?: (...args: unknown[]) => void };
	pi?: RuntimePiLike;
}

interface ProviderImageDetail {
	id?: string;
	path: string;
	bytes?: number;
	mimeType?: string;
	outputFormat?: string;
	size?: string;
	quality?: string;
	revisedPrompt?: string;
	sha256?: string;
	reusedExisting?: boolean;
}

let tuiModule: TuiLike | undefined;
let tuiLoadStarted = false;

export function registerProviderImageRenderer(api: RendererApiLike, tuiOverride?: TuiLike, loadTui: () => Promise<TuiLike | undefined> = () => loadProviderImageTui(api)): void {
	if (!api.registerMessageRenderer) return;
	api.registerMessageRenderer(PROVIDER_IMAGE_MESSAGE_TYPE, (message, options, theme) => {
		const Tui = tuiOverride ?? tuiModule;
		if (!Tui) void ensureTuiLoaded(loadTui);
		return renderProviderImageMessage(message, options, theme, Tui, api.pi);
	});
}

async function loadProviderImageTui(api: RendererApiLike): Promise<TuiLike | undefined> {
	try {
		return await loadTuiModule(api.pi?.VERSION);
	} catch (error) {
		api.logger?.warn?.("OpenAI provider image preview renderer is unavailable", error);
		return undefined;
	}
}

async function ensureTuiLoaded(loadTui: () => Promise<TuiLike | undefined>): Promise<void> {
	if (tuiLoadStarted) return;
	tuiLoadStarted = true;
	const loaded = await loadTui();
	if (loaded) tuiModule = loaded;
}

async function loadTuiModule(runtimeVersion?: string): Promise<TuiLike> {
	for (const specifier of runtimeTuiSpecifiers(runtimeVersion)) {
		try {
			return await import(specifier) as TuiLike;
		} catch {
			// Try the next runtime package location.
		}
	}
	throw new Error("No compatible pi-tui runtime package was found.");
}

export function runtimeTuiSpecifiers(runtimeVersion?: string, cacheRoot = path.join(os.homedir(), ".bun", "install", "cache")): string[] {
	const specifiers = ["@oh-my-pi/pi-tui", "@mariozechner/pi-tui"];
	const cacheSpecifiers: Array<{ specifier: string; version?: string }> = [];
	const normalizedRuntimeVersion = normalizeRuntimeVersion(runtimeVersion);
	for (const scope of ["@oh-my-pi", "@mariozechner"]) {
		const scopeDir = path.join(cacheRoot, scope);
		try {
			for (const entry of fs.readdirSync(scopeDir)) {
				if (!entry.startsWith("pi-tui@")) continue;
				const indexPath = path.join(scopeDir, entry, "src", "index.ts");
				if (fs.existsSync(indexPath)) {
					cacheSpecifiers.push({ specifier: pathToFileURL(indexPath).href, version: cachedTuiVersion(entry) });
				}
			}
		} catch {
			// Cache layout is best-effort only.
		}
	}
	cacheSpecifiers.sort((left, right) => compareCachedTuiSpecifiers(left, right, normalizedRuntimeVersion));
	specifiers.push(...cacheSpecifiers.map(candidate => candidate.specifier));
	return specifiers;
}

function cachedTuiVersion(entry: string): string | undefined {
	const match = /^pi-tui@(\d+\.\d+\.\d+)(?:@@@\d+)?$/u.exec(entry);
	return match?.[1];
}

function normalizeRuntimeVersion(version: string | undefined): string | undefined {
	if (!version) return undefined;
	const match = /(\d+\.\d+\.\d+)/u.exec(version);
	return match?.[1];
}

function compareCachedTuiSpecifiers(
	left: { specifier: string; version?: string },
	right: { specifier: string; version?: string },
	runtimeVersion?: string,
): number {
	if (runtimeVersion) {
		const leftMatches = left.version === runtimeVersion;
		const rightMatches = right.version === runtimeVersion;
		if (leftMatches !== rightMatches) return leftMatches ? -1 : 1;
	}
	const versionOrder = compareVersionsDescending(left.version, right.version);
	if (versionOrder !== 0) return versionOrder;
	return left.specifier.localeCompare(right.specifier);
}

function compareVersionsDescending(left?: string, right?: string): number {
	const leftParts = versionParts(left);
	const rightParts = versionParts(right);
	for (let index = 0; index < 3; index++) {
		const diff = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function versionParts(version?: string): number[] {
	return version?.split(".").map(part => Number.parseInt(part, 10)).map(part => Number.isFinite(part) ? part : 0) ?? [];
}

function renderProviderImageMessage(
	message: unknown,
	options: { expanded: boolean },
	theme: unknown,
	Tui: TuiLike | undefined,
	runtimePi: RuntimePiLike | undefined,
): ComponentLike | undefined {
	const text = imageSummary(message) || messageContent(message);
	const images = imageDetails(message);
	if (!Tui) return undefined;
	const detailLines = expandedImageDetailLines(images);
	const runtimeImagePreview = buildRuntimeImagePreview(runtimePi, images);
	if (runtimeImagePreview) {
		return runtimeImageBox(
			theme,
			messageCustomType(message),
			text || "OpenAI provider image_generation result",
			runtimeImagePreview,
			detailLines,
			options.expanded,
		);
	}

	return directImageBox(
		theme,
		messageCustomType(message),
		text || "OpenAI provider image_generation result",
		images,
		detailLines,
		options.expanded,
		Tui,
	);
}

function runtimeImageBox(
	theme: unknown,
	customType: string,
	text: string,
	runtimeImagePreview: ComponentLike,
	detailLines: string[],
	expanded: boolean,
): ComponentLike {
	return {
		render(width: number): string[] {
			const lines: string[] = [];
			const label = color(theme, "customMessageLabel", bold(theme, `[${customType}]`));
			lines.push(backgroundLine(theme, "", width));
			lines.push(backgroundLine(theme, label, width));
			if (!expanded && detailLines.length > 0) {
				lines.push(backgroundLine(theme, expandHint(theme), width));
			}
			if (expanded) {
				for (const line of color(theme, "customMessageText", text).split("\n")) {
					lines.push(backgroundLine(theme, line, width));
				}
				if (detailLines.length > 0) {
					for (const line of color(theme, "customMessageText", detailLines.join("\n")).split("\n")) {
						lines.push(backgroundLine(theme, line, width));
					}
				}
			}
			lines.push(backgroundLine(theme, "", width));
			lines.push(...backgroundRuntimeImageLines(theme, runtimeImagePreview.render(width), width));
			return lines;
		},
		invalidate() {
			runtimeImagePreview.invalidate();
		},
	};
}

function directImageBox(
	theme: unknown,
	customType: string,
	text: string,
	images: ProviderImageDetail[],
	detailLines: string[],
	expanded: boolean,
	Tui: TuiLike,
): ComponentLike {
	const imageComponents = images.flatMap(image => {
		const component = buildImagePreview(Tui, image, theme, expanded);
		return component ? [component] : [];
	});
	return {
		render(width: number): string[] {
			const lines: string[] = [];
			const label = color(theme, "customMessageLabel", bold(theme, `[${customType}]`));
			lines.push(backgroundLine(theme, "", width));
			lines.push(backgroundLine(theme, label, width));
			if (!expanded && detailLines.length > 0) {
				lines.push(backgroundLine(theme, expandHint(theme), width));
			}
			if (expanded) {
				for (const line of color(theme, "customMessageText", text).split("\n")) {
					lines.push(backgroundLine(theme, line, width));
				}
				if (detailLines.length > 0) {
					for (const line of color(theme, "customMessageText", detailLines.join("\n")).split("\n")) {
						lines.push(backgroundLine(theme, line, width));
					}
				}
			}
			if (imageComponents.length > 0) {
				lines.push(backgroundLine(theme, "", width));
				for (const component of imageComponents) {
					lines.push(...backgroundImageComponentLines(theme, component.render(width), width));
				}
			}
			return lines;
		},
		invalidate() {
			for (const component of imageComponents) component.invalidate();
		},
	};
}

function backgroundRuntimeImageLines(theme: unknown, imageLines: string[], width: number): string[] {
	return normalizeRuntimeImageLines(imageLines).map(line => isBlankRenderLine(line) ? backgroundLine(theme, "", width) : line);
}

function backgroundImageComponentLines(theme: unknown, imageLines: string[], width: number): string[] {
	return normalizeRuntimeImageLines(imageLines).map(line => isImageProtocolLine(line) ? line : backgroundLine(theme, line, width));
}

function normalizeRuntimeImageLines(imageLines: string[]): string[] {
	const lines = [...imageLines];
	for (let ordinal = protocolLineIndexes(lines).length - 1; ordinal >= 0; ordinal--) {
		const protocolLineIndex = protocolLineIndexes(lines)[ordinal];
		if (protocolLineIndex === undefined) continue;
		const requiredBlankRows = imageCursorUpRows(lines[protocolLineIndex] ?? "") ?? 0;
		let blankRunStart = protocolLineIndex;
		while (blankRunStart > 0 && isBlankRenderLine(lines[blankRunStart - 1] ?? "")) blankRunStart--;
		const blankRunLength = protocolLineIndex - blankRunStart;
		const extraBlankRows = Math.max(0, blankRunLength - requiredBlankRows);
		if (extraBlankRows > 0) {
			lines.splice(blankRunStart, extraBlankRows);
		}
	}

	const finalProtocolLineIndex = protocolLineIndexes(lines).at(-1);
	if (finalProtocolLineIndex === undefined) return lines;
	let trailingIndex = finalProtocolLineIndex + 1;
	while (trailingIndex < lines.length && isBlankRenderLine(lines[trailingIndex] ?? "")) trailingIndex++;
	if (trailingIndex > finalProtocolLineIndex + 1) {
		lines.splice(finalProtocolLineIndex + 1, trailingIndex - finalProtocolLineIndex - 1);
	}
	return lines;
}

function protocolLineIndexes(lines: string[]): number[] {
	return lines.flatMap((line, index) => isImageProtocolLine(line) ? [index] : []);
}

function isImageProtocolLine(line: string): boolean {
	const prefix = line.slice(0, 128);
	return prefix.includes("\x1b_G") || prefix.includes("\x1b]1337;File=") || /\x1bP(?:[0-9;]*)q/u.test(prefix);
}

function imageCursorUpRows(line: string): number | undefined {
	const match = /^\x1b\[(\d+)A/u.exec(line);
	return match ? Number.parseInt(match[1] ?? "0", 10) : undefined;
}

function isBlankRenderLine(line: string): boolean {
	return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").trim().length === 0;
}

function buildRuntimeImagePreview(runtimePi: RuntimePiLike | undefined, images: ProviderImageDetail[]): ComponentLike | undefined {
	const AssistantMessageComponent = runtimePi?.AssistantMessageComponent;
	if (!AssistantMessageComponent || images.length === 0) return undefined;
	const imageContents = images.flatMap(image => {
		try {
			return [{
				type: "image" as const,
				data: fs.readFileSync(image.path).toString("base64"),
				mimeType: image.mimeType ?? "image/png",
			}];
		} catch {
			return [];
		}
	});
	if (imageContents.length === 0) return undefined;
	const component = new AssistantMessageComponent({ content: [] });
	if (typeof component.setToolResultImages !== "function") return undefined;
	component.setToolResultImages(PROVIDER_IMAGE_MESSAGE_TYPE, imageContents);
	return component;
}

function buildImagePreview(Tui: TuiLike, image: ProviderImageDetail, theme: unknown, expanded: boolean): ComponentLike | undefined {
	if (!image.path) return undefined;
	if (!Tui.Image) {
		return new Tui.Text(color(theme, "toolOutput", unavailableImagePreviewText(image.path)), 0, 0);
	}
	try {
		const base64 = fs.readFileSync(image.path).toString("base64");
		return new Tui.Image(base64, image.mimeType ?? "image/png", {
			fallbackColor: (value: string) => color(theme, "toolOutput", value),
		}, {
			maxWidthCells: expanded ? 96 : 72,
			maxHeightCells: expanded ? 32 : 20,
			filename: path.basename(image.path),
		});
	} catch {
		return new Tui.Text(color(theme, "toolOutput", unavailableImagePreviewText(image.path)), 0, 0);
	}
}

function unavailableImagePreviewText(filePath: string): string {
	return `图片预览不可用：${path.basename(filePath)}`;
}

function expandedImageDetailLines(images: ProviderImageDetail[]): string[] {
	if (images.length === 0) return [];
	const lines: string[] = [];
	for (let index = 0; index < images.length; index++) {
		const image = images[index];
		if (!image) continue;
		if (images.length > 1) lines.push(`Image ${index + 1}:`);
		lines.push(`File: ${path.basename(image.path)}`);
		if (image.mimeType) lines.push(`MIME: ${image.mimeType}`);
		if (typeof image.bytes === "number") lines.push(`Bytes: ${image.bytes}`);
		if (image.sha256) lines.push(`SHA-256: ${image.sha256}`);
		if (image.outputFormat) lines.push(`Output format: ${image.outputFormat}`);
		if (image.size) lines.push(`Size: ${image.size}`);
		if (image.quality) lines.push(`Quality: ${image.quality}`);
		if (image.id) lines.push(`ID: ${image.id}`);
		if (typeof image.reusedExisting === "boolean") lines.push(`Reused existing file: ${image.reusedExisting ? "yes" : "no"}`);
		if (image.revisedPrompt) lines.push(`Revised prompt: ${image.revisedPrompt}`);
		if (index < images.length - 1) lines.push("");
	}
	return lines;
}

function expandHint(theme: unknown): string {
	return color(theme, "dim", `${bracket(theme, "left")}(Ctrl+O for more)${bracket(theme, "right")}`);
}

function bracket(theme: unknown, side: "left" | "right"): string {
	if (theme && typeof theme === "object" && "format" in theme && typeof (theme as { format?: unknown }).format === "object") {
		const format = (theme as { format: { bracketLeft?: unknown; bracketRight?: unknown } }).format;
		const value = side === "left" ? format.bracketLeft : format.bracketRight;
		if (typeof value === "string") return value;
	}
	return side === "left" ? "[" : "]";
}

function backgroundLine(theme: unknown, value: string, width: number): string {
	const padded = padVisible(value, Math.max(0, width));
	return background(theme, "customMessageBg", padded);
}

function padVisible(value: string, width: number): string {
	const length = visibleLength(value);
	return `${value}${" ".repeat(Math.max(0, width - length))}`;
}

function visibleLength(value: string): number {
	return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}
function background(theme: unknown, key: string, value: string): string {
	if (theme && typeof theme === "object" && "bg" in theme && typeof (theme as { bg?: unknown }).bg === "function") {
		try {
			return ((theme as { bg: (key: string, value: string) => string }).bg)(key, value);
		} catch {
			return value;
		}
	}
	return value;
}

function bold(theme: unknown, value: string): string {
	if (theme && typeof theme === "object" && "bold" in theme && typeof (theme as { bold?: unknown }).bold === "function") {
		try {
			return ((theme as { bold: (value: string) => string }).bold)(value);
		} catch {
			return value;
		}
	}
	return value;
}

function messageCustomType(message: unknown): string {
	if (message && typeof message === "object" && typeof (message as { customType?: unknown }).customType === "string") {
		return (message as { customType: string }).customType;
	}
	return PROVIDER_IMAGE_MESSAGE_TYPE;
}

function color(theme: unknown, key: string, value: string): string {
	if (theme && typeof theme === "object" && "fg" in theme && typeof (theme as { fg?: unknown }).fg === "function") {
		try {
			return ((theme as { fg: (key: string, value: string) => string }).fg)(key, value);
		} catch {
			return value;
		}
	}
	return value;
}

function imageSummary(message: unknown): string {
	if (!isRecord(message)) return "";
	const details = message.details;
	if (!isRecord(details)) return "";
	return typeof details.summary === "string" ? details.summary : "";
}

function messageContent(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap(item => item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string" ? [(item as { text: string }).text] : [])
		.join("\n");
}

function imageDetails(message: unknown): ProviderImageDetail[] {
	if (!isRecord(message)) return [];
	const details = message.details;
	if (!isRecord(details)) return [];
	const images = details.images;
	if (Array.isArray(images)) {
		return images.flatMap(image => isRecord(image) && typeof image.path === "string" ? [imageDetailFromRecord(image)] : []);
	}
	return typeof details.path === "string" ? [imageDetailFromRecord(details)] : [];
}

function imageDetailFromRecord(record: Record<string, unknown>): ProviderImageDetail {
	return {
		path: String(record.path),
		id: stringField(record, "id"),
		bytes: numberField(record, "bytes"),
		mimeType: stringField(record, "mimeType"),
		outputFormat: stringField(record, "outputFormat"),
		size: stringField(record, "size"),
		quality: stringField(record, "quality"),
		revisedPrompt: stringField(record, "revisedPrompt"),
		sha256: stringField(record, "sha256"),
		reusedExisting: booleanField(record, "reusedExisting"),
	};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	return typeof record[key] === "string" ? record[key] : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	return typeof record[key] === "number" ? record[key] : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
	return typeof record[key] === "boolean" ? record[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
