// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TalkBox } from './TalkBox.tsx';
import { resetTalkThread } from './talkThread.ts';
import type { AskResult } from './shell.ts';

afterEach(() => {
  cleanup();
  resetTalkThread();
});

const context = { reviews: 2, revisions: 1, drafts: 0 };

function say(text: string) {
  fireEvent.change(screen.getByLabelText('Message to Mochi'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

describe('TalkBox', () => {
  it('shows what you said, Mochi thinking, then the answer; sends counts, not names', async () => {
    let answer!: (r: AskResult) => void;
    const ask = vi.fn(() => new Promise<AskResult>((r) => (answer = r)));
    render(<TalkBox context={context} ask={ask} onOpenLink={() => {}} />);
    say('hi Mochi');
    expect(screen.getByText('hi Mochi')).toBeTruthy();
    expect(screen.getByLabelText('Mochi is thinking')).toBeTruthy();
    expect(ask).toHaveBeenCalledWith('hi Mochi', context);
    await act(async () => answer({ kind: 'answer', text: 'Hi! Two reviews are waiting.' }));
    expect(screen.getByText('Hi! Two reviews are waiting.')).toBeTruthy();
    expect(screen.queryByLabelText('Mochi is thinking')).toBeNull();
  });

  it('offers the permission page when Metamate 3 access is missing', async () => {
    const onOpenLink = vi.fn();
    const ask = vi.fn(async (): Promise<AskResult> => ({
      kind: 'access_needed',
      message: 'Mochi needs your OK to use Metamate 3 first.',
      fix: 'https://agentcloud.internalmeta.com/authorize',
    }));
    render(<TalkBox context={context} ask={ask} onOpenLink={onOpenLink} />);
    await act(async () => say('hi'));
    expect(screen.getByText(/needs your OK/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Give permission' }));
    expect(onOpenLink).toHaveBeenCalledWith('https://agentcloud.internalmeta.com/authorize');
  });

  it("doesn't send an empty message", () => {
    const ask = vi.fn();
    render(<TalkBox context={context} ask={ask} onOpenLink={() => {}} />);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    say('   ');
    expect(ask).not.toHaveBeenCalled();
  });

  it('keeps the chat when the panel closes and reopens', async () => {
    const ask = vi.fn(async (): Promise<AskResult> => ({ kind: 'answer', text: 'Still here!' }));
    const first = render(<TalkBox context={context} ask={ask} onOpenLink={() => {}} />);
    await act(async () => say('you there?'));
    first.unmount();
    render(<TalkBox context={context} ask={ask} onOpenLink={() => {}} />);
    expect(screen.getByText('Still here!')).toBeTruthy();
  });
});
