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
 * install the push guard, then launch detached with Codex. Nothing here
 * guesses a repo path: a missing or mismatched checkout fails closed with
 * the expected path, and a task directory still missing after a fast-forward
 * fails closed naming the task's commit instead of letting Green refuse
 * cryptically at launch. The saved order of steps matters: doctor must run
 * before any live launch, and no launch happens after any failure. Only a
 * fast-forward merge is ever applied to a checkout (never a rebase or a
 * checkout of another commit), and only cloning creates a new checkout.
 *
 * Failures come back as one of: invalid_task, node_missing,
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

function installGreenScript() {
  return 'agent-market skill install green --agent codex --scope user --force';
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

function launchScript(slug, repo) {
  return `python3 "${GREEN_CLI}" ${q(slug)} --repo ${q(repo)} --live --hardening --detach --agent codex`;
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
 * Green loop for this task, and what the last 200 log lines say. The log is
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
      'if [ -f "$log" ]; then exists=1; now=$(date +%s); mtime=$(stat -c %Y "$log" 2>/dev/null || echo ""); if [ -n "$mtime" ]; then age=$((now - mtime)); fi; tail=$(tail -n 200 "$log" 2>/dev/null || true); decide=$(printf \'%s\' "$tail" | grep -F " DECIDE " | tail -n 1); blocked=$(printf \'%s\' "$tail" | grep -qE "GREEN_REPAIR_CLOSURE:[[:space:]]*BLOCKED" && echo 1 || echo 0); timing=$(printf \'%s\' "$tail" | grep -qE "TIMING[[:space:]]+green_run=[0-9.]+s[[:space:]]+result=0( |$)" && echo 1 || echo 0); fi',
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

function fail(taskSlug, kind, message, fix) {
  return { ok: false, taskSlug, agent: 'codex', error: { kind, message, ...(fix ? { fix } : {}) } };
}

function nodeError(taskSlug, result, step) {
  const detail = result.error ? String(result.error.message ?? result.error) : tailOf(result);
  return fail(taskSlug, 'node_error', `Could not reach the devserver while ${step}.${detail ? ` ${detail}` : ''}`, 'Check the devserver connection (agentcloudctl) and try again.');
}

/**
 * Delegate one task to Green on the devserver. Everything that touches the
 * system goes through `run`, injectable for tests. Returns the launch result
 * (or a classified failure); it never throws, so the renderer always gets an
 * answer it can show.
 */
export async function delegateToGreen({ taskSlug, node: nodeInput }, { run = runNodeExec } = {}) {
  const slug = String(taskSlug ?? '');
  if (!isTaskSlug(slug)) {
    return fail(slug, 'invalid_task', `Not a Codimango task slug: ${slug || '(empty)'}.`, 'Pick the task from the panel.');
  }
  const node = normalizeDelegateNode(nodeInput);
  if (!node) {
    return fail(slug, 'node_missing', 'No devserver was named for this delegation.', 'Enter the devserver node id in the Delegate picker, then try again.');
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
    return fail(slug, 'agentcloud_missing', 'agentcloudctl is not installed on this Mac.', 'Install agentcloudctl on this Mac, then try again.');
  }
  if (checked.error) return nodeError(slug, checked, 'checking Green');
  if (checked.code !== 0) {
    const installed = await safeRun({ script: installGreenScript(), timeoutMs: INSTALL_TIMEOUT_MS });
    if (installed.error?.code === 'ENOENT') {
      return fail(slug, 'agentcloud_missing', 'agentcloudctl is not installed on this Mac.', 'Install agentcloudctl on this Mac, then try again.');
    }
    const rechecked = await safeRun({ script: checkGreenScript(), timeoutMs: CHECK_TIMEOUT_MS });
    if (rechecked.error) return nodeError(slug, rechecked, 'checking Green');
    if (rechecked.code !== 0) {
      return fail(
        slug,
        'green_missing',
        `Green is not installed on the devserver.${tailOf(installed) ? ` ${tailOf(installed)}` : ''}`,
        'agent-market skill install green --agent codex --scope user --force',
      );
    }
  }

  const shown = await safeRun({ script: taskShowScript(slug), timeoutMs: TASK_SHOW_TIMEOUT_MS });
  if (shown.error) return nodeError(slug, shown, 'reading the task');
  if (shown.code !== 0) {
    return fail(slug, 'repo_not_found', `Could not read task ${slug} on the devserver.${tailOf(shown) ? ` ${tailOf(shown)}` : ''}`, 'Check the devserver connection and that the task exists.');
  }
  const sourceRepo = parseTaskShow(shown.stdout);
  const repoName = sourceRepo ? repoDirName(sourceRepo) : null;
  if (!repoName) {
    return fail(slug, 'repo_not_found', `Could not find a source repository for task ${slug}.`, 'Open the task in Codimango to confirm its repository.');
  }
  const expected = `~/AAI/${repoName}`;
  const exists = await safeRun({ script: repoExistsScript(repoName), timeoutMs: VERIFY_TIMEOUT_MS });
  if (exists.error) return nodeError(slug, exists, 'checking the task checkout');
  if (exists.code !== 0) {
    const url = cloneSshUrl(sourceRepo);
    if (!url) {
      return fail(slug, 'repo_not_found', `Task checkout not found: expected ${expected} on the devserver, pointing at the task repository.`, `Clone the task repository to ${expected} on the devserver, then try again.`);
    }
    const cloned = await safeRun({ script: cloneScript(url, repoName), timeoutMs: CLONE_TIMEOUT_MS });
    if (cloned.error) return nodeError(slug, cloned, 'cloning the task repository');
    if (cloned.code !== 0) {
      return fail(
        slug,
        'repo_not_found',
        `Could not clone the task repository to ${expected}.${tailOf(cloned) ? ` ${tailOf(cloned)}` : ''}`,
        `Clone it manually: git clone ${url} ${expected}`,
      );
    }
  }
  const verified = await safeRun({ script: verifyRepoScript(repoName), timeoutMs: VERIFY_TIMEOUT_MS });
  if (verified.error) return nodeError(slug, verified, 'verifying the task checkout');
  const lines = String(verified.stdout ?? '').trim().split('\n');
  const repo = lines[0]?.trim() ?? '';
  const remote = lines[1]?.trim() ?? '';
  if (verified.code !== 0 || !repo || !remote.includes(repoName)) {
    return fail(
      slug,
      'repo_not_found',
      `Task checkout not found: expected ${expected} on the devserver, pointing at the task repository.`,
      `Clone the task repository to ${expected} on the devserver, then try again.`,
    );
  }

  const dirChecked = await safeRun({ script: taskDirScript(repo, slug), timeoutMs: VERIFY_TIMEOUT_MS });
  if (dirChecked.error) return nodeError(slug, dirChecked, 'checking the task directory');
  if (dirChecked.code !== 0) {
    // A stale checkout is the common cause: the task directory may exist at
    // origin/main even though this checkout predates it. Only a fast-forward
    // is ever applied, so local work is never overwritten or rebased away.
    const updated = await safeRun({ cwd: repo, script: updateCheckoutScript(), timeoutMs: UPDATE_TIMEOUT_MS });
    if (updated.error) return nodeError(slug, updated, 'updating the task checkout');
    if (updated.code !== 0) {
      return fail(
        slug,
        'checkout_stale',
        `Task checkout is behind: ${repo} could not fast-forward to origin/main, and the task directory is missing.${tailOf(updated) ? ` ${tailOf(updated)}` : ''}`,
        `Run git pull in ${repo} yourself (after saving any local work), then try again.`,
      );
    }
    const rechecked = await safeRun({ script: taskDirScript(repo, slug), timeoutMs: VERIFY_TIMEOUT_MS });
    if (rechecked.error) return nodeError(slug, rechecked, 'checking the task directory');
    if (rechecked.code !== 0) {
      const commit = taskCommitSha(shown.stdout);
      const taskDir = `${repo}/${slug}`;
      return fail(
        slug,
        'task_dir_missing',
        `Task directory not found: ${taskDir} is missing from this checkout even after fast-forwarding to origin/main.${commit ? ` It exists at the task's commit ${commit}.` : ''}`,
        commit
          ? `Check out commit ${commit} in ${repo} (or restore ${slug} there), then try again.`
          : `Restore ${slug} in ${repo}, then try again.`,
      );
    }
  }

  const doctored = await safeRun({ cwd: repo, script: doctorScript(), timeoutMs: DOCTOR_TIMEOUT_MS });
  if (doctored.error) return nodeError(slug, doctored, 'running Green doctor');
  if (doctored.code !== 0 || doctored.timedOut) {
    return fail(
      slug,
      'doctor_failed',
      `Green doctor failed in ${repo}.${tailOf(doctored) ? ` ${tailOf(doctored)}` : ''}`,
      'Run doctor --install-hooks in the task checkout on the devserver.',
    );
  }

  const launched = await safeRun({ cwd: repo, script: launchScript(slug, repo), timeoutMs: LAUNCH_TIMEOUT_MS });
  if (launched.error) return nodeError(slug, launched, 'launching Green');
  const started = parseGreenStarted(launched.stdout ?? '');
  if (launched.code !== 0 && !launched.timedOut) {
    return fail(slug, 'launch_failed', `Green failed to start for ${slug}.${tailOf(launched) ? ` ${tailOf(launched)}` : ''}`, 'Check the task is not already running Green, then try again.');
  }
  if (launched.timedOut && !started.pid && !started.logPath) {
    return fail(slug, 'launch_failed', 'Green did not report a worker within 15 minutes of launching.', 'Check the devserver for a running Green worker before trying again.');
  }
  const result = {
    ok: true,
    taskSlug: slug,
    agent: 'codex',
    repo,
    pid: started.pid,
    logPath: started.logPath,
    decision: started.decision,
  };
  if (launched.timedOut) result.timedOut = true;
  return result;
}
