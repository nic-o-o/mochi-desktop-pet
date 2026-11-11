/* Saved pet looks (main process): userData/pet-looks/.
 *
 * One folder per look holding look.json ({ id, createdAtMs, prompt }) and
 * base.png (the sprite), plus a `current` file naming the active look; no file
 * (or "classic") means the classic Mochi. The prompt stays on this Mac so "My
 * Mochis" can show it; it is never logged. A look that can't be read is
 * skipped, and a current look that can't be read falls back to classic.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_LOOKS = 30;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const LOOK_ID = /^look-[0-9a-f-]{36}$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const isLookId = (id) => typeof id === 'string' && LOOK_ID.test(id);
export const isPng = (buf) => Buffer.isBuffer(buf) && buf.length > 8 && buf.length <= MAX_PNG_BYTES && buf.subarray(0, 8).equals(PNG_MAGIC);
const dataUrl = (png) => `data:image/png;base64,${png.toString('base64')}`;

/** PNG bytes from a `data:image/png;base64,` URL, or null. */
export function pngFromDataUrl(url) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(url ?? ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  return isPng(buf) ? buf : null;
}

export function createLookStore(root, { fsImpl = fs, now = Date.now, newId = () => `look-${randomUUID()}` } = {}) {
  fsImpl.mkdirSync(root, { recursive: true });
  const currentFile = path.join(root, 'current');
  const dirOf = (id) => path.join(root, id);

  function read(id) {
    if (!isLookId(id)) return null;
    try {
      const meta = JSON.parse(fsImpl.readFileSync(path.join(dirOf(id), 'look.json'), 'utf8'));
      const png = fsImpl.readFileSync(path.join(dirOf(id), 'base.png'));
      if (meta?.id !== id || !isPng(png)) return null;
      return { id, createdAtMs: Number(meta.createdAtMs) || 0, prompt: String(meta.prompt ?? ''), image: dataUrl(png) };
    } catch {
      return null;
    }
  }

  function currentId() {
    try {
      const id = fsImpl.readFileSync(currentFile, 'utf8').trim();
      return isLookId(id) ? id : null;
    } catch {
      return null;
    }
  }

  /** Every readable look, newest first. */
  function list() {
    let names = [];
    try {
      names = fsImpl.readdirSync(root);
    } catch {
      return [];
    }
    return names
      .map(read)
      .filter(Boolean)
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  /** The active look, or null for classic (also when the saved one can't be read). */
  function current() {
    const id = currentId();
    if (!id) return null;
    const look = read(id);
    if (!look) fsImpl.rmSync(currentFile, { force: true });
    return look;
  }

  function state() {
    const cur = current();
    return { looks: list(), currentId: cur?.id ?? null };
  }

  return {
    list,
    current,
    state,
    /** Save a sprite as a new look (oldest dropped past MAX_LOOKS); resolves its id, or null for a bad image. */
    save({ prompt, png }) {
      if (!isPng(png)) return null;
      const id = newId();
      fsImpl.mkdirSync(dirOf(id), { recursive: true });
      fsImpl.writeFileSync(path.join(dirOf(id), 'base.png'), png);
      fsImpl.writeFileSync(
        path.join(dirOf(id), 'look.json'),
        JSON.stringify({ id, createdAtMs: now(), prompt: String(prompt ?? '').slice(0, 200) }),
      );
      const keep = new Set([currentId(), id]);
      for (const old of list().slice(MAX_LOOKS)) if (!keep.has(old.id)) fsImpl.rmSync(dirOf(old.id), { recursive: true, force: true });
      return id;
    },
    /** Make a look the pet, or null for classic. Unknown ids change nothing. */
    setCurrent(id) {
      if (id === null) fsImpl.rmSync(currentFile, { force: true });
      else if (read(id)) fsImpl.writeFileSync(currentFile, id);
      return state();
    },
    remove(id) {
      if (!isLookId(id)) return state();
      if (currentId() === id) fsImpl.rmSync(currentFile, { force: true });
      fsImpl.rmSync(dirOf(id), { recursive: true, force: true });
      return state();
    },
  };
}
