/* Talk to Mochi through Metamate 3 (main process only).
 *
 * Auth = the user's own logins, the same way codimango.mjs uses the codimango
 * CLI: we run `meta agentcloud.session …` (and `agentcloudctl` for images) and
 * never touch a token. Metamate 3 runs on Agentcloud; `meta metamate.conversation
 * query` is disabled on laptops, but the agentcloud session commands are not.
 *
 * One hidden Metamate 3 session per install, so Mochi remembers the chat. It is
 * created empty, the first message carries Mochi's persona, and each answer is
 * read with `session result --input-id`. Text goes through `meta agentcloud.session
 * send`; a message with images goes through `agentcloudctl send --image`, the
 * only CLI that attaches pictures (meta's send is text-only). The session id and
 * persona version live in userData/metamate.json; a new persona starts a new chat.
 *
 * Failures come back as one of: cli_missing, access_needed (Agentcloud
 * permissions not granted yet: open AUTHORIZE_URL once), offline, timeout, error.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* GUI apps on macOS don't inherit the shell PATH, so use absolute paths. */
export const META_BIN = process.env.MOCHI_META_BIN ?? '/opt/facebook/bin/meta';
export const CTL_BIN = process.env.MOCHI_AGENTCLOUDCTL_BIN ?? '/usr/local/bin/agentcloudctl';
export const AUTHORIZE_URL = 'https://agentcloud.internalmeta.com/authorize';
export const MAX_MESSAGE = 2000;
export const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
export const MAX_IMAGES = 5;
/* Bump when the persona changes: the next message starts a fresh chat with it. */
export const PERSONA_VERSION = 2;
const CLI_TIMEOUT_MS = 60_000;
const ANSWER_TIMEOUT_MS = 120_000;
const POLL_MS = 1500;

/** Mochi's persona, sent once at the start of a chat. */
export function persona() {
  return [
    'You are Mochi, a small, cheerful desktop pet who lives on the screen of an AI task reviewer at Meta.',
    'They review and write coding tasks in Codimango. Talk like a friendly pet: warm, a little playful, and brief',
    '(one to three short sentences, no headings or lists unless asked).',
    'Never use tools, run commands or ask for permissions: answer only from this conversation, the images they share,',
    "and the task counts Mochi's panel adds to each message. If they want details you don't have, say where to look",
    '(their Codimango page) instead of fetching anything.',
  ].join(' ');
}

/** The panel's counts, added to every message so "how are my tasks?" is answered with current numbers. Counts only. */
export function contextLine(context) {
  if (!context) return '';
  return `[Mochi's panel right now: ${context.reviews} review(s) waiting, ${context.revisions} sent back for revision, ${context.drafts} draft(s).]`;
}

/** Run a CLI; resolves { err, stdout, stderr } and never rejects. */
function runCli(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });
}
const runMeta = (args) => runCli(META_BIN, [...args, '--output=json']);
const runCtl = (args) => runCli(CTL_BIN, args);

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
  if (/access registration|agentcloud\.internalmeta\.com\/authorize|agentcloud-auth setup|registration is required/i.test(text)) {
    return {
      kind: 'access_needed',
      message: 'Mochi needs your OK to use Metamate 3 first.',
      fix: AUTHORIZE_URL,
    };
  }
  if (err?.killed || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|VPN/i.test(text)) {
    return { kind: 'offline', message: "Mochi couldn't reach Metamate (VPN or network?)." };
  }
  const first = text.trim().split('\n').find((l) => l.trim() && !/^note:/i.test(l.trim())) ?? 'Something went wrong.';
  return { kind: 'error', message: first.slice(0, 300) };
}

function readState(file) {
  return parseJson(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') ?? {};
}

/** Keep images Metamate accepts; returns { images } or { problem }. */
export function checkImages(images) {
  const list = Array.isArray(images) ? images : [];
  if (list.length > MAX_IMAGES) return { problem: `Mochi can look at up to ${MAX_IMAGES} pictures at a time.` };
  for (const img of list) {
    if (!IMAGE_TYPES[img?.type]) return { problem: 'Mochi can look at PNG, JPEG, GIF or WebP pictures.' };
    if (!(img.bytes?.byteLength > 0) || img.bytes.byteLength > MAX_IMAGE_BYTES) return { problem: 'That picture is too big for Mochi (7 MB max).' };
  }
  return { images: list };
}

/**
 * Ask Mochi something, optionally with pictures ({ type, bytes }).
 * Returns { kind: 'answer', text } or a failure from classifyFailure.
 * `meta`, `ctl`, `sleep`, `now` and `tmpDir` are injectable for tests.
 */
export async function askMochi(
  text,
  {
    stateFile,
    context,
    images = [],
    meta = runMeta,
    ctl = runCtl,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
    tmpDir = os.tmpdir(),
  } = {},
) {
  const checked = checkImages(images);
  if (checked.problem) return { kind: 'error', message: checked.problem };
  const said = String(text ?? '').trim().slice(0, MAX_MESSAGE);
  if (!said && checked.images.length === 0) return { kind: 'error', message: 'Say something first.' };

  const state = readState(stateFile);
  let sessionId = state.personaVersion === PERSONA_VERSION ? state.sessionId : null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fresh = !sessionId;
    if (fresh) {
      const created = await meta(['agentcloud.session', 'create', '--hidden', '--title=Mochi', '--no-message']);
      const body = parseJson(created.stdout);
      if (created.err || !body?.session_id) return classifyFailure(created);
      sessionId = body.session_id;
      fs.writeFileSync(stateFile, JSON.stringify({ sessionId, personaVersion: PERSONA_VERSION }));
    }
    const message = [fresh ? persona() : '', contextLine(context), said ? `They say: ${said}` : 'They shared a picture.']
      .filter(Boolean)
      .join('\n\n');
    const sent = checked.images.length ? await sendWithImages(sessionId, message, checked.images, ctl, tmpDir) : await sendText(sessionId, message, meta);
    if (sent.gone && !fresh) {
      sessionId = null; // the saved chat is gone: start over once
      continue;
    }
    if (sent.failure) return sent.failure;
    return waitForAnswer(sessionId, sent.inputId, { meta, sleep, now });
  }
  return { kind: 'error', message: 'Mochi could not start a chat.' };
}

const GONE = /not[ _]found|archived|NOT_FOUND|no such session/i;

async function sendText(sessionId, message, meta) {
  const out = await meta(['agentcloud.session', 'send', `--session-id=${sessionId}`, `--message=${message}`]);
  const body = parseJson(out.stdout);
  if (!out.err && body?.input_id != null) return { inputId: body.input_id };
  if (GONE.test(`${out.stdout} ${out.stderr}`)) return { gone: true };
  return { failure: classifyFailure(out) };
}

/* agentcloudctl reads images from files, and the text from a file so it stays out of argv. */
async function sendWithImages(sessionId, message, images, ctl, tmpDir) {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'mochi-send-'));
  try {
    const textFile = path.join(dir, 'message.txt');
    fs.writeFileSync(textFile, message);
    const args = ['send', '-s', sessionId, '--text-file', textFile];
    images.forEach((img, i) => {
      const file = path.join(dir, `image-${i + 1}-${randomUUID().slice(0, 8)}.${IMAGE_TYPES[img.type]}`);
      fs.writeFileSync(file, Buffer.from(img.bytes));
      args.push('--image', file);
    });
    const out = await ctl(args);
    const seq = /durable at seq (\d+)/.exec(`${out.stdout}\n${out.stderr}`)?.[1];
    if (!out.err && seq) return { inputId: Number(seq) };
    if (out.err?.code === 'ENOENT') return { failure: { kind: 'cli_missing', message: "Sending pictures needs agentcloudctl, which isn't on this Mac." } };
    if (GONE.test(`${out.stdout} ${out.stderr}`)) return { gone: true };
    return { failure: classifyFailure(out) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForAnswer(sessionId, inputId, { meta, sleep, now }) {
  const deadline = now() + ANSWER_TIMEOUT_MS;
  const args = ['agentcloud.session', 'result', `--session-id=${sessionId}`];
  if (inputId != null) args.push(`--input-id=${inputId}`);
  while (now() < deadline) {
    const out = await meta(args);
    const body = parseJson(out.stdout);
    if (body?.outcome) {
      if (body.final_answer) return { kind: 'answer', text: body.final_answer.trim() };
      return classifyFailure({ detail: body.detail ?? `Metamate finished with ${body.outcome} and no answer.` });
    }
    /* Still running: `result` answers CONFLICT (run_open) until the run finishes. A 503 or an
       infra fault ("authentication is temporarily unavailable") is a blip: keep polling. */
    if (out.err && !/CONFLICT|run_open|still open|queued|HTTP 50[234]|temporarily unavailable|"fault_domain":"infra"/i.test(`${out.stdout} ${out.stderr}`)) {
      return classifyFailure(out);
    }
    await sleep(POLL_MS);
  }
  return { kind: 'timeout', message: 'Mochi is still thinking. Try again in a moment.' };
}
