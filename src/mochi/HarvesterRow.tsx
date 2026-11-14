/* The agent line under a draft row: what Harvester is doing with this task —
 * working, stuck, done or stopped — with Harvester's own one-line reason, and
 * the matching action. Active runs offer Stop (Harvester won't restart a task
 * while its run is active); stopped runs offer to start again, which publishes: it
 * pushes to the task and posts a comment. Both ask first. The row names the
 * job: on drafts it's "Fix validation" (Harvester's revive workflow), on Needs
 * revision rows "Address revisions" (its revision workflow, which takes the
 * reviewer's request).
 */
import { useState } from 'react';
import { harvesterLabel, plainReason, sinceLabel } from './harvester.ts';
import { restartHarvesterTask, stopHarvesterRun } from './shell.ts';
import type { HarvesterTaskStatus } from './shell.ts';
import { logClick } from './usage.ts';

type Phase = 'idle' | 'confirm-stop' | 'confirm-restart' | 'working' | 'error' | 'sent';

export function HarvesterRow({
  taskId,
  status,
  revision = false,
  nowMs,
  onChanged,
  stop = stopHarvesterRun,
  restart = restartHarvesterTask,
}: {
  taskId: string;
  status: HarvesterTaskStatus;
  /** A Needs revision row: starting again asks Harvester to address the reviewer's request, not just fix validation. */
  revision?: boolean;
  nowMs: number;
  /** Re-read statuses after an action. */
  onChanged?: () => void;
  stop?: typeof stopHarvesterRun;
  restart?: typeof restartHarvesterTask;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState('');
  /* The status an action answered; its confirmation goes once the status line moves on (it says the same thing). */
  const statusKey = `${status.kind}|${status.state}|${status.runId ?? ''}`;
  const [actedOn, setActedOn] = useState('');
  const fields = { task_id: taskId, status: status.kind };
  const tone = status.kind === 'stuck' || status.kind === 'stopped' ? 'agent-failed' : 'agent-done';
  const since = sinceLabel(status.sinceMs, nowMs);
  /* The job is the row's: a draft has no reviewer request (Harvester refuses a revision run on one). */
  const intent = revision ? 'revision' : 'revive';
  const startLabel = revision ? 'Address revisions' : 'Fix validation';

  async function act(kind: 'stop' | 'restart') {
    setPhase('working');
    setActedOn(statusKey);
    setNote(kind === 'stop' ? 'Stopping…' : 'Starting…');
    logClick('glance_panel', kind === 'stop' ? 'harvester_stop' : 'harvester_restart', fields);
    const res = await (kind === 'stop' ? stop(status) : restart({ ...status, intent }));
    if (res.ok) {
      setPhase('sent');
      setNote(
        kind === 'stop'
          ? 'Stopped. Harvester leaves the task alone until you start it again.'
          : `Queued: Harvester will ${revision ? 'address the revisions' : 'fix validation'}.`,
      );
      onChanged?.();
    } else {
      setPhase('error');
      setNote(res.error ?? 'Harvester refused.');
    }
  }

  const canStop = (status.kind === 'stuck' || status.kind === 'working') && Boolean(status.runId);
  const canRestart = status.kind === 'stopped';
  const showAction = phase === 'idle' || phase === 'sent' || phase === 'error';
  return (
    <div className="agent-row harvester-row">
      {/* Same shape as the validation line above: text on the left, the action in the flag's slot on the right. */}
      <div className="glance-meta-line">
        <span className={`agent-status ${tone}`} title={status.reason || undefined}>
          {harvesterLabel(status)}
          {status.reason ? ` · ${plainReason(status.reason)}` : ''}
          {since ? <span className="muted"> · {since}</span> : null}
        </span>
        {showAction && canStop && (
          <button
            type="button"
            className="btn-link agent-link glance-action"
            onClick={() => {
              logClick('glance_panel', 'harvester_stop_open', fields);
              setPhase('confirm-stop');
            }}
          >
            Stop
          </button>
        )}
        {showAction && canRestart && (
          <button
            type="button"
            className="btn-link agent-link glance-action"
            onClick={() => {
              logClick('glance_panel', 'harvester_restart_open', fields);
              setPhase('confirm-restart');
            }}
          >
            {startLabel}
          </button>
        )}
      </div>
      {phase === 'confirm-stop' ? (
        <fieldset className="agent-picker">
          <legend>Stop Harvester</legend>
          <p className="muted small">
            {status.kind === 'stuck'
              ? 'Stops the stuck run so you can restart it. Harvester leaves the task alone until then.'
              : 'Stops the run that is working on this task now. Harvester leaves the task alone until you restart it.'}
          </p>
          <div className="agent-picker-actions">
            <button type="button" className="btn-secondary" onClick={() => setPhase('idle')}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={() => void act('stop')}>
              Stop
            </button>
          </div>
        </fieldset>
      ) : phase === 'confirm-restart' ? (
        <fieldset className="agent-picker">
          <legend>{startLabel}</legend>
          <p className="muted small">
            Harvester will {revision ? 'address the requested revisions on' : 'fix validation on'} <code>{status.taskName}</code>. It pushes its
            repairs to the task and posts a comment.
          </p>
          <div className="agent-picker-actions">
            <button type="button" className="btn-secondary" onClick={() => setPhase('idle')}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={() => void act('restart')}>
              {startLabel}
            </button>
          </div>
        </fieldset>
      ) : phase === 'working' || phase === 'error' || (phase === 'sent' && statusKey === actedOn) ? (
        <p className={`agent-note small ${phase === 'error' ? 'agent-failed' : 'muted'}`}>{note}</p>
      ) : null}
    </div>
  );
}
