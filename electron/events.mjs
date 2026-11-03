/* Usage events (logging plan: "Mochi Logging Plan" doc): one JSON line per
 * event in ~/Library/Logs/Mochi/events.jsonl, on this Mac only. The renderer
 * sends event-specific fields; this adds the common columns. Only listed
 * fields with short enum/ID/number values are kept, so a task name or review
 * text can't end up in the file by accident.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 5_000_000;
const DAY_MS = 86_400_000;

export const EVENT_NAMES = new Set([
  'mochi_vpv',
  'mochi_click',
  'mochi_close',
  'mochi_app_start',
  'mochi_daily_active',
  'mochi_fetch',
  'mochi_resource',
]);

/* Event-specific columns from the plan, plus the renderer-side common ones. */
const FIELDS = new Set([
  'surface',
  'component',
  'panel_session_id',
  'app_build',
  'action',
  'unread_count',
  'time_hidden_ms',
  'trigger',
  'sections_on',
  'time_spent_ms',
  'reason',
  'section',
  'task_id',
  'position',
  'badge',
  'ms_since_panel_open',
  'hidden_count',
  'enabled',
  'freshness_state',
  'data_age_ms',
  'goal',
  'old_value',
  'new_value',
  'notif_kind',
  'source',
  'time_on_screen_ms',
  'kind',
  'result',
  'launched_at_login',
  'status',
  'duration_ms',
  'reviewing_rows',
  'mine_rows',
  'cpu_percent',
  'memory_mb',
]);

/* IDs and enums: letters, digits and a few separators, short. */
const SAFE_STRING = /^[\w.,:+\- ]{0,64}$/;

/** The event to write, or null if it isn't one we log. Unknown or unsafe fields are dropped. */
export function sanitizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || !EVENT_NAMES.has(raw.event_name)) return null;
  const out = { event_name: raw.event_name };
  for (const [key, value] of Object.entries(raw)) {
    if (!FIELDS.has(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
    else if (typeof value === 'string' && SAFE_STRING.test(value)) out[key] = value;
  }
  return out;
}

/**
 * Appends events to `<dir>/events.jsonl` (rotated to .1 at startup past 5 MB).
 * `common` columns (app_session_id, os_version, unixname…) go on every line.
 */
export function createEventLog(dir, common, now = () => Date.now()) {
  const file = path.join(dir, 'events.jsonl');
  let stream = null;
  function open() {
    if (stream) return stream;
    fs.mkdirSync(dir, { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no file yet */
    }
    stream = fs.createWriteStream(file, { flags: 'a' });
    return stream;
  }
  return {
    file,
    log(raw) {
      const event = sanitizeEvent(raw);
      if (!event) return false;
      open().write(`${JSON.stringify({ ...event, ...common, time: new Date(now()).toISOString() })}\n`);
      return true;
    },
    /** Resolves once buffered lines are on disk. */
    close() {
      const s = stream;
      stream = null;
      return new Promise((resolve) => (s ? s.end(resolve) : resolve()));
    },
  };
}

/** Parsed events from the last `days` days (bad lines skipped). */
export function readEvents(file, nowMs, days = 7) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const since = nowMs - days * DAY_MS;
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (Date.parse(e.time) >= since) out.push(e);
    } catch {
      /* partial line from a crash */
    }
  }
  return out;
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '–');

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Aggregates testers can paste (no task IDs): appended to "Copy my review stats". */
export function usageSummary(events, days = 7) {
  const count = (pred) => events.filter(pred).length;
  const is = (name, surface, component) => (e) =>
    e.event_name === name && (!surface || e.surface === surface) && (!component || e.component === component);
  const panelOpens = events.filter(is('mochi_vpv', 'glance_panel', 'panel'));
  const byTrigger = {};
  for (const e of panelOpens) byTrigger[e.trigger ?? 'other'] = (byTrigger[e.trigger ?? 'other'] ?? 0) + 1;
  const rowsSeen = count(is('mochi_vpv', 'glance_panel', 'row'));
  const rowsClicked = count(is('mochi_click', 'glance_panel', 'row'));
  const bubbles = count((e) => is('mochi_vpv', 'bubble', 'bubble')(e) && e.source === 'arrival');
  const bubbleClicks = count((e) => is('mochi_click', 'bubble', 'bubble')(e) && e.source === 'arrival');
  const fetches = events.filter(is('mochi_fetch'));
  const fetchOk = fetches.filter((e) => e.status === 'ok');
  const fetchMs = median(fetchOk.map((e) => e.duration_ms).filter((n) => typeof n === 'number'));
  const days_active = new Set(events.filter(is('mochi_daily_active')).map((e) => String(e.time).slice(0, 10))).size;
  const memory = events.filter(is('mochi_resource')).map((e) => e.memory_mb);
  const triggers = Object.entries(byTrigger)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  return [
    `Mochi usage (last ${days} days on this Mac; counts only)`,
    `Days active: ${days_active}`,
    `Panel opens: ${panelOpens.length}${triggers ? ` (${triggers})` : ''}`,
    `Rows seen / clicked: ${rowsSeen} / ${rowsClicked} (${pct(rowsClicked, rowsSeen)})`,
    `Bubbles shown / clicked: ${bubbles} / ${bubbleClicks} (${pct(bubbleClicks, bubbles)})`,
    `Setup card shown: ${count(is('mochi_vpv', 'setup_card'))}`,
    `Hidden to the paw: ${count(is('mochi_close', 'pet', 'hide'))}`,
    `Refreshes: ${fetches.length}, ${pct(fetchOk.length, fetches.length)} ok${fetchMs === null ? '' : `, median ${(fetchMs / 1000).toFixed(1)} s`}`,
    `Memory: ${memory.length ? `max ${Math.max(...memory)} MB` : 'not sampled yet'}`,
  ].join('\n');
}
