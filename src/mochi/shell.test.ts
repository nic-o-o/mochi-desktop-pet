import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDisplayBounds,
  isDesktopShell,
  isShellMode,
  onDisplayChanged,
  onSimulateNotification,
  openLink,
  syncBounds,
} from './shell.ts';
import type { BoundsRect } from './shell.ts';

afterEach(() => {
  // @ts-expect-error test cleanup: remove the fake browser global
  delete globalThis.window;
  vi.unstubAllGlobals();
});

function fakeBridge() {
  const synced: BoundsRect[] = [];
  const listeners: Record<string, Array<() => void>> = {
    display: [],
    simulate: [],
  };
  return {
    synced,
    listeners,
    bridge: {
      getDisplayBounds: () =>
        Promise.resolve({ x: 0, y: 0, width: 1280, height: 800 }),
      onDisplayChanged: (cb: () => void) => {
        listeners.display.push(cb);
        return () => {};
      },
      onSimulateNotification: (cb: () => void) => {
        listeners.simulate.push(cb);
        return () => {};
      },
      syncBounds: (rect: BoundsRect) => {
        synced.push(rect);
      },
    },
  };
}

describe('desktop shell bridge', () => {
  it('is inactive in a plain browser/Node (no bridge exposed)', () => {
    expect(isDesktopShell()).toBe(false);
    expect(isShellMode()).toBe(false);
    expect(() => syncBounds({ x: 0, y: 0, width: 10, height: 10 })).not.toThrow();
    expect(onDisplayChanged(() => {})).toEqual(expect.any(Function));
  });

  it('detects shell mode from the query string, independent of the bridge', () => {
    vi.stubGlobal('window', { location: { search: '?mochi-shell=1' } });
    expect(isShellMode()).toBe(true);
    expect(isDesktopShell()).toBe(false);
    expect(() => syncBounds({ x: 0, y: 0, width: 10, height: 10 })).not.toThrow();
  });

  it('forwards bounds syncs and display info, and fires subscriptions', async () => {
    const fake = fakeBridge();
    vi.stubGlobal('window', {
      location: { search: '' },
      mochiShell: fake.bridge,
    });
    expect(isDesktopShell()).toBe(true);
    syncBounds({ x: 5, y: 6, width: 200, height: 230 });
    expect(fake.synced).toEqual([{ x: 5, y: 6, width: 200, height: 230 }]);
    await expect(getDisplayBounds()).resolves.toEqual({ x: 0, y: 0, width: 1280, height: 800 });

    let changed = 0;
    let simulated = 0;
    const offDisplay = onDisplayChanged(() => {
      changed += 1;
    });
    const offSimulate = onSimulateNotification(() => {
      simulated += 1;
    });
    fake.listeners.display.forEach((cb) => cb());
    fake.listeners.simulate.forEach((cb) => cb());
    expect(changed).toBe(1);
    expect(simulated).toBe(1);
    expect(offDisplay).toEqual(expect.any(Function));
    expect(offSimulate).toEqual(expect.any(Function));
  });

  it('opens Codimango pages through the bridge, or a new tab in a plain browser', () => {
    const opened: string[] = [];
    vi.stubGlobal('window', {
      location: { search: '' },
      mochiShell: { openLink: (url: string) => (opened.push(url), Promise.resolve(true)) },
    });
    openLink('https://codimango.internalmeta.com/reviews/1');
    expect(opened).toEqual(['https://codimango.internalmeta.com/reviews/1']);

    const tabs: string[] = [];
    vi.stubGlobal('window', { location: { search: '' }, open: (url: string) => tabs.push(url) });
    openLink('https://codimango.internalmeta.com/submissions/2');
    expect(tabs).toEqual(['https://codimango.internalmeta.com/submissions/2']);
  });
});
