import { runtimeTuiSpecifiers } from "./image-renderer";
import { PROVIDER_TOOL_RESULT_MESSAGE_TYPE } from "./provider-results";

interface ComponentLike {
	render(width: number): string[];
	invalidate(): void;
}

interface ContainerLike extends ComponentLike {
	addChild(component: ComponentLike): void;
}

interface BoxLike extends ContainerLike {
	clear?: () => void;
}

interface TuiLike {
	Box: new (paddingX?: number, paddingY?: number, bgFn?: (text: string) => string) => BoxLike;
	Spacer: new (height?: number) => ComponentLike;
	Text: new (text?: string, paddingX?: number, paddingY?: number, customBgFn?: (text: string) => string) => ComponentLike;
}

interface RendererApiLike {
	registerMessageRenderer?: (customType: string, renderer: (message: unknown, options: { expanded: boolean }, theme: unknown) => ComponentLike | undefined) => void;
	logger?: { warn?: (...args: unknown[]) => void };
	pi?: { VERSION?: string };
}

type Reference = { title?: string; url: string };

let tuiModule: TuiLike | undefined;
let tuiLoadStarted = false;

export function registerProviderToolResultRenderer(api: RendererApiLike, tuiOverride?: TuiLike): void {
	if (!api.registerMessageRenderer) return;
	if (!tuiOverride) void ensureTuiLoaded(api);
	api.registerMessageRenderer(PROVIDER_TOOL_RESULT_MESSAGE_TYPE, (message, options, theme) =>
		renderProviderToolResultMessage(message, options, theme, tuiOverride ?? tuiModule));
}

async function ensureTuiLoaded(api: RendererApiLike): Promise<void> {
	if (tuiLoadStarted) return;
	tuiLoadStarted = true;
	try {
		tuiModule = await loadTuiModule(api.pi?.VERSION);
	} catch (error) {
		api.logger?.warn?.("OpenAI provider tool result renderer is unavailable", error);
	}
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

function renderProviderToolResultMessage(
	message: unknown,
	options: { expanded: boolean },
	theme: unknown,
	Tui: TuiLike | undefined,
): ComponentLike | undefined {
	if (!Tui) return undefined;
	const details = resultDetails(message);
	const summary = details.summary || providerToolSummary(details) || messageContent(message) || "OpenAI provider completed web_search.";
	const detailLines = providerToolDetailLines(details);
	const box = new Tui.Box(1, 1, value => background(theme, "customMessageBg", value));
	const label = color(theme, "customMessageLabel", bold(theme, `[${messageCustomType(message)}]`));
	box.addChild(new Tui.Text(label, 0, 0));
	box.addChild(new Tui.Spacer(1));
	box.addChild(new Tui.Text(color(theme, "customMessageText", summary), 0, 0));
	if (!options.expanded && detailLines.length > 0) {
		box.addChild(new Tui.Text(expandHint(theme), 0, 0));
	}
	if (options.expanded && detailLines.length > 0) {
		box.addChild(new Tui.Spacer(1));
		box.addChild(new Tui.Text(color(theme, "customMessageText", detailLines.join("\n")), 0, 0));
	}
	return box;
}

function resultDetails(message: unknown): { summary?: string; resultCount: number; queries: string[]; citations: Reference[]; sources: Reference[] } {
	if (!isRecord(message) || !isRecord(message.details)) return { resultCount: 0, queries: [], citations: [], sources: [] };
	const details = message.details;
	return {
		summary: typeof details.summary === "string" ? details.summary : undefined,
		resultCount: Array.isArray(details.results) ? details.results.length : 0,
		queries: stringArray(details.queries),
		citations: referenceArray(details.citations),
		sources: referenceArray(details.sources),
	};
}

function providerToolSummary(details: { resultCount: number }): string | undefined {
	if (details.resultCount <= 0) return undefined;
	return `OpenAI provider completed web_search (${details.resultCount === 1 ? "1 call" : `${details.resultCount} calls`}).`;
}

function providerToolDetailLines(details: { queries: string[]; citations: Reference[]; sources: Reference[] }): string[] {
	const lines: string[] = [];
	if (details.queries.length > 0) lines.push(`Queries: ${details.queries.join("; ")}`);
	appendReferences(lines, "Citations", details.citations);
	appendReferences(lines, "Sources", details.sources);
	return lines;
}

function appendReferences(lines: string[], label: string, references: Reference[]): void {
	if (references.length === 0) return;
	lines.push(`${label}:`);
	for (const reference of references.slice(0, 10)) {
		lines.push(`- ${reference.title ? `${reference.title}: ` : ""}${reference.url}`);
	}
	if (references.length > 10) lines.push(`- ... ${references.length - 10} more`);
}

function referenceArray(value: unknown): Reference[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(entry => {
		if (!isRecord(entry) || typeof entry.url !== "string") return [];
		return [{ url: entry.url, title: typeof entry.title === "string" ? entry.title : undefined }];
	});
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.flatMap(entry => typeof entry === "string" ? [entry] : []) : [];
}

function messageCustomType(message: unknown): string {
	if (isRecord(message) && typeof message.customType === "string") return message.customType;
	return PROVIDER_TOOL_RESULT_MESSAGE_TYPE;
}

function messageContent(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap(item => isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [])
		.join("\n");
}

function expandHint(theme: unknown): string {
	return color(theme, "dim", `${bracket(theme, "left")}(Ctrl+O for more)${bracket(theme, "right")}`);
}

function bracket(theme: unknown, side: "left" | "right"): string {
	if (isRecord(theme) && isRecord(theme.format)) {
		const value = side === "left" ? theme.format.bracketLeft : theme.format.bracketRight;
		if (typeof value === "string") return value;
	}
	return side === "left" ? "[" : "]";
}

function background(theme: unknown, key: string, value: string): string {
	if (isRecord(theme) && typeof theme.bg === "function") {
		try {
			return (theme.bg as (key: string, value: string) => string)(key, value);
		} catch {
			return value;
		}
	}
	return value;
}

function bold(theme: unknown, value: string): string {
	if (isRecord(theme) && typeof theme.bold === "function") {
		try {
			return (theme.bold as (value: string) => string)(value);
		} catch {
			return value;
		}
	}
	return value;
}

function color(theme: unknown, key: string, value: string): string {
	if (isRecord(theme) && typeof theme.fg === "function") {
		try {
			return (theme.fg as (key: string, value: string) => string)(key, value);
		} catch {
			return value;
		}
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
