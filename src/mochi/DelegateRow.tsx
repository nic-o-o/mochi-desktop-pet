/* "Delegate to agent" under a "Needs revision" row: Green repairs the task on
 * the devserver with Codex. The picker states exactly what Confirm will do —
 * a live, detached Green run that edits and pushes the real task — and the row
 * then shows the worker pid and log path (or the failure) from localStorage,
 * so they survive the panel closing. In a plain browser there is no bridge
 * and the button stays hidden, like Submit.
 */
import { useId, useState } from 'react';
import { delegateAvailable, delegateToGreen } from './shell.ts';
import type { DelegateResult } from './delegations.ts';
import { loadDelegations, recordDelegation, saveDelegations } from './delegations.ts';
import type { DelegationRecord } from './delegations.ts';
import { logClick, logClose } from './usage.ts';

export function DelegateRow({
  taskId,
  taskSlug,
  detail,
  onDelegate,
}: {
  taskId: string;
  taskSlug: string;
  detail?: string;
  onDelegate?: (slug: string) => Promise<DelegateResult | null>;
}) {
  const uid = useId();
  const [picking, setPicking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [record, setRecord] = useState<DelegationRecord | null>(() => loadDelegations().find((r) => r.taskSlug === taskSlug) ?? null);
  const canDelegate = Boolean(onDelegate) || delegateAvailable();
  if (!canDelegate) return null;

  const openPicker = () => {
    logClick('glance_panel', 'delegate_open', { section: 'needs_revision', task_id: taskId });
    setPicking(true);
  };

  const confirm = async () => {
    logClick('glance_panel', 'delegate_start', { section: 'needs_revision', task_id: taskId, agent: 'codex' });
    setPicking(false);
    setStarting(true);
    let result: DelegateResult | null;
    try {
      result = onDelegate ? await onDelegate(taskSlug) : await delegateToGreen(taskSlug);
    } catch {
      result = null;
    }
    setStarting(false);
    const next: DelegationRecord = result?.ok
      ? {
          taskSlug,
          agent: 'codex',
          status: 'started',
          pid: result.pid ?? null,
          logPath: result.logPath ?? null,
          repo: result.repo ?? null,
          startedAtMs: Date.now(),
        }
      : {
          taskSlug,
          agent: 'codex',
          status: 'failed',
          pid: null,
          logPath: null,
          repo: null,
          startedAtMs: Date.now(),
          errorMessage: result?.error?.message ?? 'Delegate needs the desktop shell.',
          errorFix: result?.error?.fix,
        };
    setRecord(next);
    saveDelegations(recordDelegation(loadDelegations(), next));
  };

  return (
    <div className="agent-row">
      {record?.status === 'started' && (
        <ul className="agent-status-list">
          <li className="agent-status agent-done">
            Green started
            {record.pid != null ? ` — worker ${record.pid}` : ''}
            {record.logPath ? `. Log: ${record.logPath}` : ''}
          </li>
        </ul>
      )}
      {record?.status === 'failed' && (
        <ul className="agent-status-list">
          <li className="agent-status agent-failed">
            {record.errorMessage}
            {record.errorFix ? ` ${record.errorFix}` : ''}
          </li>
        </ul>
      )}
      <div className="agent-row-actions">
        {!picking && !starting && (
          <button type="button" className="btn-link agent-link" onClick={openPicker}>
            {record ? 'Delegate again' : 'Delegate to agent'}
          </button>
        )}
      </div>
      {starting && <p className="muted small">Starting Green on the devserver… Green keeps working after the first decision; this can take a few minutes.</p>}
      {picking && (
        <fieldset className="agent-picker" aria-describedby={`${uid}-note`}>
          <legend>Delegate to agent</legend>
          <span className="small agent-picker-label">Repair agent</span>
          <label className="agent-choice">
            <input type="radio" name={`${uid}-model`} defaultChecked />
            Codex
          </label>
          <p className="muted small" id={`${uid}-note`}>
            Task: <code>{taskSlug}</code>
            {detail ? ` — failing checks: ${detail}` : ''}
          </p>
          <p className="muted small">
            Runs Green on devvm7438 with Codex (<code>green {taskSlug} --live --hardening --detach --agent codex</code>). Green repairs the task, proves
            it locally, pushes, and waits for validation — up to 10 hours, detached. Before launching, Mochi checks Green is installed on the devserver
            (installing it if needed) and runs <code>doctor --install-hooks</code> in the task checkout.
          </p>
          <div className="agent-picker-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                logClose('glance_panel', 'delegate_picker', { task_id: taskId });
                setPicking(false);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={() => void confirm()}>
              Delegate to Codex
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );
}
