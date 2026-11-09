/* Scuba sender (logging plan): ship events.jsonl rows through logger_cat.
 *
 * Rows go to AaiMochiEventsLoggerConfig (D129586374; Scuba aai_mochi_events).
 * logger_cat takes one typed-JSON message per line, keyed by the serving
 * Logger's input IDs with base64 strings, so each events.jsonl line is
 * converted with toLoggerRow first. Sharing is opt-out (toggle in the Dock menu, persisted
 * in userData): nothing ships while it is off.
 *
 * Queue rule from the plan: buffer new lines, send one batch, drop on
 * failure (the offset advances either way so a bad batch never retries
 * forever). Position is a byte offset plus the max event time, so a rotated
 * file resends only rows newer than what already shipped.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/* null keeps every Mac local-only (flushes become no-ops). */
export const LOGGER_CONFIG = 'AaiMochiEventsLoggerConfig';
export const LOGGER_BIN = process.env.MOCHI_LOGGER_BIN ?? 'logger_cat';
export const FLUSH_MS = 10 * 60_000;
const SEND_TIMEOUT_MS = 30_000;

/* logger_cat input ID and type per column. These are the serving Logger's input
   IDs, which match neither the thrift IDs nor the Tulip IDs and are in no
   checked-in file. Measured 2026-11-09 by sending one row per ID and type and
   reading back which Scuba column each value landed in (Muse's sink, D123801663,
   did the same). Re-measure after any schema change: a wrong type drops the whole
   row on the server, and logger_cat still exits 0. */
export const FIELD_IDS = {
  event_name: [4, 'str'],
  new_value: [5, 'i64'],
  unread_count: [6, 'i64'],
  time_hidden_ms: [7, 'i64'],
  time_spent_ms: [8, 'i64'],
  position: [9, 'i64'],
  ms_since_panel_open: [10, 'i64'],
  hidden_count: [11, 'i64'],
  data_age_ms: [12, 'i64'],
  old_value: [13, 'i64'],
  time_on_screen_ms: [14, 'i64'],
  result: [16, 'str'],
  duration_ms: [17, 'i64'],
  reviewing_rows: [18, 'i64'],
  mine_rows: [19, 'i64'],
  enabled: [20, 'i64'],
  launched_at_login: [21, 'i64'],
  memory_mb: [22, 'i64'],
  cpu_percent: [23, 'double'],
  status: [25, 'str'],
  kind: [26, 'str'],
  event_time_ms: [27, 'i64'],
  action: [28, 'str'],
  unixname: [29, 'str'],
  app_session_id: [30, 'str'],
  panel_session_id: [31, 'str'],
  app_version: [32, 'str'],
  app_build: [33, 'str'],
  os_version: [34, 'str'],
  surface: [35, 'str'],
  component: [36, 'str'],
  trigger: [37, 'str'],
  source: [38, 'str'],
  sections_on: [39, 'str'],
  reason: [40, 'str'],
  section: [41, 'str'],
  task_id: [42, 'str'],
  badge: [43, 'str'],
  freshness_state: [44, 'str'],
  goal: [45, 'str'],
  notif_kind: [46, 'str'],
};

/* logger_cat's typed JSON carries strings base64-encoded. */
const b64 = (value) => Buffer.from(String(value), 'utf8').toString('base64');

/** One events.jsonl line as a logger_cat message, or null if it can't be sent. */
export function toLoggerRow(line) {
  let event = null;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  const time = Date.parse(event?.time);
  if (typeof event?.event_name !== 'string' || !Number.isFinite(time)) return null;
  const row = {
    [FIELD_IDS.event_name[0]]: { str: b64(event.event_name) },
    [FIELD_IDS.event_time_ms[0]]: { i64: time },
  };
  for (const [key, value] of Object.entries(event)) {
    const field = FIELD_IDS[key];
    if (!field) continue;
    const [id, type] = field;
    if (type === 'str' && (typeof value === 'string' || typeof value === 'number')) row[id] = { str: b64(value) };
    else if (type === 'i64' && typeof value === 'boolean') row[id] = { i64: value ? 1 : 0 };
    else if (type === 'i64' && typeof value === 'number' && Number.isFinite(value)) row[id] = { i64: Math.round(value) };
    else if (type === 'double' && typeof value === 'number' && Number.isFinite(value)) row[id] = { double: value };
  }
  return JSON.stringify(row);
}

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
  const rows = lines.map(toLoggerRow).filter(Boolean);
  let ok = rows.length > 0;
  try {
    /* --fail-on-error only catches rows the local relay can't parse; the server
       checks IDs and types and drops bad rows silently, so FIELD_IDS must be right. */
    if (ok) ok = await run(['--logger', logger, '--fail-on-error'], `${rows.join('\n')}\n`);
  } catch {
    ok = false;
  }
  saveState(userDataDir, { ...state, sent });
  if (!ok) console.warn(`[mochi] sender dropped ${lines.length} rows (logger_cat failed)`);
  return ok ? { shipped: lines.length, dropped: 0 } : { shipped: 0, dropped: lines.length };
}
