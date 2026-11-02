/* Talk to Mochi through Metamate 3 (main process only).
 *
 * Auth = the user's own `meta` CLI login, the same way codimango.mjs uses the
 * codimango CLI: we run `meta agentcloud.session …` and never touch a token.
 * Metamate 3 runs on Agentcloud; `meta metamate.conversation query` is
 * disabled on laptops, but the agentcloud session commands are not.
 *
 * One hidden Metamate 3 session per install, so Mochi remembers the chat:
 * the first message creates it (with Mochi's persona), later ones are sent to
 * it, and each answer is read with `session result --input-id`. The session id
 * is kept in userData/metamate.json. Answers take a few seconds (one model run).
 *
 * Failures come back as one of: cli_missing, access_needed (Agentcloud
 * permissions not granted yet: open AUTHORIZE_URL once), offline, timeout, error.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';

/* GUI apps on macOS don't inherit the shell PATH, so use the absolute path. */
export const META_BIN = process.env.MOCHI_META_BIN ?? '/opt/facebook/bin/meta';
export const AUTHORIZE_URL = 'https://agentcloud.internalmeta.com/authorize';
export const MAX_MESSAGE = 2000;
const CLI_TIMEOUT_MS = 60_000;
const ANSWER_TIMEOUT_MS = 120_000;
const POLL_MS = 1500;

/** Mochi's persona, sent once as the start of the first message. Counts only: no task names. */
export function persona(context) {
  const lines = [
    'You are Mochi, a small, cheerful desktop pet who lives on the screen of an AI task reviewer at Meta.',
    'They review and write coding tasks in Codimango. Talk like a friendly pet: warm, a little playful, and brief',
    '(one to three short sentences, no headings or lists unless asked). You can answer work questions too.',
  ];
  if (context) {
    lines.push(
      `Right now they have ${context.reviews} review(s) waiting, ${context.revisions} task(s) sent back for revision,` +
        ` and ${context.drafts} draft(s).`,
    );
  }
  return lines.join(' ');
}

/** Run `meta` with JSON output; resolves { err, stdout, stderr } and never rejects. */
function runMeta(args) {
  return new Promise((resolve) => {
    execFile(META_BIN, [...args, '--output=json'], { timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Map a failed CLI run, or a run that finished without an answer, to a user-facing state. */
export function classifyFailure({ err, stdout = '', stderr = '', detail = '' }) {
  if (err?.code === 'ENOENT') {
    return { kind: 'cli_missing', message: "Mochi can't find the meta CLI on this Mac." };
  }
  const text = `${detail} ${parseJson(stdout)?.error?.message ?? ''} ${stderr}`;
  if (/access registration|agentcloud\.internalmeta\.com\/authorize|agentcloud-auth setup/i.test(text)) {
    return {
      kind: 'access_needed',
      message: 'Mochi needs your OK to use Metamate 3 first.',
      fix: AUTHORIZE_URL,
    };
  }
  if (err?.killed || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|VPN/i.test(text)) {
    return { kind: 'offline', message: "Mochi couldn't reach Metamate (VPN or network?)." };
  }
  const first = text.trim().split('\n').find((l) => l.trim()) ?? 'Something went wrong.';
  return { kind: 'error', message: first.slice(0, 300) };
}

function readState(file) {
  return parseJson(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') ?? {};
}

function writeState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state));
}

/**
 * Ask Mochi something. Returns { kind: 'answer', text } or a failure from classifyFailure.
 * `run` and `sleep` are injectable for tests.
 */
export async function askMochi(text, { stateFile, context, run = runMeta, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const message = String(text ?? '').trim().slice(0, MAX_MESSAGE);
  if (!message) return { kind: 'error', message: 'Say something first.' };
  const state = readState(stateFile);

  let sent = state.sessionId ? await send(state.sessionId, message, run) : null;
  if (!sent || sent.gone) {
    /* First message, or the old session is gone: start a fresh one with the persona. */
    const created = await run([
      'agentcloud.session', 'create', '--hidden', '--title=Mochi',
      `--message=${persona(context)}\n\nThey say: ${message}`,
    ]);
    const body = parseJson(created.stdout);
    if (created.err || !body?.session_id) return classifyFailure(created);
    writeState(stateFile, { ...state, sessionId: body.session_id });
    sent = { sessionId: body.session_id, inputId: body.input_id };
  } else if (sent.failure) {
    return sent.failure;
  }
  return waitForAnswer(sent, { run, sleep, now });
}

async function send(sessionId, message, run) {
  const out = await run(['agentcloud.session', 'send', `--session-id=${sessionId}`, `--message=${message}`]);
  const body = parseJson(out.stdout);
  if (!out.err && body?.input_id != null) return { sessionId, inputId: body.input_id };
  if (/not[ _]found|archived|NOT_FOUND/i.test(`${out.stdout} ${out.stderr}`)) return { gone: true };
  return { failure: classifyFailure(out) };
}

async function waitForAnswer({ sessionId, inputId }, { run, sleep, now }) {
  const deadline = now() + ANSWER_TIMEOUT_MS;
  const args = ['agentcloud.session', 'result', `--session-id=${sessionId}`];
  if (inputId != null) args.push(`--input-id=${inputId}`);
  while (now() < deadline) {
    const out = await run(args);
    const body = parseJson(out.stdout);
    if (body?.outcome) {
      if (body.final_answer) return { kind: 'answer', text: body.final_answer.trim() };
      return classifyFailure({ detail: body.detail ?? `Metamate finished with ${body.outcome} and no answer.` });
    }
    /* Still running: `result` answers CONFLICT (run_open) until the run finishes. */
    if (out.err && !/CONFLICT|run_open|still open|queued/i.test(`${out.stdout} ${out.stderr}`)) return classifyFailure(out);
    await sleep(POLL_MS);
  }
  return { kind: 'timeout', message: 'Mochi is still thinking. Try again in a moment.' };
}
