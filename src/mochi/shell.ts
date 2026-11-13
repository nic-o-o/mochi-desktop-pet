/* Bridge to the Electron desktop shell.
 * In a plain browser `window.mochiShell` is undefined and every function here
 * is a no-op, so `npm run dev` behaves exactly as before.
 */
import type { AgentJob, AgentReviewStart, ReviewSkill } from './agentReviews.ts';
import type { DelegateResult, DelegateStatusRequest, DelegateStatusResult } from './delegations.ts';
import type { CodimangoFetchResult } from './codimango.ts';
import type { Sev } from './sevs.ts';
import type { GenerateResult, LooksState, PetLook } from './looks.ts';

type LooksStoreState = { looks: PetLook[]; currentId: string | null };

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
  /** Settings menu: Open at Login (null outside the packaged app) and Share Usage Data. */
  appSettings?: () => Promise<AppSettings>;
  setAppSetting?: (key: keyof AppSettings, value: boolean) => Promise<AppSettings>;
  /** Customize Mochi (main process): saved looks and whether pets can be drawn. */
  looksState?: () => Promise<LooksState>;
  /** Draw candidates for a description. */
  generatePet?: (text: string) => Promise<GenerateResult>;
  cancelPetGenerate?: () => Promise<void>;
  /** Save a candidate as a look and make it the pet. */
  keepLook?: (candidateId: string) => Promise<LooksStoreState | null>;
  /** A saved look, or null for the classic Mochi. */
  setCurrentLook?: (id: string | null) => Promise<LooksStoreState | null>;
  deleteLook?: (id: string) => Promise<LooksStoreState | null>;
  /** Dock menu → Customize Mochi…; returns unsubscribe. */
  onOpenCustomize?: (callback: () => void) => () => void;
  /** Copy diagnostics (plus version, OS, log tail) and open #mochi-dogfood-feedback in Slack. */
  reportProblem?: (state: ProblemReportState) => Promise<boolean>;
  /** Read your reviews and tasks through the codimango CLI login (main process). */
  fetchCodimango?: () => Promise<CodimangoFetchResult>;
  /** Open a Codimango (or Alacarte) page in the default browser. */
  openLink?: (url: string) => Promise<boolean>;
  /** Append a usage event to events.jsonl (main adds the common columns). */
  logEvent?: (event: UsageEvent) => void;
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
  /** Skills the Ask agents picker offers, default first (main process). */
  listReviewSkills?: () => Promise<ReviewSkill[]>;
  /** File picker for a skill folder; resolves the new id (null if it wasn't a skill) and the list, or null if cancelled. */
  addReviewSkill?: () => Promise<{ id: string | null; skills: ReviewSkill[] } | null>;
  /** Forget an added skill; resolves the updated list. */
  removeReviewSkill?: (id: string) => Promise<ReviewSkill[]>;
  /** Every change to the runs (progress, finish); returns unsubscribe. */
  onAgentReviewsChanged?: (callback: (jobs: AgentJob[]) => void) => () => void;
  /** Delegate a task to Green on the named devserver; resolves the launch result. */
  delegateToGreen?: (taskSlug: string, node: string) => Promise<DelegateResult>;
  /** One live status probe for a launched delegation. */
  checkDelegateStatus?: (req: DelegateStatusRequest) => Promise<DelegateStatusResult>;
  /** Harvester's agent status per task name, from a Harvester board on this Mac. */
  harvesterStatus?: () => Promise<HarvesterStatuses>;
  stopHarvesterRun?: (req: { base: string; runId: string }) => Promise<HarvesterActionResult>;
  restartHarvesterTask?: (req: { base: string; repo: string; taskName: string; intent: 'revive' | 'revision' }) => Promise<HarvesterActionResult>;
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

export interface AppSettings {
  /** Null when it can't be set here (running from source). */
  openAtLogin: boolean | null;
  sharing: boolean;
}

export function appSettings(): Promise<AppSettings | null> {
  const b = bridge();
  if (!b?.appSettings) return Promise.resolve(null);
  return b.appSettings().catch(() => null);
}

export function setAppSetting(key: keyof AppSettings, value: boolean): Promise<AppSettings | null> {
  const b = bridge();
  if (!b?.setAppSetting) return Promise.resolve(null);
  return b.setAppSetting(key, value).catch(() => null);
}

export function looksState(): Promise<LooksState | null> {
  const b = bridge();
  if (!b?.looksState) return Promise.resolve(null);
  return b.looksState().catch(() => null);
}

export function generatePet(text: string): Promise<GenerateResult> {
  const b = bridge();
  if (!b?.generatePet) return Promise.resolve({ ok: false, error: { kind: 'error' } });
  return b.generatePet(text).catch(() => ({ ok: false, error: { kind: 'error' } }));
}

export function cancelPetGenerate(): void {
  void bridge()?.cancelPetGenerate?.().catch(() => {});
}

export function keepLook(candidateId: string): Promise<LooksStoreState | null> {
  const b = bridge();
  if (!b?.keepLook) return Promise.resolve(null);
  return b.keepLook(candidateId).catch(() => null);
}

export function setCurrentLook(id: string | null): Promise<LooksStoreState | null> {
  const b = bridge();
  if (!b?.setCurrentLook) return Promise.resolve(null);
  return b.setCurrentLook(id).catch(() => null);
}

export function deleteLook(id: string): Promise<LooksStoreState | null> {
  const b = bridge();
  if (!b?.deleteLook) return Promise.resolve(null);
  return b.deleteLook(id).catch(() => null);
}

export function onOpenCustomize(callback: () => void): () => void {
  return bridge()?.onOpenCustomize?.(callback) ?? (() => {});
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

/** Skills for the picker; just the default when the bridge can't list them. */
export function listReviewSkills(): Promise<ReviewSkill[]> {
  const fallback: ReviewSkill[] = [{ id: 'default', source: 'default', label: 'Codimango review assistant (default)' }];
  const b = bridge();
  if (!b?.listReviewSkills) return Promise.resolve(fallback);
  return b
    .listReviewSkills()
    .then((skills) => (Array.isArray(skills) && skills.length ? skills : fallback))
    .catch(() => fallback);
}

export function canAddReviewSkill(): boolean {
  return typeof bridge()?.addReviewSkill === 'function';
}

export function addReviewSkill(): Promise<{ id: string | null; skills: ReviewSkill[] } | null> {
  const b = bridge();
  if (!b?.addReviewSkill) return Promise.resolve(null);
  return b.addReviewSkill().catch(() => null);
}

export function removeReviewSkill(id: string): Promise<ReviewSkill[] | null> {
  const b = bridge();
  if (!b?.removeReviewSkill) return Promise.resolve(null);
  return b.removeReviewSkill(id).catch(() => null);
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

/** True when the shell can delegate to Green on the devserver (not in a plain browser or an older preload). */
export function delegateAvailable(): boolean {
  return typeof bridge()?.delegateToGreen === 'function';
}

/** Launch Green for one task slug on the named devserver; null outside the desktop shell. */
export function delegateToGreen(taskSlug: string, node: string): Promise<DelegateResult | null> {
  const b = bridge();
  if (!b?.delegateToGreen) return Promise.resolve(null);
  return b.delegateToGreen(taskSlug, node).catch(() => null);
}

/** Fetch one live status for a launched delegation; null outside the desktop shell. */
/** Harvester's view of one task (electron/harvester.mjs). */
export interface HarvesterTaskStatus {
  kind: 'working' | 'stuck' | 'done' | 'stopped';
  /** Harvester's own run state, e.g. running, remote_waiting, cancelled. */
  state: string;
  /** One line from Harvester: why it's in this state. */
  reason: string;
  runId: string | null;
  intent: 'revive' | 'revision';
  restartCount: number;
  sinceMs: number | null;
  startedMs: number | null;
  taskName: string;
  base: string;
  repo: string;
}

export interface HarvesterStatuses {
  /** False when no Harvester board answers on this Mac. */
  available: boolean;
  statuses: Record<string, HarvesterTaskStatus>;
}

export interface HarvesterActionResult {
  ok: boolean;
  error?: string;
}

export function harvesterStatus(): Promise<HarvesterStatuses | null> {
  const b = bridge();
  if (!b?.harvesterStatus) return Promise.resolve(null);
  return b.harvesterStatus().catch(() => null);
}

export function stopHarvesterRun(s: HarvesterTaskStatus): Promise<HarvesterActionResult> {
  const b = bridge();
  if (!b?.stopHarvesterRun || !s.runId) return Promise.resolve({ ok: false, error: 'Stop needs the desktop app.' });
  return b.stopHarvesterRun({ base: s.base, runId: s.runId }).catch(() => ({ ok: false, error: "Couldn't reach Harvester." }));
}

export function restartHarvesterTask(s: HarvesterTaskStatus): Promise<HarvesterActionResult> {
  const b = bridge();
  if (!b?.restartHarvesterTask) return Promise.resolve({ ok: false, error: 'Restart needs the desktop app.' });
  return b
    .restartHarvesterTask({ base: s.base, repo: s.repo, taskName: s.taskName, intent: s.intent })
    .catch(() => ({ ok: false, error: "Couldn't reach Harvester." }));
}

export function checkDelegateStatus(req: DelegateStatusRequest): Promise<DelegateStatusResult | null> {
  const b = bridge();
  if (!b?.checkDelegateStatus) return Promise.resolve(null);
  return b.checkDelegateStatus(req).catch(() => null);
}
