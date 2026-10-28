/* "Report a Problem…" (Dock menu and the panel's ≡ menu): copy a diagnostics
 * block to the clipboard, then open the Mochi dogfood chat space so the tester
 * can describe the problem and paste it. No task names or review text: the
 * renderer sends only status, counts and the last refresh time, and the log
 * holds counts and errors.
 */
import fs from 'node:fs';

/* Override with MOCHI_REPORT_URL for testing. */
export const REPORT_URL = process.env.MOCHI_REPORT_URL ?? 'https://chat.google.com/';
const TAIL_LINES = 50;

/** Last lines of Mochi's log file, or a note when there isn't one (dev runs). */
export function logTail(file, lines = TAIL_LINES) {
  try {
    const text = fs.readFileSync(file, 'utf8').trimEnd();
    return text ? text.split('\n').slice(-lines).join('\n') : '(log is empty)';
  } catch {
    return '(no log file: dev run, or nothing logged yet)';
  }
}

function since(ms, nowMs) {
  const mins = Math.max(0, Math.floor((nowMs - ms) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * The block testers paste. `state` comes from the renderer:
 * { build, status, failureKind, fetchedAtMs, counts: { reviews, revisions, drafts } }.
 */
export function diagnostics({ state, appVersion, osVersion, arch, log, nowMs = Date.now() }) {
  const s = state ?? {};
  const refreshed = typeof s.fetchedAtMs === 'number'
    ? `${new Date(s.fetchedAtMs).toISOString().replace('T', ' ').slice(0, 16)} UTC (${since(s.fetchedAtMs, nowMs)})`
    : 'never';
  const c = s.counts ?? {};
  return [
    '--- Mochi diagnostics (paste under your description) ---',
    `Mochi: build ${s.build ?? 'unknown'}, app ${appVersion}`,
    `macOS: ${osVersion} (${arch})`,
    `Data: ${s.status ?? 'unknown'}${s.failureKind ? ` (last error: ${s.failureKind})` : ''}, last refresh ${refreshed}`,
    `Panel: ${c.reviews ?? '?'} to review, ${c.revisions ?? '?'} revisions, ${c.drafts ?? '?'} drafts`,
    'Recent log:',
    log,
    '--- end ---',
  ].join('\n');
}
