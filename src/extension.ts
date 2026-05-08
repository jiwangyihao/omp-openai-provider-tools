import * as os from "node:os";
import * as path from "node:path";

import { enabledProviderToolsToHostTools, normalizeActiveToolNames, removeHostSideTools } from "./active-tools";
import { buildRequestTarget, type RequestTarget } from "./match";
import { getEnabledProviderToolTypes, injectConfiguredTools } from "./request-injection";
import {
	buildImageErrorMessage,
	buildImageMessage,
	extractImageGenerationResults,
	imageResultKey,
	saveImageResultSync,
} from "./image-results";
import {
	buildProviderToolResultMessage,
	extractDisplayableProviderToolResults,
	providerToolResultKey,
} from "./provider-results";
import type { ExtensionApiLike, ExtensionContextLike, ProviderToolType, ProviderToolsEntry, RuntimeModelLike } from "./types";

interface ProviderRequestEventLike {
	payload?: unknown;
	model?: RuntimeModelLike;
	requestModel?: RuntimeModelLike;
}

interface AgentEndEventLike {
	messages?: unknown;
	message?: unknown;
}

interface MessageEndEventLike {
	message?: unknown;
}

interface ExpectedToolsState {
	expected: ProviderToolType[];
	snapshot: string[];
	removed: boolean;
}


interface ImageResultState {
	outputDirectory?: string;
	sessionId?: string;
	artifactDirectory?: string;
}

function isExplicitOpenAIResponsesModel(model: RuntimeModelLike | undefined): boolean {
	const api = model?.api;
	if (typeof api !== "string") return false;
	const normalized = api.trim().toLowerCase();
	return normalized === "openai-responses" || normalized === "responses" || normalized === "openai_responses" || normalized === "openai.responses";
}

function baseUrlHost(baseUrl: string | undefined): string | undefined {
	if (typeof baseUrl !== "string") return undefined;
	try {
		return new URL(baseUrl).hostname.trim().toLowerCase();
	} catch {
		return undefined;
	}
}

function isOfficialOpenAIResponsesProvider(model: RuntimeModelLike | undefined): boolean {
	if (!isExplicitOpenAIResponsesModel(model)) return false;
	const host = baseUrlHost(model?.baseUrl);
	if (host) return host === "api.openai.com";
	const provider = typeof model?.provider === "string" ? model.provider.trim().toLowerCase() : undefined;
	return provider === "openai";
}

type RuntimeKind = "omp" | "pi" | "unknown";
type RuntimeMetadata = { name?: unknown; kind?: unknown };

function normalizeRuntimeName(value: unknown): RuntimeKind {
	if (typeof value !== "string") return "unknown";
	const normalized = value.trim().toLowerCase();
	if (normalized === "pi" || normalized === "pi-family" || normalized === "mariozechner-pi") return "pi";
	if (normalized === "omp" || normalized === "oh-my-pi" || normalized === "oh my pi") return "omp";
	return "unknown";
}

function runtimeMetadataCandidates(api: unknown, ctx: unknown): RuntimeMetadata[] {
	const candidates: RuntimeMetadata[] = [];
	for (const value of [api, ctx]) {
		if (!isRecord(value)) continue;
		if (isRecord(value.runtime)) candidates.push(value.runtime);
		if (isRecord(value.model) && isRecord(value.model.runtime)) candidates.push(value.model.runtime);
		candidates.push(value as RuntimeMetadata);
	}
	return candidates;
}

function detectRuntimeKind(api: ExtensionApiLike, ctx?: ExtensionContextLike): RuntimeKind {
	for (const candidate of runtimeMetadataCandidates(api, ctx)) {
		const byName = normalizeRuntimeName(candidate.name);
		if (byName !== "unknown") return byName;
		const byKind = normalizeRuntimeName(candidate.kind);
		if (byKind !== "unknown") return byKind;
	}
	return "unknown";
}

function modelPayloadForBeforeAgent(model: RuntimeModelLike | undefined): Record<string, unknown> | undefined {
	const modelId = model?.id ?? model?.name;
	if (!modelId) return undefined;
	return { model: modelId, input: "" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function openAIProviderToolsMetadata(model: RuntimeModelLike | undefined): NonNullable<RuntimeModelLike["compat"]>["openaiProviderTools"] | undefined {
	const metadata = model?.compat?.openaiProviderTools;
	return isRecord(metadata) ? metadata : undefined;
}

function isEnabledFlag(value: unknown): boolean {
	if (value === true) return true;
	if (value === 1) return true;
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "enabled";
}


function modelAllowsProviderImageGeneration(model: RuntimeModelLike | undefined): boolean {
	const metadata = openAIProviderToolsMetadata(model);
	return isEnabledFlag(metadata?.imageGeneration);
}

function providerEntryFromModel(model: RuntimeModelLike | undefined): ProviderToolsEntry | undefined {
	if (!isExplicitOpenAIResponsesModel(model)) return undefined;
	const metadata = openAIProviderToolsMetadata(model);
	if (!isOfficialOpenAIResponsesProvider(model) && !isEnabledFlag(metadata?.enabled)) return undefined;

	const tools: ProviderToolsEntry["tools"] = {};
	if (metadata?.webSearch !== false) {
		tools.web_search = { enabled: true };
	}
	if (modelAllowsProviderImageGeneration(model)) {
		tools.image_generation = { enabled: true };
	}

	const outputDirectory = metadata?.outputDirectory;
	return {
		tools,
		...(typeof outputDirectory === "string" ? { output: { directory: outputDirectory } } : {}),
	};
}

function getEnabledProviderToolTypesForModel(entry: ProviderToolsEntry, model: RuntimeModelLike | undefined): ProviderToolType[] {
	const enabled = getEnabledProviderToolTypes(entry);
	if (modelAllowsProviderImageGeneration(model)) return enabled;
	return enabled.filter((tool) => tool !== "image_generation");
}

function providerEntryWithEnabledTools(entry: ProviderToolsEntry, enabledProviderTools: readonly ProviderToolType[]): ProviderToolsEntry {
	const enabled = new Set(enabledProviderTools);
	return {
		...entry,
		tools: {
			...(enabled.has("web_search") && entry.tools.web_search ? { web_search: entry.tools.web_search } : {}),
			...(enabled.has("image_generation") && entry.tools.image_generation ? { image_generation: entry.tools.image_generation } : {}),
		},
	};
}

function targetKey(target: RequestTarget): string {
	return [target.api, target.provider ?? "", target.baseUrl ?? "", target.modelId, target.modelName ?? ""].join("\u0000");
}

function coversExpected(ensured: readonly ProviderToolType[], expected: readonly ProviderToolType[]): boolean {
	const ensuredSet = new Set(ensured);
	return expected.every((tool) => ensuredSet.has(tool));
}

function pendingRemovedState(
	expectedByTarget: Map<string, ExpectedToolsState>,
	matches?: (key: string, state: ExpectedToolsState) => boolean,
): [string, ExpectedToolsState] | undefined {
	for (const [key, state] of expectedByTarget) {
		if (state.removed && (!matches || matches(key, state))) return [key, state];
	}
	return undefined;
}

function warningMessage(reason: string): string {
	return `OpenAI provider tools could not be safely injected: ${reason}`;
}

function logAsyncFailure(api: ExtensionApiLike, ctx: ExtensionContextLike, message: string, error: unknown): void {
	const detail = error instanceof Error ? error.message : String(error);
	api.logger?.warn?.(`${message}: ${detail}`, error);
	ctx.logger?.warn?.(`${message}: ${detail}`, error);
}

function consumePromiseLater(api: ExtensionApiLike, ctx: ExtensionContextLike, promise: PromiseLike<unknown>, message: string): void {
	void Promise.resolve(promise).catch((error) => logAsyncFailure(api, ctx, message, error));
}

function notifyWarningLater(api: ExtensionApiLike, ctx: ExtensionContextLike, message: string): void {
	consumePromiseLater(api, ctx, notifyWarning(api, ctx, message), "OpenAI provider tools warning delivery failed");
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && "then" in value && typeof (value as { then?: unknown }).then === "function";
}


function imageResultsFromAgentEndEvent(event: unknown) {
	const candidate = event as AgentEndEventLike | undefined;
	const messages = Array.isArray(candidate?.messages) ? candidate.messages : [candidate?.message ?? event];
	return messages.flatMap((message) => extractImageGenerationResults(message));
}

function imageResultsFromMessageEndEvent(event: unknown) {
	const candidate = event as MessageEndEventLike | undefined;
	return extractImageGenerationResults(candidate?.message ?? event);
}

function providerToolResultsFromAgentEndEvent(event: unknown) {
	const candidate = event as AgentEndEventLike | undefined;
	const messages = Array.isArray(candidate?.messages) ? candidate.messages : [candidate?.message ?? event];
	return messages.flatMap((message) => extractDisplayableProviderToolResults(message));
}

function providerToolResultsFromMessageEndEvent(event: unknown) {
	const candidate = event as MessageEndEventLike | undefined;
	return extractDisplayableProviderToolResults(candidate?.message ?? event);
}

async function preloadImageRuntimeState(state: ImageResultState, ctx: ExtensionContextLike): Promise<void> {
	try {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		state.sessionId = typeof sessionId === "string" ? sessionId : isPromiseLike(sessionId) ? await sessionId : undefined;
	} catch {
		state.sessionId = undefined;
	}

	try {
		const artifactDirectory = ctx.sessionManager?.getArtifactsDir?.();
		state.artifactDirectory = typeof artifactDirectory === "string" ? artifactDirectory : isPromiseLike(artifactDirectory) ? await artifactDirectory : undefined;
	} catch {
		state.artifactDirectory = undefined;
	}
}

function runtimeSessionId(ctx: ExtensionContextLike, api: ExtensionApiLike, state: ImageResultState): string {
	if (state.sessionId) return state.sessionId;
	try {
		const explicit = ctx.sessionManager?.getSessionId?.();
		if (typeof explicit === "string" && explicit.length > 0) return explicit;
	} catch {
		// Fall back to a deterministic session key; image saving must remain best-effort.
	}
	const runtime = detectRuntimeKind(api, ctx);
	return `fallback:${runtime}:${ctx.homeDir ?? "no-home"}:${ctx.cwd ?? "no-cwd"}`;
}

function sessionArtifactDirectory(ctx: ExtensionContextLike, state: ImageResultState): string | undefined {
	if (state.artifactDirectory) return state.artifactDirectory;
	try {
		const directory = ctx.sessionManager?.getArtifactsDir?.();
		return typeof directory === "string" && directory.length > 0 ? directory : undefined;
	} catch {
		return undefined;
	}
}

function agentImageDirectory(ctx: ExtensionContextLike, api: ExtensionApiLike): string {
	const runtime = detectRuntimeKind(api, ctx) === "pi" ? "pi" : "omp";
	return path.join(ctx.homeDir ?? os.homedir(), `.${runtime}`, "agent", "provider-tool-images");
}

function updateImageResultState(state: ImageResultState, entry: ProviderToolsEntry): void {
	if (entry.tools.image_generation?.enabled === true) {
		state.outputDirectory = entry.output?.directory;
	}
}

function logImageSaveFailure(api: ExtensionApiLike, ctx: ExtensionContextLike, error: unknown): void {
	const message = `OpenAI provider image result could not be saved: ${error instanceof Error ? error.message : String(error)}`;
	api.logger?.warn?.(message, error);
	ctx.logger?.warn?.(message, error);
}

async function sendVisibleImageMessage(api: ExtensionApiLike, message: unknown): Promise<void> {
	await api.sendMessage?.(message, { deliverAs: "nextTurn" });
}

function handleImageResults({
	api,
	ctx,
	results,
	state,
	seen,
}: {
	api: ExtensionApiLike;
	ctx: ExtensionContextLike;
	results: ReturnType<typeof extractImageGenerationResults>;
	state: ImageResultState;
	seen: Set<string>;
}): void {
	if (results.length === 0) return;

	const sessionId = runtimeSessionId(ctx, api, state);
	const artifactDirectory = sessionArtifactDirectory(ctx, state);
	const locations = {
		outputDirectory: state.outputDirectory,
		artifactDirectory,
		agentImageDirectory: agentImageDirectory(ctx, api),
	};

	for (const result of results) {
		try {
			const key = imageResultKey(sessionId, result);
			if (seen.has(key)) continue;
			const saved = saveImageResultSync(result, locations);
			seen.add(key);
			consumePromiseLater(api, ctx, sendVisibleImageMessage(api, buildImageMessage(result, saved)), "OpenAI provider image message delivery failed");
		} catch (error) {
			logImageSaveFailure(api, ctx, error);
			consumePromiseLater(api, ctx, sendVisibleImageMessage(api, buildImageErrorMessage(result, error)), "OpenAI provider image error message delivery failed");
		}
	}
}

function handleAgentEndImageResults({
	api,
	ctx,
	event,
	state,
	seen,
}: {
	api: ExtensionApiLike;
	ctx: ExtensionContextLike;
	event: unknown;
	state: ImageResultState;
	seen: Set<string>;
}): void {
	let results;
	try {
		results = imageResultsFromAgentEndEvent(event);
	} catch (error) {
		notifyWarningLater(api, ctx, `OpenAI provider image results could not be extracted: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	handleImageResults({ api, ctx, results, state, seen });
}

function handleMessageEndImageResults({
	api,
	ctx,
	event,
	state,
	seen,
}: {
	api: ExtensionApiLike;
	ctx: ExtensionContextLike;
	event: unknown;
	state: ImageResultState;
	seen: Set<string>;
}): void {
	let results;
	try {
		results = imageResultsFromMessageEndEvent(event);
	} catch (error) {
		notifyWarningLater(api, ctx, `OpenAI provider image results could not be extracted: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	handleImageResults({ api, ctx, results, state, seen });
}

async function sendVisibleProviderToolResultMessage(api: ExtensionApiLike, message: unknown): Promise<void> {
	await api.sendMessage?.(message, { deliverAs: "nextTurn" });
}

function handleProviderToolResults({
	api,
	ctx,
	results,
	state,
	seen,
}: {
	api: ExtensionApiLike;
	ctx: ExtensionContextLike;
	results: ReturnType<typeof extractDisplayableProviderToolResults>;
	state: ImageResultState;
	seen: Set<string>;
}): void {
	if (results.length === 0) return;
	const sessionId = runtimeSessionId(ctx, api, state);
	for (const result of results) {
		const key = providerToolResultKey(sessionId, result);
		if (seen.has(key)) continue;
		seen.add(key);
		consumePromiseLater(api, ctx, sendVisibleProviderToolResultMessage(api, buildProviderToolResultMessage(result)), "OpenAI provider tool result message delivery failed");
	}
}

function handleAgentEndProviderToolResults({
	api,
	ctx,
	event,
	state,
	seen,
}: {
	api: ExtensionApiLike;
	ctx: ExtensionContextLike;
	event: unknown;
	state: ImageResultState;
	seen: Set<string>;
}): void {
	let results;
	try {
		results = providerToolResultsFromAgentEndEvent(event);
	} catch (error) {
		notifyWarningLater(api, ctx, `OpenAI provider tool results could not be extracted: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	handleProviderToolResults({ api, ctx, results, state, seen });
}

function handleMessageEndProviderToolResults({
	api,
	ctx,
	event,
	state,
	seen,
}: {
	api: ExtensionApiLike;
	ctx: ExtensionContextLike;
	event: unknown;
	state: ImageResultState;
	seen: Set<string>;
}): void {
	let results;
	try {
		results = providerToolResultsFromMessageEndEvent(event);
	} catch (error) {
		notifyWarningLater(api, ctx, `OpenAI provider tool results could not be extracted: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	handleProviderToolResults({ api, ctx, results, state, seen });
}
async function notifyWarning(api: ExtensionApiLike, ctx: ExtensionContextLike, message: string): Promise<void> {
	api.logger?.warn?.(message);
	ctx.logger?.warn?.(message);
	if (ctx.ui?.notify) {
		await ctx.ui.notify({ type: "warning", message });
		return;
	}
	if (api.sendMessage) {
		await api.sendMessage({ type: "warning", content: message, display: true }, { deliverAs: "nextTurn" });
	}
}

async function restoreActiveTools(api: ExtensionApiLike, state: ExpectedToolsState | undefined): Promise<boolean> {
	if (!state?.removed) return true;
	if (!api.setActiveTools) return false;
	try {
		await api.setActiveTools([...state.snapshot]);
		return true;
	} catch {
		return false;
	}
}

async function failAfterRemoval({
	api,
	ctx,
	reason,
	state,
	incompatibleTargets,
	key,
}: {
	api: ExtensionApiLike;
	ctx: ExtensionContextLike;
	reason: string;
	state?: ExpectedToolsState;
	incompatibleTargets: Set<string>;
	key?: string;
}): Promise<void> {
	if (key) incompatibleTargets.add(key);

	const message = warningMessage(reason);
	if (ctx.abort) {
		api.logger?.warn?.(message);
		ctx.logger?.warn?.(message);
		try {
			const abortResult = ctx.abort(message);
			if (isPromiseLike(abortResult)) {
				consumePromiseLater(api, ctx, abortResult, "OpenAI provider tools abort failed");
			}
		} catch (error) {
			logAsyncFailure(api, ctx, "OpenAI provider tools abort failed", error);
		}
		consumePromiseLater(api, ctx, restoreActiveTools(api, state), "OpenAI provider tools active tool restoration failed");
		return;
	}

	await restoreActiveTools(api, state);
	await notifyWarning(api, ctx, message);
}


function requestEventModel(event: unknown): RuntimeModelLike | undefined {
	const candidate = event as ProviderRequestEventLike;
	return candidate?.requestModel ?? candidate?.model;
}

function requestPayload(event: unknown): unknown {
	return (event as ProviderRequestEventLike | undefined)?.payload;
}

export default function openAIProviderToolsExtension(api: ExtensionApiLike): void {
	api.setLabel?.("OpenAI Provider Tools");

	const expectedByTarget = new Map<string, ExpectedToolsState>();
	const incompatibleTargets = new Set<string>();
	const imageResultState: ImageResultState = {};
	const seenImageResults = new Set<string>();
	const seenProviderToolResults = new Set<string>();

	api.on?.("session_start", async (_event, ctx) => {
		expectedByTarget.clear();
		incompatibleTargets.clear();
		seenImageResults.clear();
		seenProviderToolResults.clear();
		imageResultState.outputDirectory = undefined;
		imageResultState.sessionId = undefined;
		imageResultState.artifactDirectory = undefined;
		await preloadImageRuntimeState(imageResultState, ctx);
	});

	api.on?.("before_agent_start", async (_event, ctx) => {
		const syntheticPayload = modelPayloadForBeforeAgent(ctx.model);
		if (!isExplicitOpenAIResponsesModel(ctx.model)) return undefined;
		if (!syntheticPayload) return undefined;

		const target = buildRequestTarget({ payload: syntheticPayload, contextModel: ctx.model });
		if (!target) return undefined;
		const key = targetKey(target);
		if (incompatibleTargets.has(key)) return undefined;

		const entry = providerEntryFromModel(ctx.model);
		if (!entry) return undefined;

		const enabledProviderTools = getEnabledProviderToolTypesForModel(entry, ctx.model);
		if (enabledProviderTools.length === 0) return undefined;

		if (!api.getActiveTools || !api.setActiveTools) {
			incompatibleTargets.add(key);
			await notifyWarning(api, ctx, warningMessage("active tool control API is unavailable"));
			return undefined;
		}
		const snapshot = normalizeActiveToolNames(await api.getActiveTools());
		if (snapshot.length === 0) {
			expectedByTarget.set(key, { expected: enabledProviderTools, snapshot, removed: false });
			return undefined;
		}

		const hostToolsToRemove = enabledProviderToolsToHostTools(enabledProviderTools);
		const removal = removeHostSideTools(snapshot, hostToolsToRemove);
		if (!removal.removed) {
			expectedByTarget.set(key, { expected: enabledProviderTools, snapshot, removed: false });
			return undefined;
		}

		try {
			await api.setActiveTools(removal.toolNames);
		} catch (error) {
			incompatibleTargets.add(key);
			await notifyWarning(api, ctx, warningMessage(`active tool removal failed: ${error instanceof Error ? error.message : String(error)}`));
			return undefined;
		}
		expectedByTarget.set(key, { expected: enabledProviderTools, snapshot, removed: true });
		return undefined;
	});

	api.on?.("before_provider_request", async (event, ctx) => {
		const payload = requestPayload(event);
		const eventModel = requestEventModel(event);
		const eligibilityModel = eventModel ?? ctx.model;
		imageResultState.outputDirectory = undefined;
		if (!isExplicitOpenAIResponsesModel(eligibilityModel)) {
			const pending = pendingRemovedState(expectedByTarget);
			if (pending) {
				const [key, state] = pending;
				await failAfterRemoval({
					api,
					ctx,
					reason: "provider request model was not explicitly OpenAI Responses after host-side tool removal",
					state,
					incompatibleTargets,
					key,
				});
				expectedByTarget.delete(key);
			}
			return undefined;
		}
		const target = buildRequestTarget({ payload, contextModel: ctx.model, eventModel });
		if (!target) {
			const pending = pendingRemovedState(expectedByTarget);
			if (pending) {
				const [key, state] = pending;
				await failAfterRemoval({ api, ctx, reason: "provider request target could not be verified after host-side tool removal", state, incompatibleTargets, key });
				expectedByTarget.delete(key);
			}
			return undefined;
		}

		const key = targetKey(target);
		const crossTargetPending = pendingRemovedState(expectedByTarget, (pendingKey) => pendingKey !== key);
		if (crossTargetPending) {
			const [pendingKey, state] = crossTargetPending;
			await failAfterRemoval({
				api,
				ctx,
				reason: "provider request target differed after host-side tool removal",
				state,
				incompatibleTargets,
				key: pendingKey,
			});
			expectedByTarget.delete(pendingKey);
			return undefined;
		}

		if (incompatibleTargets.has(key)) {
			const pending = pendingRemovedState(expectedByTarget, (pendingKey) => pendingKey === key);
			if (pending) {
				const [pendingKey, state] = pending;
				await failAfterRemoval({
					api,
					ctx,
					reason: "provider request target is incompatible after host-side tool removal",
					state,
					incompatibleTargets,
					key: pendingKey,
				});
				expectedByTarget.delete(pendingKey);
			}
			return undefined;
		}
		const entry = providerEntryFromModel(eligibilityModel);
		if (!entry) {
			const expected = expectedByTarget.get(key);
			const pending: [string, ExpectedToolsState] | undefined = expected ? [key, expected] : pendingRemovedState(expectedByTarget);
			if (pending) {
				const [pendingKey, state] = pending;
				await failAfterRemoval({
					api,
					ctx,
					reason: "provider request no longer matched configured provider tools after host-side tool removal",
					state,
					incompatibleTargets,
					key: pendingKey,
				});
				expectedByTarget.delete(pendingKey);
			}
			return undefined;
		}
		const expected = expectedByTarget.get(key);
		const enabledProviderTools = getEnabledProviderToolTypesForModel(entry, eligibilityModel);
		if (enabledProviderTools.length === 0) {
			if (expected) {
				await failAfterRemoval({
					api,
					ctx,
					reason: "provider request enabled fewer provider tools than host-side removal expected",
					state: expected,
					incompatibleTargets,
					key,
				});
				expectedByTarget.delete(key);
			}
			return undefined;
		}
		if (expected && !coversExpected(enabledProviderTools, expected.expected)) {
			await failAfterRemoval({
				api,
				ctx,
				reason: "provider request enabled fewer provider tools than host-side removal expected",
				state: expected,
				incompatibleTargets,
				key,
			});
			expectedByTarget.delete(key);
			return undefined;
		}
		const hostToolsToRemove = enabledProviderToolsToHostTools(enabledProviderTools);
		if (!expected && eventModel && hostToolsToRemove.length > 0) {
			if (!api.getActiveTools) {
				incompatibleTargets.add(key);
				notifyWarningLater(api, ctx, warningMessage("active tool control API is unavailable"));
				return undefined;
			}

			let activeToolNames: string[];
			try {
				const activeTools = api.getActiveTools();
				if (isPromiseLike(activeTools)) {
					incompatibleTargets.add(key);
					consumePromiseLater(api, ctx, activeTools, "OpenAI provider tools active tool inspection failed");
					notifyWarningLater(api, ctx, warningMessage("active tool inspection is asynchronous and cannot safely precede provider request injection"));
					return undefined;
				}
				activeToolNames = normalizeActiveToolNames(activeTools);
			} catch (error) {
				incompatibleTargets.add(key);
				notifyWarningLater(api, ctx, warningMessage(`active tool inspection failed: ${error instanceof Error ? error.message : String(error)}`));
				return undefined;
			}

			const activeHostConflicts = hostToolsToRemove.filter((toolName) => activeToolNames.includes(toolName));
			if (activeHostConflicts.length > 0) {
				incompatibleTargets.add(key);
				notifyWarningLater(api, ctx, warningMessage(`active host-side tools remain: ${activeHostConflicts.join(", ")}`));
				return undefined;
			}
		}

		const injectionEntry = providerEntryWithEnabledTools(entry, enabledProviderTools);
		updateImageResultState(imageResultState, injectionEntry);
		const result = injectConfiguredTools(payload, injectionEntry);
		if (!result.ok) {
			await failAfterRemoval({ api, ctx, reason: result.reason, state: expected, incompatibleTargets, key });
			expectedByTarget.delete(key);
			return undefined;
		}

		if (expected && !coversExpected(result.ensured, expected.expected)) {
			await failAfterRemoval({
				api,
				ctx,
				reason: "ensured provider tools did not cover tools removed from the host runtime",
				state: expected,
				incompatibleTargets,
				key,
			});
			expectedByTarget.delete(key);
			return undefined;
		}

		expectedByTarget.delete(key);
		return undefined;
	});

	api.on?.("message_end", (event, ctx) => {
		handleMessageEndImageResults({ api, ctx, event, state: imageResultState, seen: seenImageResults });
		handleMessageEndProviderToolResults({ api, ctx, event, state: imageResultState, seen: seenProviderToolResults });
	});

	api.on?.("agent_end", async (event, ctx) => {
		const pending = [...expectedByTarget.entries()].filter(([, state]) => state.removed);
		for (const [key, state] of pending) {
			await failAfterRemoval({
				api,
				ctx,
				reason: "provider request was not observed after host-side tool removal",
				state,
				incompatibleTargets,
				key,
			});
			expectedByTarget.delete(key);
		}
		handleAgentEndImageResults({ api, ctx, event, state: imageResultState, seen: seenImageResults });
		handleAgentEndProviderToolResults({ api, ctx, event, state: imageResultState, seen: seenProviderToolResults });
	});
}
