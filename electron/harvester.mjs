/* Harvester's agent status for drafts (main process only).
 *
 * Harvester (codimango/harvester) revives draft tasks with an agent and serves
 * a local board. On a laptop the board is plain HTTP on 127.0.0.1, port 44101
 * by default (44100–44109 when several run); a devserver board is HTTPS behind
 * Secure Web Apps and not reachable from here, so Mochi only sees a Harvester
 * running on this Mac. Nothing here is a documented Harvester API — the board
 * calls it "not part of the runtime contract" — so every field is read
 * defensively and an unreachable or unexpected board means "no status", never
 * an error on the row.
 *
 * Reads: GET /api/projects (board project names), then
 * GET /api/taskflow-state?repo=<name>&fast=1 → runs[] with task_name, state,
 * stalled_since, restart_count, error, failure{cause}, detail{outcome, means,
 * detail, timing{phase}}. The one-line reason is the board's own: detail.detail,
 * then detail.means, then failure.cause.
 *
 * Writes (the person's own runs only; Harvester checks `owner` against the
 * board's Unix user): POST /api/cancel-run {id, owner} stops a run and keeps
 * the scheduler off it; POST /api/taskflow-bulk {repo, tasks, owner, intent}
 * queues a revival, which publishes — pushes to the task and comments.
 */

export const HARVESTER_PORTS = [44101, 44100, 44102, 44103, 44104, 44105, 44106, 44107, 44108, 44109];
const PROBE_TIMEOUT_MS = 800;
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;
const REASON_MAX = 200;

/** Harvester's 3 automatic infra retries; past that a blocked run counts as stuck. */
const INFRA_RETRY_LIMIT = 3;

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function epochMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(str(v));
  return Number.isNaN(t) ? null : t;
}

/** The board's own one-line reason for a run, trimmed to one line. */
export function runReason(run) {
  const detail = isObj(run?.detail) ? run.detail : {};
  const failure = isObj(run?.failure) ? run.failure : {};
  const text = str(detail.detail).trim() || str(detail.means).trim() || str(failure.cause).trim() || str(run?.error).trim();
  const line = text.split('\n')[0].replace(/\s+/g, ' ').trim();
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line;
}

/**
 * One Harvester run → Mochi's agent status: working, stuck, done or stopped.
 * Mirrors Harvester's own Farmer rules: queued and waiting-on-Nest runs are
 * healthy; a run with no log output for 10 minutes is stalled (stuck); a
 * platform-blocked phase or an infra block past the automatic retries is stuck.
 */
export function mapRun(run) {
  const state = str(run?.state);
  const detail = isObj(run?.detail) ? run.detail : {};
  const phase = str(isObj(detail.timing) ? detail.timing.phase : '');
  const outcome = str(detail.outcome);
  const restarts = Number.isFinite(Number(run?.restart_count)) ? Number(run.restart_count) : 0;
  let kind;
  if (state === 'running') kind = run?.stalled_since ? 'stuck' : phase === 'platform_blocked' ? 'stuck' : 'working';
  else if (state === 'queued' || state === 'remote_waiting' || state === 'update-held') kind = phase === 'platform_blocked' ? 'stuck' : 'working';
  else if (state === 'infrastructure_blocked') kind = restarts >= INFRA_RETRY_LIMIT ? 'stuck' : 'working';
  else if (state === 'done') kind = outcome === 'green' ? 'done' : 'stopped';
  else if (state === 'failed' || state === 'cancelled') kind = 'stopped';
  else return null;
  const waiting = state === 'queued' ? 'Queued' : state === 'remote_waiting' ? 'Waiting for validation' : state === 'infrastructure_blocked' ? 'Retrying after an infrastructure error' : '';
  return {
    kind,
    state,
    reason: runReason(run) || waiting || (kind === 'stuck' && run?.stalled_since ? 'No output for over 10 minutes' : ''),
    runId: str(run?.id) || null,
    intent: str(run?.intent) === 'revision' ? 'revision' : 'revive',
    restartCount: restarts,
    sinceMs: epochMs(run?.last_progress_at) ?? epochMs(run?.ended_at) ?? epochMs(run?.started_at),
    startedMs: epochMs(run?.started_at),
  };
}

/** The latest run per Codimango task name, mapped; unknown states are skipped. */
export function statusesFromRuns(runs, { base, repo }) {
  const latest = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const name = str(run?.task_name).trim();
    if (!name) continue;
    const prev = latest.get(name);
    if (!prev || (epochMs(run?.started_at) ?? 0) >= (epochMs(prev?.started_at) ?? 0)) latest.set(name, run);
  }
  const out = {};
  for (const [name, run] of latest) {
    const mapped = mapRun(run);
    if (mapped) out[name] = { ...mapped, taskName: name, base, repo };
  }
  return out;
}

async function getJson(fetchImpl, url, timeoutMs, init) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  return { ok: res.ok, status: res.status, body };
}

const withToken = (url, token) => (token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url);

/**
 * Every Harvester task status on this Mac: { available, statuses: { [taskName]: status } }.
 * `available` is false when no board answers; the rows then show nothing.
 */
export async function harvesterStatuses({ fetchImpl = fetch, token = '', ports = HARVESTER_PORTS } = {}) {
  const boards = [];
  await Promise.all(
    ports.map(async (port) => {
      const base = `http://127.0.0.1:${port}`;
      try {
        const r = await getJson(fetchImpl, withToken(`${base}/api/projects`, token), PROBE_TIMEOUT_MS);
        if (r.ok && Array.isArray(r.body)) {
          const names = r.body.map((p) => str(p?.name).trim()).filter(Boolean);
          boards.push({ base, names });
        }
      } catch {
        /* nothing on this port */
      }
    }),
  );
  if (boards.length === 0) return { available: false, statuses: {} };
  const statuses = {};
  for (const { base, names } of boards) {
    for (const repo of names) {
      try {
        const r = await getJson(fetchImpl, withToken(`${base}/api/taskflow-state?repo=${encodeURIComponent(repo)}&fast=1`, token), READ_TIMEOUT_MS);
        if (!r.ok || !isObj(r.body)) continue;
        for (const [name, status] of Object.entries(statusesFromRuns(r.body.runs, { base, repo }))) {
          const prev = statuses[name];
          if (!prev || (status.startedMs ?? 0) >= (prev.startedMs ?? 0)) statuses[name] = status;
        }
      } catch {
        /* this project is unreadable right now; keep the others */
      }
    }
  }
  return { available: true, statuses };
}

const LOCAL_BASE = /^http:\/\/127\.0\.0\.1:\d{4,5}$/;
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function post(fetchImpl, base, route, body, token) {
  if (!LOCAL_BASE.test(str(base))) return { ok: false, error: 'Harvester is not running on this Mac.' };
  try {
    const r = await getJson(fetchImpl, withToken(`${base}${route}`, token), WRITE_TIMEOUT_MS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok && r.body?.ok !== false) return { ok: true, result: r.body?.result ?? null };
    return { ok: false, error: str(r.body?.error) || `Harvester answered ${r.status}.` };
  } catch {
    return { ok: false, error: "Couldn't reach Harvester on this Mac." };
  }
}

/** Stop one run (Harvester's Cancel): SIGTERM its process group; the scheduler then leaves the task alone. */
export function stopHarvesterRun({ base, runId, owner, token = '' }, { fetchImpl = fetch } = {}) {
  if (!str(runId).trim()) return Promise.resolve({ ok: false, error: 'No Harvester run to stop.' });
  return post(fetchImpl, base, '/api/cancel-run', { id: str(runId), owner }, token);
}

/**
 * Restart a task's revival (Harvester's Revive): queues a fresh run under the
 * same owner record. It publishes — pushes to the task and comments — and
 * Harvester refuses while a run is still active or Nest no longer lists the
 * task as needing repair.
 */
export function restartHarvesterTask({ base, repo, taskName, intent, owner, token = '' }, { fetchImpl = fetch } = {}) {
  if (!TASK_NAME.test(str(taskName))) return Promise.resolve({ ok: false, error: 'Not a task name Harvester accepts.' });
  if (!str(repo).trim()) return Promise.resolve({ ok: false, error: 'Unknown Harvester project.' });
  return post(fetchImpl, base, '/api/taskflow-bulk', { repo: str(repo), tasks: [str(taskName)], owner, intent: intent === 'revision' ? 'revision' : 'revive' }, token);
}
