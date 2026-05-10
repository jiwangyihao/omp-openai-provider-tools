import type { LoggerLike, ProviderToolType } from "./types";

export const LIVE_STATUS_WIDGET_KEY = "openai-provider-tools-live";

const DEFAULT_THROTTLE_MS = 250;
const MAX_QUERIES = 3;
const MAX_QUERY_CHARS = 140;
const DEFAULT_COMPLETED_AUTO_CLOSE_MS = 3_000;
const DEFAULT_OVERLAY_WIDTH = 80;

type Placement = "aboveEditor" | "belowEditor";
type Phase = "queued" | "searching" | "completed" | "failed";

export type LiveOverlayPhase = "searching" | "completed" | "failed";

export interface LiveOverlayCallSnapshot {
	id: string;
	phase: Phase;
	queries: string[];
	sourceCount?: number;
	error?: string;
	updatedAt: number;
}

export interface LiveOverlaySnapshot {
	phase: LiveOverlayPhase;
	calls: LiveOverlayCallSnapshot[];
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

interface SchedulerLike {
	setTimeout(handler: () => void, timeout: number): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

interface LiveToolStatus {
	id: string;
	phase: Phase;
	startedAt: number;
	updatedAt: number;
	queries: string[];
	status?: string;
	sourceCount?: number;
	error?: string;
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
		`phase ${color(theme, phaseToken, snapshot.phase)}  calls ${snapshot.calls.length}  elapsed ${elapsedSeconds}s`,
		normalizedWidth,
	));
	lines.push(truncateToWidth(color(theme, "borderMuted", "-".repeat(normalizedWidth)), normalizedWidth));

	const calls = snapshot.calls.slice(0, maxCalls);
	if (calls.length === 0) {
		lines.push(truncateToWidth("┌ web_search_call pending  searching", normalizedWidth));
		lines.push(truncateToWidth("└ updated now", normalizedWidth));
	} else {
		for (const call of calls) {
			const callPhaseToken = call.phase === "failed" ? "error" : call.phase === "completed" ? "success" : "warning";
			const sourceText = typeof call.sourceCount === "number" ? `  sources ${call.sourceCount}` : "";
			lines.push(truncateToWidth(
				`┌ web_search_call ${shortId(call.id)}  ${color(theme, callPhaseToken, call.phase)}${sourceText}`,
				normalizedWidth,
			));
			const queries = call.queries.length > 0 ? call.queries : ["waiting for provider query"];
			queries.slice(0, MAX_QUERIES).forEach((query, index) => {
				const labelText = queries.length > 1 ? `query ${index + 1}/${Math.min(queries.length, MAX_QUERIES)}` : "query";
				lines.push(truncateToWidth(`│ ${labelText}  "${query}"`, normalizedWidth));
			});
			if (call.error) {
				lines.push(truncateToWidth(`│ error  ${call.error}`, normalizedWidth));
			}
			lines.push(truncateToWidth(`└ updated ${formatAge(now, call.updatedAt)}`, normalizedWidth));
		}
	}

	lines.push(truncateToWidth(color(theme, "borderMuted", "-".repeat(normalizedWidth)), normalizedWidth));
	lines.push(truncateToWidth(color(theme, "dim", " esc/q close  j/k scroll "), normalizedWidth));
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
	} = {},
): ProviderToolLiveStatusManager {
	const logger = options.logger;
	void options.widgetKey;
	const now = options.now ?? Date.now;
	const scheduler = options.scheduler ?? globalThis;
	const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
	void options.placement;
	const completedAutoCloseMs = options.completedAutoCloseMs ?? DEFAULT_COMPLETED_AUTO_CLOSE_MS;
	const activeTrackers = new Set<LiveTracker>();
	let disabled = false;

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

	function disableAfterOverlayFailure(error: unknown): void {
		disabled = true;
		warn("OpenAI provider live overlay update failed; disabling live status UI", error);
		for (const tracker of [...activeTrackers]) {
			tracker.disable();
		}
	}

	class LiveTracker implements ProviderToolLiveTracker {
		private readonly statuses = new Map<string, LiveToolStatus>();
		private pendingRender: ReturnType<typeof setTimeout> | undefined;
		private pendingAutoClose: ReturnType<typeof setTimeout> | undefined;
		private ended = false;
		private openingOverlay = false;
		private overlay: { requestRender?: () => void; close?: () => void; open: boolean } | undefined;
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
			this.cancelPendingRender();
			this.cancelPendingAutoClose();
			const timestamp = now();
			const status = this.firstStatus() ?? this.createStatus("failure", timestamp);
			status.phase = "failed";
			status.updatedAt = timestamp;
			status.error = describeError(error);
			this.statuses.set(status.id, status);
			this.renderNow();
			this.closeOverlay();
			this.ended = true;
			activeTrackers.delete(this);
		}

		clear(): void {
			this.cancelPendingRender();
			this.cancelPendingAutoClose();
			if (!this.ended) {
				this.ended = true;
				this.closeOverlay();
				activeTrackers.delete(this);
			}
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
			this.overlay = undefined;
			this.openingOverlay = false;
			this.ended = true;
			activeTrackers.delete(this);
		}

		private handleEvent(event: unknown): void {
			if (!isRecord(event)) return;
			const typedEvent = event as EventRecord;
			const eventType = typeof typedEvent.type === "string" ? typedEvent.type : undefined;

			if (eventType === "response.completed") {
				if (!this.hasRenderableStatuses()) {
					this.disable();
					return;
				}
				this.markIncompleteStatuses("completed");
				this.renderNow();
				this.scheduleAutoClose();
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
				this.upsertStatus(item, typedEvent, eventType === "response.output_item.done" ? "completed" : undefined);
				const status = this.statuses.get(getStatusId(item, typedEvent));
				if (eventType === "response.output_item.done") {
					if (!statusHasRenderableDetails(status)) return;
					this.renderNow();
					this.scheduleAutoCloseIfComplete();
				} else {
					this.cancelPendingAutoClose();
					if (statusHasRenderableDetails(status)) this.scheduleRender();
				}
				return;
			}

			if (eventType === "response.web_search_call.searching") {
				const item = isRecord(typedEvent.item) ? (typedEvent.item as ItemRecord) : undefined;
				if (item && item.type !== undefined && item.type !== "web_search_call") return;
				this.upsertStatus(item, typedEvent, "searching");
				if (statusHasRenderableDetails(this.statuses.get(getStatusId(item, typedEvent)))) this.scheduleRender();
			}
		}

		private upsertStatus(item: ItemRecord | undefined, event: EventRecord, explicitPhase?: Phase): void {
			const timestamp = now();
			const id = getStatusId(item, event);
			const status = this.statuses.get(id) ?? this.createStatus(id, timestamp);
			const queries = extractQueries(item, event);
			const sourceCount = extractSourceCount(item);
			status.updatedAt = timestamp;
			status.phase = explicitPhase ?? inferPhase(item, queries);
			status.status = typeof item?.status === "string" ? item.status : status.status;
			if (queries.length > 0) {
				status.queries = queries;
			}
			if (sourceCount !== undefined) {
				status.sourceCount = sourceCount;
			}
			this.statuses.set(id, status);
		}

		private createStatus(id: string, timestamp: number): LiveToolStatus {
			return {
				id,
				phase: "queued",
				startedAt: timestamp,
				updatedAt: timestamp,
				queries: [],
			};
		}

		private markIncompleteStatuses(phase: Phase): void {
			const timestamp = now();
			for (const status of this.statuses.values()) {
				if (status.phase !== "failed") {
					status.phase = phase;
					status.updatedAt = timestamp;
				}
			}
		}

		private hasRenderableStatuses(): boolean {
			for (const status of this.statuses.values()) {
				if (statusHasRenderableDetails(status)) return true;
			}
			return false;
		}

		private scheduleAutoCloseIfComplete(): void {
			const calls = [...this.statuses.values()];
			if (calls.length > 0 && calls.every((status) => status.phase === "completed")) {
				this.scheduleAutoClose();
			}
		}

		private scheduleAutoClose(): void {
			if (this.ended || completedAutoCloseMs <= 0) return;
			this.cancelPendingAutoClose();
			try {
				this.pendingAutoClose = scheduler.setTimeout(() => {
					this.pendingAutoClose = undefined;
					this.clear();
				}, completedAutoCloseMs);
			} catch (error) {
				disableAfterOverlayFailure(error);
			}
		}

		private scheduleRender(): void {
			if (this.ended || disabled || !this.ui?.custom) return;
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
				disableAfterOverlayFailure(error);
			}
		}

		private renderNow(): void {
			this.cancelPendingRender();
			if (this.ended || disabled || !this.ui?.custom) return;
			this.showOrRenderOverlay();
		}

		private showOrRenderOverlay(): void {
			if (this.overlay?.open) {
				try {
					this.overlay.requestRender?.();
				} catch (error) {
					disableAfterOverlayFailure(error);
				}
				return;
			}
			if (this.openingOverlay) return;
			this.openingOverlay = true;

			try {
				const result = this.ui!.custom!(this.createOverlayFactory(), { overlay: true });
				void Promise.resolve(result).catch((error) => {
					disableAfterOverlayFailure(error);
				}).finally(() => {
					this.openingOverlay = false;
				});
			} catch (error) {
				this.openingOverlay = false;
				disableAfterOverlayFailure(error);
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
						disableAfterOverlayFailure(error);
					}
					this.overlay = undefined;
					this.openingOverlay = false;
					this.ended = true;
					this.cancelPendingRender();
					this.cancelPendingAutoClose();
					activeTrackers.delete(this);
				};

				const component: OverlayComponentLike = {
					render: (width: number) => renderProviderToolLiveOverlay(this.snapshot(), width, theme, { now }),
					handleInput: (data: string) => {
						const normalized = String(data).toLowerCase();
						if (normalized === "q" || normalized === "escape" || normalized === "esc") {
							close();
						}
					},
					dispose: () => {
						closed = true;
						this.disable();
					},
				};
				this.overlay = { requestRender: tui?.requestRender, close, open: true };
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
					disableAfterOverlayFailure(error);
				}
			}
		}

		private snapshot(): LiveOverlaySnapshot {
			const calls = [...this.statuses.values()]
				.sort((left, right) => right.updatedAt - left.updatedAt)
				.map((status): LiveOverlayCallSnapshot => ({
					id: status.id,
					phase: status.phase,
					queries: status.queries,
					sourceCount: status.sourceCount,
					error: status.error,
					updatedAt: status.updatedAt,
				}));
			const hasFailure = calls.some((call) => call.phase === "failed");
			const allCompleted = calls.length > 0 && calls.every((call) => call.phase === "completed");
			const updatedAt = calls.reduce((max, call) => Math.max(max, call.updatedAt), this.startedAt);
			return {
				phase: hasFailure ? "failed" : allCompleted ? "completed" : "searching",
				calls,
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
			const tracker = new LiveTracker(ui);
			activeTrackers.add(tracker);
			return tracker;
		},
		clearAll() {
			for (const tracker of [...activeTrackers]) {
				tracker.clear();
			}
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getStatusId(item: ItemRecord | undefined, event: EventRecord): string {
	if (typeof item?.id === "string" && item.id.length > 0) return item.id;
	const eventType = typeof event.type === "string" ? event.type : "web_search_call";
	const query = extractQueries(item, event)[0] ?? "unknown";
	return `${eventType}:${query}`;
}

function inferPhase(item: ItemRecord | undefined, queries: string[]): Phase {
	if (typeof item?.status === "string") {
		const normalized = item.status.toLowerCase();
		if (normalized === "completed") return "completed";
		if (normalized === "failed") return "failed";
		if (normalized === "searching" || normalized === "in_progress") return "searching";
	}
	return queries.length > 0 ? "searching" : "queued";
}

function extractQueries(item: ItemRecord | undefined, event: EventRecord): string[] {
	const action = isRecord(item?.action) ? (item.action as Record<string, unknown>) : undefined;
	const candidates: unknown[] = [];
	if (typeof action?.query === "string") candidates.push(action.query);
	if (Array.isArray(action?.queries)) candidates.push(...action.queries);
	if (typeof item?.query === "string") candidates.push(item.query);
	if (typeof event.query === "string") candidates.push(event.query);
	const queries: string[] = [];
	for (const candidate of candidates) {
		if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
		const formatted = formatQuery(candidate);
		if (!queries.includes(formatted)) queries.push(formatted);
		if (queries.length >= MAX_QUERIES) break;
	}
	return queries;
}

function formatQuery(query: string): string {
	const singleLine = query.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
	const chars = [...singleLine];
	if (chars.length <= MAX_QUERY_CHARS) return singleLine;
	return `${chars.slice(0, MAX_QUERY_CHARS).join("")}…`;
}

function extractSourceCount(item: ItemRecord | undefined): number | undefined {
	if (Array.isArray(item?.sources)) return item.sources.length;
	const action = isRecord(item?.action) ? (item.action as Record<string, unknown>) : undefined;
	if (Array.isArray(action?.sources)) return action.sources.length;
	if (Array.isArray(item?.results)) return item.results.length;
	return undefined;
}

function statusHasRenderableDetails(status: LiveToolStatus | undefined): boolean {
	if (!status) return false;
	return status.queries.length > 0 || typeof status.sourceCount === "number" || Boolean(status.error) || status.phase === "failed";
}

function describeError(error: unknown): string {
	if (error instanceof Error && error.message) return formatQuery(error.message);
	if (typeof error === "string") return formatQuery(error);
	if (isRecord(error) && typeof error.message === "string") return formatQuery(error.message);
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
