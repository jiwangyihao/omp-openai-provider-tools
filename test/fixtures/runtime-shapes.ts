export type RuntimeCapabilityStatus = "observed" | "required" | "guarded";

export type RuntimeCapabilityRecord = {
	runtime: string;
	capability: string;
	status: RuntimeCapabilityStatus;
	evidence: string;
	pluginBehavior: string;
};

export const OMP_14_7_3_CAPABILITIES = [
	{
		runtime: "omp@14.7.3",
		capability: "extension event registration includes before_provider_request",
		status: "observed",
		evidence: "OMP 14.7.3 extension runtime source; docs/superpowers/specs/2026-05-07-openai-provider-tools-design.md#runtime-support-boundary",
		pluginBehavior: "Register the provider request hook through the runtime extension entry and inspect only OpenAI Responses payloads.",
	},
	{
		runtime: "omp@14.7.3",
		capability: "before_provider_request payload mutation is synchronous and in-place",
		status: "observed",
		evidence: "OMP 14.7.3 OpenAI Responses provider calls options?.onPayload?.(params)",
		pluginBehavior: "Mutate the existing params object before the provider sends it; do not depend on returned replacement payloads or asynchronous mutation.",
	},
	{
		runtime: "omp@14.7.3",
		capability: "assistant messages can preserve OpenAI Responses native history",
		status: "observed",
		evidence: "Observed message shape: providerPayload.type === 'openaiResponsesHistory' with providerPayload.items[]",
		pluginBehavior: "Read provider-native image result items from preserved history when present; never synthesize image-save success without this history.",
	},
	{
		runtime: "omp@14.7.3",
		capability: "session artifact directory, save, and allocate APIs are available",
		status: "observed",
		evidence: "OMP 14.7.3 session manager artifact APIs",
		pluginBehavior: "Prefer configured output directory, then runtime session artifact APIs for persisted image files.",
	},
	{
		runtime: "omp@14.7.3",
		capability: "extension and custom tool context can expose model, session, and settings",
		status: "observed",
		evidence: "OMP 14.7.3 extension/custom tool context shapes",
		pluginBehavior: "Use request-scoped model metadata when available and fall back to context model only after consistency checks.",
	},
	{
		runtime: "omp@14.7.3",
		capability: "visible custom messages can be delivered through runtime message APIs",
		status: "observed",
		evidence: "OMP 14.7.3 runtime message APIs for custom visible messages",
		pluginBehavior: "Send visible warnings and image-save notices through runtime message delivery without embedding image base64 content.",
	},
] as const satisfies readonly RuntimeCapabilityRecord[];

export const PI_FAMILY_REQUIRED_CAPABILITIES = [
	{
		runtime: "pi-family",
		capability: "extension registration",
		status: "required",
		evidence: "docs/superpowers/specs/2026-05-07-openai-provider-tools-design.md#required-runtime-capabilities",
		pluginBehavior: "Load the shared extension entry only when the runtime exposes compatible registration metadata or APIs.",
	},
	{
		runtime: "pi-family",
		capability: "mutable provider request payload",
		status: "required",
		evidence: "before_provider_request or equivalent hook must expose mutable OpenAI Responses params",
		pluginBehavior: "Inject provider-native tools only when the current request payload can be synchronously modified before send.",
	},
	{
		runtime: "pi-family",
		capability: "active tools read/write or equivalent conflict-control mechanism",
		status: "required",
		evidence: "Runtime must expose current tool names and a safe way to remove conflicting host-side tools for the turn",
		pluginBehavior: "Remove conflicting host-side tools only after provider-native injection is ensured or can be safely blocked/restored on failure.",
	},
	{
		runtime: "pi-family",
		capability: "session artifact directory or visible warning path",
		status: "required",
		evidence: "Runtime must expose artifact persistence or a visible message mechanism for degraded image-save behavior",
		pluginBehavior: "Save generated image files when a supported directory exists; otherwise warn visibly rather than pretending persistence succeeded.",
	},
	{
		runtime: "pi-family",
		capability: "custom or visible message delivery",
		status: "required",
		evidence: "Runtime must expose a user-visible notification or custom message API",
		pluginBehavior: "Report compatibility warnings, save failures, and successful image file paths through visible runtime messages.",
	},
	{
		runtime: "pi-family",
		capability: "OpenAI Responses native history preservation",
		status: "guarded",
		evidence: "Required message shape: providerPayload.type === 'openaiResponsesHistory' with providerPayload.items[]",
		pluginBehavior: "Enable automatic image result saving only when native history is present; otherwise inject provider-native tools but warn and skip automatic image file saving.",
	},
] as const satisfies readonly RuntimeCapabilityRecord[];

export const RUNTIME_COMPATIBILITY_SUMMARY = {
	primaryVerifiedRuntime: "omp@14.7.3",
	piSupportMode: "capability-gated",
	forbiddenAssumptions: [
		"do not assume Pi equals OMP",
		"do not default unknown runtime to OMP-only config",
		"do not infer credentials from plugin config",
	],
} as const;
