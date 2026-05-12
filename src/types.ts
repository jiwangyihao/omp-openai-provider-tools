export interface LoggerLike {
	debug?: (...args: unknown[]) => void;
	info?: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
	error?: (...args: unknown[]) => void;
}

export interface RuntimeModelLike {
	id?: string;
	name?: string;
	api?: string;
	provider?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	compat?: {
		openaiProviderTools?: {
			enabled?: unknown;
			webSearch?: unknown;
			imageGeneration?: unknown;
			outputDirectory?: unknown;
			interruptOnImageResult?: unknown;
			experimental?: {
				interruptImageStreamOnResult?: unknown;
				[key: string]: unknown;
			};
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
	runtime?: {
		name?: string;
		kind?: string;
	};
}

export interface RuntimeToolObject {
	name: string;
	description?: string;
}

export type RuntimeActiveTool = string | RuntimeToolObject;

export interface ExtensionContextLike {
	cwd?: string;
	homeDir?: string;
	model?: RuntimeModelLike;
	logger?: LoggerLike;
	sessionManager?: {
		getArtifactsDir?: () => string | undefined | Promise<string | undefined>;
		getSessionId?: () => string | undefined | Promise<string | undefined>;
		getBranch?: () => unknown;
	};
	hasUI?: boolean;
	ui?: {
		notify?: (message: unknown) => void | Promise<void>;
		setWidget?: (
			key: string,
			content: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		) => void;
		custom?: (
			factory: (...args: unknown[]) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void } | Promise<{ render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }>,
			options?: { overlay?: boolean },
		) => Promise<undefined> | undefined;
	};
	abort?: (reason?: string) => void | Promise<void>;
	isIdle?: () => boolean;
}

export interface ExtensionApiLike {
	logger?: LoggerLike;
	runtime?: {
		name?: string;
		kind?: string;
	};
	setLabel?: (label: string) => void;
	on?: (eventName: string, handler: (event: unknown, context: ExtensionContextLike) => unknown | Promise<unknown>) => void;
	getActiveTools?: () => RuntimeActiveTool[] | Promise<RuntimeActiveTool[]>;
	setActiveTools?: (tools: RuntimeActiveTool[]) => void | Promise<void>;
	sendMessage?: (message: unknown, options?: unknown) => void | Promise<void>;
	appendEntry?: (customType: string, data: unknown) => void | Promise<void>;
	registerMessageRenderer?: (customType: string, renderer: (message: unknown, options: { expanded: boolean }, theme: unknown) => unknown) => void;
}

export type ExtensionApiEventRegistrar = NonNullable<ExtensionApiLike["on"]>;

export type ProviderToolType = "web_search" | "image_generation";

export type HostSideToolName = "web_search" | "generate_image";

export interface WebSearchToolConfig {
	enabled?: boolean;
	search_context_size?: "low" | "medium" | "high";
}

export interface ImageGenerationToolConfig {
	enabled?: boolean;
	output_format?: "png" | "jpeg" | "webp";
	quality?: "low" | "medium" | "high" | "auto";
	size?: string;
	background?: "transparent" | "opaque" | "auto";
	action?: "auto" | "generate" | "edit";
}

export interface ProviderToolsEntry {
	tools: {
		web_search?: WebSearchToolConfig;
		image_generation?: ImageGenerationToolConfig;
	};
	output?: {
		directory?: string;
	};
}


