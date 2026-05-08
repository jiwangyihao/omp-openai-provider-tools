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
		extraBody?: Record<string, unknown>;
		[key: string]: unknown;
	};
	runtime?: {
		name?: string;
		kind?: string;
		capabilities?: Record<string, unknown>;
	};
	capabilities?: Record<string, unknown>;
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
	};
	ui?: {
		notify?: (message: unknown) => void | Promise<void>;
	};
	abort?: (reason?: string) => void | Promise<void>;
}

export interface ExtensionApiLike {
	logger?: LoggerLike;
	runtime?: {
		name?: string;
		kind?: string;
		capabilities?: Record<string, unknown>;
	};
	setLabel?: (label: string) => void;
	on?: (eventName: string, handler: (event: unknown, context: ExtensionContextLike) => unknown | Promise<unknown>) => void;
	getActiveTools?: () => RuntimeActiveTool[] | Promise<RuntimeActiveTool[]>;
	setActiveTools?: (tools: RuntimeActiveTool[]) => void | Promise<void>;
	sendMessage?: (message: unknown, options?: unknown) => void | Promise<void>;
}

export type ExtensionApiEventRegistrar = NonNullable<ExtensionApiLike["on"]>;

export type ProviderToolType = "web_search" | "image_generation";

export type HostSideToolName = "web_search" | "generate_image";

export type BaseUrlMatch = { equals: string } | { prefix: string } | { host: string };

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
	name: string;
	match: {
		api: "openai-responses";
		provider?: string;
		modelId?: string;
		modelName?: string;
		baseUrl?: BaseUrlMatch;
	};
	tools: {
		web_search?: WebSearchToolConfig;
		image_generation?: ImageGenerationToolConfig;
	};
	output?: {
		directory?: string;
	};
}

export interface ProviderToolsConfig {
	version: 1;
	providers: ProviderToolsEntry[];
}
