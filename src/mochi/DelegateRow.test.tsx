// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegateRow } from './DelegateRow.tsx';
import { DELEGATIONS_STORAGE_KEY } from './delegations.ts';
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

beforeEach(() => {
  localStorage.clear();
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
    expect(onDelegate).toHaveBeenCalledWith('ember-task');
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
});
