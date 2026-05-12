import * as os from "node:os";
import * as path from "node:path";

import { enabledProviderToolsToHostTools, normalizeActiveToolNames, removeHostSideTools } from "./active-tools";
import { buildRequestTarget, type RequestTarget } from "./match";
import { getEnabledProviderToolTypes, injectConfiguredTools } from "./request-injection";
import {
	buildImageErrorSummaryMessage,
	buildImageSummaryMessage,
	extractImageGenerationResults,
	imageResultKey,
	saveImageResultSync,
	type ProviderImageGenerationResult,
} from "./image-results";
import { registerProviderImageRenderer } from "./image-renderer";
import {
	PROVIDER_TOOL_RESULT_MESSAGE_TYPE,
	buildProviderToolResultSummaryMessage,
	extractDisplayableProviderToolResults,
	providerToolResultKey,
	type DisplayableProviderToolResult,
	type ProviderToolResultMessage,
} from "./provider-results";
import { registerProviderToolResultRenderer } from "./provider-result-renderer";
import { createProviderToolLiveStatusManager, type ProviderToolLiveUiSink } from "./provider-tool-live-status";
import { installOpenAIResponsesImageInterruption, registerProviderToolRequest, clearInterruptibleImageGenerationRequests } from "./stream-interruption";
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
const PROVIDER_TOOL_RESULT_ENTRY_TYPE = "openai-provider-tool-result-ui";
const PROVIDER_TOOL_RESULT_SOURCE = "omp-openai-provider-tools";
const MAX_PROVIDER_TOOL_RESULT_DELIVERY_RETRIES = 3;

interface PendingProviderToolResultCard {
	resultKey: string;
	resultKeys: string[];
	sessionId: string;
	message: ProviderToolResultMessage;
	replay: boolean;
	deliveryFailures?: number;
}

interface ProviderToolResultState {
	pending: PendingProviderToolResultCard[];
	queuedKeys: Set<string>;
	insertedKeys: Set<string>;
	replayedKeys: Set<string>;
	replayScopeKey?: string;
	generation: number;
	retryScheduled: boolean;
	retryHandle?: unknown;
	flushInProgress: boolean;
}


type ProviderToolResultDelivery = "none" | "started" | "failed";

interface ImageResultState {
	outputDirectory?: string;
	sessionId?: string;
	artifactDirectory?: string;
	pendingRetries: Map<string, ProviderImageGenerationResult>;
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

function modelInterruptsProviderImageGeneration(model: RuntimeModelLike | undefined): boolean {
	const metadata = openAIProviderToolsMetadata(model);
	if (isEnabledFlag(metadata?.interruptOnImageResult)) return true;
	const experimental = isRecord(metadata?.experimental) ? metadata.experimental : undefined;
	return isEnabledFlag(experimental?.interruptImageStreamOnResult);
}

function modelProviderImageGenerationKeepaliveIntervalMs(model: RuntimeModelLike | undefined): number | undefined {
	const metadata = openAIProviderToolsMetadata(model);
	const experimental = isRecord(metadata?.experimental) ? metadata.experimental : undefined;
	const value = metadata?.imageGenerationKeepaliveIntervalMs ?? experimental?.imageGenerationKeepaliveIntervalMs;
	if (value === undefined) return undefined;
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isFinite(parsed)) return undefined;
	if (parsed <= 0) return 0;
	return Math.trunc(parsed);
}

function providerEntryFromModel(model: RuntimeModelLike | undefined): ProviderToolsEntry | undefined {
	if (!isExplicitOpenAIResponsesModel(model)) return undefined;
	const metadata = openAIProviderToolsMetadata(model);
	if (!isOfficialOpenAIResponsesProvider(model) && !isEnabledFlag(metadata?.enabled) && !modelAllowsProviderImageGeneration(model)) return undefined;
	const providerEnabled = isEnabledFlag(metadata?.enabled);
	const officialProvider = isOfficialOpenAIResponsesProvider(model);

	const tools: ProviderToolsEntry["tools"] = {};
	if ((officialProvider || providerEnabled || metadata?.webSearch === true) && metadata?.webSearch !== false) {
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

function eventMessages(event: unknown): unknown[] {
	const candidate = event as AgentEndEventLike | MessageEndEventLike | undefined;
	const messages = (candidate as AgentEndEventLike | undefined)?.messages;
	if (Array.isArray(messages)) return messages;
	return [(candidate as MessageEndEventLike | undefined)?.message ?? event];
}

function normalizedProviderImageGenerationReplayItem(item: unknown): unknown | undefined {
	if (!isRecord(item)) return item;
	if (item.type !== "image_generation_call") return item;
	return typeof item.id === "string" && item.id.length > 0 ? { type: "image_generation_call", id: item.id } : undefined;
}

function normalizeProviderImageGenerationReplayItems(message: unknown): void {
	if (!isRecord(message)) return;
	const providerPayload = message.providerPayload;
	if (!isRecord(providerPayload)) return;
	if (providerPayload.type !== "openaiResponsesHistory") return;
	if (!Array.isArray(providerPayload.items)) return;

	const items = providerPayload.items;
	const safeItems = items.flatMap((item) => {
		const normalized = normalizedProviderImageGenerationReplayItem(item);
		return normalized === undefined ? [] : [normalized];
	});
	if (safeItems.length === items.length && safeItems.every((item, index) => item === items[index])) return;
	if (safeItems.length === 0) {
		delete message.providerPayload;
		return;
	}
	providerPayload.items = safeItems;
}

function normalizeProviderImageGenerationReplayItemsFromEvent(event: unknown): void {
	for (const message of eventMessages(event)) {
		normalizeProviderImageGenerationReplayItems(message);
	}
}


function normalizeProviderImageGenerationReplayItemsFromPayload(payload: unknown): void {
	if (!isRecord(payload)) return;
	if (!Array.isArray(payload.input)) return;
	payload.input = payload.input.flatMap((item) => {
		const normalized = normalizedProviderImageGenerationReplayItem(item);
		return normalized === undefined ? [] : [normalized];
	});
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

function completeProviderToolResultsForFinalEcho(results: ReturnType<typeof extractDisplayableProviderToolResults>) {
	return results.filter((result) => {
		if (result.type !== "web_search") return true;
		const status = result.status?.toLowerCase();
		if (!status) {
			return Boolean(result.id || result.query || result.queries.length > 0 || result.citations.length > 0 || result.sources.length > 0 || result.actionDetails.length > 0);
		}
		return status === "completed" || status === "complete" || status === "succeeded" || status === "success";
	});
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
	await api.sendMessage?.(message, { deliverAs: "nextTurn", triggerTurn: true });
}

function handleImageResults({
	api,
	ctx,
	results,
	state,
	seen,
	retainFailures = false,
}: {
	api: ExtensionApiLike;
	ctx: ExtensionContextLike;
	results: ProviderImageGenerationResult[];
	state: ImageResultState;
	seen: Set<string>;
	retainFailures?: boolean;
}): void {
	if (results.length === 0) return;

	const sessionId = runtimeSessionId(ctx, api, state);
	const artifactDirectory = sessionArtifactDirectory(ctx, state);
	const locations = {
		outputDirectory: state.outputDirectory,
		artifactDirectory,
		agentImageDirectory: agentImageDirectory(ctx, api),
	};

	const savedResults: Array<{ result: ProviderImageGenerationResult; saved: ReturnType<typeof saveImageResultSync> }> = [];
	const failedResults: Array<{ result: ProviderImageGenerationResult; error: unknown }> = [];
	for (const result of results) {
		let key: string | undefined;
		try {
			key = imageResultKey(sessionId, result);
			if (seen.has(key)) {
				state.pendingRetries.delete(key);
				continue;
			}
			const saved = saveImageResultSync(result, locations);
			seen.add(key);
			state.pendingRetries.delete(key);
			savedResults.push({ result, saved });
		} catch (error) {
			if (key && retainFailures) {
				state.pendingRetries.set(key, result);
			} else if (key) {
				state.pendingRetries.delete(key);
			}
			logImageSaveFailure(api, ctx, error);
			failedResults.push({ result, error });
		}
	}
	if (failedResults.length > 0) {
		consumePromiseLater(api, ctx, sendVisibleImageMessage(api, buildImageErrorSummaryMessage(failedResults)), "OpenAI provider image error message delivery failed");
	}
	if (savedResults.length > 0) {
		consumePromiseLater(api, ctx, sendVisibleImageMessage(api, buildImageSummaryMessage(savedResults)), "OpenAI provider image message delivery failed");
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
		results = [...state.pendingRetries.values(), ...imageResultsFromAgentEndEvent(event)];
	} catch (error) {
		notifyWarningLater(api, ctx, `OpenAI provider image results could not be extracted: ${error instanceof Error ? error.message : String(error)}`);
		normalizeProviderImageGenerationReplayItemsFromEvent(event);
		return;
	}
	handleImageResults({ api, ctx, results, state, seen });
	normalizeProviderImageGenerationReplayItemsFromEvent(event);
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
		normalizeProviderImageGenerationReplayItemsFromEvent(event);
		return;
	}
	handleImageResults({ api, ctx, results, state, seen, retainFailures: true });
	normalizeProviderImageGenerationReplayItemsFromEvent(event);
}

function providerToolResultState(): ProviderToolResultState {
	return {
		pending: [],
		queuedKeys: new Set(),
		insertedKeys: new Set(),
		replayedKeys: new Set(),
		generation: 0,
		replayScopeKey: undefined,
		retryScheduled: false,
		flushInProgress: false,
	};
}

function providerToolResultDisplayMessage(card: PendingProviderToolResultCard) {
	return {
		role: "custom",
		customType: PROVIDER_TOOL_RESULT_MESSAGE_TYPE,
		content: "OpenAI provider web_search result",
		display: true,
		attribution: "agent",
		details: {
			uiOnly: true,
			source: PROVIDER_TOOL_RESULT_SOURCE,
			resultKey: card.resultKey,
			message: card.message,
		},
	};
}

function persistProviderToolResultCard(api: ExtensionApiLike, ctx: ExtensionContextLike, card: PendingProviderToolResultCard): void {
	if (card.replay || !api.appendEntry) return;
	try {
		const persisted = api.appendEntry(PROVIDER_TOOL_RESULT_ENTRY_TYPE, {
			resultKey: card.resultKey,
			sessionId: card.sessionId,
			insertedAt: Date.now(),
			message: card.message,
		});
		if (isPromiseLike(persisted)) {
			consumePromiseLater(api, ctx, persisted, "OpenAI provider tool result UI persistence failed");
		}
	} catch (error) {
		logAsyncFailure(api, ctx, "OpenAI provider tool result UI persistence failed", error);
	}
}

function isRuntimeIdle(ctx: ExtensionContextLike): boolean {
	const checker = (ctx as { isIdle?: unknown }).isIdle;
	if (typeof checker !== "function") return true;
	try {
		return checker.call(ctx) === true;
	} catch {
		return false;
	}
}

async function sendProviderToolResultDisplayMessage(
	api: ExtensionApiLike,
	ctx: ExtensionContextLike,
	card: PendingProviderToolResultCard,
): Promise<ProviderToolResultDelivery> {
	if (!api.sendMessage) return "none";
	try {
		await api.sendMessage(providerToolResultDisplayMessage(card), { triggerTurn: false });
		persistProviderToolResultCard(api, ctx, card);
		card.deliveryFailures = 0;
		return "started";
	} catch (error) {
		card.deliveryFailures = (card.deliveryFailures ?? 0) + 1;
		logAsyncFailure(api, ctx, "OpenAI provider tool result message delivery failed", error);
		return "failed";
	}
}

function enqueueProviderToolResultCards({
	api,
	ctx,
	results,
	imageState,
	providerState,
}: {
	api: ExtensionApiLike;
	ctx: ExtensionContextLike;
	results: DisplayableProviderToolResult[];
	imageState: ImageResultState;
	providerState: ProviderToolResultState;
}): boolean {
	if (results.length === 0) return false;
	const sessionId = runtimeSessionId(ctx, api, imageState);
	const newResults: DisplayableProviderToolResult[] = [];
	let resultKey: string | undefined;
	for (const result of results) {
		const key = providerToolResultKey(sessionId, result);
		if (providerState.queuedKeys.has(key) || providerState.insertedKeys.has(key) || providerState.replayedKeys.has(key)) continue;
		if (!resultKey) resultKey = key;
		newResults.push(result);
	}
	if (!resultKey || newResults.length === 0) return false;
	const resultKeys: string[] = [];
	for (const result of newResults) {
		resultKeys.push(providerToolResultKey(sessionId, result));
	}
	for (const key of resultKeys) providerState.queuedKeys.add(key);
	providerState.pending.push({
		resultKey,
		resultKeys,
		sessionId,
		message: buildProviderToolResultSummaryMessage(newResults),
		replay: false,
	});
	return true;
}

function scheduleProviderToolResultFlush(
	api: ExtensionApiLike,
	ctx: ExtensionContextLike,
	state: ProviderToolResultState,
	clearLiveStatusOnSuccess: () => void,
): void {
	if (state.retryScheduled || state.pending.length === 0) return;
	const generation = state.generation;
	state.retryScheduled = true;
	state.retryHandle = setTimeout(() => {
		state.retryScheduled = false;
		state.retryHandle = undefined;
		if (state.generation !== generation) return;
		void flushProviderToolResultCards(api, ctx, state, clearLiveStatusOnSuccess).catch((error) => logAsyncFailure(api, ctx, "OpenAI provider tool result flush failed", error));
	}, 0);
}

async function flushProviderToolResultCards(
	api: ExtensionApiLike,
	ctx: ExtensionContextLike,
	state: ProviderToolResultState,
	clearLiveStatusOnSuccess: () => void,
): Promise<ProviderToolResultDelivery> {
	if (state.flushInProgress) return "none";
	if (state.pending.length === 0) return "none";
	if (!isRuntimeIdle(ctx)) {
		scheduleProviderToolResultFlush(api, ctx, state, clearLiveStatusOnSuccess);
		return "none";
	}
	state.flushInProgress = true;
	const generation = state.generation;
	try {
		let anyStarted = false;
		while (state.pending.length > 0) {
			if (!isRuntimeIdle(ctx)) {
				scheduleProviderToolResultFlush(api, ctx, state, clearLiveStatusOnSuccess);
				return anyStarted ? "started" : "none";
			}
			const card = state.pending[0];
			if (!card) break;
			const delivery = await sendProviderToolResultDisplayMessage(api, ctx, card);
			if (state.generation !== generation) return anyStarted ? "started" : "none";
			if (delivery !== "started") {
				if (delivery === "failed" && (card.deliveryFailures ?? 0) < MAX_PROVIDER_TOOL_RESULT_DELIVERY_RETRIES) {
					scheduleProviderToolResultFlush(api, ctx, state, clearLiveStatusOnSuccess);
				}
				return delivery;
			}
			state.pending.shift();
			for (const resultKey of card.resultKeys) {
				state.queuedKeys.delete(resultKey);
				state.insertedKeys.add(resultKey);
			}
			if (card.replay) state.replayedKeys.add(card.resultKey);
			anyStarted = true;
			clearLiveStatusOnSuccess();
		}
		return anyStarted ? "started" : "none";
	} finally {
		if (state.generation === generation) state.flushInProgress = false;
	}
}

function handleAgentEndProviderToolResults({
	api,
	ctx,
	event,
	imageState,
	providerState,
}: {
	api: ExtensionApiLike;
	ctx: ExtensionContextLike;
	event: unknown;
	imageState: ImageResultState;
	providerState: ProviderToolResultState;
}): ProviderToolResultDelivery {
	let results;
	try {
		results = completeProviderToolResultsForFinalEcho(providerToolResultsFromAgentEndEvent(event));
	} catch (error) {
		notifyWarningLater(api, ctx, `OpenAI provider tool results could not be extracted: ${error instanceof Error ? error.message : String(error)}`);
		return "failed";
	}
	return enqueueProviderToolResultCards({ api, ctx, results, imageState, providerState }) ? "started" : "none";
}

function handleMessageEndProviderToolResults({
	api,
	ctx,
	event,
	imageState,
	providerState,
}: {
	api: ExtensionApiLike;
	ctx: ExtensionContextLike;
	event: unknown;
	imageState: ImageResultState;
	providerState: ProviderToolResultState;
}): ProviderToolResultDelivery {
	let results;
	try {
		results = completeProviderToolResultsForFinalEcho(providerToolResultsFromMessageEndEvent(event));
	} catch (error) {
		notifyWarningLater(api, ctx, `OpenAI provider tool results could not be extracted: ${error instanceof Error ? error.message : String(error)}`);
		return "failed";
	}
	return enqueueProviderToolResultCards({ api, ctx, results, imageState, providerState }) ? "started" : "none";
}

function invalidateProviderToolResultState(state: ProviderToolResultState): void {
	state.generation++;
	state.pending.length = 0;
	state.queuedKeys.clear();
	if (state.retryHandle !== undefined) clearTimeout(state.retryHandle as ReturnType<typeof setTimeout>);
	state.retryHandle = undefined;
	state.retryScheduled = false;
	state.flushInProgress = false;
}

function isProviderToolResultUiOnlyMessage(message: unknown): boolean {
	if (!isRecord(message)) return false;
	if (message.role !== "custom") return false;
	if (message.customType !== PROVIDER_TOOL_RESULT_MESSAGE_TYPE) return false;
	return isRecord(message.details) && message.details.uiOnly === true;
}

function filterProviderToolResultContextMessages(event: unknown): unknown {
	if (!isRecord(event) || !Array.isArray(event.messages)) return event;
	return {
		...event,
		messages: event.messages.filter((message) => !isProviderToolResultUiOnlyMessage(message)),
	};
}

function validPersistedProviderToolResultCard(data: unknown): PendingProviderToolResultCard | undefined {
	if (!isRecord(data)) return undefined;
	if (typeof data.resultKey !== "string" || data.resultKey.length === 0) return undefined;
	if (typeof data.sessionId !== "string" || data.sessionId.length === 0) return undefined;
	if (!isRecord(data.message)) return undefined;
	if (data.message.customType !== PROVIDER_TOOL_RESULT_MESSAGE_TYPE) return undefined;
	if (data.message.display !== true) return undefined;
	return {
		resultKey: data.resultKey,
		resultKeys: [data.resultKey],
		sessionId: data.sessionId,
		message: data.message as unknown as ProviderToolResultMessage,
		replay: true,
	};
}

function branchEntries(ctx: ExtensionContextLike): unknown[] {
	try {
		const branch = (ctx.sessionManager as { getBranch?: () => unknown } | undefined)?.getBranch?.();
		if (Array.isArray(branch)) return branch;
		if (isRecord(branch) && Array.isArray(branch.entries)) return branch.entries;
	} catch {
		return [];
	}
	return [];
}

function providerToolResultReplayScopeKey(entries: unknown[]): string {
	return JSON.stringify(entries.map((entry, index) => {
		if (!isRecord(entry)) return [index, undefined];
		return [entry.type, entry.customType, isRecord(entry.data) ? entry.data.resultKey : undefined];
	}));
}

function replayProviderToolResultEntries(
	api: ExtensionApiLike,
	ctx: ExtensionContextLike,
	state: ProviderToolResultState,
	clearLiveStatusOnSuccess: () => void,
): void {
	const entries = branchEntries(ctx);
	const scopeKey = providerToolResultReplayScopeKey(entries);
	if (state.replayScopeKey !== scopeKey) {
		state.replayedKeys.clear();
		state.insertedKeys.clear();
		state.replayScopeKey = scopeKey;
	}
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		if (entry.type !== "custom" || entry.customType !== PROVIDER_TOOL_RESULT_ENTRY_TYPE) continue;
		const card = validPersistedProviderToolResultCard(entry.data);
		if (!card) continue;
		if (state.queuedKeys.has(card.resultKey) || state.insertedKeys.has(card.resultKey) || state.replayedKeys.has(card.resultKey)) continue;
		state.queuedKeys.add(card.resultKey);
		state.pending.push(card);
	}
	void flushProviderToolResultCards(api, ctx, state, clearLiveStatusOnSuccess).catch((error) => logAsyncFailure(api, ctx, "OpenAI provider tool result flush failed", error));
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


function providerToolLiveUiFromContext(ctx: ExtensionContextLike): ProviderToolLiveUiSink {
	return { hasUI: ctx.hasUI, setWidget: ctx.ui?.setWidget, custom: ctx.ui?.custom as ProviderToolLiveUiSink["custom"] };
}

export default function openAIProviderToolsExtension(api: ExtensionApiLike): void {
	api.setLabel?.("OpenAI Provider Tools");
	registerProviderImageRenderer(api);
	registerProviderToolResultRenderer(api);
	installOpenAIResponsesImageInterruption();

	const expectedByTarget = new Map<string, ExpectedToolsState>();
	const incompatibleTargets = new Set<string>();
	const imageResultState: ImageResultState = { pendingRetries: new Map() };
	const providerResultState = providerToolResultState();
	const seenImageResults = new Set<string>();
	const liveStatusManager = createProviderToolLiveStatusManager({ logger: api.logger });
	const clearLiveStatus = () => {
		try {
			liveStatusManager.clearAll();
		} catch (error) {
			try {
				api.logger?.warn?.(`OpenAI provider live status clear failed: ${error instanceof Error ? error.message : String(error)}`, error);
			} catch {
				// Live status cleanup must not break provider final echo handling.
			}
		}
	};
	const clearProviderResultState = () => invalidateProviderToolResultState(providerResultState);

	api.on?.("session_start", async (_event, ctx) => {
		clearLiveStatus();
		clearProviderResultState();
		expectedByTarget.clear();
		incompatibleTargets.clear();
		seenImageResults.clear();
		imageResultState.outputDirectory = undefined;
		imageResultState.sessionId = undefined;
		imageResultState.artifactDirectory = undefined;
		imageResultState.pendingRetries.clear();
		clearInterruptibleImageGenerationRequests();
		await preloadImageRuntimeState(imageResultState, ctx);
		replayProviderToolResultEntries(api, ctx, providerResultState, clearLiveStatus);
	});

	for (const eventName of ["session_before_switch", "session_switch", "session_branch", "session_shutdown"]) {
		api.on?.(eventName, (_event, ctx) => {
			clearLiveStatus();
			clearProviderResultState();
			if (eventName === "session_switch" || eventName === "session_branch") {
				replayProviderToolResultEntries(api, ctx, providerResultState, clearLiveStatus);
			}
		});
	}

	api.on?.("session_tree", (_event, ctx) => {
		clearProviderResultState();
		replayProviderToolResultEntries(api, ctx, providerResultState, clearLiveStatus);
	});

	api.on?.("context", (event) => filterProviderToolResultContextMessages(event));

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
		normalizeProviderImageGenerationReplayItemsFromPayload(payload);
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

		registerProviderToolRequest(payload, {
			enabledTools: result.ensured,
			interruptOnImageResult: result.ensured.includes("image_generation") && modelInterruptsProviderImageGeneration(eligibilityModel),
			keepaliveIntervalMs: result.ensured.includes("image_generation")
				? modelProviderImageGenerationKeepaliveIntervalMs(eligibilityModel)
				: undefined,
			liveTracker: result.ensured.includes("web_search")
				? liveStatusManager.createTracker({ enabledTools: result.ensured, ui: providerToolLiveUiFromContext(ctx) })
				: undefined,
		});
		expectedByTarget.delete(key);
		return undefined;
	});

	api.on?.("message_end", (event, ctx) => {
		handleMessageEndImageResults({ api, ctx, event, state: imageResultState, seen: seenImageResults });
		handleMessageEndProviderToolResults({ api, ctx, event, imageState: imageResultState, providerState: providerResultState });
	});

	api.on?.("turn_end", (_event, ctx) => {
		void flushProviderToolResultCards(api, ctx, providerResultState, clearLiveStatus).catch((error) => logAsyncFailure(api, ctx, "OpenAI provider tool result flush failed", error));
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
		const delivery = handleAgentEndProviderToolResults({ api, ctx, event, imageState: imageResultState, providerState: providerResultState });
		if (delivery === "started") scheduleProviderToolResultFlush(api, ctx, providerResultState, clearLiveStatus);
	});
}
