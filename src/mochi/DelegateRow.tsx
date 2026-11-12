/* "Delegate to agent" under a "Needs revision" row: Green repairs the task on
 * the devserver with Codex. The picker states exactly what Confirm will do —
 * a live, detached Green run that edits and pushes the real task — and the row
 * then shows one concise live status (starting, working, blocked, done, or
 * not running) fetched from the devserver while the panel is open, refreshed
 * every 30 seconds. The launch record itself lives in localStorage, so the
 * row remembers a delegation across panel closings; only the status is live.
 * In a plain browser there is no bridge and the button stays hidden, like
 * Submit.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { checkDelegateStatus, delegateAvailable, delegateToGreen } from './shell.ts';
import type { DelegateResult, DelegateStatus, DelegateStatusRequest, DelegateStatusResult } from './delegations.ts';
import {
  DELEGATE_STATUS_LABELS,
  formatActivityAge,
  loadDelegateNode,
  loadDelegations,
  normalizeDelegateNode,
  recordDelegation,
  saveDelegateNode,
  saveDelegations,
} from './delegations.ts';
import type { DelegationRecord } from './delegations.ts';
import { logClick, logClose } from './usage.ts';

const STATUS_POLL_MS = 30_000;

export function DelegateRow({
  taskId,
  taskSlug,
  detail,
  onDelegate,
  onStatusCheck,
}: {
  taskId: string;
  taskSlug: string;
  detail?: string;
  onDelegate?: (slug: string, node: string) => Promise<DelegateResult | null>;
  onStatusCheck?: (req: DelegateStatusRequest) => Promise<DelegateStatusResult | null>;
}) {
  const uid = useId();
  const [picking, setPicking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [record, setRecord] = useState<DelegationRecord | null>(() => loadDelegations().find((r) => r.taskSlug === taskSlug) ?? null);
  const [savedNode, setSavedNode] = useState<string | null>(() => loadDelegateNode());
  const [nodeInput, setNodeInput] = useState(savedNode ?? '');
  const [editingNode, setEditingNode] = useState(() => loadDelegateNode() === null);
  const node = editingNode ? normalizeDelegateNode(nodeInput) : savedNode;
  const displayNode = node ?? 'your devserver';
  const [liveStatus, setLiveStatus] = useState<DelegateStatus | null>(null);
  const [statusUnknown, setStatusUnknown] = useState(false);
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

  /* Live status for the saved launch only: needs a pid and log path to probe
     and a node to probe on. The status request identity is a key string so
     the poll does not restart on every render. */
  const statusNode = record?.node ?? savedNode;
  const statusKey =
    record?.status === 'started' && record.pid != null && record.logPath && statusNode ? `${taskSlug}|${statusNode}|${record.pid}|${record.logPath}` : null;
  /* Refs are synced in an effect, never during render: the poll reads the
     latest request and checker without restarting on every render. */
  const statusReqRef = useRef<DelegateStatusRequest | null>(null);
  const statusCheckRef = useRef(onStatusCheck);
  useEffect(() => {
    statusReqRef.current =
      statusKey && record?.pid != null && record.logPath && statusNode
        ? { taskSlug, node: statusNode, pid: record.pid, logPath: record.logPath }
        : null;
    statusCheckRef.current = onStatusCheck;
  });
  const doCheck = useCallback(async () => {
    const req = statusReqRef.current;
    if (!req) return;
    try {
      const res = statusCheckRef.current ? await statusCheckRef.current(req) : await checkDelegateStatus(req);
      if (!mountedRef.current) return;
      if (res?.ok && res.status) {
        setLiveStatus(res.status);
        setStatusUnknown(false);
      } else {
        setStatusUnknown(true);
      }
    } catch {
      if (mountedRef.current) setStatusUnknown(true);
    }
  }, []);
  useEffect(() => {
    if (!statusKey) return;
    void doCheck();
    const timer = window.setInterval(() => {
      void doCheck();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [statusKey, doCheck]);

  const canDelegate = Boolean(onDelegate) || delegateAvailable();
  if (!canDelegate) return null;

  const openPicker = () => {
    logClick('glance_panel', 'delegate_open', { section: 'needs_revision', task_id: taskId });
    setPicking(true);
  };

  const confirm = async () => {
    const targetNode = editingNode ? normalizeDelegateNode(nodeInput) : savedNode;
    if (!targetNode) return;
    saveDelegateNode(targetNode);
    setSavedNode(targetNode);
    setEditingNode(false);
    logClick('glance_panel', 'delegate_start', { section: 'needs_revision', task_id: taskId, agent: 'codex' });
    setPicking(false);
    setStarting(true);
    let result: DelegateResult | null;
    try {
      result = onDelegate ? await onDelegate(taskSlug, targetNode) : await delegateToGreen(taskSlug, targetNode);
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
          node: targetNode,
          startedAtMs: Date.now(),
        }
      : {
          taskSlug,
          agent: 'codex',
          status: 'failed',
          pid: null,
          logPath: null,
          repo: null,
          node: targetNode,
          startedAtMs: Date.now(),
          errorMessage: result?.error?.message ?? 'Delegate needs the desktop shell.',
          errorFix: result?.error?.fix,
        };
    setRecord(next);
    setLiveStatus(null);
    setStatusUnknown(false);
    saveDelegations(recordDelegation(loadDelegations(), next));
  };

  const logBase = record?.logPath ? (record.logPath.split('/').pop() ?? record.logPath) || record.logPath : null;
  const copyLogPath = () => {
    if (!record?.logPath) return;
    navigator.clipboard
      ?.writeText(record.logPath)
      .then(() => setCopied(true))
      .catch(() => {
        /* clipboard blocked — the copied label stays off, the path stays selectable in the title */
      });
  };

  return (
    <div className="agent-row">
      {record?.status === 'started' && (
        <>
          <ul className="agent-status-list">
            <li
              className={`agent-status ${
                liveStatus?.kind === 'done'
                  ? 'agent-done'
                  : liveStatus?.kind === 'blocked'
                    ? 'agent-failed'
                    : liveStatus?.kind === 'working' || liveStatus?.kind === 'starting'
                      ? 'agent-running'
                      : 'agent-status'
              }`}
            >
              {liveStatus ? DELEGATE_STATUS_LABELS[liveStatus.kind] : statusUnknown ? DELEGATE_STATUS_LABELS.unknown : 'Green started'}
            </li>
          </ul>
          {record.pid != null && (
            <p className="muted small">
              {record.node ? `on ${record.node} · ` : ''}worker {record.pid}
              {liveStatus?.lastActivityAgeSecs != null && formatActivityAge(liveStatus.lastActivityAgeSecs) ? ` · active ${formatActivityAge(liveStatus.lastActivityAgeSecs)}` : ''}
              {liveStatus?.lastDecision ? ` · ${liveStatus.lastDecision}` : ''}
              {logBase ? (
                <>
                  {' · '}
                  <span title={record.logPath ?? ''}>{logBase}</span>{' '}
                  <button type="button" className="btn-link" onClick={copyLogPath}>
                    {copied ? 'Copied' : 'Copy log path'}
                  </button>
                </>
              ) : null}
              {statusKey ? (
                <>
                  {' '}
                  <button type="button" className="btn-link" onClick={() => void doCheck()}>
                    Refresh status
                  </button>
                </>
              ) : null}
            </p>
          )}
        </>
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
          {editingNode ? (
            <>
              <label className="small agent-picker-label" htmlFor={`${uid}-node`}>
                Devserver
              </label>
              <input
                id={`${uid}-node`}
                aria-label="Devserver"
                type="text"
                value={nodeInput}
                onChange={(e) => setNodeInput(e.target.value)}
                placeholder="Devserver node id"
                autoComplete="off"
              />
              <p className="muted small">Asked once and saved for future delegations. Enter the AgentCloud node id for your devserver.</p>
            </>
          ) : (
            <p className="muted small">
              Devserver: <code>{savedNode}</code>{' '}
              <button
                type="button"
                className="btn-link"
                onClick={() => {
                  setNodeInput(savedNode ?? '');
                  setEditingNode(true);
                }}
              >
                Change
              </button>
            </p>
          )}
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
            Runs Green on {displayNode} with Codex (<code>green {taskSlug} --live --hardening --detach --agent codex</code>). Green repairs the task, proves
            it locally, pushes, and waits for validation — up to 10 hours, detached. Before launching, Mochi checks Green is installed on the devserver
            (installing it if needed), clones the task checkout if it is missing, fast-forwards it to origin/main if the task directory is missing from a
            stale checkout, and runs <code>doctor --install-hooks</code> in the task checkout.
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
            <button type="button" className="btn-primary" disabled={!node} onClick={() => void confirm()}>
              Delegate to Codex
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );
}
