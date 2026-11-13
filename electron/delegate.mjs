/* Delegate a "needs revision" task to Green on the devserver (main process only).
 *
 * Green drives one Codimango task to green: it reads the task's validation
 * state, hands the failing checks to a repair agent, proves the repair
 * locally, pushes, and waits for validation. Mochi launches it detached and
 * reports the worker pid and log path; the worker keeps going on its own.
 * Mochi never hand-writes a repair prompt: Green authors the repair prompt
 * from the task findings itself.
 *
 * Launching runs through agentcloudctl on the devserver the user named
 * (asked the first time they delegate, then saved): check Green is installed there (install it if needed), resolve
 * the task repo from the task's sourceRepo, clone the checkout if it is
 * missing, verify it, fast-forward it when the task directory is missing from
 * a stale checkout, check the task directory exists, run Green's doctor to
 * install the push guard, then launch detached with the chosen repair agent
 * (Muse or Codex). A launch refused by the remote lease instead reports the
 * worker already holding it (its pid and log, found on the devserver), so
 * the panel can show that worker's live status. Nothing here
 * guesses a repo path: a missing or mismatched checkout fails closed with
 * the expected path, and a task directory still missing after a fast-forward
 * fails closed naming the task's commit instead of letting Green refuse
 * cryptically at launch. The saved order of steps matters: doctor must run
 * before any live launch, and no launch happens after any failure. Only a
 * fast-forward merge is ever applied to a checkout (never a rebase or a
 * checkout of another commit), and only cloning creates a new checkout.
 *
 * Failures come back as one of: invalid_task, invalid_agent, node_missing,
 * agentcloud_missing, node_error, green_missing, repo_not_found,
 * task_dir_missing, checkout_stale, doctor_failed, launch_failed. The last
 * launch step may report ok with timedOut when the worker started but its
 * first decision had not landed before the wait ended.
 */
import { spawn } from 'node:child_process';

export const AGENTCLOUD_BIN = process.env.MOCHI_AGENTCLOUD_BIN ?? '/usr/local/bin/agentcloudctl';

/**
 * A devserver node id, as the user typed it: trimmed, lowercased, scheme and
 * trailing path stripped, and rejected when it is not one hostname-like
 * token. Mirrors normalizeDelegateNode in src/mochi/delegations.ts, which is
 * only the picker-side check; this one is authoritative before any
 * agentcloudctl call. Keep the two in sync. There is deliberately no
 * default node: running on someone else's devserver must be asked for.
 */
export function normalizeDelegateNode(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim().toLowerCase().replace(/^https?:\/\//, '');
  value = (value.split('/')[0] ?? '').replace(/\.+$/, '');
  if (!value || value.length > 253 || value.includes('..')) return null;
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(value) ? value : null;
}
/** Green on the devserver, addressed through the remote home directory. */
export const GREEN_DIR = '$HOME/.claude/skills/green';
export const GREEN_SKILL_FILE = `${GREEN_DIR}/SKILL.md`;
export const GREEN_CLI = `${GREEN_DIR}/scripts/cli.py`;

const CHECK_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const TASK_SHOW_TIMEOUT_MS = 60_000;
const VERIFY_TIMEOUT_MS = 60_000;
const CLONE_TIMEOUT_MS = 15 * 60_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const DOCTOR_TIMEOUT_MS = 5 * 60_000;
const LAUNCH_TIMEOUT_MS = 15 * 60_000;

/** Codimango task names are slugs; anything else never reaches a shell. */
export function isTaskSlug(slug) {
  return typeof slug === 'string' && /^[\w.-]{1,200}$/.test(slug);
}

/**
 * The repo directory name off a task's sourceRepo URL, or null. A URL must
 * name an org and a repo (an org-only URL is not a repo): the last segment
 * after the host is the repo, and a bare name is not a sourceRepo.
 */
export function repoDirName(sourceRepo) {
  const clean = String(sourceRepo ?? '').trim().replace(/\/+$/, '');
  if (!clean) return null;
  let segments;
  const schemeIdx = clean.indexOf('://');
  if (schemeIdx >= 0) {
    segments = clean.slice(schemeIdx + 3).split('/').filter(Boolean);
    if (segments.length < 3) return null; // host + org + repo
  } else if (clean.includes(':')) {
    segments = (clean.split(':').pop() ?? '').split('/').filter(Boolean);
    if (segments.length < 2) return null; // org + repo
  } else {
    return null;
  }
  const name = segments[segments.length - 1].replace(/\.git$/, '');
  return /^[\w.-]+$/.test(name) ? name : null;
}

/** Where a task's checkout lives on the devserver, or null. */
export function repoCandidatePath(home, sourceRepo) {
  const name = repoDirName(sourceRepo);
  if (!name || typeof home !== 'string' || !home) return null;
  return `${home.replace(/\/+$/, '')}/AAI/${name}`;
}

/**
 * The SSH clone URL for a task's sourceRepo, or null when no org and repo
 * can be read off it. HTTPS URLs cannot be cloned on the devserver (the git
 * credential helper there is broken); SSH was verified against ls-remote.
 */
export function cloneSshUrl(sourceRepo) {
  const clean = String(sourceRepo ?? '').trim().replace(/\/+$/, '');
  if (!clean) return null;
  let path;
  const schemeIdx = clean.indexOf('://');
  if (schemeIdx >= 0) {
    const segments = clean.slice(schemeIdx + 3).split('/').filter(Boolean);
    if (segments.length < 3) return null; // host + org + repo
    path = segments.slice(1).join('/');
  } else if (clean.includes(':')) {
    const segments = (clean.split(':').pop() ?? '').split('/').filter(Boolean);
    if (segments.length < 2) return null; // org + repo
    path = segments.join('/');
  } else {
    const segments = clean.split('/').filter(Boolean);
    if (segments.length < 2) return null; // org + repo
    path = segments.join('/');
  }
  const repo = path.replace(/\.git$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return `git@github.com:${repo}.git`;
}

function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function checkGreenScript() {
  return `test -e "${GREEN_SKILL_FILE}"`;
}

/** Green accepts only `muse` and `codex` as repair agents; anything else is rejected before any run. Mirrors isDelegateAgent in src/mochi/delegations.ts. */
export function isDelegateAgent(value) {
  return value === 'muse' || value === 'codex';
}

function installGreenScript(agent) {
  return `agent-market skill install green --agent ${agent} --scope user --force`;
}

function taskShowScript(slug) {
  return `codimango task show ${q(slug)} --json`;
}

function verifyRepoScript(repoName) {
  return `repo="$HOME/AAI/${repoName}"\ntop=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null) || exit 3\nremote=$(git -C "$repo" remote get-url origin 2>/dev/null) || exit 3\nprintf '%s\\n%s\\n' "$top" "$remote"`;
}

function repoExistsScript(repoName) {
  return `test -e "$HOME/AAI/${repoName}"`;
}

function cloneScript(sshUrl, repoName) {
  return `git clone ${q(sshUrl)} "$HOME/AAI/${repoName}"`;
}

function taskDirScript(repo, slug) {
  return `test -d ${q(`${repo}/${slug}`)}`;
}

function updateCheckoutScript() {
  return 'git pull --ff-only origin main';
}

function doctorScript() {
  return `python3 "${GREEN_CLI}" doctor --install-hooks`;
}

function launchScript(slug, repo, agent) {
  return `python3 "${GREEN_CLI}" ${q(slug)} --repo ${q(repo)} --live --hardening --detach --agent ${agent}`;
}

function parseTaskJson(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** sourceRepo out of `codimango task show --json`, tolerating a banner line. */
export function parseTaskShow(text) {
  const parsed = parseTaskJson(text);
  return typeof parsed?.sourceRepo === 'string' && parsed.sourceRepo ? parsed.sourceRepo : null;
}

/** The task's 40-character commit SHA out of `codimango task show --json`, or null. */
export function taskCommitSha(text) {
  const parsed = parseTaskJson(text);
  const sha = parsed?.commitSha;
  return typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/**
 * Green doctor output, read for the failing check instead of the raw table:
 * each binary prints its path or `MISSING`, and the last line is the
 * overall `ok` / `not ready` verdict. Unknown output defaults to no
 * missing binary and not ready, so callers fail closed on the doctor
 * exit code rather than on a guess.
 */
export function parseDoctorOutput(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const missingBinaries = [];
  for (const binary of ['codimango', 'codex', 'muse', 'git', 'docker']) {
    const line = lines.find((l) => l.startsWith(binary) && /\s/.test(l));
    if (line && /MISSING\b/.test(line)) missingBinaries.push(binary);
  }
  return {
    dockerMissing: missingBinaries.includes('docker'),
    ready: lines.length > 0 && lines[lines.length - 1] === 'ok',
    missingBinaries,
  };
}

/** The worker pid, log path, and first decision out of a detached launch. */
export function parseGreenStarted(text) {
  const output = String(text ?? '');
  const pid = /worker pid:\s*(\d+)/i.exec(output);
  const log = /(?:^|\n)\s*log:\s*(\S+)/i.exec(output);
  const decision = /^\s*(DECIDE[^\n]*)/m.exec(output);
  return {
    pid: pid ? Number(pid[1]) : null,
    logPath: log ? log[1].trim() : null,
    decision: decision ? decision[1].trim() : null,
  };
}

/**
 * The worker already running a task, out of the discovery probe: a live pid
 * and an absolute log path, or null when the probe found nothing usable. An
 * unrecognized agent is null too, for the caller to default — the pid and
 * log are what the status probe needs.
 */
export function parseExistingWorkerOutput(text) {
  const lines = String(text ?? '').split('\n');
  const valueOf = (prefix) => {
    const line = lines.find((l) => l.startsWith(prefix));
    return line == null ? null : line.slice(prefix.length).trim();
  };
  const pidRaw = valueOf('WORKER_PID=');
  const pid = pidRaw != null && /^\d+$/.test(pidRaw) ? Number(pidRaw) : null;
  const logPath = valueOf('WORKER_LOG=');
  const agentRaw = valueOf('WORKER_AGENT=');
  if (!pid || !logPath || !logPath.startsWith('/')) return null;
  return { pid, logPath, agent: isDelegateAgent(agentRaw) ? agentRaw : null };
}

/**
 * One probe script for the worker already holding a task's remote lease:
 * the loop.py process for the slug, verified by its own command line, with
 * its log path read off the file its stdout is redirected to (a detached
 * worker's fd 1 is its log file). The probe always exits 0 and prints
 * nothing when there is no such worker, so a miss is never an error. The
 * pgrep pattern spells the name with a bracket class so the probe never
 * matches its own command line.
 */
function existingWorkerScript(slug) {
  const pattern = String(slug).replace(/\./g, '\\.');
  return [
    '# mochi-discover-worker',
    `slug=${q(slug)}`,
    `pid=$(pgrep -f "loop\\.p[y].*${pattern}" | head -n 1)`,
    'if [ -z "$pid" ]; then exit 0; fi',
    'args=$(ps -p "$pid" -o args= 2>/dev/null || true)',
    'case "$args" in *loop.py*"$slug"*) ;; *) exit 0;; esac',
    'log=$(readlink "/proc/$pid/fd/1" 2>/dev/null || true)',
    'case "$log" in /*) ;; *) log=$(readlink "/proc/$pid/fd/2" 2>/dev/null || true);; esac',
    'case "$log" in /*) ;; *) exit 0;; esac',
    'agent=""',
    'case "$args" in *"--agent muse"*) agent=muse;; *"--agent codex"*) agent=codex;; esac',
    "printf 'WORKER_PID=%s\\n' \"$pid\"",
    "printf 'WORKER_LOG=%s\\n' \"$log\"",
    "printf 'WORKER_AGENT=%s\\n' \"$agent\"",
    'exit 0',
  ].join('\n');
}

/**
 * Find the worker already holding a task's lease, or null. Never throws and
 * never masks the caller's failure: a failed probe is a miss, so the
 * original launch failure still stands.
 */
async function discoverExistingWorker(slug, safeRun) {
  try {
    const probed = await safeRun({ script: existingWorkerScript(slug), timeoutMs: VERIFY_TIMEOUT_MS });
    if (probed.error || probed.code !== 0) return null;
    return parseExistingWorkerOutput(probed.stdout ?? '');
  } catch {
    return null;
  }
}

/**
 * The last waiting line and repair closure out of a worker log: a wait only
 * counts as active when the last non-empty log line is itself a waiting
 * line — a stale wait from an earlier phase must not make a moved-on worker
 * look stuck on it. The closure reason is the free text after BLOCKED.
 */
export function parseLogDetailOutput(text) {
  const lines = String(text ?? '').split('\n');
  const valueOf = (prefix) => {
    const line = lines.find((l) => l.startsWith(prefix));
    return line == null ? null : line.slice(prefix.length);
  };
  const waitingLine = valueOf('WAITING_LINE=');
  const lastLine = valueOf('LAST_LINE=');
  const closureLine = valueOf('CLOSURE_LINE=');
  const waitingActive = waitingLine != null && waitingLine.length > 0 && lastLine != null && /waiting \d+m for /.test(lastLine);
  let waitingMins = null;
  let waitingReason = null;
  if (waitingActive) {
    const match = /waiting (\d+)m for (.+)$/.exec(waitingLine);
    if (match) {
      waitingMins = Number(match[1]);
      waitingReason = match[2].trim().slice(0, 160);
    }
  }
  const blocked = closureLine != null && closureLine.includes('GREEN_REPAIR_CLOSURE:') && closureLine.includes('BLOCKED');
  let blockedReason = null;
  if (blocked) {
    const match = /BLOCKED\s*[—-]\s*(.+)$/.exec(closureLine);
    blockedReason = (match ? match[1] : closureLine.slice(closureLine.indexOf('BLOCKED') + 'BLOCKED'.length)).trim().slice(0, 160) || null;
  }
  return { waitingActive, waitingMins, waitingReason, blockedReason, hasBlocked: blocked };
}

/** One probe for the last waiting/closure lines of a worker log. Always exits 0. */
function logDetailScript(logPath) {
  return [
    '# mochi-log-detail',
    `log=${q(logPath)}`,
    'waiting=$(grep -E "waiting [0-9]+m for " "$log" 2>/dev/null | tail -n 1)',
    'last=$(grep . "$log" 2>/dev/null | tail -n 1)',
    'closure=$(grep -F "GREEN_REPAIR_CLOSURE:" "$log" 2>/dev/null | tail -n 1)',
    "printf 'WAITING_LINE=%s\\n' \"$waiting\"",
    "printf 'LAST_LINE=%s\\n' \"$last\"",
    "printf 'CLOSURE_LINE=%s\\n' \"$closure\"",
    'exit 0',
  ].join('\n');
}

/**
 * How old the remote lease is, from the lease commit's timestamp. The lease
 * ref is read with ls-remote and its commit is fetched by SHA, so no local
 * ref is moved; any failure leaves the age unknown rather than inventing
 * one. Needs the task checkout as its working directory.
 */
function leaseAgeScript(slug) {
  const ref = `refs/heads/converge-locks/${slug}`;
  return [
    '# mochi-lease-age',
    `ref=${q(ref)}`,
    'sha=$(git ls-remote origin "$ref" 2>/dev/null | awk \'{print $1}\')',
    'if [ -z "$sha" ]; then exit 0; fi',
    'git fetch -q origin "$sha" 2>/dev/null || exit 0',
    'ts=$(git show -s --format=%ct "$sha" 2>/dev/null || true)',
    "printf 'LEASE_TS=%s\\n' \"$ts\"",
    'exit 0',
  ].join('\n');
}

function parseLeaseAge(text) {
  const line = String(text ?? '')
    .split('\n')
    .find((l) => l.startsWith('LEASE_TS='));
  const ts = line == null ? NaN : Number(line.slice('LEASE_TS='.length).trim());
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const age = Math.floor(Date.now() / 1000) - Math.floor(ts);
  return age >= 0 ? age : null;
}

/**
 * One command on the devserver through agentcloudctl. Resolves with the exit
 * code and collected output; a spawn failure resolves with `error` instead of
 * throwing, so callers can tell a missing agentcloudctl apart from a failed
 * command. `cwd` is the working directory on the node when given.
 */
const STATUS_TIMEOUT_MS = 60_000;

/**
 * A live worker status from one probe: the worker pid is alive, the log
 * exists, and the log's last lines say what happened. A live worker is
 * working once it has decided and starting before that; a dead worker is
 * done only when its log ends with a zero green_run timing, blocked when its
 * last closure says so, and stopped otherwise. Markers from an earlier wave
 * never override the pid being alive.
 */
export function deriveDelegateStatus(probe) {
  const { pidAlive, hasDecide, hasBlocked, hasTimingZero, lastDecision } = probe;
  let kind;
  if (pidAlive) {
    kind = hasDecide ? 'working' : 'starting';
  } else if (hasTimingZero) {
    kind = 'done';
  } else if (hasBlocked) {
    kind = 'blocked';
  } else {
    kind = 'stopped';
  }
  return { kind, lastDecision: lastDecision ?? null };
}

/** The probe lines one status check prints, parsed with safe defaults. */
export function parseDelegateStatusOutput(text) {
  const lines = String(text ?? '').split('\n');
  const valueOf = (prefix) => {
    const line = lines.find((l) => l.startsWith(prefix));
    return line == null ? null : line.slice(prefix.length);
  };
  const flag = (prefix) => valueOf(prefix) === '1';
  const ageRaw = valueOf('LOG_AGE_SECS=');
  const age = ageRaw == null || ageRaw === '' ? null : Number(ageRaw);
  const decideRaw = valueOf('DECIDE_LINE=');
  const decideAt = decideRaw == null ? -1 : decideRaw.indexOf('DECIDE');
  const lastDecision = decideAt >= 0 ? decideRaw.slice(decideAt).trim().slice(0, 160) : null;
  return {
    pidAlive: flag('PID_ALIVE='),
    logExists: flag('LOG_EXISTS='),
    logAgeSecs: age != null && Number.isFinite(age) && age >= 0 ? Math.floor(age) : null,
    hasDecide: lastDecision != null && lastDecision.length > 0,
    lastDecision,
    hasBlocked: flag('HAS_BLOCKED='),
    hasTimingZero: flag('HAS_TIMING_ZERO='),
  };
}

/**
 * One probe script for checkDelegateStatus: whether the worker pid is the
 * Green loop for this task, and what its log says. The decision is searched
 * in the whole log (a worker can wait hours past its DECIDE and still be
 * working); blocked and timing markers use the last 200 lines. The log is
 * only read when its path is absolute; a relative path is never opened.
 */
function statusScript({ pid, logPath, taskSlug }) {
  const probeLog = typeof logPath === 'string' && logPath.startsWith('/');
  const lines = [
    `pid=${pid}`,
    `log=${probeLog ? q(logPath) : "''"}`,
    `slug=${q(taskSlug)}`,
    'alive=0',
    'if [ -n "$pid" ] && [ "$pid" != "0" ]; then args=$(ps -p "$pid" -o args= 2>/dev/null || true); printf \'%s\' "$args" | grep -qF "loop.py" && printf \'%s\' "$args" | grep -qF "$slug" && alive=1; fi',
    'exists=0; age=""; decide=""; blocked=0; timing=0',
  ];
  if (probeLog) {
    lines.push(
      'if [ -f "$log" ]; then exists=1; now=$(date +%s); mtime=$(stat -c %Y "$log" 2>/dev/null || echo ""); if [ -n "$mtime" ]; then age=$((now - mtime)); fi; tail=$(tail -n 200 "$log" 2>/dev/null || true); decide=$(grep -F " DECIDE " "$log" 2>/dev/null | tail -n 1); blocked=$(printf \'%s\' "$tail" | grep -qE "GREEN_REPAIR_CLOSURE:[[:space:]]*BLOCKED" && echo 1 || echo 0); timing=$(printf \'%s\' "$tail" | grep -qE "TIMING[[:space:]]+green_run=[0-9.]+s[[:space:]]+result=0( |$)" && echo 1 || echo 0); fi',
    );
  }
  lines.push(
    "printf 'PID_ALIVE=%s\\n' \"$alive\"",
    "printf 'LOG_EXISTS=%s\\n' \"$exists\"",
    "printf 'LOG_AGE_SECS=%s\\n' \"$age\"",
    "printf 'DECIDE_LINE=%s\\n' \"$decide\"",
    "printf 'HAS_BLOCKED=%s\\n' \"$blocked\"",
    "printf 'HAS_TIMING_ZERO=%s\\n' \"$timing\"",
    'exit 0',
  );
  return lines.join('\n');
}

/**
 * Fetch one live status for a launched delegation. Returns a status result;
 * a failed probe is a node error, never a status, so the row can keep showing
 * its last known state instead of inventing one.
 */
export async function checkDelegateStatus({ taskSlug, node: nodeInput, pid, logPath }, { run = runNodeExec } = {}) {
  const slug = String(taskSlug ?? '');
  if (!isTaskSlug(slug)) {
    return { ok: false, taskSlug: slug, error: { kind: 'invalid_task', message: `Not a Codimango task slug: ${slug || '(empty)'}.`, fix: 'Pick the task from the panel.' } };
  }
  const node = normalizeDelegateNode(nodeInput);
  if (!node) {
    return { ok: false, taskSlug: slug, error: { kind: 'node_missing', message: 'No devserver was named for this delegation.', fix: 'Enter the devserver node id in the Delegate picker, then try again.' } };
  }
  const pidNum = Number.isInteger(pid) && pid > 0 ? pid : 0;
  let probed;
  try {
    probed = await run({ node, script: statusScript({ pid: pidNum, logPath, taskSlug: slug }), timeoutMs: STATUS_TIMEOUT_MS });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, taskSlug: slug, error: { kind: 'agentcloud_missing', message: 'agentcloudctl is not installed on this Mac.', fix: 'Install agentcloudctl on this Mac, then try again.' } };
    }
    return { ok: false, taskSlug: slug, error: { kind: 'node_error', message: `Could not reach the devserver while checking the worker. ${String(error?.message ?? error)}`, fix: 'Check the devserver connection (agentcloudctl) and try again.' } };
  }
  if (probed.error?.code === 'ENOENT') {
    return { ok: false, taskSlug: slug, error: { kind: 'agentcloud_missing', message: 'agentcloudctl is not installed on this Mac.', fix: 'Install agentcloudctl on this Mac, then try again.' } };
  }
  if (probed.error || probed.code !== 0) {
    return { ok: false, taskSlug: slug, error: { kind: 'node_error', message: `Could not reach the devserver while checking the worker.${tailOf(probed) ? ` ${tailOf(probed)}` : ''}`, fix: 'Check the devserver connection (agentcloudctl) and try again.' } };
  }
  const probe = parseDelegateStatusOutput(probed.stdout ?? '');
  const derived = deriveDelegateStatus(probe);
  return {
    ok: true,
    status: {
      kind: derived.kind,
      taskSlug: slug,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      logPath: typeof logPath === 'string' ? logPath : null,
      lastDecision: derived.lastDecision,
      lastActivityAgeSecs: probe.logAgeSecs,
      checkedAtMs: Date.now(),
    },
  };
}

/**
 * What is handling a task on the devserver, probed rather than remembered:
 * a live worker found by discovery, or the evidence in a saved worker's
 * log, or nothing. The saved pid/log are only the fallback for reading a
 * dead worker's log; a live worker is always found by process discovery,
 * so a lost launch record cannot hide it. The task checkout is resolved
 * best-effort for the lease age only — a missing checkout never makes the
 * probe fail. A failed probe is a node error, never an invented handler.
 */
export async function checkTaskHandler({ taskSlug, node: nodeInput, pid: pidInput, logPath: logPathInput }, { run = runNodeExec } = {}) {
  const slug = String(taskSlug ?? '');
  if (!isTaskSlug(slug)) {
    return { ok: false, taskSlug: slug, error: { kind: 'invalid_task', message: `Not a Codimango task slug: ${slug || '(empty)'}.`, fix: 'Pick the task from the panel.' } };
  }
  const node = normalizeDelegateNode(nodeInput);
  if (!node) {
    return { ok: false, taskSlug: slug, error: { kind: 'node_missing', message: 'No devserver was named for this delegation.', fix: 'Enter the devserver node id in the Delegate picker, then try again.' } };
  }
  const safeRun = async (job) => {
    try {
      return await run({ node, ...job });
    } catch (error) {
      return { code: null, stdout: '', stderr: String(error?.message ?? error), error };
    }
  };
  const noHandler = {
    handler: 'none',
    pid: null,
    logPath: null,
    agent: null,
    kind: null,
    lastDecision: null,
    lastActivityAgeSecs: null,
    waitingMins: null,
    waitingReason: null,
    blockedReason: null,
    hasBlocked: false,
    hasTimingZero: false,
    leaseAgeSecs: null,
    checkedAtMs: Date.now(),
  };

  let repo = null;
  const shown = await safeRun({ script: taskShowScript(slug), timeoutMs: TASK_SHOW_TIMEOUT_MS });
  if (shown.error?.code === 'ENOENT') {
    return { ok: false, taskSlug: slug, error: { kind: 'agentcloud_missing', message: 'agentcloudctl is not installed on this Mac.', fix: 'Install agentcloudctl on this Mac, then try again.' } };
  }
  if (shown.error) return { ok: false, taskSlug: slug, error: nodeError(slug, shown, 'reading the task').error };
  if (shown.code === 0) {
    const repoName = repoDirName(parseTaskShow(shown.stdout));
    if (repoName) {
      const verified = await safeRun({ script: verifyRepoScript(repoName), timeoutMs: VERIFY_TIMEOUT_MS });
      if (!verified.error && verified.code === 0) {
        const lines = String(verified.stdout ?? '').trim().split('\n');
        const top = lines[0]?.trim() ?? '';
        const remote = lines[1]?.trim() ?? '';
        if (top && remote.includes(repoName)) repo = top;
      }
    }
  }

  const existing = await discoverExistingWorker(slug, safeRun);
  const savedPid = Number.isInteger(pidInput) && pidInput > 0 ? pidInput : null;
  const savedLog = typeof logPathInput === 'string' && logPathInput.startsWith('/') ? logPathInput : null;
  const probePid = existing?.pid ?? savedPid;
  const probeLog = existing?.logPath ?? savedLog;
  if (!probePid || !probeLog) {
    return { ok: true, probe: noHandler };
  }
  const statusRes = await checkDelegateStatus({ taskSlug: slug, node, pid: probePid, logPath: probeLog }, { run });
  if (!statusRes.ok) return { ok: false, taskSlug: slug, error: statusRes.error };
  const status = statusRes.status;
  let detail = { waitingActive: false, waitingMins: null, waitingReason: null, blockedReason: null, hasBlocked: false };
  const detailed = await safeRun({ script: logDetailScript(probeLog), timeoutMs: STATUS_TIMEOUT_MS });
  if (!detailed.error && detailed.code === 0) detail = parseLogDetailOutput(detailed.stdout ?? '');
  let leaseAgeSecs = null;
  if (existing && repo) {
    const leased = await safeRun({ cwd: repo, script: leaseAgeScript(slug), timeoutMs: VERIFY_TIMEOUT_MS });
    if (!leased.error && leased.code === 0) leaseAgeSecs = parseLeaseAge(leased.stdout ?? '');
  }
  return {
    ok: true,
    probe: {
      handler: existing ? 'green' : 'none',
      pid: probePid,
      logPath: probeLog,
      agent: existing?.agent ?? null,
      kind: status.kind,
      lastDecision: status.lastDecision ?? null,
      lastActivityAgeSecs: status.lastActivityAgeSecs ?? null,
      waitingMins: detail.waitingActive ? detail.waitingMins : null,
      waitingReason: detail.waitingActive ? detail.waitingReason : null,
      blockedReason: status.kind === 'blocked' ? detail.blockedReason : null,
      hasBlocked: detail.hasBlocked || status.kind === 'blocked',
      hasTimingZero: status.kind === 'done',
      leaseAgeSecs,
      checkedAtMs: Date.now(),
    },
  };
}

/** Whether a pid is this task's Green loop, from its command line. */
export function parseWorkerAliveOutput(text) {
  return String(text ?? '')
    .split('\n')
    .some((l) => l.trim() === 'WORKER_ALIVE=1');
}

function workerAliveScript(pid, slug) {
  return [
    '# mochi-verify-worker',
    `pid=${pid}`,
    `slug=${q(slug)}`,
    'args=$(ps -p "$pid" -o args= 2>/dev/null || true)',
    'alive=0',
    'case "$args" in *loop.py*"$slug"*) alive=1;; esac',
    "printf 'WORKER_ALIVE=%s\\n' \"$alive\"",
    'exit 0',
  ].join('\n');
}

function stopWorkerScript(pid) {
  return `# mochi-stop-worker\nkill ${pid}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stop a Green worker, and only a Green worker: the pid is verified to be
 * this task's loop.py before any signal, it is sent SIGTERM (never SIGKILL),
 * and the stop is confirmed by re-probing. A worker that survives TERM is
 * reported, never escalated to. Returns a failure, never throws, so the
 * renderer always gets an answer.
 */
export async function stopGreenWorker({ taskSlug, node: nodeInput, pid: pidInput }, { run = runNodeExec, pollIntervalMs = 1000, maxPolls = 10 } = {}) {
  const slug = String(taskSlug ?? '');
  if (!isTaskSlug(slug)) {
    return { ok: false, taskSlug: slug, error: { kind: 'invalid_task', message: `Not a Codimango task slug: ${slug || '(empty)'}.`, fix: 'Pick the task from the panel.' } };
  }
  const node = normalizeDelegateNode(nodeInput);
  if (!node) {
    return { ok: false, taskSlug: slug, error: { kind: 'node_missing', message: 'No devserver was named for this delegation.', fix: 'Enter the devserver node id in the Delegate picker, then try again.' } };
  }
  const pid = Number.isInteger(pidInput) && pidInput > 0 ? pidInput : null;
  if (!pid) {
    return { ok: false, taskSlug: slug, error: { kind: 'invalid_pid', message: 'No Green worker pid was given to stop.', fix: 'Pick the running worker from the panel.' } };
  }
  const safeRun = async (job) => {
    try {
      return await run({ node, ...job });
    } catch (error) {
      return { code: null, stdout: '', stderr: String(error?.message ?? error), error };
    }
  };
  const checkAlive = async () => {
    const verified = await safeRun({ script: workerAliveScript(pid, slug), timeoutMs: STATUS_TIMEOUT_MS });
    if (verified.error) return { spawnError: verified.error, result: verified };
    if (verified.code !== 0) return { spawnError: null, result: verified, alive: false, failed: true };
    return { spawnError: null, result: verified, alive: parseWorkerAliveOutput(verified.stdout ?? ''), failed: false };
  };
  const verified = await checkAlive();
  if (verified.spawnError) {
    if (verified.spawnError.code === 'ENOENT') {
      return { ok: false, taskSlug: slug, error: { kind: 'agentcloud_missing', message: 'agentcloudctl is not installed on this Mac.', fix: 'Install agentcloudctl on this Mac, then try again.' } };
    }
    return { ok: false, taskSlug: slug, error: nodeError(slug, verified.result, 'checking the worker').error };
  }
  if (!verified.alive) {
    return { ok: false, taskSlug: slug, pid, error: { kind: 'not_a_worker', message: `No Green worker with pid ${pid} is running for ${slug}.`, fix: 'The worker may already have stopped; check the status again.' } };
  }
  const killed = await safeRun({ script: stopWorkerScript(pid), timeoutMs: STATUS_TIMEOUT_MS });
  if (killed.error) return { ok: false, taskSlug: slug, pid, error: nodeError(slug, killed, 'stopping the worker').error };
  if (killed.code !== 0) {
    return { ok: false, taskSlug: slug, pid, error: { kind: 'stop_failed', message: `Could not stop the Green worker with pid ${pid}.`, fix: 'Check the worker on the devserver, then try again.' } };
  }
  let stopped = false;
  for (let i = 0; i < maxPolls; i += 1) {
    await sleep(pollIntervalMs);
    const polled = await checkAlive();
    if (polled.spawnError) return { ok: false, taskSlug: slug, pid, error: nodeError(slug, polled.result, 'checking the worker').error };
    if (!polled.alive && !polled.failed) {
      stopped = true;
      break;
    }
  }
  if (!stopped) {
    return { ok: false, taskSlug: slug, pid, error: { kind: 'stop_failed', message: `The Green worker with pid ${pid} is still running after SIGTERM.`, fix: 'Check the worker on the devserver before trying again; it was not sent SIGKILL.' } };
  }
  const holder = await discoverExistingWorker(slug, safeRun);
  if (holder) {
    return { ok: false, taskSlug: slug, pid, error: { kind: 'stop_failed', message: `Another Green worker (pid ${holder.pid}) now holds the lease for ${slug}.`, fix: 'Check the status again before delegating.' } };
  }
  return { ok: true, taskSlug: slug, pid, stopped: true };
}

/**
 * The devserver's Docker install environment, off one probe: the Docker
 * binary, whether the daemon answers this user, the OS, the package
 * managers, systemctl, and whether sudo works without a password prompt.
 */
export function parseDockerProbeOutput(text) {
  const lines = String(text ?? '').split('\n');
  const valueOf = (prefix) => {
    const line = lines.find((l) => l.startsWith(prefix));
    return line == null ? null : line.slice(prefix.length).trim();
  };
  const flag = (prefix) => valueOf(prefix) === '1';
  const bin = valueOf('DOCKER_BIN=');
  const dockerBin = bin && bin.startsWith('/') ? bin : null;
  return {
    dockerBin,
    daemonReachable: flag('DOCKER_DAEMON=') && dockerBin != null,
    osId: valueOf('OS_ID=') || null,
    hasDnf: flag('HAS_DNF='),
    hasYum: flag('HAS_YUM='),
    hasApt: flag('HAS_APT='),
    hasSystemctl: flag('HAS_SYSTEMCTL='),
    sudoOk: flag('SUDO_OK='),
  };
}

function dockerProbeScript() {
  return [
    '# mochi-docker-probe',
    'printf \'DOCKER_BIN=%s\\n\' "$(command -v docker || true)"',
    'if docker info >/dev/null 2>&1; then printf \'DOCKER_DAEMON=1\\n\'; else printf \'DOCKER_DAEMON=0\\n\'; fi',
    'osid=""; if [ -f /etc/os-release ]; then osid=$(. /etc/os-release; printf \'%s\' "${ID:-}"); fi',
    'printf \'OS_ID=%s\\n\' "$osid"',
    'if command -v dnf >/dev/null 2>&1; then printf \'HAS_DNF=1\\n\'; else printf \'HAS_DNF=0\\n\'; fi',
    'if command -v yum >/dev/null 2>&1; then printf \'HAS_YUM=1\\n\'; else printf \'HAS_YUM=0\\n\'; fi',
    'if command -v apt-get >/dev/null 2>&1; then printf \'HAS_APT=1\\n\'; else printf \'HAS_APT=0\\n\'; fi',
    'if command -v systemctl >/dev/null 2>&1; then printf \'HAS_SYSTEMCTL=1\\n\'; else printf \'HAS_SYSTEMCTL=0\\n\'; fi',
    'if sudo -n true >/dev/null 2>&1; then printf \'SUDO_OK=1\\n\'; else printf \'SUDO_OK=0\\n\'; fi',
    'exit 0',
  ].join('\n');
}

function dockerInstallScript(manager) {
  if (manager === 'apt') {
    return '# mochi-docker-install\nsudo -n apt-get update && sudo -n apt-get install -y docker.io';
  }
  const tool = manager === 'yum' ? 'yum' : 'dnf';
  return `# mochi-docker-install\nsudo -n ${tool} install -y docker-ce docker-ce-cli containerd.io`;
}

function dockerDaemonScript() {
  return '# mochi-docker-daemon\nsudo -n systemctl enable --now docker';
}

function dockerGroupScript() {
  return '# mochi-docker-group\nsudo -n usermod -aG docker "$(id -un)"';
}

function dockerSudoInfoScript() {
  return '# mochi-docker-sudo-info\nsudo -n docker info >/dev/null 2>&1';
}

const DOCKER_INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Install Docker on the devserver, only ever as an explicit user action:
 * probe first (already installed means no privileged step runs), then
 * sudo install, daemon start, and docker-group membership, verified by
 * re-probing. sudo must work without a password prompt — a password prompt
 * would hang a non-interactive exec, so a sudo failure is reported instead
 * of attempted. Nothing here guesses a package manager: an unsupported
 * system fails closed with manual instructions. Never throws.
 */
export async function installDocker({ taskSlug, node: nodeInput }, { run = runNodeExec } = {}) {
  const slug = String(taskSlug ?? '');
  if (!isTaskSlug(slug)) {
    return { ok: false, taskSlug: slug, error: { kind: 'invalid_task', message: `Not a Codimango task slug: ${slug || '(empty)'}.`, fix: 'Pick the task from the panel.' } };
  }
  const node = normalizeDelegateNode(nodeInput);
  if (!node) {
    return { ok: false, taskSlug: slug, error: { kind: 'node_missing', message: 'No devserver was named for this delegation.', fix: 'Enter the devserver node id in the Delegate picker, then try again.' } };
  }
  const safeRun = async (job) => {
    try {
      return await run({ node, ...job });
    } catch (error) {
      return { code: null, stdout: '', stderr: String(error?.message ?? error), error };
    }
  };
  const failInstall = (kind, message, fix, extra) => ({ ok: false, taskSlug: slug, error: { kind, message, fix }, ...(extra ?? {}) });
  const probeDocker = async () => {
    const probed = await safeRun({ script: dockerProbeScript(), timeoutMs: STATUS_TIMEOUT_MS });
    if (probed.error?.code === 'ENOENT') return { probeError: { kind: 'agentcloud_missing', message: 'agentcloudctl is not installed on this Mac.', fix: 'Install agentcloudctl on this Mac, then try again.' } };
    if (probed.error || probed.code !== 0) {
      return { probeError: { kind: 'node_error', message: `Could not reach the devserver while checking Docker.${tailOf(probed) ? ` ${tailOf(probed)}` : ''}`, fix: 'Check the devserver connection (agentcloudctl) and try again.' } };
    }
    return { env: parseDockerProbeOutput(probed.stdout ?? '') };
  };

  const first = await probeDocker();
  if (first.probeError) return failInstall(first.probeError.kind, first.probeError.message, first.probeError.fix);
  const env = first.env;
  if (env.dockerBin && env.daemonReachable) {
    return { ok: true, taskSlug: slug, alreadyInstalled: true, daemonReachable: true };
  }
  if (!env.sudoOk) {
    return failInstall('sudo_required', 'Docker install needs passwordless sudo on the devserver.', 'Run the install yourself with sudo, or ask for sudo access on the devserver, then try again.');
  }
  const manager = env.hasDnf ? 'dnf' : env.hasYum ? 'yum' : env.hasApt ? 'apt' : null;
  if (!manager) {
    return failInstall('unsupported_os', 'Docker install is not supported on this devserver.', 'Install Docker with the devserver\u2019s package manager, then delegate again.');
  }
  if (!env.hasSystemctl) {
    return failInstall('daemon_failed', 'Docker cannot be started here: systemctl is not available on the devserver.', 'Start the Docker daemon by hand on the devserver, then delegate again.');
  }
  if (!env.dockerBin) {
    const installed = await safeRun({ script: dockerInstallScript(manager), timeoutMs: DOCKER_INSTALL_TIMEOUT_MS });
    if (installed.error?.code === 'ENOENT') return failInstall('agentcloud_missing', 'agentcloudctl is not installed on this Mac.', 'Install agentcloudctl on this Mac, then try again.');
    if (installed.error || installed.code !== 0) {
      return failInstall('install_failed', 'Docker install failed on the devserver.', 'Install Docker by hand on the devserver, then delegate again.');
    }
  }
  const daemoned = await safeRun({ script: dockerDaemonScript(), timeoutMs: VERIFY_TIMEOUT_MS });
  if (daemoned.error?.code === 'ENOENT') return failInstall('agentcloud_missing', 'agentcloudctl is not installed on this Mac.', 'Install agentcloudctl on this Mac, then try again.');
  if (daemoned.error || daemoned.code !== 0) {
    return failInstall('daemon_failed', 'Docker is installed, but the daemon would not start.', 'Start the Docker daemon by hand on the devserver, then delegate again.');
  }
  const grouped = await safeRun({ script: dockerGroupScript(), timeoutMs: VERIFY_TIMEOUT_MS });
  if (grouped.error?.code === 'ENOENT') return failInstall('agentcloud_missing', 'agentcloudctl is not installed on this Mac.', 'Install agentcloudctl on this Mac, then try again.');
  if (grouped.error || grouped.code !== 0) {
    return failInstall('install_failed', 'Docker install failed while adding your user to the docker group.', 'Add your user to the docker group by hand on the devserver, then delegate again.');
  }
  const second = await probeDocker();
  if (second.probeError) return failInstall(second.probeError.kind, second.probeError.message, second.probeError.fix);
  if (second.env.dockerBin && second.env.daemonReachable) {
    return { ok: true, taskSlug: slug, daemonReachable: true };
  }
  if (second.env.dockerBin) {
    const sudoInfo = await safeRun({ script: dockerSudoInfoScript(), timeoutMs: STATUS_TIMEOUT_MS });
    if (!sudoInfo.error && sudoInfo.code === 0) {
      return failInstall(
        'docker_permission',
        'Docker is installed and the daemon is running, but your user cannot reach it yet.',
        'Reconnect to the devserver so the docker group applies, then check again.',
        { needsRelogin: true },
      );
    }
  }
  return failInstall('daemon_failed', 'Docker was installed, but the daemon is still not reachable.', 'Start the Docker daemon by hand on the devserver, then delegate again.');
}

export function runNodeExec({ node, cwd, script, timeoutMs }, spawnImpl = spawn) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    try {
      const args = ['node', 'exec', '--node', node, ...(cwd ? ['--cwd', cwd] : []), '--', 'bash', '-c', script];
      child = spawnImpl(AGENTCLOUD_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error });
      return;
    }
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      child?.kill('SIGTERM');
    }, timeoutMs) : null;
    timer?.unref?.();
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error });
    });
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function tailOf(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-500).trim();
}

function fail(taskSlug, kind, message, fix, agent = 'codex') {
  return { ok: false, taskSlug, agent, error: { kind, message, ...(fix ? { fix } : {}) } };
}

function nodeError(taskSlug, result, step, agent = 'codex') {
  const detail = result.error ? String(result.error.message ?? result.error) : tailOf(result);
  return fail(taskSlug, 'node_error', `Could not reach the devserver while ${step}.${detail ? ` ${detail}` : ''}`, 'Check the devserver connection (agentcloudctl) and try again.', agent);
}

/**
 * Delegate one task to Green on the devserver. Everything that touches the
 * system goes through `run`, injectable for tests. Returns the launch result
 * (or a classified failure); it never throws, so the renderer always gets an
 * answer it can show.
 */
export async function delegateToGreen({ taskSlug, node: nodeInput, agent: agentInput }, { run = runNodeExec } = {}) {
  const slug = String(taskSlug ?? '');
  if (!isTaskSlug(slug)) {
    return fail(slug, 'invalid_task', `Not a Codimango task slug: ${slug || '(empty)'}.`, 'Pick the task from the panel.');
  }
  /* No agent named means the old Codex-only caller: default to Codex. A
     named agent that Green does not accept fails closed before any run,
     reporting the default agent so the picker can offer a valid choice. */
  const agent =
    agentInput === undefined || agentInput === null || agentInput === ''
      ? 'codex'
      : isDelegateAgent(agentInput)
        ? agentInput
        : null;
  if (!agent) {
    return fail(slug, 'invalid_agent', `Not a Green repair agent: ${String(agentInput)}.`, 'Choose Muse or Codex in the Delegate picker.');
  }
  const failFor = (kind, message, fix) => fail(slug, kind, message, fix, agent);
  const nodeErrorFor = (result, step) => nodeError(slug, result, step, agent);
  const node = normalizeDelegateNode(nodeInput);
  if (!node) {
    return failFor('node_missing', 'No devserver was named for this delegation.', 'Enter the devserver node id in the Delegate picker, then try again.');
  }
  const safeRun = async (job) => {
    try {
      return await run({ node, ...job });
    } catch (error) {
      return { code: null, stdout: '', stderr: String(error?.message ?? error), error };
    }
  };

  const checked = await safeRun({ script: checkGreenScript(), timeoutMs: CHECK_TIMEOUT_MS });
  if (checked.error?.code === 'ENOENT') {
    return failFor('agentcloud_missing', 'agentcloudctl is not installed on this Mac.', 'Install agentcloudctl on this Mac, then try again.');
  }
  if (checked.error) return nodeErrorFor(checked, 'checking Green');
  if (checked.code !== 0) {
    const installed = await safeRun({ script: installGreenScript(agent), timeoutMs: INSTALL_TIMEOUT_MS });
    if (installed.error?.code === 'ENOENT') {
      return failFor('agentcloud_missing', 'agentcloudctl is not installed on this Mac.', 'Install agentcloudctl on this Mac, then try again.');
    }
    const rechecked = await safeRun({ script: checkGreenScript(), timeoutMs: CHECK_TIMEOUT_MS });
    if (rechecked.error) return nodeErrorFor(rechecked, 'checking Green');
    if (rechecked.code !== 0) {
      return failFor(
        'green_missing',
        `Green is not installed on the devserver.${tailOf(installed) ? ` ${tailOf(installed)}` : ''}`,
        `agent-market skill install green --agent ${agent} --scope user --force`,
      );
    }
  }

  const shown = await safeRun({ script: taskShowScript(slug), timeoutMs: TASK_SHOW_TIMEOUT_MS });
  if (shown.error) return nodeErrorFor(shown, 'reading the task');
  if (shown.code !== 0) {
    return failFor('repo_not_found', `Could not read task ${slug} on the devserver.${tailOf(shown) ? ` ${tailOf(shown)}` : ''}`, 'Check the devserver connection and that the task exists.');
  }
  const sourceRepo = parseTaskShow(shown.stdout);
  const repoName = sourceRepo ? repoDirName(sourceRepo) : null;
  if (!repoName) {
    return failFor('repo_not_found', `Could not find a source repository for task ${slug}.`, 'Open the task in Codimango to confirm its repository.');
  }
  const expected = `~/AAI/${repoName}`;
  const exists = await safeRun({ script: repoExistsScript(repoName), timeoutMs: VERIFY_TIMEOUT_MS });
  if (exists.error) return nodeErrorFor(exists, 'checking the task checkout');
  if (exists.code !== 0) {
    const url = cloneSshUrl(sourceRepo);
    if (!url) {
      return failFor('repo_not_found', `Task checkout not found: expected ${expected} on the devserver, pointing at the task repository.`, `Clone the task repository to ${expected} on the devserver, then try again.`);
    }
    const cloned = await safeRun({ script: cloneScript(url, repoName), timeoutMs: CLONE_TIMEOUT_MS });
    if (cloned.error) return nodeErrorFor(cloned, 'cloning the task repository');
    if (cloned.code !== 0) {
      return failFor(
        'repo_not_found',
        `Could not clone the task repository to ${expected}.${tailOf(cloned) ? ` ${tailOf(cloned)}` : ''}`,
        `Clone it manually: git clone ${url} ${expected}`,
      );
    }
  }
  const verified = await safeRun({ script: verifyRepoScript(repoName), timeoutMs: VERIFY_TIMEOUT_MS });
  if (verified.error) return nodeErrorFor(verified, 'verifying the task checkout');
  const lines = String(verified.stdout ?? '').trim().split('\n');
  const repo = lines[0]?.trim() ?? '';
  const remote = lines[1]?.trim() ?? '';
  if (verified.code !== 0 || !repo || !remote.includes(repoName)) {
    return failFor(
      'repo_not_found',
      `Task checkout not found: expected ${expected} on the devserver, pointing at the task repository.`,
      `Clone the task repository to ${expected} on the devserver, then try again.`,
    );
  }

  const dirChecked = await safeRun({ script: taskDirScript(repo, slug), timeoutMs: VERIFY_TIMEOUT_MS });
  if (dirChecked.error) return nodeErrorFor(dirChecked, 'checking the task directory');
  if (dirChecked.code !== 0) {
    // A stale checkout is the common cause: the task directory may exist at
    // origin/main even though this checkout predates it. Only a fast-forward
    // is ever applied, so local work is never overwritten or rebased away.
    const updated = await safeRun({ cwd: repo, script: updateCheckoutScript(), timeoutMs: UPDATE_TIMEOUT_MS });
    if (updated.error) return nodeErrorFor(updated, 'updating the task checkout');
    if (updated.code !== 0) {
      return failFor(
        'checkout_stale',
        `Task checkout is behind: ${repo} could not fast-forward to origin/main, and the task directory is missing.${tailOf(updated) ? ` ${tailOf(updated)}` : ''}`,
        `Run git pull in ${repo} yourself (after saving any local work), then try again.`,
      );
    }
    const rechecked = await safeRun({ script: taskDirScript(repo, slug), timeoutMs: VERIFY_TIMEOUT_MS });
    if (rechecked.error) return nodeErrorFor(rechecked, 'checking the task directory');
    if (rechecked.code !== 0) {
      const commit = taskCommitSha(shown.stdout);
      const taskDir = `${repo}/${slug}`;
      return failFor(
        'task_dir_missing',
        `Task directory not found: ${taskDir} is missing from this checkout even after fast-forwarding to origin/main.${commit ? ` It exists at the task's commit ${commit}.` : ''}`,
        commit
          ? `Check out commit ${commit} in ${repo} (or restore ${slug} there), then try again.`
          : `Restore ${slug} in ${repo}, then try again.`,
      );
    }
  }

  const doctored = await safeRun({ cwd: repo, script: doctorScript(), timeoutMs: DOCTOR_TIMEOUT_MS });
  if (doctored.error) return nodeErrorFor(doctored, 'running Green doctor');
  if (doctored.code !== 0 || doctored.timedOut) {
    const doctorOutput = `${doctored.stdout ?? ''}\n${doctored.stderr ?? ''}`;
    if (parseDoctorOutput(doctorOutput).dockerMissing) {
      return {
        ok: false,
        taskSlug: slug,
        agent,
        error: {
          kind: 'doctor_failed',
          check: 'docker',
          message: 'Green doctor failed: Docker is missing on the devserver.',
          fix: 'Install Docker on the devserver — local task proof needs it — then delegate again.',
        },
      };
    }
    return failFor(
      'doctor_failed',
      `Green doctor failed in ${repo}.${tailOf(doctored) ? ` ${tailOf(doctored)}` : ''}`,
      'Run doctor --install-hooks in the task checkout on the devserver.',
    );
  }

  const launched = await safeRun({ cwd: repo, script: launchScript(slug, repo, agent), timeoutMs: LAUNCH_TIMEOUT_MS });
  if (launched.error) return nodeErrorFor(launched, 'launching Green');
  const started = parseGreenStarted(launched.stdout ?? '');
  if (launched.code !== 0 && !launched.timedOut) {
    // A refusal by the remote lease proves a worker is already running this
    // task: find it on the devserver and report it, so the row shows that
    // worker's live status instead of a failure that would overwrite any
    // record of it. The refusing worker's own pid and log are not the
    // holder's, so they are never reported here.
    if (/holds the remote lease/i.test(tailOf(launched))) {
      const existing = await discoverExistingWorker(slug, safeRun);
      if (existing) {
        return {
          ok: true,
          taskSlug: slug,
          agent: existing.agent ?? agent,
          repo,
          pid: existing.pid,
          logPath: existing.logPath,
          decision: null,
          alreadyRunning: true,
        };
      }
    }
    return failFor('launch_failed', `Green failed to start for ${slug}.${tailOf(launched) ? ` ${tailOf(launched)}` : ''}`, 'Check the task is not already running Green, then try again.');
  }
  if (launched.timedOut && !started.pid && !started.logPath) {
    return failFor('launch_failed', 'Green did not report a worker within 15 minutes of launching.', 'Check the devserver for a running Green worker before trying again.');
  }
  const result = {
    ok: true,
    taskSlug: slug,
    agent,
    repo,
    pid: started.pid,
    logPath: started.logPath,
    decision: started.decision,
  };
  if (launched.timedOut) result.timedOut = true;
  return result;
}
