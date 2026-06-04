import type { LoggerLike, ProviderToolType } from "./types";
import { displayProviderWebSearchQuery, normalizeProviderWebSearchQueryForIdentity } from "./provider-results";

export const LIVE_STATUS_WIDGET_KEY = "openai-provider-tools-live";

const DEFAULT_THROTTLE_MS = 250;
const MAX_QUERIES = 3;

const MAX_EXPANDED_LIVE_CALLS = 3;
const DEFAULT_COMPLETED_COLLAPSE_MS = 3_000;
const DEFAULT_COMPLETED_HIDE_MS = 8_000;
const DEFAULT_OVERLAY_WIDTH = 80;

type Placement = "aboveEditor" | "belowEditor";
type Phase = "queued" | "searching" | "completed" | "failed";

export type LiveOverlayPhase = "searching" | "completed" | "failed";

export interface LiveOverlayCallSnapshot {
	id: string;
	phase: Phase;
	queries: string[];
	sourceCount?: number;
	actionDetails?: string[];
	error?: string;
	updatedAt: number;
	collapsed?: boolean;
}

export interface LiveOverlaySnapshot {
	phase: LiveOverlayPhase;
	calls: LiveOverlayCallSnapshot[];
	totalCalls: number;
	startedAt: number;
	updatedAt: number;
}

export interface OverlayRuntimeLike {
	requestRender?: () => void;
}

export interface LiveThemeLike {
	fg?: (token: string, value: string) => string;
}

export interface OverlayComponentLike {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate?(): void;
	dispose?(): void;
}

type OverlayFactory = (
	tui: OverlayRuntimeLike,
	theme: LiveThemeLike,
	third?: unknown,
	fourth?: unknown,
) => OverlayComponentLike | Promise<OverlayComponentLike>;

export interface ProviderToolLiveUiSink {
	hasUI?: boolean;
	setWidget?: (key: string, content: string[] | undefined, options?: { placement?: Placement }) => void;
	custom?: (
		factory: OverlayFactory,
		options?: { overlay?: boolean },
	) => Promise<undefined> | undefined;
}

export interface ProviderToolLiveTracker {
	onEvent(event: unknown): void;
	fail(error: unknown): void;
	clear(): void;
}

export interface ProviderToolLiveStatusManager {
	createTracker(options: { enabledTools: readonly ProviderToolType[]; ui?: ProviderToolLiveUiSink }): ProviderToolLiveTracker | undefined;
	clearAll(): void;
}

type LiveStatusTimer = number | ReturnType<typeof setTimeout>;

interface SchedulerLike {
	setTimeout(handler: () => void, timeout: number): LiveStatusTimer;
	clearTimeout(handle: LiveStatusTimer): void;
}

interface LiveToolStatus {
	id: string;
	displayId: string;
	finalProviderItemId?: string;
	providerItemIds: Set<string>;
	ordinal: number;
	requestLocalKey?: string;
	phase: Phase;
	visibility: "full" | "collapsed" | "hidden";
	completionGeneration: number;
	startedAt: number;
	updatedAt: number;
	normalizedQueries: string[];
	queries: string[];
	status?: string;
	sourceCount?: number;
	actionDetails: string[];
	error?: string;
	hideReady?: boolean;
	collapseTimer?: LiveStatusTimer;
	hideTimer?: LiveStatusTimer;
}

interface EventRecord {
	type?: unknown;
	item?: unknown;
	error?: unknown;
	query?: unknown;
	[key: string]: unknown;
}

interface ItemRecord {
	type?: unknown;
	id?: unknown;
	status?: unknown;
	action?: unknown;
	query?: unknown;
	sources?: unknown;
	results?: unknown;
	[key: string]: unknown;
}

interface StatusPatch {
	providerItemId?: string;
	providerItemIdIsFinal: boolean;
	requestLocalKey?: string;
	normalizedQueries: string[];
	displayQueries: string[];
	sourceCount?: number;
	actionDetails: string[];
	phase: Phase;
	itemStatus?: string;
}

export function renderProviderToolLiveOverlay(
	snapshot: LiveOverlaySnapshot,
	width: number,
	theme: LiveThemeLike = {},
	options: { now?: () => number; maxCalls?: number } = {},
): string[] {
	const normalizedWidth = Math.max(24, Math.floor(Number.isFinite(width) ? width : DEFAULT_OVERLAY_WIDTH));
	const now = options.now?.() ?? Date.now();
	const maxCalls = Math.max(1, options.maxCalls ?? 8);
	const lines: string[] = [];
	const label = color(theme, "accent", " OpenAI provider web_search ");
	const hint = color(theme, "dim", ` live overlay  ${snapshot.phase} `);
	const fillerWidth = Math.max(1, normalizedWidth - visibleLength(label) - visibleLength(hint));
	lines.push(truncateToWidth(`${label}${color(theme, "borderMuted", "-".repeat(fillerWidth))}${hint}`, normalizedWidth));

	const elapsedSeconds = Math.max(0, Math.floor((now - snapshot.startedAt) / 1_000));
	const phaseToken = snapshot.phase === "failed" ? "error" : snapshot.phase === "completed" ? "success" : "warning";
	lines.push(truncateToWidth(
		`phase ${color(theme, phaseToken, snapshot.phase)}  calls ${snapshot.totalCalls ?? snapshot.calls.length}  elapsed ${elapsedSeconds}s`,
		normalizedWidth,
	));
	lines.push(truncateToWidth(color(theme, "borderMuted", "-".repeat(normalizedWidth)), normalizedWidth));

	const calls = snapshot.calls.slice(0, maxCalls);
	if (calls.length === 0 && snapshot.phase !== "completed") {
		lines.push(truncateToWidth("┌ web_search_call pending  searching", normalizedWidth));
		lines.push(truncateToWidth("└ updated now", normalizedWidth));
	} else if (calls.length > 0) {
		for (const call of calls) {
			const callPhaseToken = call.phase === "failed" ? "error" : call.phase === "completed" ? "success" : "warning";
			const sourceText = typeof call.sourceCount === "number" ? `  sources ${call.sourceCount}` : "";
			lines.push(truncateToWidth(
				`┌ web_search_call ${shortId(call.id)}  ${color(theme, callPhaseToken, call.phase)}${sourceText}`,
				normalizedWidth,
			));
			if (call.collapsed) {
				const summary = call.queries.length > 0 ? `  ${call.queries.slice(0, MAX_QUERIES).join("; ")}` : "";
				lines.push(truncateToWidth(`└ updated ${formatAge(now, call.updatedAt)}${summary}`, normalizedWidth));
				continue;
			}
			const queries = call.queries.length > 0 ? call.queries : call.actionDetails && call.actionDetails.length > 0 ? [] : ["waiting for provider query"];
			queries.slice(0, MAX_QUERIES).forEach((query, index) => {
				const labelText = queries.length > 1 ? `query ${index + 1}/${Math.min(queries.length, MAX_QUERIES)}` : "query";
				lines.push(truncateToWidth(`│ ${labelText}  "${query}"`, normalizedWidth));
			});
			if (call.actionDetails && call.actionDetails.length > 0) {
				for (const detail of call.actionDetails.slice(0, MAX_QUERIES)) {
					lines.push(truncateToWidth(`│ action  ${detail}`, normalizedWidth));
				}
			}
			if (call.error) {
				lines.push(truncateToWidth(`│ error  ${call.error}`, normalizedWidth));
			}
			lines.push(truncateToWidth(`└ updated ${formatAge(now, call.updatedAt)}`, normalizedWidth));
		}
	}

	lines.push(truncateToWidth(color(theme, "borderMuted", "-".repeat(normalizedWidth)), normalizedWidth));
	lines.push(truncateToWidth(color(theme, "dim", " q close  j/k scroll "), normalizedWidth));
	return lines;
}

export function createProviderToolLiveStatusManager(
	options: {
		logger?: LoggerLike;
		widgetKey?: string;
		now?: () => number;
		scheduler?: SchedulerLike;
		throttleMs?: number;
		placement?: Placement;
		completedAutoCloseMs?: number;
		completedCollapseMs?: number;
		completedHideMs?: number;
	} = {},
): ProviderToolLiveStatusManager {
	const logger = options.logger;
	void options.widgetKey;
	const now = options.now ?? Date.now;
	const scheduler = options.scheduler ?? globalThis;
	const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
	void options.placement;
	void options.completedAutoCloseMs;
	const completedCollapseMs = options.completedCollapseMs ?? DEFAULT_COMPLETED_COLLAPSE_MS;
	const completedHideMs = options.completedHideMs ?? DEFAULT_COMPLETED_HIDE_MS;
	let currentTracker: LiveTracker | undefined;

	function warn(message: string, error: unknown): void {
		try {
			logger?.warn?.(message, error);
		} catch {
			// Logger failures must not affect provider streaming.
		}
	}

	function debug(message: string, error: unknown): void {
		try {
			(logger?.debug ?? logger?.warn)?.(message, error);
		} catch {
			// Logger failures must not affect provider streaming.
		}
	}

	function handleOverlayFailure(tracker: LiveTracker, error: unknown): void {
		warn("OpenAI provider live overlay update failed; disabling current live status UI", error);
		tracker.disable();
	}

	class LiveTracker implements ProviderToolLiveTracker {
		private readonly statuses = new Map<string, LiveToolStatus>();
		private readonly itemIdToStableKey = new Map<string, string>();
		private readonly requestLocalKeyToStableKey = new Map<string, string>();
		private readonly queryToStableKeys = new Map<string, Set<string>>();
		private nextOrdinal = 1;
		private pendingRender: LiveStatusTimer | undefined;
		private pendingAutoClose: LiveStatusTimer | undefined;
		private ended = false;
		private openingOverlay = false;
		private overlay: { requestRender?: () => void; close?: () => void; open: boolean } | undefined;
		private requestCompleted = false;
		private readonly seenDisplayableStatusIds = new Set<string>();
		private readonly startedAt = now();

		constructor(private readonly ui: ProviderToolLiveUiSink | undefined) {}

		onEvent(event: unknown): void {
			if (this.ended) return;
			try {
				this.handleEvent(event);
			} catch (error) {
				debug("Ignoring malformed OpenAI provider live overlay event", error);
			}
		}

		fail(error: unknown): void {
			if (this.ended) return;
			const timestamp = now();
			const status = this.firstStatus() ?? this.createStatus("failure", timestamp);
			status.phase = "failed";
			status.visibility = "full";
			status.completionGeneration += 1;
			status.updatedAt = timestamp;
			status.error = describeError(error);
			this.statuses.set(status.id, status);
			this.cancelPendingAutoClose();
			this.renderNow();
		}

		clear(): void {
			// Request-local stream cleanup must not close the shared live panel.
			// The panel closes when the final custom echo is displayed, when the
			// session clears all live UI, or when the user presses q.
		}

		cancelPendingRender(): void {
			if (this.pendingRender !== undefined) {
				try {
					scheduler.clearTimeout(this.pendingRender);
				} catch (error) {
					warn("OpenAI provider live overlay timer cleanup failed", error);
				}
				this.pendingRender = undefined;
			}
		}

		cancelPendingAutoClose(): void {
			if (this.pendingAutoClose !== undefined) {
				try {
					scheduler.clearTimeout(this.pendingAutoClose);
				} catch (error) {
					warn("OpenAI provider live overlay auto-close cleanup failed", error);
				}
				this.pendingAutoClose = undefined;
			}
		}

		disposeOverlay(): void {
			this.overlay = undefined;
			this.openingOverlay = false;
		}

		disable(): void {
			this.cancelPendingRender();
			this.cancelPendingAutoClose();
			this.cancelAllCompletedTimers();
			if (!this.ended) {
				this.ended = true;
				this.closeOverlay();
			}
			this.overlay = undefined;
			this.openingOverlay = false;
			if (currentTracker === this) currentTracker = undefined;
		}

		private handleEvent(event: unknown): void {
			if (!isRecord(event)) return;
			const typedEvent = event as EventRecord;
			const eventType = typeof typedEvent.type === "string" ? typedEvent.type : undefined;

			if (eventType === "response.completed") {
				this.requestCompleted = true;
				if (!this.hasVisibleStatuses()) {
					this.clear();
					return;
				}
				this.markIncompleteStatuses("completed");
				this.renderNow();
				this.scheduleAutoCloseIfComplete();
				return;
			}

			if (eventType === "response.failed" || eventType === "error") {
				this.fail(typedEvent.error ?? event);
				return;
			}

			if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
				if (!isRecord(typedEvent.item)) return;
				const item = typedEvent.item as ItemRecord;
				if (item.type !== "web_search_call") return;
				const status = this.upsertStatus(item, typedEvent, eventType === "response.output_item.done" ? "completed" : undefined);
				if (eventType === "response.output_item.done") {
					if (!statusHasVisibleDetails(status)) return;
					this.reconcileCompletedVisibility();
					this.cancelPendingAutoClose();
					this.renderNow();
					this.scheduleCompletedTimers(status);
					this.scheduleAutoCloseIfComplete();
				} else {
					if (statusHasVisibleDetails(status)) {
						this.reconcileCompletedVisibility();
						this.cancelPendingAutoClose();
						this.scheduleRender();
					} else {
						this.scheduleAutoCloseIfComplete();
					}
				}
				return;
			}

			if (
				eventType === "response.web_search_call.in_progress"
				|| eventType === "response.web_search_call.searching"
				|| eventType === "response.web_search_call.completed"
			) {
				const item = this.lifecycleItem(typedEvent);
				if (item && item.type !== undefined && item.type !== "web_search_call") return;
				const phase = eventType === "response.web_search_call.completed" ? "completed" : "searching";
				const status = this.upsertStatus(item, typedEvent, phase);
				if (statusHasVisibleDetails(status)) {
					this.reconcileCompletedVisibility();
					if (status.phase === "completed") this.scheduleCompletedTimers(status);
					this.cancelPendingAutoClose();
					this.scheduleRender();
					this.scheduleAutoCloseIfComplete();
				}
			}
		}

		private lifecycleItem(event: EventRecord): ItemRecord {
			const item = isRecord(event.item) ? { ...(event.item as ItemRecord) } : {} as ItemRecord;
			if (item.type === undefined) item.type = "web_search_call";
			if (item.id === undefined && typeof event.item_id === "string" && event.item_id.length > 0) {
				item.id = event.item_id;
			}
			if (item.status === undefined && typeof event.type === "string") {
				item.status = event.type.slice("response.web_search_call.".length);
			}
			if (item.sources === undefined && Array.isArray(event.sources)) {
				item.sources = event.sources;
			}
			if (item.results === undefined && Array.isArray(event.results)) {
				item.results = event.results;
			}
			return item;
		}

		private upsertStatus(item: ItemRecord | undefined, event: EventRecord, explicitPhase?: Phase): LiveToolStatus {
			const timestamp = now();
			const patch = createStatusPatch(item, event, explicitPhase);
			const status = this.statuses.get(this.findMergeTarget(patch)) ?? this.createStatus(this.createStableKey(patch), timestamp);
			status.updatedAt = timestamp;
			status.phase = patch.phase;
			status.status = patch.itemStatus ?? status.status;
			if (patch.requestLocalKey) {
				status.requestLocalKey = patch.requestLocalKey;
				this.requestLocalKeyToStableKey.set(patch.requestLocalKey, status.id);
			}
			if (patch.providerItemId) {
				status.providerItemIds.add(patch.providerItemId);
				this.itemIdToStableKey.set(patch.providerItemId, status.id);
				if (patch.providerItemIdIsFinal) {
					status.finalProviderItemId = patch.providerItemId;
					status.displayId = patch.providerItemId;
				}
			}
			if (patch.displayQueries.length > 0) {
				this.setQueries(status, patch.normalizedQueries, patch.displayQueries);
			}
			if (patch.sourceCount !== undefined) {
				status.sourceCount = patch.sourceCount;
			}
			if (patch.actionDetails.length > 0) {
				status.actionDetails = patch.actionDetails;
			}
			if (status.phase === "searching" || status.phase === "failed") {
				status.visibility = "full";
				status.completionGeneration += 1;
				this.cancelCompletedTimers(status);
			}
			this.statuses.set(status.id, status);
			return status;
		}

		private findMergeTarget(patch: StatusPatch): string {
			if (patch.providerItemId) {
				const mapped = this.itemIdToStableKey.get(patch.providerItemId);
				if (mapped) return mapped;
			}
			if (patch.requestLocalKey) {
				const mapped = this.requestLocalKeyToStableKey.get(patch.requestLocalKey);
				if (mapped) return mapped;
			}
			if (patch.providerItemIdIsFinal && patch.providerItemId) {
				const target = this.uniqueUnfinalizedQueryCandidate(patch.normalizedQueries, patch.providerItemId);
				if (target) return target.id;
			}
			if (!patch.providerItemIdIsFinal) {
				const target = this.uniquePendingQueryCandidate(patch.normalizedQueries);
				if (target) return target.id;
			}
			return this.createStableKey(patch);
		}

		private uniqueUnfinalizedQueryCandidate(queries: string[], finalId: string): LiveToolStatus | undefined {
			const candidates = this.queryCandidates(queries);
			let match: LiveToolStatus | undefined;
			for (const candidate of candidates) {
				if (candidate.finalProviderItemId && candidate.finalProviderItemId !== finalId) continue;
				if (match && match !== candidate) return undefined;
				match = candidate;
			}
			return match;
		}


		private uniquePendingQueryCandidate(queries: string[]): LiveToolStatus | undefined {
			const candidates = this.queryCandidates(queries);
			let match: LiveToolStatus | undefined;
			for (const candidate of candidates) {
				if (candidate.finalProviderItemId || candidate.phase === "completed" || candidate.visibility !== "full") continue;
				if (match && match !== candidate) return undefined;
				match = candidate;
			}
			return match;
		}

		private queryCandidates(queries: string[]): Set<LiveToolStatus> {
			const candidates = new Set<LiveToolStatus>();
			for (const query of queries) {
				const keys = this.queryToStableKeys.get(query);
				if (!keys) continue;
				for (const key of keys) {
					const status = this.statuses.get(key);
					if (status) candidates.add(status);
				}
			}
			return candidates;
		}

		private createStableKey(patch: StatusPatch): string {
			if (patch.providerItemId && patch.providerItemIdIsFinal) return `final:${patch.providerItemId}`;
			if (patch.providerItemId) return `provider:${patch.providerItemId}`;
			if (patch.requestLocalKey) return `request:${patch.requestLocalKey}`;
			const firstQuery = patch.normalizedQueries[0];
			if (firstQuery) return `content:${firstQuery}:${this.nextOrdinal}`;
			return `placeholder:${this.nextOrdinal}`;
		}

		private createStatus(id: string, timestamp: number): LiveToolStatus {
			const ordinal = this.nextOrdinal++;
			return {
				id,
				displayId: `search #${ordinal}`,
				providerItemIds: new Set<string>(),
				ordinal,
				phase: "queued",
				visibility: "full",
				completionGeneration: 0,
				startedAt: timestamp,
				updatedAt: timestamp,
				normalizedQueries: [],
				queries: [],
				actionDetails: [],
			};
		}

		private setQueries(status: LiveToolStatus, normalizedQueries: string[], displayQueries: string[]): void {
			for (const query of status.normalizedQueries) {
				const keys = this.queryToStableKeys.get(query);
				if (!keys) continue;
				keys.delete(status.id);
				if (keys.size === 0) this.queryToStableKeys.delete(query);
			}
			status.normalizedQueries = normalizedQueries;
			status.queries = displayQueries;
			for (const query of normalizedQueries) {
				let keys = this.queryToStableKeys.get(query);
				if (!keys) {
					keys = new Set<string>();
					this.queryToStableKeys.set(query, keys);
				}
				keys.add(status.id);
			}
		}

		private reconcileCompletedVisibility(): void {
			this.rememberDisplayableStatuses();
			const displayable = [...this.statuses.values()].filter(statusHasVisibleDetails);
			if (displayable.length <= MAX_EXPANDED_LIVE_CALLS) {
				for (const status of displayable) {
					if (status.phase === "completed") status.visibility = "full";
				}
				return;
			}

			const nonCompleted = displayable.filter(status => status.phase !== "completed" && status.visibility !== "hidden");
			const completed = displayable
				.filter(status => status.phase === "completed")
				.sort((left, right) => right.updatedAt - left.updatedAt || right.ordinal - left.ordinal);
			const visibleTarget = Math.min(MAX_EXPANDED_LIVE_CALLS, displayable.length);
			const visibleCompletedSlots = Math.max(0, visibleTarget - nonCompleted.length);
			const keepVisible = new Set(completed.slice(0, visibleCompletedSlots));
			for (const status of completed) {
				if (keepVisible.has(status)) {
					status.visibility = "full";
				} else {
					status.visibility = status.hideReady ? "hidden" : "collapsed";
				}
			}
		}

		private markIncompleteStatuses(phase: Phase): void {
			const timestamp = now();
			for (const status of this.statuses.values()) {
				if (status.phase !== "failed" && status.visibility !== "hidden" && statusHasVisibleDetails(status)) {
					status.phase = phase;
					status.updatedAt = timestamp;
					this.scheduleCompletedTimers(status);
				}
			}
			this.reconcileCompletedVisibility();
		}

		private hasVisibleStatuses(): boolean {
			for (const status of this.statuses.values()) {
				if (status.visibility !== "hidden" && statusHasVisibleDetails(status)) return true;
			}
			return false;
		}

		private scheduleAutoCloseIfComplete(): void {
			// The live panel lifetime is tied to the final provider-result custom message.
			// Provider lifecycle events may mark calls complete, collapse, or hide rows, but
			// they must not close the overlay before the final UI-only echo is displayed.
			return;
		}

		private scheduleCompletedTimers(status: LiveToolStatus): void {
			if (this.ended || status.phase !== "completed" || !statusHasVisibleDetails(status)) return;
			this.cancelCompletedTimers(status);
			status.completionGeneration += 1;
			status.hideReady = false;
			status.visibility = "full";
			const generation = status.completionGeneration;
			if (completedCollapseMs > 0) {
				try {
					status.collapseTimer = scheduler.setTimeout(() => {
						status.collapseTimer = undefined;
						if (this.ended || status.phase !== "completed" || status.completionGeneration !== generation) return;
						this.reconcileCompletedVisibility();
						this.renderNow();
					}, completedCollapseMs);
				} catch (error) {
					handleOverlayFailure(this, error);
				}
			}
			if (completedHideMs > 0) {
				try {
					status.hideTimer = scheduler.setTimeout(() => {
						status.hideTimer = undefined;
						if (this.ended || status.phase !== "completed" || status.completionGeneration !== generation) return;
						status.hideReady = true;
						this.reconcileCompletedVisibility();
						this.scheduleAutoCloseIfComplete();
						this.renderNow();
					}, completedHideMs);
				} catch (error) {
					handleOverlayFailure(this, error);
				}
			}
		}

		private cancelCompletedTimers(status: LiveToolStatus): void {
			if (status.collapseTimer !== undefined) {
				try {
					scheduler.clearTimeout(status.collapseTimer);
				} catch (error) {
					warn("OpenAI provider live overlay collapse timer cleanup failed", error);
				}
				status.collapseTimer = undefined;
			}
			if (status.hideTimer !== undefined) {
				try {
					scheduler.clearTimeout(status.hideTimer);
				} catch (error) {
					warn("OpenAI provider live overlay hide timer cleanup failed", error);
				}
				status.hideTimer = undefined;
			}
		}

		private cancelAllCompletedTimers(): void {
			for (const status of this.statuses.values()) {
				this.cancelCompletedTimers(status);
			}
		}

		private scheduleRender(): void {
			if (this.ended || typeof this.ui?.custom !== "function") return;
			if (throttleMs <= 0) {
				this.renderNow();
				return;
			}
			if (this.pendingRender !== undefined) return;
			try {
				this.pendingRender = scheduler.setTimeout(() => {
					this.pendingRender = undefined;
					this.renderNow();
				}, throttleMs);
			} catch (error) {
				handleOverlayFailure(this, error);
			}
		}

		private renderNow(): void {
			this.cancelPendingRender();
			if (this.ended || typeof this.ui?.custom !== "function") return;
			this.showOrRenderOverlay();
		}

		private showOrRenderOverlay(): void {
			if (this.overlay?.open) {
				try {
					this.overlay.requestRender?.();
				} catch (error) {
					handleOverlayFailure(this, error);
				}
				return;
			}
			if (this.openingOverlay) return;
			this.openingOverlay = true;

			try {
				const result = this.ui!.custom!(this.createOverlayFactory(), { overlay: true });
				void Promise.resolve(result).catch((error) => {
					handleOverlayFailure(this, error);
				}).finally(() => {
					this.openingOverlay = false;
				});
			} catch (error) {
				this.openingOverlay = false;
				handleOverlayFailure(this, error);
			}
		}

		private createOverlayFactory(): OverlayFactory {
			return (tui: OverlayRuntimeLike, theme: LiveThemeLike = {}, third?: unknown, fourth?: unknown) => {
				const done = typeof fourth === "function"
					? fourth as (result: undefined) => void
					: typeof third === "function"
						? third as (result: undefined) => void
						: undefined;
				let closed = false;
				const close = () => {
					if (closed) return;
					closed = true;
					try {
						done?.(undefined);
					} catch (error) {
						handleOverlayFailure(this, error);
					}
					this.overlay = undefined;
					this.openingOverlay = false;
					this.ended = true;
					this.cancelPendingRender();
					this.cancelPendingAutoClose();
					if (currentTracker === this) currentTracker = undefined;
				};

				const component: OverlayComponentLike = {
					render: (width: number) => renderProviderToolLiveOverlay(this.snapshot(), width, theme, { now }),
					handleInput: (data: string) => {
						const normalized = String(data).toLowerCase();
						if (normalized === "q") {
							close();
						}
					},
					dispose: () => {
						closed = true;
						this.disable();
					},
				};
				const requestRender = typeof tui?.requestRender === "function" ? () => tui.requestRender?.() : undefined;
				this.overlay = { requestRender, close, open: true };
				return component;
			};
		}

		private closeOverlay(): void {
			const close = this.overlay?.close;
			this.overlay = undefined;
			this.openingOverlay = false;
			if (close) {
				try {
					close();
				} catch (error) {
					handleOverlayFailure(this, error);
				}
			}
		}

		private rememberDisplayableStatuses(): void {
			for (const status of this.statuses.values()) {
				if (statusHasVisibleDetails(status)) this.seenDisplayableStatusIds.add(status.id);
			}
		}

		private snapshot(): LiveOverlaySnapshot {
			this.rememberDisplayableStatuses();
			const visibleStatuses = [...this.statuses.values()].filter(status => status.visibility !== "hidden" && statusHasVisibleDetails(status));
			const calls = visibleStatuses
				.sort((left, right) => right.updatedAt - left.updatedAt)
				.map((status): LiveOverlayCallSnapshot => ({
					id: status.displayId,
					phase: status.phase,
					queries: status.queries,
					sourceCount: status.sourceCount,
					actionDetails: status.actionDetails,
					error: status.error,
					updatedAt: status.updatedAt,
					collapsed: status.visibility === "collapsed",
				}));
			const allStatuses = [...this.statuses.values()].filter(statusHasVisibleDetails);
			const hasFailure = allStatuses.some((status) => status.phase === "failed");
			const allCompleted = allStatuses.length > 0 && allStatuses.every((status) => status.phase === "completed");
			const updatedAt = allStatuses.reduce((max, status) => Math.max(max, status.updatedAt), this.startedAt);
			return {
				phase: hasFailure ? "failed" : allCompleted ? "completed" : "searching",
				calls,
				totalCalls: this.seenDisplayableStatusIds.size,
				startedAt: this.startedAt,
				updatedAt,
			};
		}

		private firstStatus(): LiveToolStatus | undefined {
			return [...this.statuses.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0];
		}
	}

	return {
		createTracker({ enabledTools, ui }) {
			if (!enabledTools.includes("web_search")) return undefined;
			if (currentTracker) return currentTracker;
			currentTracker = new LiveTracker(ui);
			return currentTracker;
		},
		clearAll() {
			currentTracker?.disable();
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function createStatusPatch(item: ItemRecord | undefined, event: EventRecord, explicitPhase?: Phase): StatusPatch {
	const normalizedQueries = extractNormalizedQueries(item, event);
	const providerItemId = typeof item?.id === "string" && item.id.length > 0 ? item.id : undefined;
	return {
		providerItemId,
		providerItemIdIsFinal: isFinalProviderItemId(providerItemId),
		requestLocalKey: createRequestLocalKey(event),
		normalizedQueries,
		displayQueries: normalizedQueries.map(displayProviderWebSearchQuery),
		sourceCount: extractSourceCount(item),
		actionDetails: extractActionDetails(item),
		phase: explicitPhase ?? inferPhase(item, normalizedQueries),
		itemStatus: typeof item?.status === "string" ? item.status : undefined,
	};
}

function createRequestLocalKey(event: EventRecord): string | undefined {
	const outputIndex = stableIntegerToken(event.output_index);
	if (outputIndex !== undefined) return `output:${outputIndex}`;
	const sequenceNumber = stableIntegerToken(event.sequence_number);
	if (sequenceNumber !== undefined) return `sequence:${sequenceNumber}`;
	return undefined;
}

function stableIntegerToken(value: unknown): string | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? String(value) : undefined;
}

function inferPhase(item: ItemRecord | undefined, queries: string[]): Phase {
	if (typeof item?.status === "string") {
		const normalized = item.status.toLowerCase();
		if (normalized === "completed") return "completed";
		if (normalized === "failed") return "failed";
		if (normalized === "searching" || normalized === "in_progress" || normalized === "in-progress") return "searching";
	}
	return queries.length > 0 ? "searching" : "queued";
}

function extractNormalizedQueries(item: ItemRecord | undefined, event: EventRecord): string[] {
	const action = isRecord(item?.action) ? (item.action as Record<string, unknown>) : undefined;
	const candidates: unknown[] = [];
	if (typeof action?.query === "string") candidates.push(action.query);
	if (Array.isArray(action?.queries)) candidates.push(...action.queries);
	if (typeof item?.query === "string") candidates.push(item.query);
	if (typeof event.query === "string") candidates.push(event.query);
	const queries: string[] = [];
	for (const candidate of candidates) {
		const normalized = normalizeProviderWebSearchQueryForIdentity(candidate);
		if (!normalized || queries.includes(normalized)) continue;
		queries.push(normalized);
		if (queries.length >= MAX_QUERIES) break;
	}
	return queries;
}

function isFinalProviderItemId(id: string | undefined): boolean {
	if (!id) return false;
	return !(id.startsWith("res_") || id.startsWith("resp_") || id === "unknown");
}

function extractSourceCount(item: ItemRecord | undefined): number | undefined {
	if (Array.isArray(item?.sources)) return item.sources.length;
	const action = isRecord(item?.action) ? (item.action as Record<string, unknown>) : undefined;
	if (Array.isArray(action?.sources)) return action.sources.length;
	if (Array.isArray(item?.results)) return item.results.length;
	return undefined;
}

function extractActionDetails(item: ItemRecord | undefined): string[] {
	const action = isRecord(item?.action) ? (item.action as Record<string, unknown>) : undefined;
	if (!action) return [];
	const actionType = typeof action.type === "string" ? action.type : undefined;
	if (actionType === "open_page" && typeof action.url === "string" && action.url.trim().length > 0) {
		return [`open_page url: ${displayProviderWebSearchQuery(action.url)}`];
	}
	if (actionType === "find_in_page" && typeof action.pattern === "string" && action.pattern.trim().length > 0) {
		return [`find_in_page pattern: ${displayProviderWebSearchQuery(action.pattern)}`];
	}
	return [];
}

function statusHasRenderableDetails(status: LiveToolStatus | undefined): boolean {
	if (!status) return false;
	return status.queries.length > 0 || status.actionDetails.length > 0 || typeof status.sourceCount === "number" || Boolean(status.error) || status.phase === "failed" || status.phase === "completed";
}

function statusHasVisibleDetails(status: LiveToolStatus | undefined): boolean {
	if (!status) return false;
	return statusHasRenderableDetails(status) || status.phase === "searching" || status.phase === "queued";
}

function describeError(error: unknown): string {
	if (error instanceof Error && error.message) return displayProviderWebSearchQuery(error.message);
	if (typeof error === "string") return displayProviderWebSearchQuery(error);
	if (isRecord(error) && typeof error.message === "string") return displayProviderWebSearchQuery(error.message);
	return "stream error";
}

function color(theme: LiveThemeLike, token: string, value: string): string {
	try {
		return theme.fg?.(token, value) ?? value;
	} catch {
		return value;
	}
}

function shortId(id: string): string {
	const chars = [...id];
	if (chars.length <= 16) return id;
	return `${chars.slice(0, 7).join("")}…${chars.slice(-6).join("")}`;
}

function formatAge(now: number, updatedAt: number): string {
	const seconds = Math.max(0, Math.floor((now - updatedAt) / 1_000));
	return seconds === 0 ? "now" : `${seconds}s ago`;
}

function stripAnsi(value: string): string {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\[[A-Za-z]+:([^\]]*)\]/g, "$1");
}

function visibleLength(value: string): number {
	return [...stripAnsi(value)].length;
}

function truncateToWidth(value: string, width: number): string {
	if (width <= 0) return "";
	if (visibleLength(value) <= width) return value;
	const target = Math.max(0, width - 1);
	let result = "";
	let visible = 0;
	for (let index = 0; index < value.length && visible < target;) {
		const ansi = value.slice(index).match(/^\x1B\[[0-?]*[ -/]*[@-~]/);
		if (ansi?.[0]) {
			result += ansi[0];
			index += ansi[0].length;
			continue;
		}
		const codePoint = value.codePointAt(index);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		result += char;
		visible += 1;
		index += char.length;
	}
	return `${result}…`;
}
