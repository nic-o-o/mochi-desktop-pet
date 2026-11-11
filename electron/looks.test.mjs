import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_LOOKS, createLookStore, isLookId, pngFromDataUrl } from './looks.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-png')]);
let n = 0;
const make = (root = fs.mkdtempSync(path.join(os.tmpdir(), 'looks-'))) => {
  let t = 1000;
  return {
    root,
    store: createLookStore(root, {
      now: () => (t += 1000),
      newId: () => `look-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    }),
  };
};

describe('look store', () => {
  it('saves a look, makes it current, lists newest first, and survives a restart', () => {
    const { root, store } = make();
    const a = store.save({ prompt: 'orange cat', png: PNG });
    const b = store.save({ prompt: 'blue bunny', png: PNG });
    expect(store.setCurrent(a)).toMatchObject({ currentId: a });
    expect(store.list().map((l) => l.prompt)).toEqual(['blue bunny', 'orange cat']);
    expect(store.list()[0].image.startsWith('data:image/png;base64,')).toBe(true);
    const again = createLookStore(root);
    expect(again.current()?.id).toBe(a);
    expect(again.list().map((l) => l.id)).toEqual([b, a]);
  });

  it('refuses images that are not PNGs and ids that are not look ids', () => {
    const { store } = make();
    expect(store.save({ prompt: 'x', png: Buffer.from('GIF89a...') })).toBeNull();
    expect(store.setCurrent('../../etc')).toMatchObject({ currentId: null });
    expect(isLookId('look-../x')).toBe(false);
  });

  it('falls back to classic when the current look is corrupt, and skips it in the list', () => {
    const { root, store } = make();
    const a = store.save({ prompt: 'x', png: PNG });
    store.setCurrent(a);
    fs.writeFileSync(path.join(root, a, 'look.json'), '{not json');
    expect(store.current()).toBeNull();
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(path.join(root, 'current'))).toBe(false);
  });

  it('reset to classic and delete; deleting the current look resets too', () => {
    const { store } = make();
    const a = store.save({ prompt: 'x', png: PNG });
    store.setCurrent(a);
    expect(store.setCurrent(null).currentId).toBeNull();
    store.setCurrent(a);
    expect(store.remove(a)).toEqual({ looks: [], currentId: null });
  });

  it(`keeps at most ${MAX_LOOKS} looks, never dropping the current one`, () => {
    const { store } = make();
    const first = store.save({ prompt: 'first', png: PNG });
    store.setCurrent(first);
    for (let i = 0; i < MAX_LOOKS + 2; i++) store.save({ prompt: `p${i}`, png: PNG });
    const ids = store.list().map((l) => l.id);
    expect(ids.length).toBeLessThanOrEqual(MAX_LOOKS + 1);
    expect(ids).toContain(first);
  });

  it('reads PNG data URLs and rejects anything else', () => {
    expect(pngFromDataUrl(`data:image/png;base64,${PNG.toString('base64')}`)?.equals(PNG)).toBe(true);
    expect(pngFromDataUrl('data:text/html;base64,PGI+')).toBeNull();
  });
});
