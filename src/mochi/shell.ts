/* Bridge to the Electron desktop shell.
 * In a plain browser `window.mochiShell` is undefined and every function here
 * is a no-op, so `npm run dev` behaves exactly as before.
 */
import type { CodimangoFetchResult } from './codimango.ts';

export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
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
}

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

export function syncBounds(rect: BoundsRect): void {
  bridge()?.syncBounds(rect);
}

/** Null outside the desktop shell (plain browser, or an older preload). */
export function fetchCodimango(): Promise<CodimangoFetchResult | null> {
  const b = bridge();
  if (!b?.fetchCodimango) return Promise.resolve(null);
  return b.fetchCodimango();
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
