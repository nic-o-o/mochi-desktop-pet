/* The team's too-easy pool (main process only).
 *
 * The pool is pipeline/pools/too_easy.json in codimango/swe-bench-aai-labs-ember,
 * rebuilt daily by scripts/taskgen/too_easy_pool.py: teammates' tasks still too
 * easy after 3+ validated commits. We read it from GitHub with the user's `gh`
 * login, else from a local checkout (MOCHI_POOL_FILE, or ~/swe-bench-aai-labs-ember
 * after a pull). Your own tasks are dropped: the pool is for helping others.
 *
 * Returns { ok: true, me, updated, tasks } or { ok: false, kind: 'missing' | 'error', message }.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = 'codimango/swe-bench-aai-labs-ember';
const POOL_PATH = 'pipeline/pools/too_easy.json';
/* GUI apps on macOS don't inherit the shell PATH, so look in the usual places. */
const GH_CANDIDATES = [process.env.MOCHI_GH_BIN, '/opt/homebrew/bin/gh', '/usr/local/bin/gh'].filter(Boolean);
const TIMEOUT_MS = 30_000;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readFromGitHub() {
  const gh = GH_CANDIDATES.find((p) => fs.existsSync(p));
  if (!gh) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      gh,
      ['api', `repos/${REPO}/contents/${POOL_PATH}`, '-H', 'Accept: application/vnd.github.raw'],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : parseJson(String(stdout))),
    );
  });
}

function readFromCheckout(home) {
  const file = process.env.MOCHI_POOL_FILE ?? path.join(home, 'swe-bench-aai-labs-ember', POOL_PATH);
  return fs.existsSync(file) ? parseJson(fs.readFileSync(file, 'utf8')) : null;
}

/** Keep what the panel shows, minus the viewer's own tasks; most-tried first. */
export function pickPool(data, me) {
  const tasks = Object.entries(data?.tasks ?? {})
    .filter(([, e]) => e && e.owner !== me)
    .map(([name, e]) => ({
      name,
      id: e.id ?? null,
      owner: String(e.owner ?? ''),
      rounds: Number(e.rounds) || 0,
      active: Boolean(e.active),
      claimedBy: e.claimed_by ?? null,
      outcome: e.outcome ?? null,
      pr: e.pr ?? null,
      saturated: Boolean(e.owner_flagged_saturated),
    }))
    .sort((a, b) => b.rounds - a.rounds || a.name.localeCompare(b.name));
  return { ok: true, me, updated: data?.updated ?? null, tasks };
}

export async function fetchPool({ github = readFromGitHub, checkout = readFromCheckout, home = os.homedir(), me = os.userInfo().username } = {}) {
  try {
    const data = (await github()) ?? checkout(home);
    if (!data?.tasks) return { ok: false, kind: 'missing', message: 'The team pool is not published yet.' };
    return pickPool(data, me);
  } catch (e) {
    return { ok: false, kind: 'error', message: String(e?.message ?? e) };
  }
}
