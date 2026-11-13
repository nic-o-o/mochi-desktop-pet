/* The agent line under a draft row: what Harvester is doing with this task —
 * working, stuck, done or stopped — with Harvester's own one-line reason, and
 * the matching action. Active runs offer Stop (Harvester won't restart a task
 * while its run is active); stopped runs offer Restart, which publishes: it
 * pushes to the task and posts a comment. Both ask first.
 */
import { useState } from 'react';
import { HARVESTER_LABELS, sinceLabel } from './harvester.ts';
import { restartHarvesterTask, stopHarvesterRun } from './shell.ts';
import type { HarvesterTaskStatus } from './shell.ts';
import { logClick } from './usage.ts';

type Phase = 'idle' | 'confirm-stop' | 'confirm-restart' | 'working' | 'error' | 'sent';

export function HarvesterRow({
  taskId,
  status,
  nowMs,
  onChanged,
  stop = stopHarvesterRun,
  restart = restartHarvesterTask,
}: {
  taskId: string;
  status: HarvesterTaskStatus;
  nowMs: number;
  /** Re-read statuses after an action. */
  onChanged?: () => void;
  stop?: typeof stopHarvesterRun;
  restart?: typeof restartHarvesterTask;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState('');
  const fields = { task_id: taskId, status: status.kind };
  const tone = status.kind === 'stuck' || status.kind === 'stopped' ? 'agent-failed' : 'agent-done';
  const since = sinceLabel(status.sinceMs, nowMs);

  async function act(kind: 'stop' | 'restart') {
    setPhase('working');
    setNote(kind === 'stop' ? 'Stopping…' : 'Restarting…');
    logClick('glance_panel', kind === 'stop' ? 'harvester_stop' : 'harvester_restart', fields);
    const res = await (kind === 'stop' ? stop(status) : restart(status));
    if (res.ok) {
      setPhase('sent');
      setNote(kind === 'stop' ? 'Stopped. Restart when you are ready.' : 'Restarted: Harvester queued a new run.');
      onChanged?.();
    } else {
      setPhase('error');
      setNote(res.error ?? 'Harvester refused.');
    }
  }

  return (
    <div className="agent-row harvester-row">
      <ul className="agent-status-list">
        <li className={`agent-status ${tone}`} title={status.reason || undefined}>
          {HARVESTER_LABELS[status.kind]}
          {status.reason ? ` · ${status.reason}` : ''}
          {since ? <span className="muted"> · {since}</span> : null}
        </li>
      </ul>
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
          <legend>Restart Harvester</legend>
          <p className="muted small">
            Harvester starts a new run on <code>{status.taskName}</code>. It pushes its repairs to the task and posts a comment, like any Harvester
            revival.
          </p>
          <div className="agent-picker-actions">
            <button type="button" className="btn-secondary" onClick={() => setPhase('idle')}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={() => void act('restart')}>
              Restart
            </button>
          </div>
        </fieldset>
      ) : (
        <div className="agent-row-actions">
          {phase === 'working' || phase === 'sent' || phase === 'error' ? <span className={`small ${phase === 'error' ? 'agent-failed' : 'muted'}`}>{note}</span> : null}
          {phase !== 'working' && (status.kind === 'stuck' || status.kind === 'working') && status.runId && (
            <button
              type="button"
              className="btn-link agent-link"
              onClick={() => {
                logClick('glance_panel', 'harvester_stop_open', fields);
                setPhase('confirm-stop');
              }}
            >
              Stop
            </button>
          )}
          {phase !== 'working' && status.kind === 'stopped' && (
            <button
              type="button"
              className="btn-link agent-link"
              onClick={() => {
                logClick('glance_panel', 'harvester_restart_open', fields);
                setPhase('confirm-restart');
              }}
            >
              Restart
            </button>
          )}
        </div>
      )}
    </div>
  );
}
