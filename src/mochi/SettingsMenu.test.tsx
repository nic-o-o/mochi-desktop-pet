// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsMenu } from './OverviewPanel.tsx';
import { DELEGATE_NODE_STORAGE_KEY } from './delegations.ts';

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as unknown as { mochiShell?: unknown }).mochiShell;
});

describe('SettingsMenu', () => {
  it('shows the saved devserver; Change reopens it for editing, and Save stores a valid one', async () => {
    localStorage.setItem(DELEGATE_NODE_STORAGE_KEY, 'devvm6833.dkl0.facebook.com');
    await act(async () => {
      render(<SettingsMenu open onOpenChange={() => {}} />);
    });
    expect(screen.getByText('Devserver: devvm6833')).toBeTruthy();
    fireEvent.click(screen.getByText('Change'));
    expect(localStorage.getItem(DELEGATE_NODE_STORAGE_KEY)).toBeNull();
    const input = screen.getByLabelText('Devserver') as HTMLInputElement;
    expect(input.value).toBe('devvm6833.dkl0.facebook.com');
    fireEvent.change(input, { target: { value: 'not a node!!' } });
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: ' DEVVM7438.hil0.facebook.com ' } });
    fireEvent.click(screen.getByText('Save'));
    expect(localStorage.getItem(DELEGATE_NODE_STORAGE_KEY)).toBe('devvm7438.hil0.facebook.com');
    expect(screen.getByText('Devserver: devvm7438')).toBeTruthy();
  });

  it('hides Open at login when it cannot be set here, and toggles Share usage data', async () => {
    const calls: [string, boolean][] = [];
    (window as unknown as { mochiShell: unknown }).mochiShell = {
      appSettings: async () => ({ openAtLogin: null, sharing: true }),
      setAppSetting: async (key: string, value: boolean) => (calls.push([key, value]), { openAtLogin: null, sharing: value }),
    };
    await act(async () => {
      render(<SettingsMenu open onOpenChange={() => {}} />);
    });
    expect(screen.queryByText('Open at login')).toBeNull();
    const box = screen.getByLabelText('Share usage data') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => {
      fireEvent.click(box);
    });
    expect(calls).toEqual([['sharing', false]]);
    expect((screen.getByLabelText('Share usage data') as HTMLInputElement).checked).toBe(false);
  });
});
