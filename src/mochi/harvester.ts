/* Harvester's agent status for the panel: read from a Harvester board on this
 * Mac and on the person's devserver (the one saved in Settings / Delegate),
 * while the panel is open, every 30 seconds. With no board, or in a plain
 * browser, there are no statuses and rows show nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadDelegateNode } from './delegations.ts';
import { harvesterStatus } from './shell.ts';
import type { HarvesterTaskStatus } from './shell.ts';

export const HARVESTER_POLL_MS = 30_000;

export const HARVESTER_LABELS: Record<HarvesterTaskStatus['kind'], string> = {
  working: 'Harvester working',
  stuck: 'Harvester stuck',
  done: 'Harvester done',
  stopped: 'Harvester stopped',
};

export function useHarvesterStatuses(open: boolean): { statuses: Record<string, HarvesterTaskStatus>; refresh: () => void } {
  const [statuses, setStatuses] = useState<Record<string, HarvesterTaskStatus>>({});
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const refresh = useCallback(() => {
    void harvesterStatus(loadDelegateNode()).then((res) => {
      if (live.current && res) setStatuses(res.available ? res.statuses : {});
    });
  }, []);
  useEffect(() => {
    if (!open) return;
    refresh();
    const id = window.setInterval(refresh, HARVESTER_POLL_MS);
    return () => window.clearInterval(id);
  }, [open, refresh]);
  return { statuses, refresh };
}

/** "5m ago" for the status line. */
export function sinceLabel(ms: number | null, nowMs: number): string {
  if (ms == null) return '';
  const mins = Math.floor(Math.max(0, nowMs - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
