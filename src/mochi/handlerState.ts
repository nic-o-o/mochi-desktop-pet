/* One derived row state for a "Needs revision" row: the handler probe is the
 * truth about what is working on the task, the saved launch record is only
 * memory, and an Ask-agent review never blocks a Green repair. A live worker
 * hides the Delegate button; a stuck worker offers a confirmed stop; a
 * setup failure is a short status reason, never an error paragraph.
 */
import type { DelegationRecord, HandlerProbe } from './delegations.ts';
import { isDockerMissingFailure } from './delegations.ts';

/** Log silence past this long, with a live pid, counts as stuck. */
export const STUCK_SILENCE_SECS = 30 * 60;

/** A wait past this long counts as long: the worker may be healthy, but the person may stop it and re-delegate. */
export const LONG_WAIT_MINS = 30;

export type RowPhase = 'idle' | 'starting' | 'running' | 'waiting' | 'blocked' | 'stuck' | 'done' | 'stopped' | 'unknown' | 'setup-blocked';

export interface RowState {
  phase: RowPhase;
  handler: 'green' | 'agent-review' | 'none' | 'unknown';
  /** The one status line for the meta line, or null when the row shows none. */
  statusText: string | null;
  statusClass: 'agent-done' | 'agent-failed' | 'agent-status';
  showDelegate: boolean;
  showInstallDocker: boolean;
  interruptible: boolean;
  stuckPid: number | null;
  /** The pid a confirmed stop would end: set for stuck and long-waiting workers. */
  stopPid: number | null;
  leaseAgeSecs: number | null;
  needsInput: boolean;
  reason: string | null;
}

export type ProbeState = 'pending' | 'ok' | 'failed';

const SETUP_REASONS: Record<string, string> = {
  doctor_failed: 'Green doctor failed on your devserver',
  green_missing: 'Green is not installed on your devserver',
  repo_not_found: 'Task checkout not found on your devserver',
  checkout_stale: 'Task checkout is out of date on your devserver',
  task_dir_missing: 'Task checkout is out of date on your devserver',
  agentcloud_missing: 'agentcloudctl is not installed on this Mac',
  node_error: 'Could not reach your devserver',
  invalid_agent: 'Choose Muse or Codex in the Delegate picker',
};

/** A blocked reason that sounds like it is waiting on a person, not on a queue. Green has no structured signal for this, so this is a keyword heuristic over free text. */
function needsInputReason(reason: string | null): boolean {
  return reason != null && /approv|decision|permission|access|credential|confirm|needs? (a |an |your )?input|sign-?off|2fa|yubikey/i.test(reason);
}

function setupState(record: DelegationRecord): RowState {
  const docker = isDockerMissingFailure(record);
  return {
    phase: 'setup-blocked',
    handler: 'none',
    statusText: docker ? 'Docker is missing on your devserver' : (record.errorKind ? (SETUP_REASONS[record.errorKind] ?? 'Green could not start on your devserver') : 'Green could not start on your devserver'),
    statusClass: 'agent-failed',
    showDelegate: !docker,
    showInstallDocker: docker,
    interruptible: false,
    stuckPid: null,
    stopPid: null,
    leaseAgeSecs: null,
    needsInput: false,
    reason: record.errorFix ?? null,
  };
}

export function deriveRowState(input: {
  probe: HandlerProbe | null;
  probeState: ProbeState;
  record: DelegationRecord | null;
  reviewJobRunning: boolean;
}): RowState {
  const { probe, probeState, record, reviewJobRunning } = input;
  const base = {
    leaseAgeSecs: probe?.leaseAgeSecs ?? null,
    needsInput: false,
    reason: null as string | null,
    stopPid: null as number | null,
  };

  if (probe?.handler === 'green') {
    const age = probe.lastActivityAgeSecs ?? null;
    const stuck = probe.pid != null && age != null && age > STUCK_SILENCE_SECS;
    if (stuck) {
      const mins = Math.floor(age / 60);
      return {
        ...base,
        phase: 'stuck',
        handler: 'green',
        statusText: `Green stuck · no activity for ${mins}m`,
        statusClass: 'agent-failed',
        showDelegate: true,
        showInstallDocker: false,
        interruptible: true,
        stuckPid: probe.pid,
        stopPid: probe.pid,
        reason: probe.lastDecision ?? null,
      };
    }
    if (probe.waitingMins != null && probe.waitingReason) {
      const longWait = probe.waitingMins >= LONG_WAIT_MINS;
      return {
        ...base,
        phase: 'waiting',
        handler: 'green',
        statusText: `Green waiting · ${probe.waitingReason} (${probe.waitingMins}m)`,
        statusClass: 'agent-done',
        showDelegate: longWait,
        showInstallDocker: false,
        interruptible: longWait,
        stuckPid: null,
        stopPid: longWait ? probe.pid : null,
        reason: probe.waitingReason,
      };
    }
    const starting = probe.kind === 'starting';
    return {
      ...base,
      phase: starting ? 'starting' : 'running',
      handler: 'green',
      statusText: starting ? 'Green starting' : 'Green working',
      statusClass: 'agent-done',
      showDelegate: false,
      showInstallDocker: false,
      interruptible: false,
      stuckPid: null,
      reason: probe.lastDecision ?? null,
    };
  }

  if (probe?.kind === 'done' || probe?.kind === 'blocked' || probe?.kind === 'stopped') {
    if (probe.kind === 'done') {
      return { ...base, phase: 'done', handler: 'green', statusText: 'Green done', statusClass: 'agent-done', showDelegate: true, showInstallDocker: false, interruptible: false, stuckPid: null, reason: probe.lastDecision ?? null };
    }
    if (probe.kind === 'blocked') {
      const reason = probe.blockedReason ?? null;
      const needsInput = needsInputReason(probe.blockedReason ?? null);
      return {
        ...base,
        phase: 'blocked',
        handler: 'green',
        statusText: reason ? (needsInput ? `Green blocked · needs your input: ${reason}` : `Green blocked · ${reason}`) : 'Green blocked',
        statusClass: 'agent-failed',
        showDelegate: true,
        showInstallDocker: false,
        interruptible: false,
        stuckPid: null,
        needsInput,
        reason: probe.blockedReason ?? null,
      };
    }
    return { ...base, phase: 'stopped', handler: 'green', statusText: 'Green not running', statusClass: 'agent-failed', showDelegate: true, showInstallDocker: false, interruptible: false, stuckPid: null, reason: probe.lastDecision ?? null };
  }

  if (record?.status === 'failed') {
    const kind = record.errorKind;
    if (kind === 'launch_failed' || kind == null) {
      return { ...base, phase: 'stopped', handler: 'green', statusText: 'Green not running', statusClass: 'agent-failed', showDelegate: true, showInstallDocker: false, interruptible: false, stuckPid: null, reason: record.errorFix ?? null };
    }
    if (kind === 'node_missing' || kind === 'invalid_task') {
      return { ...base, phase: 'idle', handler: 'none', statusText: null, statusClass: 'agent-status', showDelegate: true, showInstallDocker: false, interruptible: false, stuckPid: null };
    }
    return setupState(record);
  }

  if (record?.status === 'started') {
    if (probeState === 'failed') {
      return { ...base, phase: 'unknown', handler: 'unknown', statusText: 'Green status unknown', statusClass: 'agent-status', showDelegate: true, showInstallDocker: false, interruptible: false, stuckPid: null };
    }
    if (probeState === 'pending') {
      return { ...base, phase: 'starting', handler: 'green', statusText: 'Green started', statusClass: 'agent-status', showDelegate: false, showInstallDocker: false, interruptible: false, stuckPid: null };
    }
    return { ...base, phase: 'stopped', handler: 'green', statusText: 'Green not running', statusClass: 'agent-failed', showDelegate: true, showInstallDocker: false, interruptible: false, stuckPid: null };
  }

  if (reviewJobRunning) {
    return { ...base, phase: 'idle', handler: 'agent-review', statusText: 'Agent review running', statusClass: 'agent-status', showDelegate: true, showInstallDocker: false, interruptible: false, stuckPid: null };
  }

  return { ...base, phase: 'idle', handler: 'none', statusText: null, statusClass: 'agent-status', showDelegate: true, showInstallDocker: false, interruptible: false, stuckPid: null };
}
