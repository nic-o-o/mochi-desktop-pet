// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegateRow, TaskHandlerStatus } from './DelegateRow.tsx';
import { DELEGATE_NODE_STORAGE_KEY, DELEGATIONS_STORAGE_KEY } from './delegations.ts';
import type { DelegationRecord, DelegateResult, HandlerProbe, HandlerProbeResult } from './delegations.ts';

const NODE = 'devvm7438.hil0.facebook.com';

function seedStartedRecord(over: Partial<DelegationRecord> = {}) {
  localStorage.setItem(
    DELEGATIONS_STORAGE_KEY,
    JSON.stringify([
      {
        taskSlug: 'ember-task',
        agent: 'codex',
        status: 'started',
        pid: 99,
        logPath: '/tmp/old.log',
        repo: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember',
        node: NODE,
        startedAtMs: 1000,
        ...over,
      },
    ]),
  );
}

function seedFailedRecord(over: Partial<DelegationRecord> = {}) {
  localStorage.setItem(
    DELEGATIONS_STORAGE_KEY,
    JSON.stringify([
      {
        taskSlug: 'ember-task',
        agent: 'codex',
        status: 'failed',
        pid: null,
        logPath: null,
        repo: null,
        node: NODE,
        startedAtMs: 1000,
        ...over,
      },
    ]),
  );
}

function handlerProbe(over: Partial<HandlerProbe> = {}): HandlerProbe {
  return {
    handler: 'green',
    pid: 99,
    logPath: '/tmp/old.log',
    agent: 'codex',
    kind: 'working',
    lastDecision: 'DECIDE FIX: x',
    lastActivityAgeSecs: 120,
    waitingMins: null,
    waitingReason: null,
    blockedReason: null,
    hasBlocked: false,
    hasTimingZero: false,
    leaseAgeSecs: null,
    checkedAtMs: 1000,
    ...over,
  };
}

function probeResult(probe: HandlerProbe): HandlerProbeResult {
  return { ok: true, probe };
}

function noWorkerProbe(): HandlerProbeResult {
  return probeResult(handlerProbe({ handler: 'none', pid: null, logPath: null, agent: null, kind: null, lastDecision: null, lastActivityAgeSecs: null }));
}

function deadProbe(kind: 'blocked' | 'done' | 'stopped', over: Partial<HandlerProbe> = {}): HandlerProbeResult {
  return probeResult(handlerProbe({ handler: 'none', kind, hasBlocked: kind === 'blocked', hasTimingZero: kind === 'done', ...over }));
}

const STARTED: DelegateResult = {
  ok: true,
  taskSlug: 'ember-task',
  agent: 'codex',
  repo: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember',
  pid: 424242,
  logPath: '/home/zixuanchen/logs/green-1.log',
  decision: 'DECIDE repair: validation failures',
};

const FAILED: DelegateResult = {
  ok: false,
  taskSlug: 'ember-task',
  agent: 'codex',
  error: { kind: 'repo_not_found', message: 'Task checkout not found.', fix: 'Clone it to ~/AAI/swe-bench-aai-labs-ember.' },
};

const LEASE_REFUSED: DelegateResult = {
  ok: false,
  taskSlug: 'ember-task',
  agent: 'codex',
  error: {
    kind: 'launch_failed',
    message: 'Green failed to start for ember-task. log: /tmp/green.ember-task.log worker pid: 3263841 refusing: another unattended worker holds the remote lease for ember-task Green worker exited with code 64',
    fix: 'Check the task is not already running Green, then try again.',
  },
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(DELEGATE_NODE_STORAGE_KEY, NODE);
});

afterEach(cleanup);

describe('DelegateRow', () => {
  it('opens a picker with Muse and Codex, MetaCode and Claude Code disabled, and the instruction.md rule', () => {
    render(<DelegateRow taskId="644347" taskSlug="ember-task" detail="Solvability & difficulty" onDelegate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to agent' }));
    expect(screen.getByText('Delegate to agent')).toBeTruthy();
    const codex = screen.getByRole('radio', { name: 'Codex' }) as HTMLInputElement;
    const muse = screen.getByRole('radio', { name: 'Muse' }) as HTMLInputElement;
    expect(codex.checked).toBe(true);
    expect(codex.disabled).toBe(false);
    expect(muse.checked).toBe(false);
    expect(muse.disabled).toBe(false);
    expect((screen.getByRole('radio', { name: 'MetaCode' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('radio', { name: 'Claude Code' }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Green has no mapping for MetaCode or Claude Code/)).toBeTruthy();
    expect(screen.getByText('Only use Muse to rewrite/modify instruction.md.')).toBeTruthy();
    expect(screen.getByText('Green repairs the task. Ask agents reviews tasks and cannot repair this one.')).toBeTruthy();
    expect(screen.getByText('ember-task')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delegate to Codex' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Delegate to Codex' })).toBeNull();
  });

  it('delegates with Muse when Muse is chosen, and saves it on the record', async () => {
    const onDelegate = vi.fn(async () => STARTED);
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={onDelegate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to agent' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Muse' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to Muse' }));
    expect(onDelegate).toHaveBeenCalledWith('ember-task', NODE, 'muse');
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(DELEGATIONS_STORAGE_KEY) ?? '[]') as Array<{ agent: string }>;
      expect(saved[0]).toMatchObject({ agent: 'muse' });
    });
  });

  it('delegates on Confirm and saves the worker pid and log path without showing them', async () => {
    const onDelegate = vi.fn(async () => STARTED);
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={onDelegate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to Codex' }));
    expect(onDelegate).toHaveBeenCalledWith('ember-task', NODE, 'codex');
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(DELEGATIONS_STORAGE_KEY) ?? '[]') as Array<{ pid: number; logPath: string }>;
      expect(saved[0]).toMatchObject({ pid: 424242, logPath: '/home/zixuanchen/logs/green-1.log' });
    });
    expect(screen.queryByText(/worker 424242/)).toBeNull();
    expect(screen.queryByText(/green-1\.log/)).toBeNull();
  });

  it('shows a setup status and the fix in the picker, and lets the person try again', async () => {
    const onDelegate = vi.fn(async () => FAILED);
    const onHandlerCheck = vi.fn(async () => noWorkerProbe());
    render(
      <>
        <TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={onHandlerCheck} />
        <DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={onDelegate} onHandlerCheck={onHandlerCheck} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to Codex' }));
    await waitFor(() => expect(screen.getByText('Task checkout not found on your devserver')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Delegate/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Delegate/ }));
    expect(screen.getByText(/Clone it to/)).toBeTruthy();
  });

  it('asks for the devserver the first time, saves it, and passes the normalized node', async () => {
    localStorage.removeItem(DELEGATE_NODE_STORAGE_KEY);
    const onDelegate = vi.fn(async () => STARTED);
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={onDelegate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to agent' }));
    const input = screen.getByRole('textbox', { name: 'Devserver' }) as HTMLInputElement;
    const confirm = screen.getByRole('button', { name: 'Delegate to Codex' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  HTTPS://DevVM7438.Hil0.Facebook.Com/ ' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onDelegate).toHaveBeenCalledWith('ember-task', NODE, 'codex');
    expect(localStorage.getItem(DELEGATE_NODE_STORAGE_KEY)).toBe(NODE);
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(DELEGATIONS_STORAGE_KEY) ?? '[]') as Array<{ pid: number }>;
      expect(saved[0]).toMatchObject({ pid: 424242 });
    });
    expect(screen.queryByText(/worker 424242/)).toBeNull();
  });

  it('keeps Confirm disabled for an invalid devserver, and lets the saved one be changed', async () => {
    localStorage.removeItem(DELEGATE_NODE_STORAGE_KEY);
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to agent' }));
    const input = screen.getByRole('textbox', { name: 'Devserver' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'not a node!!' } });
    expect((screen.getByRole('button', { name: 'Delegate to Codex' }) as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    localStorage.setItem(DELEGATE_NODE_STORAGE_KEY, NODE);
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to agent' }));
    expect(screen.getByText('devvm7438.hil0.facebook.com')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    const changeInput = screen.getByRole('textbox', { name: 'Devserver' }) as HTMLInputElement;
    expect(changeInput.value).toBe(NODE);
  });

  it('shows a saved delegation without launching again', () => {
    seedStartedRecord();
    const onDelegate = vi.fn();
    const pending = () => new Promise<HandlerProbeResult | null>(() => {});
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={onDelegate} onHandlerCheck={pending} />);
    expect(screen.queryByText('Green is already running for this task.')).toBeNull();
    expect(screen.queryByRole('button', { name: /Delegate/ })).toBeNull();
    expect(screen.queryByText(/worker 99/)).toBeNull();
    expect(screen.queryByText(/old\.log/)).toBeNull();
    expect(onDelegate).not.toHaveBeenCalled();
  });

  it('heals a failed record to Green working when the launch finds the worker already running', async () => {
    seedFailedRecord({
      errorMessage: 'Green failed to start for ember-task. refusing: another unattended worker holds the remote lease for ember-task',
      errorFix: 'Check the task is not already running Green, then try again.',
    });
    let healed = false;
    const onHandlerCheck = vi.fn(async () => (healed ? probeResult(handlerProbe()) : noWorkerProbe()));
    const onDelegate = vi.fn(async () => {
      healed = true;
      return {
        ok: true,
        taskSlug: 'ember-task',
        agent: 'codex' as const,
        repo: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember',
        pid: 2353662,
        logPath: '/tmp/green.ember-task.20261112-135356.q_oey57t.log',
        alreadyRunning: true,
      };
    });
    render(
      <>
        <TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={onHandlerCheck} />
        <DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={onDelegate} onHandlerCheck={onHandlerCheck} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to Codex' }));
    await waitFor(() => expect(screen.getByText('Green working')).toBeTruthy());
    const saved = JSON.parse(localStorage.getItem(DELEGATIONS_STORAGE_KEY) ?? '[]') as Array<{ status: string; pid: number; logPath: string }>;
    expect(saved[0]).toMatchObject({ status: 'started', pid: 2353662, logPath: '/tmp/green.ember-task.20261112-135356.q_oey57t.log' });
  });

  it('updates the status label when a delegation is saved', async () => {
    let launched = false;
    const onHandlerCheck = vi.fn(async () => (launched ? probeResult(handlerProbe()) : noWorkerProbe()));
    const onDelegate = vi.fn(async () => {
      launched = true;
      return STARTED;
    });
    render(
      <>
        <TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={onHandlerCheck} />
        <DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={onDelegate} onHandlerCheck={onHandlerCheck} />
      </>,
    );
    expect(screen.queryByText(/Green/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to Codex' }));
    await waitFor(() => expect(screen.getByText('Green working')).toBeTruthy());
  });

  it('shows only the live status label, with no worker or log detail', async () => {
    seedStartedRecord();
    const onHandlerCheck = vi.fn(async () => probeResult(handlerProbe()));
    render(<TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={onHandlerCheck} />);
    await waitFor(() => expect(screen.getByText('Green working')).toBeTruthy());
    expect(screen.getByText('Green working').className).toContain('agent-done');
    expect(screen.queryByText(/worker 99/)).toBeNull();
    expect(screen.queryByText(/old\.log/)).toBeNull();
    expect(screen.queryByText(/2m ago/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy log path' })).toBeNull();
    expect(onHandlerCheck).toHaveBeenCalledWith({ taskSlug: 'ember-task', node: NODE, pid: 99, logPath: '/tmp/old.log' });
  });

  it('colors good statuses green and blocked/stopped red, and hides Delegate again while Green is running', async () => {
    for (const [kind, label, className, hideButton] of [
      ['starting', 'Green starting', 'agent-done', true],
      ['working', 'Green working', 'agent-done', true],
      ['blocked', 'Green blocked', 'agent-failed', false],
      ['done', 'Green done', 'agent-done', false],
      ['stopped', 'Green not running', 'agent-failed', false],
    ] as const) {
      cleanup();
      localStorage.clear();
      localStorage.setItem(DELEGATE_NODE_STORAGE_KEY, NODE);
      seedStartedRecord();
      const check = async () =>
        probeResult(
          handlerProbe({
            kind,
            handler: kind === 'blocked' || kind === 'done' || kind === 'stopped' ? 'none' : 'green',
            hasBlocked: kind === 'blocked',
            hasTimingZero: kind === 'done',
          }),
        );
      render(
        <>
          <TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={check} />
          <DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={vi.fn()} onHandlerCheck={check} />
        </>,
      );
      await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
      expect(screen.getByText(label).className).toContain(className);
      if (hideButton) {
        expect(screen.queryByRole('button', { name: /Delegate/ })).toBeNull();
      } else {
        expect(screen.getByRole('button', { name: /Delegate/ })).toBeTruthy();
      }
    }
  });

  it('shows waiting with the waited-on reason, and hides Delegate again for a short wait', async () => {
    seedStartedRecord();
    const check = async () =>
      probeResult(handlerProbe({ waitingMins: 10, waitingReason: 'Agentic trial-output review, Codex run' }));
    render(
      <>
        <TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={check} />
        <DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={vi.fn()} onHandlerCheck={check} />
      </>,
    );
    await waitFor(() => expect(screen.getByText('Green waiting · Agentic trial-output review, Codex run (10m)')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Delegate/ })).toBeNull();
  });

  it('stops a long-waiting worker only after confirmation, then delegates', async () => {
    seedStartedRecord();
    const waiting = async () =>
      probeResult(handlerProbe({ waitingMins: 72, waitingReason: 'Agentic trial-output review, Codex run', lastActivityAgeSecs: 120 }));
    const onStopWorker = vi.fn(async () => ({ ok: true, taskSlug: 'ember-task', pid: 99, stopped: true }));
    const onDelegate = vi.fn(async () => STARTED);
    render(
      <>
        <TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={waiting} />
        <DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={onDelegate} onHandlerCheck={waiting} onStopWorker={onStopWorker} />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByText('Green waiting · Agentic trial-output review, Codex run (72m)')).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate again' }));
    expect(screen.getByText(/has been waiting 72m/)).toBeTruthy();
    expect(screen.getByText(/pid 99/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop worker & delegate to Codex' }));
    await waitFor(() => expect(onStopWorker).toHaveBeenCalledWith({ taskSlug: 'ember-task', node: NODE, pid: 99, logPath: '/tmp/old.log' }));
    expect(onDelegate).toHaveBeenCalled();
  });

  it('hides Delegate again before the first probe returns for a started record', () => {
    seedStartedRecord();
    const pending = () => new Promise<HandlerProbeResult | null>(() => {});
    render(
      <>
        <TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={pending} />
        <DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={vi.fn()} onHandlerCheck={pending} />
      </>,
    );
    expect(screen.getByText('Green started')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Delegate/ })).toBeNull();
    expect(screen.queryByText('Green is already running for this task.')).toBeNull();
  });

  it('keeps the started record when a re-delegation is refused by the lease', async () => {
    seedStartedRecord();
    let phase: 'stopped' | 'working' = 'stopped';
    const check = async () => (phase === 'stopped' ? deadProbe('stopped') : probeResult(handlerProbe()));
    const onDelegate = vi.fn(async () => {
      phase = 'working';
      return LEASE_REFUSED;
    });
    render(
      <>
        <TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={check} />
        <DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={onDelegate} onHandlerCheck={check} />
      </>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delegate again' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delegate again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to Codex' }));
    await waitFor(() => {
      expect(screen.getByText('Green working')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Delegate/ })).toBeNull();
    });
    expect(screen.queryByText(/Green failed to start/)).toBeNull();
    expect(screen.queryByText(/holds the remote lease/)).toBeNull();
    const saved = JSON.parse(localStorage.getItem(DELEGATIONS_STORAGE_KEY) ?? '[]') as Array<{ pid: number; logPath: string; status: string }>;
    expect(saved[0]).toMatchObject({ pid: 99, logPath: '/tmp/old.log', status: 'started' });
  });

  it('still overwrites a started record with a non-lease failure', async () => {
    seedStartedRecord();
    let failed = false;
    const check = async () => (failed ? noWorkerProbe() : deadProbe('stopped'));
    render(
      <>
        <TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={check} />
        <DelegateRow
          taskId="644347"
          taskSlug="ember-task"
          onDelegate={vi.fn(async () => {
            failed = true;
            return FAILED;
          })}
          onHandlerCheck={check}
        />
      </>,
    );
    await waitFor(() => expect(screen.getByText('Green not running')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delegate again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to Codex' }));
    await waitFor(() => expect(screen.getByText('Task checkout not found on your devserver')).toBeTruthy());
    const saved = JSON.parse(localStorage.getItem(DELEGATIONS_STORAGE_KEY) ?? '[]') as Array<{ pid: number | null; status: string }>;
    expect(saved[0]).toMatchObject({ pid: null, status: 'failed' });
    expect(screen.getByRole('button', { name: /Delegate/ })).toBeTruthy();
  });

  it('shows unknown in neutral grey when the probe fails, with no detail', async () => {
    seedStartedRecord();
    render(<TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={async () => null} />);
    await waitFor(() => expect(screen.getByText('Green status unknown')).toBeTruthy());
    const label = screen.getByText('Green status unknown');
    expect(label.className).toContain('agent-status');
    expect(label.className).not.toContain('agent-done');
    expect(label.className).not.toContain('agent-failed');
    expect(screen.queryByText(/worker 99/)).toBeNull();
  });

  it('probes by discovery when the record has no pid or log path', async () => {
    seedStartedRecord({ pid: null, logPath: null });
    const onHandlerCheck = vi.fn(async () => noWorkerProbe());
    render(<TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={onHandlerCheck} />);
    await waitFor(() => expect(screen.getByText('Green not running')).toBeTruthy());
    expect(onHandlerCheck).toHaveBeenCalledWith({ taskSlug: 'ember-task', node: NODE });
    expect(screen.queryByRole('button', { name: 'Copy log path' })).toBeNull();
  });

  it('rechecks the status every 30 seconds while the panel is open', async () => {
    vi.useFakeTimers();
    try {
      seedStartedRecord();
      const onHandlerCheck = vi.fn(async () => probeResult(handlerProbe()));
      render(<TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={onHandlerCheck} />);
      await vi.advanceTimersByTimeAsync(0);
      expect(onHandlerCheck).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30000);
      expect(onHandlerCheck).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30000);
      expect(onHandlerCheck).toHaveBeenCalledTimes(3);
      expect(screen.getByText('Green working')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a stuck worker only after confirmation, then delegates', async () => {
    seedStartedRecord();
    const stuck = async () =>
      probeResult(handlerProbe({ lastActivityAgeSecs: 3600, leaseAgeSecs: 7200 }));
    const onStopWorker = vi.fn(async () => ({ ok: true, taskSlug: 'ember-task', pid: 99, stopped: true }));
    const onDelegate = vi.fn(async () => STARTED);
    render(
      <>
        <TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={stuck} />
        <DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={onDelegate} onHandlerCheck={stuck} onStopWorker={onStopWorker} />
      </>,
    );
    await waitFor(() => expect(screen.getByText('Green stuck · no activity for 60m')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delegate again' }));
    expect(screen.getByText(/no log activity/)).toBeTruthy();
    expect(screen.getByText(/pid 99/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop worker & delegate to Codex' }));
    await waitFor(() => expect(onStopWorker).toHaveBeenCalledWith({ taskSlug: 'ember-task', node: NODE, pid: 99, logPath: '/tmp/old.log' }));
    expect(onDelegate).toHaveBeenCalled();
  });

  it('keeps the picker open and does not delegate when stopping a stuck worker fails', async () => {
    seedStartedRecord();
    const stuck = async () => probeResult(handlerProbe({ lastActivityAgeSecs: 3600 }));
    const onStopWorker = vi.fn(async () => ({
      ok: false,
      taskSlug: 'ember-task',
      pid: 99,
      error: { kind: 'stop_failed', message: 'The worker is still running after SIGTERM.', fix: 'Check the worker on the devserver.' },
    }));
    const onDelegate = vi.fn(async () => STARTED);
    render(
      <DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={onDelegate} onHandlerCheck={stuck} onStopWorker={onStopWorker} />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delegate again' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delegate again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop worker & delegate to Codex' }));
    await waitFor(() => expect(screen.getByText(/still running after SIGTERM/)).toBeTruthy());
    expect(onDelegate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Stop worker & delegate to Codex' })).toBeTruthy();
    const saved = JSON.parse(localStorage.getItem(DELEGATIONS_STORAGE_KEY) ?? '[]') as Array<{ status: string }>;
    expect(saved[0].status).toBe('started');
  });

  it('offers Install Docker for a Docker-missing failure, and clears the record when it succeeds', async () => {
    seedFailedRecord({ errorKind: 'doctor_failed', errorCheck: 'docker', errorMessage: 'Green doctor failed: Docker is missing on the devserver.' });
    const onInstallDocker = vi.fn(async () => ({ ok: true, taskSlug: 'ember-task', daemonReachable: true }));
    render(
      <>
        <TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={async () => noWorkerProbe()} />
        <DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={vi.fn()} onInstallDocker={onInstallDocker} />
      </>,
    );
    await waitFor(() => expect(screen.getByText('Docker is missing on your devserver')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Delegate/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Install Docker' }));
    expect(screen.getByText(/with the package manager/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onInstallDocker).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Install Docker' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Install Docker' }).at(-1)!);
    await waitFor(() => expect(onInstallDocker).toHaveBeenCalledWith('ember-task', NODE));
    await waitFor(() => expect(screen.getByText(/Docker is ready/)).toBeTruthy());
    expect(localStorage.getItem(DELEGATIONS_STORAGE_KEY)).toBe('[]');
    expect(screen.getByRole('button', { name: 'Delegate to agent' })).toBeTruthy();
  });

  it('keeps the failed record and shows a short reason when installing Docker fails', async () => {
    seedFailedRecord({ errorKind: 'doctor_failed', errorCheck: 'docker', errorMessage: 'Green doctor failed: Docker is missing on the devserver.' });
    const onInstallDocker = vi.fn(async () => ({
      ok: false,
      taskSlug: 'ember-task',
      error: { kind: 'daemon_failed', message: 'Docker is installed, but the daemon would not start.', fix: 'Start the Docker daemon by hand.' },
    }));
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={vi.fn()} onInstallDocker={onInstallDocker} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install Docker' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Install Docker' }).at(-1)!);
    await waitFor(() => expect(screen.getByText(/daemon would not start/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Install Docker' })).toBeTruthy();
    const saved = JSON.parse(localStorage.getItem(DELEGATIONS_STORAGE_KEY) ?? '[]') as Array<{ status: string }>;
    expect(saved[0].status).toBe('failed');
  });

  it('does not offer Install Docker for other setup failures', async () => {
    seedFailedRecord({ errorKind: 'repo_not_found', errorMessage: 'Task checkout not found.' });
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={vi.fn()} onInstallDocker={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Install Docker' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delegate again' })).toBeTruthy();
  });
});

describe('TaskHandlerStatus shape', () => {
  it('renders the status as an inline span, not a list, for the meta line', () => {
    seedStartedRecord();
    const pending = () => new Promise<HandlerProbeResult | null>(() => {});
    render(<TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={pending} />);
    const label = screen.getByText('Green started');
    expect(label.tagName).toBe('SPAN');
    expect(label.closest('ul')).toBeNull();
    expect(label.className).toContain('agent-status');
  });

  it('renders nothing when there is no started delegation and no handler is found', () => {
    const { container } = render(<TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('names a running agent review without a Green status', async () => {
    render(<TaskHandlerStatus taskSlug="ember-task" reviewJobRunning onHandlerCheck={async () => noWorkerProbe()} />);
    await waitFor(() => expect(screen.getByText('Agent review running')).toBeTruthy());
  });

  it('shows a Docker-missing setup status from a failed record', async () => {
    seedFailedRecord({ errorKind: 'doctor_failed', errorCheck: 'docker', errorMessage: 'Green doctor failed.' });
    render(<TaskHandlerStatus taskSlug="ember-task" onHandlerCheck={async () => noWorkerProbe()} />);
    await waitFor(() => expect(screen.getByText('Docker is missing on your devserver')).toBeTruthy());
    expect(screen.getByText('Docker is missing on your devserver').className).toContain('agent-failed');
  });
});
