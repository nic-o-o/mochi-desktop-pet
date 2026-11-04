/* Scuba sender (logging plan): ship events.jsonl rows through logger_cat.
 *
 * Local-only until LOGGER_CONFIG is set to Debra's codegen'd
 * AaiMochiEventsLoggerConfig; with it null every flush is a no-op and no
 * subprocess ever runs. Sharing is opt-out (toggle in the Dock menu,
 * persisted in userData): nothing ships while it is off.
 *
 * Queue rule from the plan: buffer new lines, send one batch, drop on
 * failure (the offset advances either way so a bad batch never retries
 * forever). Position is a byte offset plus the max event time, so a rotated
 * file resends only rows newer than what already shipped.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/* Set once the LoggerConfig codegen lands; null keeps every Mac local-only. */
export const LOGGER_CONFIG = null;
export const LOGGER_BIN = process.env.MOCHI_LOGGER_BIN ?? 'logger_cat';
export const FLUSH_MS = 10 * 60_000;
const SEND_TIMEOUT_MS = 30_000;

export function senderStateFile(userDataDir) {
  return path.join(userDataDir, 'sharing.json');
}

function normalizeSent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { ino, offset, maxTime } = raw;
  if (typeof ino !== 'number' || typeof offset !== 'number' || typeof maxTime !== 'number') return null;
  return { ino, offset, maxTime };
}

export function loadSharing(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(senderStateFile(userDataDir), 'utf8'));
    const sent = normalizeSent(raw.sent);
    return { sharing: raw.sharing !== false, sent };
  } catch {
    return { sharing: true, sent: null };
  }
}

function saveState(userDataDir, state) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(senderStateFile(userDataDir), JSON.stringify(state));
}

export function setSharing(userDataDir, sharing) {
  const state = { ...loadSharing(userDataDir), sharing };
  saveState(userDataDir, state);
  return state;
}

/** New event lines since `sent`, with the state that covers the whole file. */
export function collectNewLines(logFile, sent) {
  let stat = null;
  try {
    stat = fs.statSync(logFile);
  } catch {
    return { lines: [], sent };
  }
  let text = '';
  try {
    const fd = fs.openSync(logFile, 'r');
    try {
      const start = sent && sent.ino === stat.ino ? sent.offset : 0;
      const size = Math.max(0, stat.size - start);
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { lines: [], sent };
  }
  /* Same file: the byte offset is exact, take everything past it. Rotated
     file: take only rows newer than what already shipped. */
  const sameFile = sent?.ino === stat.ino;
  const floor = sameFile ? -Infinity : (sent?.maxTime ?? -Infinity);
  const lines = [];
  let max = sent?.maxTime ?? -Infinity;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let event = null;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Date.parse(event.time);
    if (!Number.isFinite(t) || t <= floor) continue;
    if (t > max) max = t;
    lines.push(line);
  }
  const next = { ino: stat.ino, offset: stat.size, maxTime: max };
  return { lines, sent: next };
}

function defaultRun(args, stdin) {
  return new Promise((resolve) => {
    const child = spawn(LOGGER_BIN, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), SEND_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    try {
      child.stdin.write(stdin);
      child.stdin.end();
    } catch {
      resolve(false);
    }
  });
}

/**
 * Ship new rows. Returns { shipped, dropped }: failures advance past the
 * batch (dropped) instead of retrying, per the plan. Never throws.
 */
export async function flushSender({ logFile, userDataDir, logger = LOGGER_CONFIG, run = defaultRun }) {
  const state = loadSharing(userDataDir);
  if (!state.sharing) return { shipped: 0, dropped: 0, reason: 'opted-out' };
  if (!logger) return { shipped: 0, dropped: 0, reason: 'no-config' };
  const { lines, sent } = collectNewLines(logFile, state.sent);
  if (lines.length === 0) {
    if (sent !== state.sent) saveState(userDataDir, { ...state, sent });
    return { shipped: 0, dropped: 0, reason: 'empty' };
  }
  let ok = false;
  try {
    ok = await run(['--logger', logger, '--input-format', 'json-lines'], `${lines.join('\n')}\n`);
  } catch {
    ok = false;
  }
  saveState(userDataDir, { ...state, sent });
  if (!ok) console.warn(`[mochi] sender dropped ${lines.length} rows (logger_cat failed)`);
  return ok ? { shipped: lines.length, dropped: 0 } : { shipped: 0, dropped: lines.length };
}
