/* Usage events from the renderer (logging plan: "Mochi Logging Plan" doc).
 * Generic mochi_vpv / mochi_click / mochi_close told apart by surface and
 * component; IDs, counts and fixed enums only, never task names or text.
 * Events go to the desktop shell (electron/events.mjs); in a plain browser
 * they go nowhere.
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { logEvent, onScreenLock } from './shell.ts';
import type { SectionKey } from './sections.ts';

export type Surface = 'pet' | 'glance_panel' | 'bubble' | 'setup_card';
type Fields = Record<string, string | number | boolean | undefined>;

const DAILY_ACTIVE_KEY = 'mochi.usage.active-day';

/** Section names as the plan writes them. */
export const SECTION_EVENT_NAME: Record<SectionKey, string> = {
  revisions: 'needs_revision',
  reviews: 'waiting_review',
  drafts: 'drafts',
};

/* ---------------------------------------------------------------- clock -- */

/* performance.now() stops while the Mac sleeps; locked-screen time is
   subtracted on top, so durations count only time someone could see Mochi. */
let lockedAt: number | null = null;
let lockedTotal = 0;
let lockSubscribed = false;

function subscribeLock() {
  if (lockSubscribed) return;
  lockSubscribed = true;
  onScreenLock((locked) => {
    const t = performance.now();
    if (locked && lockedAt === null) lockedAt = t;
    else if (!locked && lockedAt !== null) {
      lockedTotal += t - lockedAt;
      lockedAt = null;
    }
  });
}

function lockedSoFar(t: number) {
  return lockedTotal + (lockedAt === null ? 0 : t - lockedAt);
}

export interface Mark {
  t: number;
  locked: number;
}

export function mark(): Mark {
  subscribeLock();
  const t = performance.now();
  return { t, locked: lockedSoFar(t) };
}

/** Visible milliseconds since `m` (sleep and lock excluded). */
export function elapsedMs(m: Mark): number {
  const t = performance.now();
  return Math.max(0, Math.round(t - m.t - (lockedSoFar(t) - m.locked)));
}

/* ------------------------------------------------------- panel session -- */

let panelSession: { id: string; opened: Mark } | null = null;
/* VPVs already logged, per panel session (or per bubble). */
const seen = new Set<string>();

export function startPanelSession(): string {
  panelSession = { id: crypto.randomUUID(), opened: mark() };
  return panelSession.id;
}

/** Ends the session; returns its visible duration, or null if none was open. */
export function endPanelSession(): number | null {
  if (!panelSession) return null;
  const spent = elapsedMs(panelSession.opened);
  panelSession = null;
  return spent;
}

export function msSincePanelOpen(): number | undefined {
  return panelSession ? elapsedMs(panelSession.opened) : undefined;
}

/* ---------------------------------------------------------------- events -- */

function send(event_name: string, fields: Fields) {
  logEvent({ event_name, app_build: __MOCHI_BUILD__, panel_session_id: panelSession?.id, ...fields });
}

/** First pet, bell or panel interaction of the local day (at most one per day). */
function noteActive() {
  const d = new Date();
  const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  try {
    if (localStorage.getItem(DAILY_ACTIVE_KEY) === today) return;
    localStorage.setItem(DAILY_ACTIVE_KEY, today);
  } catch {
    /* storage unavailable: still log, possibly more than once a day */
  }
  send('mochi_daily_active', {});
}

export function logClick(surface: Surface, component: string, fields: Fields = {}) {
  noteActive();
  send('mochi_click', { surface, component, ...fields });
}

export function logClose(surface: Surface, component: string, fields: Fields = {}) {
  send('mochi_close', { surface, component, ...fields });
}

export function logVpv(surface: Surface, component: string, fields: Fields = {}) {
  send('mochi_vpv', { surface, component, ...fields });
}

export function logFetch(fields: Fields) {
  send('mochi_fetch', fields);
}

/* ------------------------------------------------------------------ VPV -- */

export const VPV_RATIO = 0.5;
export const VPV_MS = 250;

/**
 * Calls `onSeen` once when the element is at least 50% visible for 250 ms
 * (Instagram's rule). `key` dedupes: the same key logs once per panel session
 * (or, with `perPanel: false`, once ever, e.g. a bubble id).
 */
export function useVpv(
  ref: RefObject<HTMLElement | null>,
  key: string | null,
  onSeen: () => void,
  perPanel = true,
) {
  const onSeenRef = useRef(onSeen);
  useEffect(() => {
    onSeenRef.current = onSeen;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || key === null || typeof IntersectionObserver === 'undefined') return;
    let timer: number | undefined;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio >= VPV_RATIO) {
          timer ??= window.setTimeout(() => {
            /* Read the session when the VPV fires: rows mount before App's effect opens it. */
            const dedupe = perPanel ? `${panelSession?.id ?? '-'}|${key}` : key;
            if (seen.has(dedupe)) return;
            seen.add(dedupe);
            io.disconnect();
            onSeenRef.current();
          }, VPV_MS);
        } else {
          window.clearTimeout(timer);
          timer = undefined;
        }
      },
      { threshold: [0, VPV_RATIO] },
    );
    io.observe(el);
    return () => {
      window.clearTimeout(timer);
      io.disconnect();
    };
  }, [ref, key, perPanel]);
}

/** Test hook: forget logged VPVs and the open panel session. */
export function resetUsageForTests() {
  seen.clear();
  panelSession = null;
}
