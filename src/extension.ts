import * as os from "node:os";
import * as path from "node:path";

import { enabledProviderToolsToHostTools, normalizeActiveToolNames, removeHostSideTools } from "./active-tools";
import { detectRuntimeKind, loadAvailableProviderToolsConfig } from "./config";
import { buildRequestTarget, findMatchingProvider, type RequestTarget } from "./match";
import { getEnabledProviderToolTypes, injectConfiguredTools } from "./request-injection";
import {
	buildImageErrorMessage,
	buildImageMessage,
	extractImageGenerationResults,
	imageResultKey,
	saveImageResult,
} from "./image-results";
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

interface ExpectedToolsState {
	expected: ProviderToolType[];
	snapshot: string[];
	removed: boolean;
}

interface LoadedRuntimeConfig {
	config: Awaited<ReturnType<typeof loadAvailableProviderToolsConfig>>["config"];
}

interface ImageResultState {
	outputDirectory?: string;
}

function modelPayloadForBeforeAgent(model: RuntimeModelLike | undefined): Record<string, unknown> | undefined {
	const modelId = model?.id ?? model?.name;
	if (!modelId) return undefined;
	return { model: modelId, input: "" };
}

function targetKey(target: RequestTarget): string {
	return [target.api, target.provider ?? "", target.baseUrl ?? "", target.modelId, target.modelName ?? ""].join("\u0000");
}

function coversExpected(ensured: readonly ProviderToolType[], expected: readonly ProviderToolType[]): boolean {
	const ensuredSet = new Set(ensured);
	return expected.every((tool) => ensuredSet.has(tool));
}

function warningMessage(reason: string): string {
	return `OpenAI provider tools could not be safely injected: ${reason}`;
}


function imageResultsFromAgentEndEvent(event: unknown) {
	const candidate = event as AgentEndEventLike | undefined;
	const messages = Array.isArray(candidate?.messages) ? candidate.messages : [candidate?.message ?? event];
	return messages.flatMap((message) => extractImageGenerationResults(message));
}

async function runtimeSessionId(ctx: ExtensionContextLike, api: ExtensionApiLike): Promise<string> {
	const explicit = await ctx.sessionManager?.getSessionId?.();
	if (explicit) return explicit;
	const runtime = detectRuntimeKind(api, ctx);
	return `fallback:${runtime}:${ctx.homeDir ?? "no-home"}:${ctx.cwd ?? "no-cwd"}`;
}

async function sessionArtifactDirectory(ctx: ExtensionContextLike): Promise<string | undefined> {
	return ctx.sessionManager?.getArtifactsDir?.();
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

async function sendVisibleImageMessage(api: ExtensionApiLike, message: unknown): Promise<void> {
	await api.sendMessage?.(message, { deliverAs: "nextTurn" });
}

async function handleAgentEndImageResults({
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
}): Promise<void> {
	let results;
	try {
		results = imageResultsFromAgentEndEvent(event);
	} catch (error) {
		await notifyWarning(api, ctx, `OpenAI provider image results could not be extracted: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (results.length === 0) return;

	const sessionId = await runtimeSessionId(ctx, api);
	const artifactDirectory = await sessionArtifactDirectory(ctx);
	const locations = {
		outputDirectory: state.outputDirectory,
		artifactDirectory,
		agentImageDirectory: agentImageDirectory(ctx, api),
	};

	for (const result of results) {
		try {
			const key = imageResultKey(sessionId, result);
			if (seen.has(key)) continue;
			seen.add(key);
			const saved = await saveImageResult(result, locations);
			await sendVisibleImageMessage(api, buildImageMessage(result, saved));
		} catch (error) {
			await sendVisibleImageMessage(api, buildImageErrorMessage(result, error));
		}
	}
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
	if (state?.removed && api.setActiveTools) {
		await api.setActiveTools([...state.snapshot]);
	}
	if (key) incompatibleTargets.add(key);

	const message = warningMessage(reason);
	if (ctx.abort) {
		api.logger?.warn?.(message);
		ctx.logger?.warn?.(message);
		await ctx.abort(message);
		return;
	}
	await notifyWarning(api, ctx, message);
}

async function loadConfig(api: ExtensionApiLike, ctx: ExtensionContextLike): Promise<LoadedRuntimeConfig> {
	const runtime = detectRuntimeKind(api, ctx);
	const loaded = await loadAvailableProviderToolsConfig({
		cwd: ctx.cwd ?? process.cwd(),
		homeDir: ctx.homeDir ?? os.homedir(),
		runtime,
	});
	for (const warning of loaded.warnings) {
		api.logger?.warn?.(warning);
		ctx.logger?.warn?.(warning);
	}
	return { config: loaded.config };
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

	api.on?.("session_start", async (_event, ctx) => {
		seenImageResults.clear();
		await loadConfig(api, ctx);
	});

	api.on?.("before_agent_start", async (_event, ctx) => {
		const syntheticPayload = modelPayloadForBeforeAgent(ctx.model);
		if (!syntheticPayload) return undefined;

		const { config } = await loadConfig(api, ctx);
		const target = buildRequestTarget({ payload: syntheticPayload, contextModel: ctx.model });
		if (!target) return undefined;
		const key = targetKey(target);
		if (incompatibleTargets.has(key)) return undefined;

		const entry = findMatchingProvider(config, target);
		if (!entry) return undefined;

		const enabledProviderTools = getEnabledProviderToolTypes(entry);
		if (enabledProviderTools.length === 0) return undefined;

		const snapshot = normalizeActiveToolNames(await api.getActiveTools?.());
		if (!api.getActiveTools || !api.setActiveTools || snapshot.length === 0) {
			expectedByTarget.set(key, { expected: enabledProviderTools, snapshot, removed: false });
			return undefined;
		}

		const hostToolsToRemove = enabledProviderToolsToHostTools(enabledProviderTools);
		const removal = removeHostSideTools(snapshot, hostToolsToRemove);
		if (!removal.removed) {
			expectedByTarget.set(key, { expected: enabledProviderTools, snapshot, removed: false });
			return undefined;
		}

		await api.setActiveTools(removal.toolNames);
		expectedByTarget.set(key, { expected: enabledProviderTools, snapshot, removed: true });
		return undefined;
	});

	api.on?.("before_provider_request", async (event, ctx) => {
		const payload = requestPayload(event);
		const { config } = await loadConfig(api, ctx);
		const target = buildRequestTarget({ payload, contextModel: ctx.model, eventModel: requestEventModel(event) });
		if (!target) {
			const pending = [...expectedByTarget.entries()].find(([, state]) => state.removed);
			if (pending) {
				const [key, state] = pending;
				await failAfterRemoval({ api, ctx, reason: "provider request target could not be verified after host-side tool removal", state, incompatibleTargets, key });
				expectedByTarget.delete(key);
			}
			return undefined;
		}

		const key = targetKey(target);
		const entry = findMatchingProvider(config, target);
		if (!entry) {
			const expected = expectedByTarget.get(key);
			const pending: [string, ExpectedToolsState] | undefined = expected
				? [key, expected]
				: [...expectedByTarget.entries()].find(([, state]) => state.removed);
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
		updateImageResultState(imageResultState, entry);
		const result = injectConfiguredTools(payload, entry);
		const expected = expectedByTarget.get(key);
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

	api.on?.("agent_end", async (event, ctx) => {
		await handleAgentEndImageResults({ api, ctx, event, state: imageResultState, seen: seenImageResults });
	});
}
