/* Codimango data source for the desktop shell (main process only).
 *
 * Auth = the user's existing `codimango` CLI login: we run the CLI and never
 * read or forward its token. Each refresh is two reads run in parallel —
 * `task list --filter reviewing` (reviews assigned to you) and
 * `task list --filter mine` (your tasks) — about 3 s together today. Rows are
 * picked down to the fields src/mochi/codimango.ts maps, so the renderer gets
 * a few KB instead of ~4 MB.
 *
 * Passing validation doesn't mean a draft can be submitted: blocking signals
 * (e.g. Provenance SUSPECT), 1P SOTA holds and TBR infra errors also gate it.
 * So each draft whose validation passes also gets `task submit-status` (about
 * 2 s, run in parallel), and its blockers ride along as `submitBlockers`.
 * submit-status doesn't see the benchmark canary scan (only the submit route
 * rechecks it), so the row also carries that scan result as `canaryScan`.
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
  'commitSha',
];

/** Keep only what the panel mapping reads (CodimangoRow in src/mochi/codimango.ts). */
export function pickRow(task) {
  const row = { id: String(task.id) };
  for (const key of ROW_FIELDS) row[key] = task[key] ?? null;
  row.validationDetails = Array.isArray(task.validationDetails)
    ? task.validationDetails.map((d) => ({
        label: String(d?.label ?? ''),
        status: String(d?.status ?? ''),
        advisory: d?.advisory === true,
      }))
    : null;
  // The benchmark canary scan result is the one part of qualitativeResult the panel reads.
  const scan = task.qualitativeResult?.benchmarkCanaryScanResult;
  row.canaryScan =
    scan && typeof scan === 'object'
      ? {
          outcome: String(scan.outcome ?? ''),
          commitSha: scan.commitSha ?? null,
          scannerVersion: scan.scannerVersion ?? null,
          retryable: scan.retryable === true,
        }
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

/** One JSON CLI call. Resolves { ok: true, body } or { ok: false, error }. */
function runJsonCommand(args) {
  return new Promise((resolve) => {
    execFile(CODIMANGO_BIN, [...args, '--json'], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: classifyFailure(err, stdout, stderr) });
      const body = parseJson(stdout);
      if (!body || typeof body !== 'object') {
        return resolve({ ok: false, error: { kind: 'error', message: 'Unexpected codimango output.' } });
      }
      resolve({ ok: true, body });
    });
  });
}

/** Read-only submission preflight for one task (never submits). */
export function submitDryRun(id) {
  return runJsonCommand(['task', 'submit', String(id), '--dry-run']).then((r) =>
    r.ok ? { ok: true, preflight: r.body } : r,
  );
}

/** Pick the commit SHA to pin a submission to: the validation generation's
 * revision, falling back to the task's commit. Null when neither is a SHA. */
export function pickSubmitSha(show) {
  const sha = show?.validationGeneration?.sourceRevision ?? show?.commitSha ?? null;
  return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** Current commit SHA for one task (fresh read, so the pin can't go stale). */
export async function fetchSubmitSha(id) {
  const r = await runJsonCommand(['task', 'show', String(id)]);
  if (!r.ok) return r;
  const sha = pickSubmitSha(r.body);
  if (!sha) return { ok: false, error: { kind: 'error', message: 'No commit to submit.' } };
  return { ok: true, sha };
}

/** Submit one exact validated revision. Never retries, never overrides. */
export function submitTask(id, sha) {
  return runJsonCommand(['task', 'submit', String(id), '--expected-commit', String(sha)]).then((r) =>
    r.ok ? { ok: true, result: r.body } : r,
  );
}

/** Why `task submit-status` says a task can't be submitted yet; [] when it can. */
export function pickSubmitBlockers(status) {
  if (!status || typeof status !== 'object') return null;
  const labels = (Array.isArray(status.blockers) ? status.blockers : [])
    .map((b) => String(b?.label ?? '').trim())
    .filter(Boolean);
  if (status.tbrInfraError === true) labels.push('TBR infra error');
  if (status.validationPending === true) labels.push('Validation still running');
  if (status.blocked === true && labels.length === 0) labels.push('Blocked');
  return labels;
}

/** Blockers for one task, or null when the check itself failed (row keeps its validation status). */
export function fetchSubmitBlockers(id) {
  return runJsonCommand(['task', 'submit-status', String(id)]).then((r) => (r.ok ? pickSubmitBlockers(r.body) : null));
}

/** Attach `submitBlockers` to your drafts whose validation passes. */
export async function addSubmitBlockers(rows, fetchBlockers = fetchSubmitBlockers) {
  const passing = rows.filter((r) => r.status === 'draft' && r.validationStatus === 'passing');
  const results = await Promise.all(passing.map((r) => fetchBlockers(r.id)));
  passing.forEach((r, i) => {
    r.submitBlockers = results[i];
  });
  return rows;
}

let inFlight = null;

/** One refresh. Concurrent callers share the same run. */
export function fetchCodimango() {
  inFlight ??= (async () => {
    const started = Date.now();
    const [reviewing, mine] = await Promise.all([listTasks('reviewing'), listTasks('mine')]);
    if (!reviewing.ok) return reviewing;
    if (!mine.ok) return mine;
    await addSubmitBlockers(mine.rows);
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
    if (u.hostname !== 'www.internalfb.com') return false;
    return u.pathname === '/alacarte' || u.pathname.startsWith('/alacarte/') || /^\/sevmanager\/view\/\d+$/.test(u.pathname);
  } catch {
    return false;
  }
}
