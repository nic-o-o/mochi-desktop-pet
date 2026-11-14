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

/** The agent line's label, naming the job when there is one: Harvester fixes validation (revive) or addresses a reviewer's revisions. */
/* Harvester's most common one-line reasons, in plain words. Anything else is shown as Harvester wrote it. */
const PLAIN: [RegExp, string][] = [
  [/^(the )?durable owner is repairing or (running local checks|checking the task)/i, 'Working on the fix and running tests'],
  [/^calibration guard refused the candidate/i, 'Its own check rejected the last attempt (it changed files this fix may not touch); trying again'],
  [/^(published [0-9a-f]+|the exact revision) is still being validated by Nest/i, 'Pushed a fix; waiting for Codimango to validate it'],
  [/^pushed; waiting on the platform to re-validate/i, 'Pushed a fix; waiting for Codimango to validate it'],
  [/^an exact-revision platform job or dispatch grace is active/i, "Waiting for Codimango's validation job"],
  [/^exact-revision platform work is parked outside a repair slot/i, "Waiting for Codimango's validation"],
  [/^the platform is stale and has no live exact-revision job/i, "Codimango isn't validating its latest push yet"],
  [/^Nest has not created a validation commit or live job/i, "Codimango hasn't started validating its latest push"],
  [/^paused outside the task; retry keeps its edits and budget/i, 'Paused by an infrastructure problem; it will retry'],
  [/^hardening, round in progress/i, 'Making the task harder; round in progress'],
  [/^every gate passes/i, 'Every check passes; ready to submit'],
  [/^the full wall clock was spent pushing/i, 'Ran out of time; start it again to continue'],
  [/^no lever left, and no pivot either/i, 'Out of ideas; needs you to decide'],
  [/^needs a person; hardening is not the remedy/i, "Needs you: making it harder won't fix this"],
  [/^two rounds changed neither the suite nor the verdict/i, 'Two rounds made no progress'],
  [/^the platform's own trials errored/i, "Codimango's own trials errored; re-run validation, nothing to repair"],
];
const LAST = 'Harvester stopped before finishing. Last: ';

/** Harvester's reason in plain words when it's a known one; the original stays in the row's tooltip. */
export function plainReason(reason: string): string {
  if (reason.startsWith(LAST)) return LAST + plainReason(reason.slice(LAST.length));
  return PLAIN.find(([re]) => re.test(reason))?.[1] ?? reason;
}

export function harvesterLabel(status: Pick<HarvesterTaskStatus, 'kind' | 'intent'>): string {
  const job = status.intent === 'revision' ? 'addressing revisions' : 'fixing validation';
  if (status.kind === 'working') return `Harvester ${job}`;
  if (status.kind === 'stuck') return `Harvester stuck ${job}`;
  return status.kind === 'done' ? 'Harvester done' : 'Harvester stopped';
}

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
