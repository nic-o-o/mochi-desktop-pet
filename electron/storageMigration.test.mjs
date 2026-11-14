import { describe, expect, it } from 'vitest';
import { READ_LEGACY, migrateRendererStorage, writeEntries } from './storageMigration.mjs';

/* Two fake origins, each with its own storage, run by evaluating the scripts the migration sends. */
function fakePages(stores, { failOn } = {}) {
  const opened = [];
  const openHidden = async (url) => {
    if (failOn === url) throw new Error('load failed');
    const store = (stores[url] ??= new Map());
    const page = {
      closed: false,
      // Like the browser's localStorage: stored keys are its own enumerable properties.
      run: async (js) => {
        const ls = Object.fromEntries(store);
        Object.defineProperty(ls, 'getItem', { value: (k) => (store.has(k) ? store.get(k) : null) });
        Object.defineProperty(ls, 'setItem', { value: (k, v) => store.set(k, String(v)) });
        return new Function('localStorage', `return (${js});`)(ls);
      },
      close() {
        this.closed = true;
      },
    };
    opened.push({ url, page });
    return page;
  };
  return { openHidden, opened };
}

function fakeFs(files = {}) {
  return {
    files,
    access: async (p) => { if (!(p in files)) throw new Error('ENOENT'); },
    writeFile: async (p, data) => { files[p] = data; },
  };
}

const LEGACY = 'file:///app/electron/legacy-storage.html';
const TARGET = 'mochi://renderer/__storage';

describe('migrateRendererStorage', () => {
  it('copies every mochi. key from file:// to mochi://renderer, overwriting, once', async () => {
    const stores = {
      [LEGACY]: new Map([['mochi.study.v1', '{"installedAt":1}'], ['mochi.delegate-node.v1', 'devvm6833'], ['other', 'x']]),
      [TARGET]: new Map([['mochi.study.v1', '{"installedAt":999}'], ['mochi.petPos.v1', '{"x":1}']]),
    };
    const { openHidden, opened } = fakePages(stores);
    const fs = fakeFs();
    const res = await migrateRendererStorage({ markerPath: '/u/marker', legacyUrl: LEGACY, targetUrl: TARGET, openHidden, fs });
    expect(res).toEqual({ migrated: true, keys: 2 });
    expect(Object.fromEntries(stores[TARGET])).toEqual({
      'mochi.study.v1': '{"installedAt":1}', // the real install date wins over a fresh one
      'mochi.delegate-node.v1': 'devvm6833',
      'mochi.petPos.v1': '{"x":1}',
    });
    expect(opened.every((o) => o.page.closed)).toBe(true);
    expect(JSON.parse(fs.files['/u/marker'])).toMatchObject({ from: 'file://', keys: 2 });

    const again = await migrateRendererStorage({ markerPath: '/u/marker', legacyUrl: LEGACY, targetUrl: TARGET, openHidden, fs });
    expect(again).toEqual({ migrated: false, reason: 'done before' });
    expect(opened).toHaveLength(2);
  });

  it('marks a fresh install done without opening the new origin', async () => {
    const { openHidden, opened } = fakePages({});
    const fs = fakeFs();
    expect(await migrateRendererStorage({ markerPath: '/m', legacyUrl: LEGACY, targetUrl: TARGET, openHidden, fs })).toEqual({ migrated: true, keys: 0 });
    expect(opened.map((o) => o.url)).toEqual([LEGACY]);
    expect(fs.files['/m']).toBeTruthy();
  });

  it('leaves no marker when a page fails, so the next launch retries', async () => {
    const logs = [];
    for (const failOn of [LEGACY, TARGET]) {
      const { openHidden } = fakePages({ [LEGACY]: new Map([['mochi.goals.v3', '[]']]) }, { failOn });
      const fs = fakeFs();
      const res = await migrateRendererStorage({ markerPath: '/m', legacyUrl: LEGACY, targetUrl: TARGET, openHidden, fs, log: (l) => logs.push(l) });
      expect(res.migrated).toBe(false);
      expect(fs.files).toEqual({});
    }
    expect(logs.join('\n')).toContain('will retry next launch');
  });

  it('sends scripts that survive quotes and newlines in saved values', async () => {
    const tricky = { 'mochi.x': 'a"b\'c\n</script> ' };
    const store = new Map();
    const run = (js) => new Function('localStorage', `return (${js});`)({ setItem: (k, v) => store.set(k, v) });
    expect(run(writeEntries(tricky))).toBe(1);
    expect(store.get('mochi.x')).toBe(tricky['mochi.x']);
    expect(READ_LEGACY).toContain("startsWith('mochi.')");
  });
});
