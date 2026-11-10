/* Ask agents to review (main process only).
 *
 * The default reviewer is the team-aai `codimango-review-assistant` skill: it
 * reviews a Codimango task at its exact revision and returns "## Review summary"
 * plus "## Structured form" (every visible review-form field). People can pick
 * one of their own skills instead (listReviewSkills): personal skills in
 * ~/.claude/skills and installed plugin skills with "review" in the name, plus
 * any skill folder they add with a file picker
 * (kept in userData/review-skills.json). The renderer only ever sends a skill
 * id; the path is resolved here, from disk.
 * Mochi only launches the skill and keeps the result; it never submits a review.
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
import { createHash, randomUUID } from 'node:crypto';
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
const PLUGINS_ROOT = path.join('.claude', 'plugins', 'cache');
const PERSONAL_SKILLS = path.join('.claude', 'skills');
export const DEFAULT_SKILL_ID = 'default';
const SKILL_PART = /^[\w.-]{1,100}$/;

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

/* Every skill runs under these; only the default skill gets the review-form rules. */
const SAFETY_RULES =
  'You are running headless for Mochi, a desktop app; nobody can answer questions. ' +
  'Do not submit the review, change the task, rerun validation, start paid trials, push anything or contact the author. ';

const CUSTOM_RULES =
  SAFETY_RULES +
  'Where the skill would ask the reviewer, choose the conservative option and say so in the report. ' +
  'Your final message must be the complete review, in markdown.';

const HEADLESS_RULES =
  SAFETY_RULES +
  'Where the skill would ask the reviewer, choose the conservative option, keep the answer DRAFT and say why under Coverage / limitations. ' +
  'The reviewer copies each field into the live form, so the Structured form must cover every section that form shows for this task, in its order. ' +
  "Work out which conditional sections are visible from the exact task's data, not the fallback snapshot: " +
  'Agentic Full-Task Review Agreement whenever an Agentic Full-Task Review result exists; ' +
  "Validation Override whenever the submitter gave override reasons, with each overridden check's name, your agreement and your notes; " +
  'and always Taxonomy, with every axis and the value to select or confirm. ' +
  'Leave out sections with nothing to review, such as a Novelty report that was never generated. ' +
  'In Human Checks, give every score its own "Why this score?" field. ' +
  'If you cannot tell whether a section is shown, include it and say so in its notes. ' +
  'Your final message must be the skill\'s output: "## Review summary", then "## Structured form".';

function readFrontmatter(file, fsImpl) {
  let text = '';
  try {
    text = fsImpl.readFileSync(file, 'utf8').slice(0, 4000);
  } catch {
    return {};
  }
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const field = (key) => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(m[1]);
    return line ? line[1].trim().replace(/^["']|["']$/g, '').slice(0, 300) : undefined;
  };
  return { name: field('name'), description: field('description') };
}

function listDir(dir, fsImpl) {
  try {
    return fsImpl.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The newest version folder of one installed plugin, or null. */
function newestVersion(pluginDir, fsImpl) {
  const versions = listDir(pluginDir, fsImpl).filter((v) => /^\d+(\.\d+)*$/.test(v));
  return versions.length ? versions.sort(compareVersions).at(-1) : null;
}

/** The default skill, as a run needs it, or null when team-aai isn't installed. */
function defaultSkill(home, fsImpl) {
  const file = findReviewSkill(home, fsImpl);
  if (!file) return null;
  return {
    id: DEFAULT_SKILL_ID,
    source: 'default',
    label: 'Codimango review assistant',
    invoke: `team-aai:${SKILL}`,
    path: file,
    root: path.dirname(path.dirname(path.dirname(file))),
  };
}

/* Only skills named for reviewing are offered; the rest (emulators, design
   tools, ...) are noise in the picker. Names, not descriptions: plenty of
   descriptions mention "review" in passing. Anything else can be added by hand. */
const namedForReview = (name) => /review/i.test(name);

/** A folder or SKILL.md someone picked → the SKILL.md path, or null if it isn't a skill. */
export function skillFileFrom(picked, fsImpl = fs) {
  if (typeof picked !== 'string' || !picked) return null;
  let stat;
  try {
    stat = fsImpl.statSync(picked);
  } catch {
    return null;
  }
  const file = stat.isDirectory() ? path.join(picked, 'SKILL.md') : picked;
  if (path.basename(file) !== 'SKILL.md') return null;
  try {
    return fsImpl.statSync(file).isFile() ? path.resolve(file) : null;
  } catch {
    return null;
  }
}

/** Stable id for an added skill: its path hashed, so the path never goes to the renderer. */
export const addedSkillId = (file) => `added:${createHash('sha256').update(file).digest('hex').slice(0, 16)}`;

function addedSkill(file, fsImpl) {
  const meta = readFrontmatter(file, fsImpl);
  const label = (meta.name && SKILL_PART.test(meta.name) ? meta.name : path.basename(path.dirname(file))).slice(0, 100);
  return { id: addedSkillId(file), source: 'added', label, description: meta.description, path: file, root: path.dirname(path.dirname(file)) };
}

/**
 * Skills the picker offers, default first: the skills added with the file picker,
 * then personal and installed plugin skills named for review (the full plugin
 * list runs to hundreds). Each is { id, source, label, description }; ids are what
 * the renderer sends back. `added` is the list of picked SKILL.md paths.
 */
export function listReviewSkills(home = os.homedir(), fsImpl = fs, added = []) {
  const out = [{ id: DEFAULT_SKILL_ID, source: 'default', label: 'Codimango review assistant (default)' }];
  for (const file of added) {
    if (!fsImpl.existsSync(file)) continue;
    const { id, source, label, description } = addedSkill(file, fsImpl);
    out.push({ id, source, label, description });
  }
  const personalRoot = path.join(home, PERSONAL_SKILLS);
  for (const name of listDir(personalRoot, fsImpl).sort()) {
    if (!SKILL_PART.test(name)) continue;
    const file = path.join(personalRoot, name, 'SKILL.md');
    if (!fsImpl.existsSync(file)) continue;
    if (!namedForReview(name)) continue;
    const meta = readFrontmatter(file, fsImpl);
    out.push({ id: `personal:${name}`, source: 'personal', label: name, description: meta.description });
  }
  const pluginsRoot = path.join(home, PLUGINS_ROOT);
  for (const market of listDir(pluginsRoot, fsImpl).sort()) {
    if (!SKILL_PART.test(market)) continue;
    for (const plugin of listDir(path.join(pluginsRoot, market), fsImpl).sort()) {
      if (!SKILL_PART.test(plugin)) continue;
      const version = newestVersion(path.join(pluginsRoot, market, plugin), fsImpl);
      if (!version) continue;
      const skillsDir = path.join(pluginsRoot, market, plugin, version, 'skills');
      for (const name of listDir(skillsDir, fsImpl).sort()) {
        if (!SKILL_PART.test(name)) continue;
        if (plugin === 'team-aai' && name === SKILL) continue;
        const file = path.join(skillsDir, name, 'SKILL.md');
        if (!fsImpl.existsSync(file)) continue;
        if (!namedForReview(name)) continue;
        const meta = readFrontmatter(file, fsImpl);
        out.push({
          id: `plugin:${market}:${plugin}:${name}`,
          source: 'plugin',
          label: `${plugin}:${name}`,
          description: meta.description,
        });
      }
    }
  }
  return out;
}

/** What a run needs for one skill id, resolved from disk; null when it isn't installed. */
export function resolveReviewSkill(id = DEFAULT_SKILL_ID, home = os.homedir(), fsImpl = fs, added = []) {
  if (!id || id === DEFAULT_SKILL_ID) return defaultSkill(home, fsImpl);
  if (String(id).startsWith('added:')) {
    const file = added.find((f) => addedSkillId(f) === id);
    return file && fsImpl.existsSync(file) ? addedSkill(file, fsImpl) : null;
  }
  const parts = String(id).split(':');
  if (parts[0] === 'personal' && parts.length === 2 && SKILL_PART.test(parts[1])) {
    const root = path.join(home, PERSONAL_SKILLS);
    const file = path.join(root, parts[1], 'SKILL.md');
    if (!fsImpl.existsSync(file)) return null;
    return { id, source: 'personal', label: parts[1], invoke: parts[1], path: file, root };
  }
  if (parts[0] === 'plugin' && parts.length === 4 && parts.slice(1).every((p) => SKILL_PART.test(p))) {
    const [, market, plugin, name] = parts;
    const version = newestVersion(path.join(home, PLUGINS_ROOT, market, plugin), fsImpl);
    if (!version) return null;
    const root = path.join(home, PLUGINS_ROOT, market, plugin, version);
    const file = path.join(root, 'skills', name, 'SKILL.md');
    if (!fsImpl.existsSync(file)) return null;
    return { id, source: 'plugin', label: `${plugin}:${name}`, invoke: `${plugin}:${name}`, path: file, root };
  }
  return null;
}

/** The command line for one run. `reportFile` is where Codex writes its last message. */
export function agentCommand(agent, { taskName, cwd, skill }) {
  const rules = skill.source === 'default' ? HEADLESS_RULES : CUSTOM_RULES;
  // An added skill isn't installed, so Claude can't call it by name: point it at the file.
  const claudeTask = skill.invoke
    ? `Use the ${skill.invoke} skill to review the Codimango task "${taskName}".`
    : `Review the Codimango task "${taskName}" by following the skill in ${skill.path}: read it and the reference files it links, then follow its workflow and output contract.`;
  if (agent === 'claude') {
    return {
      bin: AGENTS.claude.bin,
      args: [
        '-p',
        `${claudeTask} ${rules}`,
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
  // Personal skills sit directly in ~/.claude/skills/<name>; plugin skills under <version>/skills/<name>.
  const namedAt =
    skill.source === 'personal' || skill.source === 'added' ? `${skill.root}/<name>/SKILL.md` : `${skill.root}/**/skills/<name>/SKILL.md`;
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
      `Review the Codimango task "${taskName}" by following the skill in ${skill.path}: read it and the reference files it links, ` +
        `then follow its workflow and output contract. Skills it names by name live at ${namedAt}. ` +
        rules,
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

const modelOf = (model) => (typeof model === 'string' && model && model.length <= 100 ? { model } : {});

/**
 * What one output line means: a tool step, the model (Claude), the final
 * report (Claude), or an error message. Non-JSON lines (launcher banners) mean nothing.
 */
export function readLine(agent, line) {
  const msg = parseJson(line);
  if (!msg || typeof msg !== 'object') return {};
  if (agent === 'claude') {
    if (msg.type === 'system' && msg.subtype === 'init') return modelOf(msg.model);
    if (msg.type === 'assistant') {
      const steps = (msg.message?.content ?? []).filter((c) => c?.type === 'tool_use').length;
      return { ...modelOf(msg.message?.model), ...(steps ? { steps } : {}) };
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
  skill_missing: (_label, _agent, skillLabel) =>
    skillLabel
      ? { message: `The skill ${skillLabel} isn't installed on this Mac anymore. Pick another skill and ask again.` }
      : { message: "The Codimango review skill isn't installed.", fix: 'claude plugin install team-aai@agent-market' },
  codimango_login: () => ({ message: 'Codimango login missing or expired.', fix: 'codimango auth setup' }),
  offline: (label) => ({ message: `${label} couldn't reach its service (VPN or network?).` }),
  timeout: () => ({ message: `The review took longer than ${TIMEOUT_MS / 60_000} minutes and was stopped.` }),
  no_report: (label) => ({ message: `${label} finished without a report.` }),
  interrupted: () => ({ message: 'Mochi quit before the review finished.' }),
  cancelled: () => ({ message: 'You stopped this review.' }),
};

export function failure(kind, agent, detail) {
  const label = AGENTS[agent]?.label ?? agent;
  const known = FAILURES[kind]?.(label, agent, kind === 'skill_missing' ? detail : undefined);
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

/** The skills people added with the file picker: a JSON list of SKILL.md paths. */
export function createAddedSkills(file, fsImpl = fs) {
  const read = () => {
    try {
      const list = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      return Array.isArray(list) ? list.filter((f) => typeof f === 'string' && path.basename(f) === 'SKILL.md') : [];
    } catch {
      return [];
    }
  };
  const write = (list) => fsImpl.writeFileSync(file, JSON.stringify(list));
  return {
    list: read,
    /** Add a picked folder or SKILL.md; resolves the new id, or null when it isn't a skill. */
    add(picked) {
      const skillFile = skillFileFrom(picked, fsImpl);
      if (!skillFile) return null;
      const list = read();
      if (!list.includes(skillFile)) write([...list, skillFile]);
      return addedSkillId(skillFile);
    },
    remove(id) {
      write(read().filter((f) => addedSkillId(f) !== id));
    },
  };
}

/**
 * The job store and scheduler. Everything that touches the system is
 * injectable for tests: `run` (spawnAgent), `findSkill`, `makeTempDir`, `now`.
 * `onChange(jobs)` fires after every change; `onFinished(job)` once per run.
 */
/**
 * The model Codex will use: the top-level `model` in its config.toml. Codex's
 * --json events don't name it, and Mochi passes no model of its own.
 */
export function codexModel(home = os.homedir(), fsImpl = fs, env = process.env) {
  const file = path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'config.toml');
  let text;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) break; // a [table]: past the top-level keys
    const m = /^\s*model\s*=\s*["']([^"']{1,100})["']/.exec(line);
    if (m) return m[1];
  }
  return null;
}

export function createAgentReviews({
  dir,
  run = spawnAgent,
  findSkill = (id) => resolveReviewSkill(id),
  findCodexModel = () => codexModel(),
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
    const skillId = job.skill?.id ?? DEFAULT_SKILL_ID;
    const skill = findSkill(skillId);
    if (!skill) {
      const custom = skillId !== DEFAULT_SKILL_ID ? job.skill?.label ?? skillId : undefined;
      finish(job, { status: 'failed', failure: failure('skill_missing', job.agent, custom) });
      return;
    }
    const cwd = makeTempDir();
    const cmd = agentCommand(job.agent, { taskName: job.taskName, cwd, skill });
    let report = '';
    let lastError = '';
    let timedOut = false;
    const handle = run({ bin: cmd.bin, args: cmd.args, cwd }, (line) => {
      const got = readLine(job.agent, line);
      if (got.model && !job.model) job.model = got.model;
      if (got.steps || got.model) {
        job.steps += got.steps ?? 0;
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
    if (job.agent === 'codex') job.model = findCodexModel() ?? undefined;
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
    start({ taskId, taskName, taskUpdatedAtMs, agents, skillId = DEFAULT_SKILL_ID }) {
      if (!isTaskName(taskName)) return list();
      const id = typeof skillId === 'string' && skillId.length <= 300 ? skillId : DEFAULT_SKILL_ID;
      const skill = id === DEFAULT_SKILL_ID ? null : findSkill(id);
      // A skill that has gone missing is kept on the job, so the run fails saying so
      // instead of quietly reviewing with a different skill.
      const chosen = id === DEFAULT_SKILL_ID ? null : skill ? { id, label: skill.label, source: skill.source } : { id, label: id.split(':').pop() };
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
          ...(chosen ? { skill: chosen } : {}),
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
