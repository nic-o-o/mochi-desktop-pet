/* Codimango data source for the desktop shell (main process only).
 *
 * Auth = the user's existing `codimango` CLI login: we run the CLI and never
 * read or forward its token. Each refresh is two reads run in parallel —
 * `task list --filter reviewing` (reviews assigned to you) and
 * `task list --filter mine` (your tasks) — about 3 s together today. Rows are
 * picked down to the fields src/mochi/codimango.ts maps, so the renderer gets
 * a few KB instead of ~4 MB.
 *
 * Failures come back as one of: cli_missing (not installed), login_required
 * (no or expired Nest token: run `codimango auth setup`), offline, error.
 */
import { execFile } from 'node:child_process';

/* GUI apps on macOS don't inherit the shell PATH, so use the absolute path. */
export const CODIMANGO_BIN = process.env.MOCHI_CODIMANGO_BIN ?? '/usr/local/bin/codimango';
/* `--limit` walks the server's pages, so heavy reviewers aren't cut off at 100
   (the reviewing feed also lists every review you've delivered). */
const LIST_LIMIT = '500';
const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;
/* Classified CLI exit codes (see `codimango` skill: auth vs network). */
const EXIT_AUTH = 9;
const EXIT_NETWORK = 5;

const ROW_FIELDS = [
  'name',
  'status',
  'reviewStatus',
  'track',
  'reviewSlaDeadline',
  'enteredPoolAt',
  'claimedAt',
  'updatedAt',
  'reviewedAt',
  'escalationLevel',
  'validationStatus',
  'validationFailedSince',
  'staleArchiveWarnedAt',
  'oraclePassCount',
  'oracleTotalCount',
];

/** Keep only what the panel mapping reads (CodimangoRow in src/mochi/codimango.ts). */
export function pickRow(task) {
  const row = { id: String(task.id) };
  for (const key of ROW_FIELDS) row[key] = task[key] ?? null;
  row.validationDetails = Array.isArray(task.validationDetails)
    ? task.validationDetails.map((d) => ({ label: String(d?.label ?? ''), status: String(d?.status ?? '') }))
    : null;
  return row;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Map a failed CLI run to a user-facing state. `err` is execFile's error. */
export function classifyFailure(err, stdout, stderr) {
  if (err?.code === 'ENOENT') {
    return {
      kind: 'cli_missing',
      message: 'The codimango CLI is not installed.',
      fix: 'Enable "Codimango" (devfeature_codimango) in Alacarte',
    };
  }
  const body = parseJson(stdout ?? '')?.error;
  if (err?.code === EXIT_AUTH || body?.kind === 'authentication') {
    return {
      kind: 'login_required',
      message: 'Codimango login missing or expired.',
      fix: body?.fix ?? 'codimango auth setup',
    };
  }
  if (err?.code === EXIT_NETWORK || err?.killed) {
    return { kind: 'offline', message: 'Could not reach Codimango (VPN or network?).' };
  }
  // Skip the CLI's "Run `codimango feedback`" banner line on stderr.
  const lastStderr = String(stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.includes('codimango feedback'))
    .pop();
  const detail = body?.message ?? lastStderr ?? '';
  return { kind: 'error', message: detail || `codimango exited with ${err?.code ?? 'an error'}` };
}

/** One `task list` read, rows picked. Resolves { ok, rows } or { ok: false, error }. */
export function listTasks(filter) {
  return new Promise((resolve) => {
    execFile(
      CODIMANGO_BIN,
      ['task', 'list', '--filter', filter, '--limit', LIST_LIMIT, '--json'],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: classifyFailure(err, stdout, stderr) });
        const parsed = parseJson(stdout);
        if (!parsed || !Array.isArray(parsed.tasks)) {
          return resolve({ ok: false, error: { kind: 'error', message: 'Unexpected codimango output.' } });
        }
        if (parsed.hasMore) {
          console.warn(`[mochi] codimango ${filter}: more than ${LIST_LIMIT} tasks, showing the first ${LIST_LIMIT}`);
        }
        resolve({ ok: true, rows: parsed.tasks.map(pickRow) });
      },
    );
  });
}

let inFlight = null;

/** One refresh. Concurrent callers share the same run. */
export function fetchCodimango() {
  inFlight ??= (async () => {
    const started = Date.now();
    const [reviewing, mine] = await Promise.all([listTasks('reviewing'), listTasks('mine')]);
    if (!reviewing.ok) return reviewing;
    if (!mine.ok) return mine;
    console.log(
      `[mochi] codimango refresh: ${reviewing.rows.length} reviewing, ${mine.rows.length} mine in ${Date.now() - started}ms`,
    );
    return {
      ok: true,
      snapshot: { fetchedAtMs: Date.now(), reviewing: reviewing.rows, mine: mine.rows },
    };
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Only Codimango pages and the Alacarte install page may be opened from the renderer. */
export function isAllowedLink(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:') return false;
    if (u.hostname === 'codimango.internalmeta.com') return true;
    return u.hostname === 'www.internalfb.com' && (u.pathname === '/alacarte' || u.pathname.startsWith('/alacarte/'));
  } catch {
    return false;
  }
}
