/* Ask agents to review (main process only).
 *
 * The reviewer is the team-aai `codimango-review-assistant` skill: it reviews a
 * Codimango task at its exact revision and returns "## Review summary" plus
 * "## Structured form" (every visible review-form field). Mochi only launches it
 * and keeps the result; it never submits a review.
 *
 * Agents run on this Mac under the user's own logins, the way codimango.mjs uses
 * the codimango CLI: Claude Code (`claude -p`, which loads the skill from the
 * user's plugins) and Codex (`codex exec`, which has no skills, so the prompt
 * points it at the skill's SKILL.md). Each run gets a fresh temp folder that is
 * removed afterwards.
 *
 * Jobs persist as one JSON file each under userData/agent-reviews/, so reports
 * survive closing the panel and restarting Mochi. A job still running when Mochi
 * quit comes back as "interrupted". At most MAX_RUNNING agents run at once; the
 * rest wait in line.
 *
 * Failures come back as one of: cli_missing, agent_login, skill_missing,
 * codimango_login, offline, timeout, no_report, interrupted, cancelled, error.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const MAX_RUNNING = 2;
export const TIMEOUT_MS = 45 * 60_000;
/** Finished jobs older than this are deleted at startup. */
export const KEEP_MS = 14 * 24 * 60 * 60_000;
const OUTPUT_TAIL_CHARS = 8000;

/* GUI apps on macOS don't inherit the shell PATH, so use absolute paths. */
export const AGENTS = {
  claude: { label: 'Claude Code', bin: process.env.MOCHI_CLAUDE_BIN ?? '/usr/local/bin/claude' },
  codex: { label: 'Codex', bin: process.env.MOCHI_CODEX_BIN ?? '/usr/local/bin/codex' },
};

const SKILL = 'codimango-review-assistant';
const PLUGIN_CACHE = path.join('.claude', 'plugins', 'cache', 'agent-market', 'team-aai');

/** Codimango task names are slugs; anything else never reaches a prompt. */
export function isTaskName(name) {
  return typeof name === 'string' && /^[\w.-]{1,200}$/.test(name);
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The newest installed team-aai copy of the review skill's SKILL.md, or null. */
export function findReviewSkill(home = os.homedir(), fsImpl = fs) {
  const root = path.join(home, PLUGIN_CACHE);
  let versions;
  try {
    versions = fsImpl.readdirSync(root).filter((v) => /^\d+(\.\d+)*$/.test(v));
  } catch {
    return null;
  }
  for (const v of versions.sort(compareVersions).reverse()) {
    const file = path.join(root, v, 'skills', SKILL, 'SKILL.md');
    if (fsImpl.existsSync(file)) return file;
  }
  return null;
}

const HEADLESS_RULES =
  'You are running headless for Mochi, a desktop app; nobody can answer questions. ' +
  'Do not submit the review, change the task, rerun validation, start paid trials, push anything or contact the author. ' +
  'Where the skill would ask the reviewer, choose the conservative option, keep the answer DRAFT and say why under Coverage / limitations. ' +
  'Your final message must be the skill\'s output: "## Review summary", then "## Structured form".';

/** The command line for one run. `reportFile` is where Codex writes its last message. */
export function agentCommand(agent, { taskName, cwd, skillPath }) {
  if (agent === 'claude') {
    return {
      bin: AGENTS.claude.bin,
      args: [
        '-p',
        `Use the team-aai:${SKILL} skill to review the Codimango task "${taskName}". ${HEADLESS_RULES}`,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'auto',
        '--disallowedTools',
        'Bash(git push:*)',
        '--no-session-persistence',
      ],
    };
  }
  const reportFile = path.join(cwd, 'report.md');
  const pluginRoot = path.dirname(path.dirname(path.dirname(skillPath)));
  return {
    bin: AGENTS.codex.bin,
    reportFile,
    args: [
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '-C',
      cwd,
      '-s',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=true',
      '-o',
      reportFile,
      `Review the Codimango task "${taskName}" by following the skill in ${skillPath}: read it and the reference files it links, ` +
        `then follow its workflow and output contract. Skills it names by name live at ${pluginRoot}/**/skills/<name>/SKILL.md. ` +
        HEADLESS_RULES,
    ],
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * What one output line means: a tool step, the final report (Claude), or an
 * error message. Non-JSON lines (launcher banners) mean nothing.
 */
export function readLine(agent, line) {
  const msg = parseJson(line);
  if (!msg || typeof msg !== 'object') return {};
  if (agent === 'claude') {
    if (msg.type === 'assistant') {
      const steps = (msg.message?.content ?? []).filter((c) => c?.type === 'tool_use').length;
      return steps ? { steps } : {};
    }
    if (msg.type === 'result') {
      if (msg.is_error || msg.subtype !== 'success') return { error: String(msg.result ?? msg.subtype ?? 'error') };
      return { report: String(msg.result ?? '') };
    }
    return {};
  }
  if (msg.type === 'item.completed') return { steps: 1 };
  if (msg.type === 'error') return { error: String(msg.message ?? 'error') };
  if (msg.type === 'turn.failed') return { error: String(msg.error?.message ?? 'turn failed') };
  return {};
}

const FAILURES = {
  cli_missing: (label) => ({ message: `Mochi can't find ${label} on this Mac.` }),
  agent_login: (label, agent) => ({
    message: `${label} needs you to sign in.`,
    fix: agent === 'codex' ? 'codex login' : 'claude',
  }),
  skill_missing: () => ({
    message: "The Codimango review skill isn't installed.",
    fix: 'claude plugin install team-aai@agent-market',
  }),
  codimango_login: () => ({ message: 'Codimango login missing or expired.', fix: 'codimango auth setup' }),
  offline: (label) => ({ message: `${label} couldn't reach its service (VPN or network?).` }),
  timeout: () => ({ message: `The review took longer than ${TIMEOUT_MS / 60_000} minutes and was stopped.` }),
  no_report: (label) => ({ message: `${label} finished without a report.` }),
  interrupted: () => ({ message: 'Mochi quit before the review finished.' }),
  cancelled: () => ({ message: 'You stopped this review.' }),
};

export function failure(kind, agent, detail) {
  const label = AGENTS[agent]?.label ?? agent;
  const known = FAILURES[kind]?.(label, agent);
  if (known) return { kind, ...known };
  const first = String(detail ?? '').trim().split('\n').find((l) => l.trim()) ?? '';
  return { kind: 'error', message: first.slice(0, 300) || `${label} stopped with an error.` };
}

/** Map a finished run without a report to a failure, from its exit and output tail. */
export function classifyRun(agent, { error, timedOut, output = '', detail = '' }) {
  if (error?.code === 'ENOENT') return failure('cli_missing', agent);
  if (timedOut) return failure('timeout', agent);
  const text = `${detail}\n${output}`;
  if (/codimango auth setup|Nest (OIDC )?token|codimango.*(login|authenticat)/i.test(text)) return failure('codimango_login', agent);
  if (/not logged in|please (log|sign) in|\/login|codex login|invalid api key|authenticat(e|ion) (failed|required)/i.test(text)) {
    return failure('agent_login', agent);
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network (is )?unreachable|VPN/i.test(text)) return failure('offline', agent);
  if (detail) return failure('error', agent, detail);
  return failure('no_report', agent);
}

/**
 * Default runner: spawns the agent, feeds each stdout line to `onLine`, keeps a
 * tail of all output, and resolves when the process exits.
 */
export function spawnAgent({ bin, args, cwd }, onLine) {
  let tail = '';
  const keep = (chunk) => {
    tail = (tail + chunk).slice(-OUTPUT_TAIL_CHARS);
  };
  let child;
  const done = new Promise((resolve) => {
    try {
      child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (error) {
      resolve({ error, output: tail });
      return;
    }
    child.on('error', (error) => resolve({ error, output: tail }));
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      keep(`${line}\n`);
      onLine(line);
    });
    child.stderr.on('data', (d) => keep(String(d)));
    child.on('close', (code, signal) => resolve({ code, signal, output: tail }));
  });
  return { done, kill: () => child?.kill('SIGTERM') };
}

const ACTIVE = new Set(['queued', 'running']);

/**
 * The job store and scheduler. Everything that touches the system is
 * injectable for tests: `run` (spawnAgent), `findSkill`, `makeTempDir`, `now`.
 * `onChange(jobs)` fires after every change; `onFinished(job)` once per run.
 */
export function createAgentReviews({
  dir,
  run = spawnAgent,
  findSkill = () => findReviewSkill(),
  makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-review-')),
  removeDir = (d) => fs.rmSync(d, { recursive: true, force: true }),
  readFile = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''),
  now = Date.now,
  onChange = () => {},
  onFinished = () => {},
  maxRunning = MAX_RUNNING,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const jobs = new Map();
  const running = new Map();
  /* Runs whose end is already recorded (cancelled) or must stay open (quitting). */
  const ignoreExit = new Set();
  let stopping = false;

  const fileFor = (id) => path.join(dir, `${id}.json`);
  const save = (job) => fs.writeFileSync(fileFor(job.id), JSON.stringify(job));
  const drop = (job) => {
    jobs.delete(job.id);
    fs.rmSync(fileFor(job.id), { force: true });
  };
  /* Oldest first; one start's jobs share a timestamp, so then agent order (Claude before Codex). */
  const agentOrder = Object.keys(AGENTS);
  const list = () =>
    [...jobs.values()].sort(
      (a, b) =>
        a.createdAtMs - b.createdAtMs ||
        a.taskId.localeCompare(b.taskId) ||
        agentOrder.indexOf(a.agent) - agentOrder.indexOf(b.agent),
    );
  const changed = () => onChange(list());

  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const job = parseJson(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (!job?.id || !AGENTS[job.agent]) continue;
    if (ACTIVE.has(job.status)) {
      Object.assign(job, { status: 'failed', endedAtMs: job.endedAtMs ?? now(), failure: failure('interrupted', job.agent) });
      save(job);
    }
    if (now() - (job.endedAtMs ?? job.createdAtMs) > KEEP_MS) {
      fs.rmSync(path.join(dir, name), { force: true });
      continue;
    }
    jobs.set(job.id, job);
  }

  function finish(job, patch) {
    Object.assign(job, { endedAtMs: now(), ...patch });
    running.delete(job.id);
    save(job);
    changed();
    onFinished(job);
    pump();
  }

  function begin(job) {
    const skillPath = findSkill();
    if (!skillPath) {
      finish(job, { status: 'failed', failure: failure('skill_missing', job.agent) });
      return;
    }
    const cwd = makeTempDir();
    const cmd = agentCommand(job.agent, { taskName: job.taskName, cwd, skillPath });
    let report = '';
    let lastError = '';
    let timedOut = false;
    const handle = run({ bin: cmd.bin, args: cmd.args, cwd }, (line) => {
      const got = readLine(job.agent, line);
      if (got.steps) {
        job.steps += got.steps;
        save(job);
        changed();
      }
      if (got.report) report = got.report;
      if (got.error) lastError = got.error;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      handle.kill();
    }, timeoutMs);
    timer.unref?.();
    running.set(job.id, handle);
    Object.assign(job, { status: 'running', startedAtMs: now() });
    save(job);
    changed();

    handle.done.then((result) => {
      clearTimeout(timer);
      if (!report && cmd.reportFile) report = readFile(cmd.reportFile);
      removeDir(cwd);
      if (stopping || ignoreExit.delete(job.id)) return;
      if (report.trim() && !timedOut) {
        finish(job, { status: 'done', report: report.trim() });
        return;
      }
      const failed = classifyRun(job.agent, { ...result, timedOut, detail: lastError });
      /* main.log only (this Mac): the end of the agent's output, to see why a run failed. */
      console.warn(`[mochi] agent review ${job.agent} failed (${failed.kind}); output tail:\n${String(result.output ?? '').slice(-1500)}`);
      finish(job, { status: 'failed', failure: failed });
    });
  }

  function pump() {
    for (const job of list()) {
      if (running.size >= maxRunning) return;
      if (job.status === 'queued') begin(job);
    }
  }

  return {
    list,
    /** Queue one run per agent for a task; an agent already reviewing that task is skipped. */
    start({ taskId, taskName, taskUpdatedAtMs, agents }) {
      if (!isTaskName(taskName)) return list();
      for (const agent of new Set(agents)) {
        if (!AGENTS[agent]) continue;
        const prior = list().filter((j) => j.taskId === taskId && j.agent === agent);
        if (prior.some((j) => ACTIVE.has(j.status))) continue;
        prior.forEach(drop);
        const job = {
          id: randomUUID(),
          taskId: String(taskId),
          taskName,
          taskUpdatedAtMs: Number.isFinite(taskUpdatedAtMs) ? taskUpdatedAtMs : null,
          agent,
          status: 'queued',
          steps: 0,
          createdAtMs: now(),
        };
        jobs.set(job.id, job);
        save(job);
      }
      changed();
      pump();
      return list();
    },
    cancel(id) {
      const job = jobs.get(id);
      if (!job || !ACTIVE.has(job.status)) return list();
      const handle = running.get(id);
      if (handle) ignoreExit.add(id);
      finish(job, { status: 'failed', failure: failure('cancelled', job.agent) });
      handle?.kill();
      return list();
    },
    /** Quitting: stop every agent. Their jobs come back as interrupted next launch. */
    stopAll() {
      stopping = true;
      for (const handle of running.values()) handle.kill();
    },
  };
}
