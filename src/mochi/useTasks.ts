/* Panel data: Codimango in the desktop shell, mock data in a plain browser.
 *
 * Cache-first: the last snapshot (raw picked rows, localStorage) renders
 * immediately, then a refresh runs on launch, when the panel opens, after the
 * Mac wakes or unlocks, when the network comes back, and every 10 minutes —
 * never more than once a minute, to stay light on Codimango.
 * Rows are re-mapped from the snapshot each minute so time-left stays current.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskItem } from './logic.ts';
import { MOCK_TASKS, WEEKLY_COMPLETED } from './mockData.ts';
import { parseCachedSnapshot, toTaskItems, weeklyCompleted } from './codimango.ts';
import type { CodimangoFailure, CodimangoFailureKind, CodimangoSnapshot, WeeklyCompleted } from './codimango.ts';
import { fetchCodimango, isDesktopShell, onSystemResumed } from './shell.ts';
import { logFetch } from './usage.ts';

export const TASKS_CACHE_KEY = 'mochi.codimango.v1';
const MIN_REFRESH_MS = 60_000;
const BACKGROUND_REFRESH_MS = 10 * 60_000;

export type TasksStatus = 'mock' | 'loading' | 'ok' | CodimangoFailureKind;
/** Why a refresh ran (logging plan: mochi_fetch.trigger). */
export type FetchTrigger = 'launch' | 'panel_open' | 'interval' | 'wake' | 'online' | 'refresh_button' | 'check_connection';

export interface TasksState {
  tasks: TaskItem[];
  weekly: WeeklyCompleted;
  /** Last fetched snapshot (null: never fetched); drives notification diffing. */
  snapshot: CodimangoSnapshot | null;
  status: TasksStatus;
  /** Set when the last refresh failed; `fix` is a command to show the user. */
  failure: CodimangoFailure | null;
  /** When the rows on screen were read from Codimango (null: never). */
  fetchedAtMs: number | null;
  /** Refresh now; resolves with the result (null: skipped, a read already running). */
  refresh: (trigger: FetchTrigger) => Promise<TasksStatus | null>;
}

function loadSnapshot(): CodimangoSnapshot | null {
  try {
    return parseCachedSnapshot(localStorage.getItem(TASKS_CACHE_KEY));
  } catch {
    return null;
  }
}

function saveSnapshot(snapshot: CodimangoSnapshot): void {
  try {
    localStorage.setItem(TASKS_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    /* storage unavailable — the snapshot still applies for the session */
  }
}

export function useTasks(active: boolean, nowMs: number): TasksState {
  const [desktop] = useState(isDesktopShell);
  const [snapshot, setSnapshot] = useState<CodimangoSnapshot | null>(() => (desktop ? loadSnapshot() : null));
  const [status, setStatus] = useState<TasksStatus>(desktop ? 'loading' : 'mock');
  const [failure, setFailure] = useState<CodimangoFailure | null>(null);
  const inFlight = useRef(false);
  const lastAttemptMs = useRef(0);

  const run = useCallback(
    (force: boolean, trigger: FetchTrigger): Promise<TasksStatus | null> => {
      if (!desktop || inFlight.current) return Promise.resolve(null);
      if (!force && Date.now() - lastAttemptMs.current < MIN_REFRESH_MS) return Promise.resolve(null);
      inFlight.current = true;
      lastAttemptMs.current = Date.now();
      const startedMs = performance.now();
      setStatus('loading');
      return fetchCodimango()
        .then((result): TasksStatus | null => {
          if (!result) return null;
          const rows = result.ok ? { reviewing_rows: result.snapshot.reviewing.length, mine_rows: result.snapshot.mine.length } : {};
          logFetch({ trigger, status: result.ok ? 'ok' : result.error.kind, duration_ms: Math.round(performance.now() - startedMs), ...rows });
          if (result.ok) {
            setSnapshot(result.snapshot);
            saveSnapshot(result.snapshot);
            setFailure(null);
            setStatus('ok');
            return 'ok';
          }
          setFailure(result.error);
          setStatus(result.error.kind);
          const fix = result.error.fix ? ` (fix: ${result.error.fix})` : '';
          console.log(`[mochi] codimango ${result.error.kind}: ${result.error.message}${fix}`);
          return result.error.kind;
        })
        .catch((err: unknown): TasksStatus => {
          logFetch({ trigger, status: 'error', duration_ms: Math.round(performance.now() - startedMs) });
          setFailure({ kind: 'error', message: String(err) });
          setStatus('error');
          return 'error';
        })
        .finally(() => {
          inFlight.current = false;
        });
    },
    [desktop],
  );

  useEffect(() => {
    void run(true, 'launch');
    const id = window.setInterval(() => void run(false, 'interval'), BACKGROUND_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [run]);

  useEffect(() => {
    if (active) void run(false, 'panel_open');
  }, [active, run]);

  /* Wake, unlock or reconnect: data may be hours old, so refresh (throttled). */
  useEffect(() => {
    const onOnline = () => void run(false, 'online');
    window.addEventListener('online', onOnline);
    const offResume = onSystemResumed(() => void run(false, 'wake'));
    return () => {
      window.removeEventListener('online', onOnline);
      offResume();
    };
  }, [run]);

  const minuteMs = Math.floor(nowMs / 60_000) * 60_000;
  const tasks = useMemo(
    () => (snapshot ? toTaskItems(snapshot, minuteMs) : desktop ? [] : MOCK_TASKS),
    [snapshot, minuteMs, desktop],
  );
  const weekly = useMemo(
    () => (snapshot ? weeklyCompleted(snapshot, minuteMs) : desktop ? { reviewsCompleted: 0, submissionsCompleted: 0 } : WEEKLY_COMPLETED),
    [snapshot, minuteMs, desktop],
  );
  const refresh = useCallback((trigger: FetchTrigger) => run(true, trigger), [run]);

  return { tasks, weekly, snapshot, status, failure, fetchedAtMs: snapshot?.fetchedAtMs ?? null, refresh };
}
