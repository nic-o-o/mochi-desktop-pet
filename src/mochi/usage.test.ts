import { afterEach, describe, expect, it, vi } from 'vitest';

describe('elapsedMs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete (globalThis as { window?: unknown }).window;
  });

  it('subtracts time the screen was locked', async () => {
    let lock: ((locked: boolean) => void) | undefined;
    (globalThis as { window?: unknown }).window = {
      mochiShell: { onScreenLock: (cb: (locked: boolean) => void) => ((lock = cb), () => {}) },
    };
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { elapsedMs, mark } = await import('./usage.ts');

    const m = mark();
    now = 6_000; // 5 s visible
    lock!(true);
    now = 66_000; // locked for a minute
    lock!(false);
    now = 68_000; // 2 s visible
    expect(elapsedMs(m)).toBe(7_000);
  });

  it('counts a lock that is still on up to now', async () => {
    let lock: ((locked: boolean) => void) | undefined;
    (globalThis as { window?: unknown }).window = {
      mochiShell: { onScreenLock: (cb: (locked: boolean) => void) => ((lock = cb), () => {}) },
    };
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { elapsedMs, mark } = await import('./usage.ts');

    const m = mark();
    now = 3_000;
    lock!(true);
    now = 10_000;
    expect(elapsedMs(m)).toBe(3_000);
  });
});
