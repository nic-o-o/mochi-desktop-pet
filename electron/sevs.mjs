/* Codimango SEVs for the bubble and the panel line: open ones affect task
 * submission, validation and reviews, so Mochi says so (and says when they are
 * mitigated). Read through the `meta` CLI with the user's own login every ten
 * minutes. Filtering happens here, so private or security SEVs never reach the
 * renderer. A failed read keeps the last list and stays quiet.
 */

import { execFile } from 'node:child_process';

export const SEV_POLL_MS = 10 * 60_000;
/* GUI apps on macOS don't inherit the shell PATH, so use the absolute path. */
export const META_BIN = process.env.MOCHI_META_BIN ?? '/opt/facebook/bin/meta';

/** Open SEVs this old or newer show in the panel; older ones are left to SEV Manager. */
export const OPEN_WINDOW_MS = 7 * 24 * 3_600_000;
/** A mitigated SEV stays in the list this long, so Mochi can say it's fixed. */
export const MITIGATED_WINDOW_MS = 24 * 3_600_000;

const CLOSED = new Set(['Mitigated', 'Cleanup', 'Closed']);
/* Titles that describe a security hole or personal data: not for a bubble on a shared screen. */
const SENSITIVE =
  /secur|vulnerab|exploit|exposed|leak|token|credential|secret|password|\bacls?\b|permission|\bpii\b|privacy|unreviewed code|access to production/i;
const SEV_URL = /^https:\/\/www\.internalfb\.com\/sevmanager\/view\/\d+$/;

/** The CLI can print a hint after its JSON; read just the first JSON value. */
export function leadingJson(text) {
  const s = String(text);
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** "[codimango] X" and "Codimango: X" read as just "X" under a "Codimango SEV" heading. */
function shortTitle(title) {
  return title.replace(/^\s*(\[[^\]]*codimango[^\]]*\]|codimango\s*:)\s*/i, '').trim();
}

/** Raw `sevmanager.sev list` rows → what Mochi shows. */
export function pickSevs(rows, nowMs) {
  const sevs = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const title = String(r?.title ?? '').trim();
    const level = Number(r?.level);
    const id = String(r?.sev_number ?? '');
    if (!/^S\d+$/.test(id) || !/codimango/i.test(title) || SENSITIVE.test(title)) continue;
    if (r.visibility !== 'PUBLIC' || !(level >= 1 && level <= 3)) continue;
    const createdAtMs = Date.parse(r.created);
    const mitigatedAtMs = Date.parse(r.time_mitigated);
    const open = !CLOSED.has(r.status);
    if (!Number.isFinite(createdAtMs)) continue;
    if (open ? nowMs - createdAtMs > OPEN_WINDOW_MS : !(nowMs - mitigatedAtMs <= MITIGATED_WINDOW_MS)) continue;
    sevs.push({
      id,
      level,
      open,
      title: shortTitle(title).slice(0, 200),
      url: SEV_URL.test(r.url) ? r.url : `https://www.internalfb.com/sevmanager/view/${id.slice(1)}`,
      createdAtMs,
      ...(Number.isFinite(mitigatedAtMs) ? { mitigatedAtMs } : {}),
    });
  }
  /* Most severe first, then newest. */
  return sevs.sort((a, b) => a.level - b.level || b.createdAtMs - a.createdAtMs);
}

const LIST_ARGS = [
  'sevmanager.sev',
  'list',
  '--title-contains=codimango',
  '--created-after=8 days ago',
  '--limit=50',
  '--columns=sev_number,level,status,visibility,created,time_mitigated,url,title',
  '--output=json',
];

function readSevRows() {
  return new Promise((resolve) => {
    execFile(META_BIN, LIST_ARGS, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const parsed = err ? null : leadingJson(stdout);
      const rows = Array.isArray(parsed) ? parsed : parsed?.data;
      resolve(Array.isArray(rows) ? rows : { error: err?.code ?? 'unreadable' });
    });
  });
}

export function createSevWatch({ read = readSevRows, now = Date.now, onChange = () => {}, pollMs = SEV_POLL_MS } = {}) {
  let sevs = [];
  let warned = false;
  let timer = null;
  async function refresh() {
    const rows = await read();
    if (!Array.isArray(rows)) {
      if (!warned) console.warn(`[mochi] couldn't read Codimango SEVs (${rows?.error ?? 'error'}); keeping the last list`);
      warned = true;
      return sevs;
    }
    warned = false;
    const next = pickSevs(rows, now());
    if (JSON.stringify(next) !== JSON.stringify(sevs)) {
      sevs = next;
      onChange(sevs);
    }
    return sevs;
  }
  return {
    list: () => sevs,
    refresh,
    start() {
      void refresh();
      timer = setInterval(() => void refresh(), pollMs);
      timer.unref?.();
    },
    stop: () => clearInterval(timer),
  };
}
