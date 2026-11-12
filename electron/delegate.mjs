/* Delegate a "needs revision" task to Green on the devserver (main process only).
 *
 * Green drives one Codimango task to green: it reads the task's validation
 * state, hands the failing checks to a repair agent, proves the repair
 * locally, pushes, and waits for validation. Mochi launches it detached and
 * reports the worker pid and log path; the worker keeps going on its own.
 * Mochi never hand-writes a repair prompt: Green authors the repair prompt
 * from the task findings itself.
 *
 * Launching runs through agentcloudctl on the devserver the user owns
 * (devvm7438): check Green is installed there (install it if needed), resolve
 * the task repo from the task's sourceRepo and verify the checkout, check the
 * task directory exists in that checkout, run Green's doctor to install the
 * push guard, then launch detached with Codex. Nothing here guesses a repo
 * path: a missing or mismatched checkout fails closed with the expected path,
 * and a missing task directory fails closed naming the task's commit instead
 * of letting Green refuse cryptically at launch. The saved order of steps
 * matters: doctor must run before any live launch, and no launch happens
 * after any failure.
 *
 * Failures come back as one of: invalid_task, agentcloud_missing, node_error,
 * green_missing, repo_not_found, task_dir_missing, doctor_failed,
 * launch_failed. The last launch step may report ok with timedOut when the
 * worker started but its first decision had not landed before the wait ended.
 */
import { spawn } from 'node:child_process';

export const DELEGATE_NODE = 'devvm7438.hil0.facebook.com';
export const AGENTCLOUD_BIN = process.env.MOCHI_AGENTCLOUD_BIN ?? '/usr/local/bin/agentcloudctl';
/** Green on the devserver, addressed through the remote home directory. */
export const GREEN_DIR = '$HOME/.claude/skills/green';
export const GREEN_SKILL_FILE = `${GREEN_DIR}/SKILL.md`;
export const GREEN_CLI = `${GREEN_DIR}/scripts/cli.py`;

const CHECK_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const TASK_SHOW_TIMEOUT_MS = 60_000;
const VERIFY_TIMEOUT_MS = 60_000;
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

function taskDirScript(repo, slug) {
  return `test -d ${q(`${repo}/${slug}`)}`;
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
export function runNodeExec({ cwd, script, timeoutMs }, spawnImpl = spawn) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    try {
      const args = ['node', 'exec', '--node', DELEGATE_NODE, ...(cwd ? ['--cwd', cwd] : []), '--', 'bash', '-c', script];
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
export async function delegateToGreen({ taskSlug }, { run = runNodeExec } = {}) {
  const slug = String(taskSlug ?? '');
  if (!isTaskSlug(slug)) {
    return fail(slug, 'invalid_task', `Not a Codimango task slug: ${slug || '(empty)'}.`, 'Pick the task from the panel.');
  }
  const safeRun = async (job) => {
    try {
      return await run(job);
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
    const commit = taskCommitSha(shown.stdout);
    const taskDir = `${repo}/${slug}`;
    return fail(
      slug,
      'task_dir_missing',
      `Task directory not found: ${taskDir} is missing from this checkout.${commit ? ` It exists at the task's commit ${commit}.` : ''}`,
      commit
        ? `Check out commit ${commit} in ${repo} (or restore ${slug} there), then try again.`
        : `Restore ${slug} in ${repo}, then try again.`,
    );
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
