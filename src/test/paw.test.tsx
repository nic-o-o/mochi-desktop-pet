// @vitest-environment jsdom
/* The paw (Mochi hidden) drags like the pet: a drag moves where Mochi comes back, a click restores. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import App from '../App.tsx';
import { PET_POS_STORAGE_KEY } from '../mochi/mockData.ts';

const saved = () => JSON.parse(localStorage.getItem(PET_POS_STORAGE_KEY) ?? 'null') as { x: number; y: number };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(PET_POS_STORAGE_KEY, JSON.stringify({ x: 300, y: 200 }));
});
afterEach(cleanup);

it('drags the paw without restoring, then a click restores Mochi at the new spot', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Hide Mochi' }));
  const paw = screen.getByRole('button', { name: 'Show Mochi' });

  fireEvent.pointerDown(paw, { pointerId: 1, clientX: 50, clientY: 50 });
  fireEvent.pointerMove(paw, { pointerId: 1, clientX: 110, clientY: 90 });
  fireEvent.pointerUp(paw, { pointerId: 1, clientX: 110, clientY: 90 });
  fireEvent.click(paw);

  expect(screen.queryByRole('button', { name: 'Show Mochi' })).not.toBeNull(); // still hidden
  expect(saved()).toEqual({ x: 360, y: 240 });

  fireEvent.click(screen.getByRole('button', { name: 'Show Mochi' }));
  expect(screen.queryByRole('button', { name: 'Show Mochi' })).toBeNull();
  expect(saved()).toEqual({ x: 360, y: 240 });
});
