// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegateRow } from './DelegateRow.tsx';
import { DELEGATE_NODE_STORAGE_KEY, DELEGATIONS_STORAGE_KEY } from './delegations.ts';
import type { DelegationRecord, DelegateStatus, DelegateStatusResult } from './delegations.ts';

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

function liveStatus(kind: DelegateStatus['kind'], over: Partial<DelegateStatus> = {}): DelegateStatusResult {
  return {
    ok: true,
    status: {
      kind,
      taskSlug: 'ember-task',
      pid: 99,
      logPath: '/tmp/old.log',
      lastDecision: 'DECIDE FIX: x',
      lastActivityAgeSecs: 120,
      checkedAtMs: 1000,
      ...over,
    },
  };
}
import type { DelegateResult } from './delegations.ts';

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

const NODE = 'devvm7438.hil0.facebook.com';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(DELEGATE_NODE_STORAGE_KEY, NODE);
});

afterEach(cleanup);

describe('DelegateRow', () => {
  it('opens a picker with Codex, the task slug, and a Confirm button', () => {
    render(<DelegateRow taskId="644347" taskSlug="ember-task" detail="Solvability & difficulty" onDelegate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to agent' }));
    expect(screen.getByText('Delegate to agent')).toBeTruthy();
    const radio = screen.getByRole('radio', { name: 'Codex' }) as HTMLInputElement;
    expect(radio.checked).toBe(true);
    expect(screen.getByText('ember-task')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delegate to Codex' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Delegate to Codex' })).toBeNull();
  });

  it('delegates on Confirm and shows the worker pid and log path, saved for later', async () => {
    const onDelegate = vi.fn(async () => STARTED);
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={onDelegate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to Codex' }));
    expect(onDelegate).toHaveBeenCalledWith('ember-task', NODE);
    await waitFor(() => expect(screen.getByText(/worker 424242/)).toBeTruthy());
    expect(screen.getByText(/green-1\.log/)).toBeTruthy();
    const saved = JSON.parse(localStorage.getItem(DELEGATIONS_STORAGE_KEY) ?? '[]') as Array<{ pid: number; logPath: string }>;
    expect(saved[0]).toMatchObject({ pid: 424242, logPath: '/home/zixuanchen/logs/green-1.log' });
  });

  it('shows the failure message and fix, and lets the person try again', async () => {
    const onDelegate = vi.fn(async () => FAILED);
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={onDelegate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to Codex' }));
    await waitFor(() => expect(screen.getByText(/Task checkout not found/)).toBeTruthy());
    expect(screen.getByText(/Clone it to/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Delegate/ })).toBeTruthy();
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
    expect(onDelegate).toHaveBeenCalledWith('ember-task', NODE);
    expect(localStorage.getItem(DELEGATE_NODE_STORAGE_KEY)).toBe(NODE);
    await waitFor(() => expect(screen.getByText(/worker 424242/)).toBeTruthy());
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
          startedAtMs: 1000,
        },
      ]),
    );
    const onDelegate = vi.fn();
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={onDelegate} />);
    expect(screen.getByText(/worker 99/)).toBeTruthy();
    expect(screen.getByText(/old\.log/)).toBeTruthy();
    expect(onDelegate).not.toHaveBeenCalled();
  });

  it('replaces the saved line with the live status, without the full log path', async () => {
    seedStartedRecord();
    const onStatusCheck = vi.fn(async () => liveStatus('working'));
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={vi.fn()} onStatusCheck={onStatusCheck} />);
    await waitFor(() => expect(screen.getByText('Green working')).toBeTruthy());
    expect(screen.queryByText(/\/tmp\/old\.log/)).toBeNull();
    expect(screen.getByText(/worker 99/)).toBeTruthy();
    expect(screen.getByText(/2m ago/)).toBeTruthy();
    expect(screen.getByText('old.log')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy log path' })).toBeTruthy();
    expect(onStatusCheck).toHaveBeenCalledWith({ taskSlug: 'ember-task', node: NODE, pid: 99, logPath: '/tmp/old.log' });
  });

  it('shows blocked, done, and stopped statuses concisely, each with Delegate again', async () => {
    for (const [kind, label] of [
      ['blocked', 'Green blocked'],
      ['done', 'Green done'],
      ['stopped', 'Green not running'],
    ] as const) {
      cleanup();
      localStorage.clear();
      localStorage.setItem(DELEGATE_NODE_STORAGE_KEY, NODE);
      seedStartedRecord();
      render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={vi.fn()} onStatusCheck={async () => liveStatus(kind)} />);
      await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
      expect(screen.getByRole('button', { name: /Delegate/ })).toBeTruthy();
    }
  });

  it('shows unknown when the status check fails, keeping the worker detail', async () => {
    seedStartedRecord();
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={vi.fn()} onStatusCheck={async () => null} />);
    await waitFor(() => expect(screen.getByText('Green status unknown')).toBeTruthy());
    expect(screen.getByText(/worker 99/)).toBeTruthy();
  });

  it('does not probe when there is no pid or log path to check', () => {
    seedStartedRecord({ pid: null, logPath: null });
    const onStatusCheck = vi.fn();
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={vi.fn()} onStatusCheck={onStatusCheck} />);
    expect(screen.getByText('Green started')).toBeTruthy();
    expect(onStatusCheck).not.toHaveBeenCalled();
  });

  it('rechecks when Refresh status is clicked', async () => {
    seedStartedRecord();
    const onStatusCheck = vi.fn(async () => liveStatus('working'));
    onStatusCheck.mockResolvedValueOnce(liveStatus('working'));
    onStatusCheck.mockResolvedValueOnce(liveStatus('blocked'));
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={vi.fn()} onStatusCheck={onStatusCheck} />);
    await waitFor(() => expect(screen.getByText('Green working')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(screen.getByText('Green blocked')).toBeTruthy());
    expect(onStatusCheck).toHaveBeenCalledTimes(2);
  });

  it('copies the full log path from the concise line', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    seedStartedRecord();
    render(<DelegateRow taskId="644347" taskSlug="ember-task" onDelegate={vi.fn()} onStatusCheck={async () => liveStatus('working')} />);
    await waitFor(() => expect(screen.getByText('Green working')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Copy log path' }));
    expect(writeText).toHaveBeenCalledWith('/tmp/old.log');
  });
});
