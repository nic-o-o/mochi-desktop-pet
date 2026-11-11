// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CustomizeView } from './CustomizeView.tsx';

const img = (n: number) => `data:image/png;base64,AAAA${n}`;

function setup() {
  (window as unknown as { mochiShell: unknown }).mochiShell = {
    generatePet: async () => ({ ok: true, candidates: [0, 1, 2].map((i) => ({ id: `c${i}`, image: img(i), framed: false })) }),
  };
  render(
    <CustomizeView
      looks={{ available: true, looks: [], currentId: null }}
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
});
