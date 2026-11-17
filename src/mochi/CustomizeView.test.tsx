// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CustomizeView } from './CustomizeView.tsx';
import type { LooksState } from './looks.ts';

const img = (n: number) => `data:image/png;base64,AAAA${n}`;

function setup(practice = false) {
  (window as unknown as { mochiShell: unknown }).mochiShell = {
    generatePet: async () => ({ ok: true, candidates: [0, 1, 2].map((i) => ({ id: `c${i}`, image: img(i), framed: false })) }),
  };
  render(
    <CustomizeView
      looks={{ available: true, practice, looks: [], currentId: null }}
      reviewFrac={0}
      subFrac={0}
      onLooksChange={() => {}}
      onDrawingChange={() => {}}
      onClose={() => {}}
    />,
  );
}

const previewHref = () => document.querySelector('.customize-preview-pet image')?.getAttribute('href');

afterEach(cleanup);

describe('CustomizeView', () => {
  it('previews whichever option is picked', async () => {
    setup();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a cat' } });
    await act(async () => fireEvent.click(screen.getByText('Draw Mochi')));
    expect(previewHref()).toBe(img(0));
    fireEvent.click(screen.getByLabelText('Option 2'));
    expect(screen.getByLabelText('Option 2').getAttribute('aria-pressed')).toBe('true');
    expect(previewHref()).toBe(img(1));
  });

  it('says when the drawings are practice ones', () => {
    setup(true);
    expect(screen.getByText(/Practice drawings/)).toBeTruthy();
    cleanup();
    setup(false);
    expect(screen.queryByText(/Practice drawings/)).toBeNull();
  });

  it('sends the Clerk token with each drawing when signed in through the draw server', async () => {
    const calls: [string, string | undefined][] = [];
    (window as unknown as { mochiShell: unknown }).mochiShell = {
      generatePet: async (text: string, token?: string) => (calls.push([text, token]), { ok: true, candidates: [{ id: 'c0', image: img(0), framed: false }] }),
    };
    render(
      <CustomizeView looks={{ available: true, signIn: true, looks: [], currentId: null }} reviewFrac={0} subFrac={0} onLooksChange={() => {}} onDrawingChange={() => {}} onClose={() => {}} getToken={async () => 'tok'} />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a cat' } });
    await act(async () => fireEvent.click(screen.getByText('Draw Mochi')));
    expect(calls).toEqual([['a cat', 'tok']]);
  });

  it('asks to sign in again instead of drawing when there is no token, and words a non-tester', async () => {
    let result: unknown = { ok: false, error: { kind: 'not_member' } };
    const calls: unknown[] = [];
    (window as unknown as { mochiShell: unknown }).mochiShell = { generatePet: async (...a: unknown[]) => (calls.push(a), result) };
    let token: string | null = null;
    render(
      <CustomizeView looks={{ available: true, signIn: true, looks: [], currentId: null }} reviewFrac={0} subFrac={0} onLooksChange={() => {}} onDrawingChange={() => {}} onClose={() => {}} getToken={async () => token} />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a cat' } });
    await act(async () => fireEvent.click(screen.getByText('Draw Mochi')));
    expect(screen.getByText('Sign in again to draw.')).toBeTruthy();
    expect(calls).toHaveLength(0);
    token = 'tok';
    result = { ok: false, error: { kind: 'not_member' } };
    await act(async () => fireEvent.click(screen.getByText('Draw Mochi')));
    expect(screen.getByText("You're not on Mochi's tester list yet.")).toBeTruthy();
  });
  it('offers to draw the current look\'s moods, sending the token, and says while they are drawn', async () => {
    const calls: unknown[][] = [];
    (window as unknown as { mochiShell: unknown }).mochiShell = {
      drawLookMoods: async (...args: unknown[]) => (calls.push(args), null),
    };
    const look = { id: 'look-1', createdAtMs: 1, prompt: 'a cat', image: img(9) };
    const view = (looks: Partial<LooksState>) => (
      <CustomizeView
        looks={{ available: true, moods: true, looks: [look], currentId: 'look-1', ...looks }}
        reviewFrac={0}
        subFrac={0}
        onLooksChange={() => {}}
        onDrawingChange={() => {}}
        onClose={() => {}}
        getToken={async () => 'tok'}
      />
    );
    const { rerender } = render(view({}));
    await act(async () => fireEvent.click(screen.getByText('Draw its moods')));
    expect(calls).toEqual([['look-1', 'tok']]);
    rerender(view({ drawingMoods: ['look-1'] }));
    expect(screen.getByRole('status').textContent).toMatch(/Drawing its moods/);
    const drawn = { ...look, moods: { happy: img(1), sleepy: img(2), nervous: img(3), focused: img(4) } };
    rerender(view({ looks: [drawn], drawingMoods: [] }));
    expect(screen.queryByText('Draw its moods')).toBeNull();
    rerender(view({ moods: false }));
    expect(screen.queryByText('Draw its moods')).toBeNull();
  });
});

