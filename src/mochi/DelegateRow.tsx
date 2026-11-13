/* "Delegate to agent" under a "Needs revision" row: Green repairs the task on
 * the devserver with the repair agent the person picks (Muse or Codex;
 * MetaCode and Claude Code are shown unavailable because Green has no
 * mapping for them). The picker states exactly what Confirm will do — a
 * live, detached Green run that edits and pushes the real task, with only
 * Muse rewriting or modifying instruction.md — and the tool is always
 * Green: Ask agents reviews tasks and cannot repair one.
 *
 * Each row derives one state from a handler probe of the devserver (a live
 * worker, its log evidence, or nothing) plus the saved launch record. A
 * live worker hides the Delegate button and shows its status — running,
 * waiting, or stuck — on the meta line; a stuck worker offers a confirmed
 * stop before re-delegating; a setup failure (including Docker missing
 * from Green doctor) is one short status line with the next step, and for
 * Docker an explicit Install Docker action. Nothing here renders a launch
 * error paragraph, and nothing launches while a live worker holds the
 * lease: the probe, not the saved record, is the truth about a handler.
 * In a plain browser there is no bridge and the button stays hidden, like
 * Submit.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { checkTaskHandler, delegateAvailable, delegateToGreen, installDocker, installDockerAvailable, stopGreenWorker } from './shell.ts';
import type {
  DelegateAgent,
  DelegateResult,
  DockerInstallResult,
  HandlerProbe,
  HandlerProbeRequest,
  HandlerProbeResult,
  StopWorkerRequest,
  StopWorkerResult,
} from './delegations.ts';
import {
  DELEGATE_AGENT_OPTIONS,
  DELEGATIONS_CHANGED_EVENT,
  isDelegateAgent,
  loadDelegateNode,
  loadDelegations,
  normalizeDelegateNode,
  recordDelegation,
  removeDelegation,
  saveDelegateNode,
  saveDelegations,
} from './delegations.ts';
import type { DelegationRecord } from './delegations.ts';
import { deriveRowState } from './handlerState.ts';
import type { ProbeState } from './handlerState.ts';
import { logClick, logClose } from './usage.ts';

const STATUS_POLL_MS = 30_000;

/** A launch failure that means a worker already holds the task's Green lease. */
function isLeaseRefusal(result: DelegateResult | null): boolean {
  return (
    !!result &&
    !result.ok &&
    result.error?.kind === 'launch_failed' &&
    /holds the remote lease|already has a worker/i.test(result.error.message ?? '')
  );
}

/**
 * One handler probe loop for a row: what is handling this task on the
 * devserver, from discovery plus any saved worker log. The probe request
 * identity is a key string so the poll does not restart on every render;
 * `refreshTick` forces an immediate recheck without changing the key, for
 * when the saved record was re-read. The probe runs even with no saved
 * record, so a worker launched elsewhere is still found.
 */
function useTaskHandler(
  taskSlug: string,
  record: DelegationRecord | null,
  fallbackNode: string | null,
  onHandlerCheck: ((req: HandlerProbeRequest) => Promise<HandlerProbeResult | null>) | undefined,
  refreshTick = 0,
) {
  const [probe, setProbe] = useState<HandlerProbe | null>(null);
  const [probeFailed, setProbeFailed] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const probeNode = record?.node ?? fallbackNode;
  const probeKey = probeNode ? `${taskSlug}|${probeNode}|${record?.pid ?? ''}|${record?.logPath ?? ''}` : null;
  /* Refs are synced in an effect, never during render: the poll reads the
     latest request and checker without restarting on every render. */
  const probeReqRef = useRef<HandlerProbeRequest | null>(null);
  const probeCheckRef = useRef(onHandlerCheck);
  useEffect(() => {
    probeReqRef.current =
      probeKey && probeNode
        ? {
            taskSlug,
            node: probeNode,
            ...(record?.status === 'started' && record.pid != null && record.logPath ? { pid: record.pid, logPath: record.logPath } : {}),
          }
        : null;
    probeCheckRef.current = onHandlerCheck;
  });
  const doCheck = useCallback(async () => {
    const req = probeReqRef.current;
    if (!req) return;
    try {
      const res = probeCheckRef.current ? await probeCheckRef.current(req) : await checkTaskHandler(req);
      if (!mountedRef.current) return;
      if (res?.ok && res.probe) {
        setProbe(res.probe);
        setProbeFailed(false);
      } else {
        setProbeFailed(true);
      }
    } catch {
      if (mountedRef.current) setProbeFailed(true);
    }
  }, []);
  const resetProbe = useCallback(() => {
    setProbe(null);
    setProbeFailed(false);
  }, []);
  useEffect(() => {
    if (!probeKey) return;
    void doCheck();
    const timer = window.setInterval(() => {
      void doCheck();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [probeKey, doCheck, refreshTick]);
  const probeState: ProbeState = probe ? 'ok' : probeFailed ? 'failed' : 'pending';
  return { probe, probeFailed, probeState, probeNode, doCheck, resetProbe };
}

function notifyDelegationsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DELEGATIONS_CHANGED_EVENT));
}

/**
 * The one status line for a delegation, as an inline span: the row's meta
 * line places it beside the validation failure at the meta text size, and
 * the span inherits that size and the status colour from its classes. It
 * owns only its record (reloaded whenever a delegation is saved) and its
 * handler probe; the row below owns launching, stopping, and installing.
 * Nothing renders when the row is idle, so the meta line is untouched
 * until something is handling the task or a setup failure needs naming.
 */
export function TaskHandlerStatus({
  taskSlug,
  reviewJobRunning = false,
  onHandlerCheck,
}: {
  taskSlug: string;
  reviewJobRunning?: boolean;
  onHandlerCheck?: (req: HandlerProbeRequest) => Promise<HandlerProbeResult | null>;
}) {
  const [record, setRecord] = useState<DelegationRecord | null>(() => loadDelegations().find((r) => r.taskSlug === taskSlug) ?? null);
  const [savedNode, setSavedNode] = useState<string | null>(() => loadDelegateNode());
  const [refreshTick, setRefreshTick] = useState(0);
  const { probe, probeState, resetProbe } = useTaskHandler(taskSlug, record, savedNode, onHandlerCheck, refreshTick);
  useEffect(() => {
    const reload = () => {
      setRecord(loadDelegations().find((r) => r.taskSlug === taskSlug) ?? null);
      setSavedNode(loadDelegateNode());
      resetProbe();
      setRefreshTick((t) => t + 1);
    };
    window.addEventListener(DELEGATIONS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(DELEGATIONS_CHANGED_EVENT, reload);
  }, [taskSlug, resetProbe]);
  const rowState = deriveRowState({ probe, probeState, record, reviewJobRunning });
  if (!rowState.statusText) return null;
  return <span className={`agent-status ${rowState.statusClass}`}>{rowState.statusText}</span>;
}

export function DelegateRow({
  taskId,
  taskSlug,
  detail,
  onDelegate,
  onHandlerCheck,
  onStopWorker,
  onInstallDocker,
}: {
  taskId: string;
  taskSlug: string;
  detail?: string;
  onDelegate?: (slug: string, node: string, agent: DelegateAgent) => Promise<DelegateResult | null>;
  onHandlerCheck?: (req: HandlerProbeRequest) => Promise<HandlerProbeResult | null>;
  onStopWorker?: (req: StopWorkerRequest) => Promise<StopWorkerResult | null>;
  onInstallDocker?: (slug: string, node: string) => Promise<DockerInstallResult | null>;
}) {
  const uid = useId();
  const [picking, setPicking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  /* Codex stays the default: it was the only agent before the picker. */
  const [agent, setAgent] = useState<DelegateAgent>('codex');
  const [record, setRecord] = useState<DelegationRecord | null>(() => loadDelegations().find((r) => r.taskSlug === taskSlug) ?? null);
  const [savedNode, setSavedNode] = useState<string | null>(() => loadDelegateNode());
  const [nodeInput, setNodeInput] = useState(savedNode ?? '');
  const [editingNode, setEditingNode] = useState(() => loadDelegateNode() === null);
  const [installPhase, setInstallPhase] = useState<'idle' | 'confirm' | 'running' | 'done'>('idle');
  const [installError, setInstallError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const node = editingNode ? normalizeDelegateNode(nodeInput) : savedNode;
  const displayNode = node ?? 'your devserver';
  const { probe, probeState, doCheck, resetProbe } = useTaskHandler(taskSlug, record, savedNode, onHandlerCheck);
  const rowState = deriveRowState({ probe, probeState, record, reviewJobRunning: false });
  const agentLabel = DELEGATE_AGENT_OPTIONS.find((option) => option.id === agent)?.label ?? 'Codex';
  const canInstall = Boolean(onInstallDocker) || installDockerAvailable();
  const installNode = record?.node ?? savedNode;
  const stuckMins = probe?.lastActivityAgeSecs != null ? Math.floor(probe.lastActivityAgeSecs / 60) : null;
  const leaseText = probe?.leaseAgeSecs != null ? ` Lease held for ${Math.floor(probe.leaseAgeSecs / 60)}m.` : '';

  const canDelegate = Boolean(onDelegate) || delegateAvailable();
  if (!canDelegate) return null;

  const openPicker = () => {
    logClick('glance_panel', 'delegate_open', { section: 'needs_revision', task_id: taskId });
    setPicking(true);
  };

  const confirm = async () => {
    const targetNode = editingNode ? normalizeDelegateNode(nodeInput) : savedNode;
    if (!targetNode) return;
    /* A stuck worker is stopped first, with the picker still open: only a
       confirmed stop may re-delegate, and a failed stop never launches. */
    if (rowState.interruptible && rowState.stopPid != null) {
      setStopping(true);
      setStopError(null);
      let stopRes: StopWorkerResult | null;
      try {
        stopRes = onStopWorker
          ? await onStopWorker({ taskSlug, node: targetNode, pid: rowState.stopPid, logPath: record?.logPath ?? null })
          : await stopGreenWorker({ taskSlug, node: targetNode, pid: rowState.stopPid, logPath: record?.logPath ?? null });
      } catch {
        stopRes = null;
      }
      setStopping(false);
      if (!stopRes?.ok) {
        setStopError(`${stopRes?.error?.message ?? 'Could not stop the Green worker.'} ${stopRes?.error?.fix ?? ''}`.trim());
        return;
      }
      logClick('glance_panel', 'delegate_stop', { section: 'needs_revision', task_id: taskId, pid: rowState.stopPid });
    }
    const prior = record;
    saveDelegateNode(targetNode);
    setSavedNode(targetNode);
    setEditingNode(false);
    logClick('glance_panel', 'delegate_start', { section: 'needs_revision', task_id: taskId, agent });
    setPicking(false);
    setStarting(true);
    let result: DelegateResult | null;
    try {
      result = onDelegate ? await onDelegate(taskSlug, targetNode, agent) : await delegateToGreen(taskSlug, targetNode, agent);
    } catch {
      result = null;
    }
    setStarting(false);
    // A lease refusal proves the earlier worker is still running: keep its
    // record (pid/log) so the live status keeps probing, recheck now, and
    // do not replace it with the new launch's failure text.
    if (isLeaseRefusal(result) && prior?.status === 'started' && prior.pid != null && prior.logPath) {
      resetProbe();
      void doCheck();
      notifyDelegationsChanged();
      return;
    }
    const next: DelegationRecord = result?.ok
      ? {
          taskSlug,
          agent,
          status: 'started',
          pid: result.pid ?? null,
          logPath: result.logPath ?? null,
          repo: result.repo ?? null,
          node: targetNode,
          startedAtMs: Date.now(),
        }
      : {
          taskSlug,
          agent,
          status: 'failed',
          pid: null,
          logPath: null,
          repo: null,
          node: targetNode,
          startedAtMs: Date.now(),
          errorMessage: result?.error?.message ?? 'Delegate needs the desktop shell.',
          errorFix: result?.error?.fix,
          errorKind: result?.error?.kind,
          errorCheck: result?.error?.check,
        };
    setRecord(next);
    resetProbe();
    saveDelegations(recordDelegation(loadDelegations(), next));
    notifyDelegationsChanged();
    void doCheck();
  };

  const runInstall = async () => {
    if (!installNode) return;
    setInstallPhase('running');
    setInstallError(null);
    let result: DockerInstallResult | null;
    try {
      result = onInstallDocker ? await onInstallDocker(taskSlug, installNode) : await installDocker(taskSlug, installNode);
    } catch {
      result = null;
    }
    if (result?.ok) {
      setRecord(null);
      saveDelegations(removeDelegation(loadDelegations(), taskSlug));
      notifyDelegationsChanged();
      setInstallPhase('done');
    } else {
      setInstallError(`${result?.error?.message ?? 'Docker install needs the desktop shell.'} ${result?.error?.fix ?? ''}`.trim());
      setInstallPhase('idle');
    }
  };

  return (
    <div className="agent-row">
      {!picking && !starting && !stopping && (installPhase === 'idle' || installPhase === 'done') && (
        <div className="agent-row-actions">
          {rowState.showDelegate && (
            <button type="button" className="btn-link agent-link" onClick={openPicker}>
              {record ? 'Delegate again' : 'Delegate to agent'}
            </button>
          )}
          {rowState.showInstallDocker && canInstall && installNode && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setInstallError(null);
                setInstallPhase('confirm');
              }}
            >
              Install Docker
            </button>
          )}
        </div>
      )}
      {starting && <p className="muted small">Starting Green on the devserver… Green keeps working after the first decision; this can take a few minutes.</p>}
      {installPhase === 'running' && <p className="muted small">Installing Docker on {installNode}… This can take a few minutes.</p>}
      {installPhase === 'done' && <p className="muted small">Docker is ready on {installNode} — you can delegate now.</p>}
      {installError && <p className="muted small">{installError}</p>}
      {installPhase === 'confirm' && installNode && (
        <fieldset className="agent-picker">
          <legend>Install Docker</legend>
          <p className="muted small">
            Installs Docker on {installNode} with the package manager (using sudo), starts the Docker daemon, and adds you to the docker group. This changes your
            devserver and can take a few minutes. You may need to reconnect before Docker works from a new shell.
          </p>
          <div className="agent-picker-actions">
            <button type="button" className="btn-secondary" onClick={() => setInstallPhase('idle')}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={() => void runInstall()}>
              Install Docker
            </button>
          </div>
        </fieldset>
      )}
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
          {DELEGATE_AGENT_OPTIONS.map((option) => (
            <label key={option.id} className="agent-choice">
              <input
                type="radio"
                name={`${uid}-model`}
                checked={option.available && agent === option.id}
                disabled={!option.available}
                onChange={() => {
                  if (isDelegateAgent(option.id)) setAgent(option.id);
                }}
              />
              {option.label}
            </label>
          ))}
          <p className="muted small">Green has no mapping for MetaCode or Claude Code, so only Muse and Codex can repair with Green.</p>
          <span className="small agent-picker-label">Tool</span>
          <p className="muted small">Green repairs the task. Ask agents reviews tasks and cannot repair this one.</p>
          {record?.status === 'failed' && record.errorFix ? <p className="muted small">Previous attempt: {record.errorFix}</p> : null}
          <p className="muted small" id={`${uid}-note`}>
            Task: <code>{taskSlug}</code>
            {detail ? ` — failing checks: ${detail}` : ''}
          </p>
          <p className="muted small">
            Runs Green on {displayNode} with {agentLabel} (<code>green {taskSlug} --live --hardening --detach --agent {agent}</code>). Green repairs the
            task, proves it locally, pushes, and waits for validation — up to 10 hours, detached. Before launching, Mochi checks Green is installed on
            the devserver (installing it if needed), clones the task checkout if it is missing, fast-forwards it to origin/main if the task directory is
            missing from a stale checkout, and runs <code>doctor --install-hooks</code> in the task checkout.
          </p>
          <p className="muted small">Only use Muse to rewrite/modify instruction.md.</p>
          {rowState.interruptible && rowState.stopPid != null && (
            <p className="muted small">
              {rowState.phase === 'waiting'
                ? `Green has been waiting ${probe?.waitingMins ?? '?'}m for ${probe?.waitingReason ?? 'validation'}. Stopping the worker (pid ${rowState.stopPid}) loses its in-flight work.`
                : `A Green worker (pid ${rowState.stopPid}) has had no log activity for ${stuckMins ?? '?'}m.${leaseText} Stopping it loses its in-flight work.`}
            </p>
          )}
          {stopError && <p className="muted small">{stopError}</p>}
          {stopping && <p className="muted small">Stopping the Green worker…</p>}
          <div className="agent-picker-actions">
            <button
              type="button"
              className="btn-secondary"
              disabled={stopping}
              onClick={() => {
                logClose('glance_panel', 'delegate_picker', { task_id: taskId });
                setPicking(false);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={!node || stopping} onClick={() => void confirm()}>
              {rowState.interruptible ? `Stop worker & delegate to ${agentLabel}` : `Delegate to ${agentLabel}`}
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );
}
