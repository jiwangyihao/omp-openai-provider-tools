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
		capability: "extension factory shape",
		status: "observed",
		evidence: "OMP 14.7.3 extension runtime and manifest docs define the extension factory/entry shape; docs/superpowers/specs/2026-05-07-openai-provider-tools-design.md#runtime-support-boundary",
		pluginBehavior: "Export the shared extension entry in the documented shape and attach hooks through runtime registration only.",
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
		capability: "request-scoped model and context model metadata",
		status: "observed",
		evidence: "OMP 14.7.3 extension/custom tool context shapes expose model metadata; provider request handling requires OpenAI Responses payload model consistency",
		pluginBehavior: "Prefer request/event model metadata when present; use context model metadata only after consistency checks confirm it describes the current provider request.",
	},

	{
		runtime: "omp@14.7.3",
		capability: "active tools conflict-control API is capability-gated",
		status: "required",
		evidence: "No exact OMP 14.7.3 active-tools get/set API is recorded in this fixture; safe removal requires an observed read/write or equivalent block/restore mechanism",
		pluginBehavior: "Remove conflicting host-side tools only when safe conflict control exists and provider-native injection is ensured; otherwise warn and avoid unsafe removal.",
	},

	{
		runtime: "omp@14.7.3",
		capability: "system prompt and before-agent behavior is not required for correctness",
		status: "guarded",
		evidence: "Exact system prompt mutation or before-agent return semantics are not recorded as an observed dependency for provider-native tool injection",
		pluginBehavior: "Keep correctness independent from system prompt mutation; rely on provider request hooks plus visible warnings.",
	},

	{
		runtime: "omp@14.7.3",
		capability: "agent_end assistant message shape includes providerPayload for native history",
		status: "observed",
		evidence: "Extension events can access AgentMessage; observed assistant messages preserve providerPayload.type === 'openaiResponsesHistory' with providerPayload.items[]",
		pluginBehavior: "Parse only observed assistant/provider payloads for image results and warn visibly when native history is absent.",
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
		capability: "request-scoped model metadata",
		status: "required",
		evidence: "Runtime events or provider request context must expose request-scoped model metadata, or context model metadata that can be checked against the request",
		pluginBehavior: "Resolve provider-native tool eligibility from the current request model and use fallback context metadata only after consistency checks.",
	},

	{
		runtime: "pi-family",
		capability: "before-agent and system prompt independence",
		status: "guarded",
		evidence: "Pi-family support must not require undocumented system prompt mutation or before-agent return semantics",
		pluginBehavior: "Keep provider-native injection correctness on provider request mutation; use visible warnings for degraded behavior instead of depending on prompt mutation.",
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

	{
		runtime: "pi-family",
		capability: "agent_end native history preservation",
		status: "guarded",
		evidence: "Automatic image extraction requires agent_end/assistant messages with providerPayload.type === 'openaiResponsesHistory' and providerPayload.items[]",
		pluginBehavior: "Parse only preserved native assistant/provider payloads; warn visibly and skip automatic saving when the shape is absent.",
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
