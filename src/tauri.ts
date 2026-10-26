import type { XY } from './types';

/** True when the frontend runs inside the Tauri overlay window. */
export function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}

export interface WindowRect extends XY {
  w: number;
  h: number;
}

let syncQueued = false;
let pending: WindowRect | null = null;
let lastApplied: WindowRect | null = null;

async function applyRect(rect: WindowRect): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi');
  const win = getCurrentWindow();
  // Resizing a transparent window every frame smears on macOS, so only
  // resize when the dimensions actually changed. Dragging only moves.
  if (
    !lastApplied ||
    lastApplied.w !== rect.w ||
    lastApplied.h !== rect.h
  ) {
    await win.setSize(new LogicalSize(rect.w, rect.h));
  }
  await win.setPosition(new LogicalPosition(rect.x, rect.y));
  lastApplied = { ...rect };
}

/** Transparent windows still cast a shadow rect on macOS — turn it off. */
export async function disableShadow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setShadow(false);
  } catch {
    /* Tauri API unavailable: stay in browser fallback mode */
  }
}

/**
 * Resize/move the native overlay window to the union of the visible
 * floating UI. Coalesced so pointer-drag streams collapse into one
 * IPC call per frame. No-op outside Tauri.
 */
export function syncTauriWindow(rect: WindowRect): void {
  if (!isTauri()) return;
  pending = rect;
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    const next = pending;
    pending = null;
    if (!next) return;
    applyRect(next).catch(() => {
      /* Tauri API unavailable: stay in browser fallback mode */
    });
  });
}
