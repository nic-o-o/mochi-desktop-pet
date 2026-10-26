/* Bridge to the Electron desktop shell.
 * In a plain browser `window.mochiShell` is undefined and every function here
 * is a no-op, so `npm run dev` behaves exactly as before.
 */

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

export interface MochiShell {
  /** Primary display bounds in screen coordinates (async: main process). */
  getDisplayBounds: () => Promise<DisplayBounds>;
  /** Subscribe to display-geometry changes; returns an unsubscribe function. */
  onDisplayChanged: (callback: () => void) => () => void;
  /** Fired by the shell's simulate global shortcut; returns unsubscribe. */
  onSimulateNotification: (callback: () => void) => () => void;
  /** Resize/move the shell window to the union of visible UI (screen coords). */
  syncBounds: (rect: BoundsRect) => void;
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

export function syncBounds(rect: BoundsRect): void {
  bridge()?.syncBounds(rect);
}
