/* Panel data: Codimango in the desktop shell, mock data in a plain browser.
 *
 * Cache-first: the last snapshot (raw picked rows, localStorage) renders
 * immediately, then a refresh runs on launch, when the panel opens, and every
 * 10 minutes — never more than once a minute, to stay light on Codimango.
 * Rows are re-mapped from the snapshot each minute so time-left stays current.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskItem } from './logic.ts';
import { MOCK_TASKS, WEEKLY_COMPLETED } from './mockData.ts';
import { parseCachedSnapshot, toTaskItems, weeklyCompleted } from './codimango.ts';
import type { CodimangoFailure, CodimangoFailureKind, CodimangoSnapshot, WeeklyCompleted } from './codimango.ts';
import { fetchCodimango, isDesktopShell } from './shell.ts';

export const TASKS_CACHE_KEY = 'mochi.codimango.v1';
const MIN_REFRESH_MS = 60_000;
const BACKGROUND_REFRESH_MS = 10 * 60_000;

export type TasksStatus = 'mock' | 'loading' | 'ok' | CodimangoFailureKind;

export interface TasksState {
  tasks: TaskItem[];
  weekly: WeeklyCompleted;
  status: TasksStatus;
  /** Set when the last refresh failed; `fix` is a command to show the user. */
  failure: CodimangoFailure | null;
  /** When the rows on screen were read from Codimango (null: never). */
  fetchedAtMs: number | null;
  refresh: () => void;
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
    (force: boolean) => {
      if (!desktop || inFlight.current) return;
      if (!force && Date.now() - lastAttemptMs.current < MIN_REFRESH_MS) return;
      inFlight.current = true;
      lastAttemptMs.current = Date.now();
      setStatus('loading');
      fetchCodimango()
        .then((result) => {
          if (!result) return;
          if (result.ok) {
            setSnapshot(result.snapshot);
            saveSnapshot(result.snapshot);
            setFailure(null);
            setStatus('ok');
          } else {
            setFailure(result.error);
            setStatus(result.error.kind);
            const fix = result.error.fix ? ` (fix: ${result.error.fix})` : '';
            console.log(`[mochi] codimango ${result.error.kind}: ${result.error.message}${fix}`);
          }
        })
        .catch((err: unknown) => {
          setFailure({ kind: 'error', message: String(err) });
          setStatus('error');
        })
        .finally(() => {
          inFlight.current = false;
        });
    },
    [desktop],
  );

  useEffect(() => {
    run(true);
    const id = window.setInterval(() => run(false), BACKGROUND_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [run]);

  useEffect(() => {
    if (active) run(false);
  }, [active, run]);

  const minuteMs = Math.floor(nowMs / 60_000) * 60_000;
  const tasks = useMemo(
    () => (snapshot ? toTaskItems(snapshot, minuteMs) : desktop ? [] : MOCK_TASKS),
    [snapshot, minuteMs, desktop],
  );
  const weekly = useMemo(
    () => (snapshot ? weeklyCompleted(snapshot, minuteMs) : desktop ? { reviewsCompleted: 0, submissionsCompleted: 0 } : WEEKLY_COMPLETED),
    [snapshot, minuteMs, desktop],
  );
  const refresh = useCallback(() => run(true), [run]);

  return { tasks, weekly, status, failure, fetchedAtMs: snapshot?.fetchedAtMs ?? null, refresh };
}
