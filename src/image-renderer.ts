import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { PROVIDER_IMAGE_MESSAGE_TYPE } from "./image-results";

interface ComponentLike {
	render(width: number): string[];
	invalidate(): void;
}

interface TuiLike {
	Container: new () => { addChild(component: ComponentLike): void } & ComponentLike;
	Text: new (text?: string, paddingX?: number, paddingY?: number, customBgFn?: (text: string) => string) => ComponentLike;
	Image?: new (
		base64Data: string,
		mimeType: string,
		theme: { fallbackColor: (text: string) => string },
		options?: { maxWidthCells?: number; maxHeightCells?: number; filename?: string },
	) => ComponentLike;
}

interface RendererApiLike {
	registerMessageRenderer?: (customType: string, renderer: (message: unknown, options: { expanded: boolean }, theme: unknown) => ComponentLike | undefined) => void;
	logger?: { warn?: (...args: unknown[]) => void };
}

let tuiModule: TuiLike | undefined;
let tuiLoadStarted = false;

export function registerProviderImageRenderer(api: RendererApiLike): void {
	if (!api.registerMessageRenderer) return;
	void ensureTuiLoaded(api);
	api.registerMessageRenderer(PROVIDER_IMAGE_MESSAGE_TYPE, (message, options, theme) => renderProviderImageMessage(message, options, theme));
}

async function ensureTuiLoaded(api: RendererApiLike): Promise<void> {
	if (tuiLoadStarted) return;
	tuiLoadStarted = true;
	try {
		tuiModule = await loadTuiModule();
	} catch (error) {
		api.logger?.warn?.("OpenAI provider image preview renderer is unavailable", error);
	}
}

async function loadTuiModule(): Promise<TuiLike> {
	for (const specifier of runtimeTuiSpecifiers()) {
		try {
			return await import(specifier) as TuiLike;
		} catch {
			// Try the next runtime package location.
		}
	}
	throw new Error("No compatible pi-tui runtime package was found.");
}

function runtimeTuiSpecifiers(): string[] {
	const specifiers = ["@oh-my-pi/pi-tui", "@mariozechner/pi-tui"];
	const cacheRoot = path.join(os.homedir(), ".bun", "install", "cache");
	for (const scope of ["@oh-my-pi", "@mariozechner"]) {
		const scopeDir = path.join(cacheRoot, scope);
		try {
			for (const entry of fs.readdirSync(scopeDir)) {
				if (!entry.startsWith("pi-tui@")) continue;
				const indexPath = path.join(scopeDir, entry, "src", "index.ts");
				if (fs.existsSync(indexPath)) specifiers.push(pathToFileURL(indexPath).href);
			}
		} catch {
			// Cache layout is best-effort only.
		}
	}
	return specifiers;
}

function renderProviderImageMessage(message: unknown, options: { expanded: boolean }, theme: unknown): ComponentLike | undefined {
	const text = messageContent(message);
	const images = imageDetails(message);
	const primary = images[0];
	const Tui = tuiModule;
	if (!Tui) {
		return textComponent(text || primary?.path || "OpenAI provider image_generation result", theme);
	}

	const container = new Tui.Container();
	container.addChild(new Tui.Text(text || "OpenAI provider image_generation result", 1, 1));
	if (!options.expanded) {
		if (primary?.path) container.addChild(new Tui.Text(`Ctrl+O 展开图片预览：${primary.path}`, 1, 0));
		return container;
	}
	if (!primary?.path || !Tui.Image) return container;
	try {
		const base64 = fs.readFileSync(primary.path).toString("base64");
		container.addChild(new Tui.Image(base64, primary.mimeType ?? "image/png", {
			fallbackColor: (value: string) => color(theme, "toolOutput", value),
		}, {
			maxWidthCells: 96,
			maxHeightCells: 32,
			filename: path.basename(primary.path),
		}));
	} catch {
		container.addChild(new Tui.Text(`图片预览不可用：${primary.path}`, 1, 0));
	}
	return container;
}

function textComponent(text: string, theme: unknown): ComponentLike {
	return {
		render() {
			return [color(theme, "customMessageText", text)];
		},
		invalidate() {},
	};
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

function messageContent(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap(item => item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string" ? [(item as { text: string }).text] : [])
		.join("\n");
}

function imageDetails(message: unknown): Array<{ path: string; mimeType?: string }> {
	if (!message || typeof message !== "object") return [];
	const details = (message as { details?: unknown }).details;
	if (!details || typeof details !== "object") return [];
	const images = (details as { images?: unknown }).images;
	if (Array.isArray(images)) {
		return images.flatMap(image => image && typeof image === "object" && typeof (image as { path?: unknown }).path === "string"
			? [{ path: (image as { path: string }).path, mimeType: typeof (image as { mimeType?: unknown }).mimeType === "string" ? (image as { mimeType: string }).mimeType : undefined }]
			: []);
	}
	const singlePath = (details as { path?: unknown }).path;
	if (typeof singlePath === "string") {
		const mimeType = (details as { mimeType?: unknown }).mimeType;
		return [{ path: singlePath, mimeType: typeof mimeType === "string" ? mimeType : undefined }];
	}
	return [];
}
