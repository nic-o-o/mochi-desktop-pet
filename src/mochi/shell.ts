/* Bridge to the Electron desktop shell.
 * In a plain browser `window.mochiShell` is undefined and every function here
 * is a no-op, so `npm run dev` behaves exactly as before.
 */
import type { AgentJob, AgentReviewStart } from './agentReviews.ts';
import type { CodimangoFetchResult } from './codimango.ts';
import type { Sev } from './sevs.ts';

export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Each display in global coordinates; x/y/width/height above is the box around them all. */
  displays?: { x: number; y: number; width: number; height: number }[];
}

export interface BoundsRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the renderer contributes to a problem report: status and counts only. */
export interface ProblemReportState {
  build: string;
  status: string;
  failureKind: string | null;
  fetchedAtMs: number | null;
  counts: { reviews: number; revisions: number; drafts: number };
}

export interface MochiShell {
  /** Primary display bounds in screen coordinates (async: main process). */
  getDisplayBounds: () => Promise<DisplayBounds>;
  /** Subscribe to display-geometry changes; returns an unsubscribe function. */
  onDisplayChanged: (callback: () => void) => () => void;
  /** Fired by the shell's simulate global shortcut; returns unsubscribe. */
  onSimulateNotification: (callback: () => void) => () => void;
  /** Resize/move the shell window to the union of visible UI (screen coords). */
  syncBounds: (rect: BoundsRect) => void;
  /** Fired after the Mac wakes from sleep or the screen unlocks; returns unsubscribe. */
  onSystemResumed?: (callback: () => void) => () => void;
  /** Dock menu "Report a Problem…" asks the renderer to start a report; returns unsubscribe. */
  onReportRequest?: (callback: () => void) => () => void;
  /** Copy diagnostics (plus version, OS, log tail) and open #mochi-dogfood-feedback in Slack. */
  reportProblem?: (state: ProblemReportState) => Promise<boolean>;
  /** Read your reviews and tasks through the codimango CLI login (main process). */
  fetchCodimango?: () => Promise<CodimangoFetchResult>;
  /** Open a Codimango (or Alacarte) page in the default browser. */
  openLink?: (url: string) => Promise<boolean>;
  /** Append a usage event to events.jsonl (main adds the common columns). */
  logEvent?: (event: UsageEvent) => void;
  /** Last 7 days of usage as paste-able counts; null if nothing is logged. */
  usageSummary?: () => Promise<string | null>;
  /** Codimango SEVs, already filtered (open in the last week, or mitigated in the last day). */
  listSevs?: () => Promise<Sev[]>;
  /** The SEV list changed (read every ten minutes); returns unsubscribe. */
  onSevsChanged?: (callback: (sevs: Sev[]) => void) => () => void;
  /** Screen locked (true) or unlocked (false); returns unsubscribe. */
  onScreenLock?: (callback: (locked: boolean) => void) => () => void;
  /** Agent review runs and their reports, oldest first (main process). */
  listAgentReviews?: () => Promise<AgentJob[]>;
  /** Queue one run per chosen agent for a task; resolves the updated list. */
  startAgentReview?: (req: AgentReviewStart) => Promise<AgentJob[]>;
  /** Stop a queued or running review; resolves the updated list. */
  cancelAgentReview?: (id: string) => Promise<AgentJob[]>;
  /** Every change to the runs (progress, finish); returns unsubscribe. */
  onAgentReviewsChanged?: (callback: (jobs: AgentJob[]) => void) => () => void;
  /** Read-only submission preflight for one task (main process). */
  submitDryRun?: (id: string) => Promise<SubmitDryRunResult>;
  /** Current commit SHA to pin a submission to (main process). */
  submitSha?: (id: string) => Promise<SubmitShaResult>;
  /** Submit one exact validated revision (main process). */
  submitTask?: (id: string, sha: string) => Promise<SubmitTaskResult>;
}

/** Dry-run preflight outcome: blockers listed, or ok to submit. */
export interface SubmitDryRunResult {
  ok: boolean;
  preflight?: unknown;
  error?: { kind: string; message?: string };
}

/** Commit-SHA outcome for pinning a submission. */
export interface SubmitShaResult {
  ok: boolean;
  sha?: string;
  error?: { kind: string; message?: string };
}

/** Submission outcome. */
export interface SubmitTaskResult {
  ok: boolean;
  result?: unknown;
  error?: { kind: string; message?: string };
}

/** One usage event: a name from the logging plan plus ID/enum/number fields. */
export type UsageEvent = { event_name: string } & Record<string, string | number | boolean | undefined>;

declare global {
  interface Window {
    mochiShell?: MochiShell;
  }
}

function bridge(): MochiShell | undefined {
  return typeof window !== 'undefined' ? window.mochiShell : undefined;
}

/** True only inside the Electron overlay (preload.cjs exposes the bridge). */
export function isDesktopShell(): boolean {
  return typeof bridge() !== 'undefined';
}

/**
 * True when the page runs as the desktop overlay, detected via the
 * `?mochi-shell=1` query the shell appends — independent of the preload
 * bridge, so visual shell mode works even if the bridge fails to load.
 */
export function isShellMode(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('mochi-shell');
}

export function getDisplayBounds(): Promise<DisplayBounds | null> {
  const b = bridge();
  if (!b) return Promise.resolve(null);
  return b.getDisplayBounds();
}

export function onDisplayChanged(callback: () => void): () => void {
  const b = bridge();
  if (!b) return () => {};
  return b.onDisplayChanged(callback);
}

export function onSimulateNotification(callback: () => void): () => void {
  const b = bridge();
  if (!b) return () => {};
  return b.onSimulateNotification(callback);
}

export function onSystemResumed(callback: () => void): () => void {
  const b = bridge();
  if (!b?.onSystemResumed) return () => {};
  return b.onSystemResumed(callback);
}

export function onReportRequest(callback: () => void): () => void {
  const b = bridge();
  if (!b?.onReportRequest) return () => {};
  return b.onReportRequest(callback);
}

/** False outside the desktop shell (or an older preload). */
export function reportProblem(state: ProblemReportState): Promise<boolean> {
  const b = bridge();
  if (!b?.reportProblem) return Promise.resolve(false);
  return b.reportProblem(state).catch(() => false);
}

export function logEvent(event: UsageEvent): void {
  bridge()?.logEvent?.(event);
}

export function usageSummary(): Promise<string | null> {
  const b = bridge();
  if (!b?.usageSummary) return Promise.resolve(null);
  return b.usageSummary().catch(() => null);
}

export function onScreenLock(callback: (locked: boolean) => void): () => void {
  const b = bridge();
  if (!b?.onScreenLock) return () => {};
  return b.onScreenLock(callback);
}

export function syncBounds(rect: BoundsRect): void {
  bridge()?.syncBounds(rect);
}

/** Null outside the desktop shell (plain browser, or an older preload). */
export function fetchCodimango(): Promise<CodimangoFetchResult | null> {
  const b = bridge();
  if (!b?.fetchCodimango) return Promise.resolve(null);
  return b.fetchCodimango();
}

/** Direct submit is shell-only; null outside the desktop shell. */
export function canSubmit(): boolean {
  return typeof bridge()?.submitTask !== 'undefined';
}

export function submitDryRun(id: string): Promise<SubmitDryRunResult | null> {
  const b = bridge();
  if (!b?.submitDryRun) return Promise.resolve(null);
  return b.submitDryRun(id).catch(() => ({ ok: false as const, error: { kind: 'error' as const } }));
}

export function submitSha(id: string): Promise<SubmitShaResult | null> {
  const b = bridge();
  if (!b?.submitSha) return Promise.resolve(null);
  return b.submitSha(id).catch(() => ({ ok: false as const, error: { kind: 'error' as const } }));
}

export function submitTask(id: string, sha: string): Promise<SubmitTaskResult | null> {
  const b = bridge();
  if (!b?.submitTask) return Promise.resolve(null);
  return b.submitTask(id, sha).catch(() => ({ ok: false as const, error: { kind: 'error' as const } }));
}

/** Opens the page in the browser via the shell; in a plain browser, a new tab. */
export function openLink(url: string): void {
  const b = bridge();
  if (b?.openLink) {
    void b.openLink(url);
  } else if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener');
  }
}

/** True when the shell can run agent reviews (not in a plain browser or an older preload). */
export function listSevs(): Promise<Sev[]> {
  const b = bridge();
  return b?.listSevs ? b.listSevs().catch(() => []) : Promise.resolve([]);
}

export function onSevsChanged(callback: (sevs: Sev[]) => void): () => void {
  return bridge()?.onSevsChanged?.(callback) ?? (() => {});
}

export function agentReviewsAvailable(): boolean {
  return typeof bridge()?.startAgentReview === 'function';
}

export function listAgentReviews(): Promise<AgentJob[]> {
  const b = bridge();
  if (!b?.listAgentReviews) return Promise.resolve([]);
  return b.listAgentReviews().catch(() => []);
}

export function startAgentReview(req: AgentReviewStart): Promise<AgentJob[] | null> {
  const b = bridge();
  if (!b?.startAgentReview) return Promise.resolve(null);
  return b.startAgentReview(req).catch(() => null);
}

export function cancelAgentReview(id: string): Promise<AgentJob[] | null> {
  const b = bridge();
  if (!b?.cancelAgentReview) return Promise.resolve(null);
  return b.cancelAgentReview(id).catch(() => null);
}

export function onAgentReviewsChanged(callback: (jobs: AgentJob[]) => void): () => void {
  const b = bridge();
  if (!b?.onAgentReviewsChanged) return () => {};
  return b.onAgentReviewsChanged(callback);
}
