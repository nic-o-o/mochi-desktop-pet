/* One-time copy of the renderer's saved state to its new address (main process only).
 *
 * Browser storage belongs to the page's origin. Packaged builds used to load
 * from file://, and now load from mochi://renderer (rendererProtocol.mjs), so
 * on the first launch after that upgrade the renderer would start empty: goals,
 * the review-study install date, sections, notification settings, the pet's
 * position, delegations, the devserver. Before the pet window opens, this
 * reads every `mochi.` key from a blank file:// page and writes it on a blank
 * mochi://renderer page, overwriting what's there, then leaves a marker so it
 * never runs again. A failure is logged and retried on the next launch; it
 * never blocks the app.
 */

export const MARKER_FILE = 'renderer-storage-migrated.json';

/** Runs in the old origin: its `mochi.` keys, as JSON. */
export const READ_LEGACY = `JSON.stringify(Object.fromEntries(Object.keys(localStorage)
  .filter((k) => k.startsWith('mochi.')).map((k) => [k, localStorage.getItem(k)])))`;

/** Runs in the new origin: writes these entries, returns how many. */
export function writeEntries(entries) {
  return `(() => { const e = ${JSON.stringify(entries)}; for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v); return Object.keys(e).length; })()`;
}

/**
 * Copy once. `openHidden(url)` opens an invisible page and resolves to
 * `{ run(js), close() }`; `fs` is node:fs/promises.
 */
export async function migrateRendererStorage({ markerPath, legacyUrl, targetUrl, openHidden, fs, log = () => {} }) {
  try {
    await fs.access(markerPath);
    return { migrated: false, reason: 'done before' };
  } catch {
    /* no marker: first launch on the new address */
  }
  let entries = {};
  let page;
  try {
    page = await openHidden(legacyUrl);
    const raw = await page.run(READ_LEGACY);
    const parsed = JSON.parse(typeof raw === 'string' ? raw : '{}');
    for (const [k, v] of Object.entries(parsed && typeof parsed === 'object' ? parsed : {})) {
      if (k.startsWith('mochi.') && typeof v === 'string') entries[k] = v;
    }
  } catch (err) {
    log(`[mochi] storage migration: couldn't read the old storage (${err?.message ?? err}); will retry next launch`);
    return { migrated: false, reason: 'read failed' };
  } finally {
    page?.close();
  }
  const keys = Object.keys(entries).length;
  if (keys) {
    let target;
    try {
      target = await openHidden(targetUrl);
      await target.run(writeEntries(entries));
    } catch (err) {
      log(`[mochi] storage migration: couldn't write ${keys} keys (${err?.message ?? err}); will retry next launch`);
      return { migrated: false, reason: 'write failed' };
    } finally {
      target?.close();
    }
  }
  await fs.writeFile(markerPath, JSON.stringify({ from: 'file://', keys, at: new Date().toISOString() }));
  log(`[mochi] storage migration: copied ${keys} saved settings to the new renderer address`);
  return { migrated: true, keys };
}
