/* Drawing a pet (main process).
 *
 * A generator takes the person's description and returns candidate PNGs:
 *   generate({ prompt, n, signal }) → { ok: true, images: Buffer[] } | { ok: false, error: { kind } }
 * Error kinds the UI words: refused (content policy), busy (rate limit), limit
 * (daily cap), offline, error. The fake generator (fixture images) builds the
 * UI and runs the tests; the Model API generator calls a real image model
 * (Muse eval while developing, OpenAI through the AAI Labs team set later).
 * The description is never logged.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DRAW_URL, isDrawUrl } from './clerkConfig.mjs';

export const PROMPT_MAX = 200;
export const CANDIDATES = 3;
export const GENERATE_ERRORS = ['refused', 'busy', 'limit', 'offline', 'error'];

/** The person's text, trimmed and capped; null when empty. */
export function cleanPrompt(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, PROMPT_MAX);
  return t || null;
}

/** What the model is asked for: their text wrapped so results come out as sprites. */
export function petPrompt(text) {
  return (
    `A small cute desktop pet character: ${text}. Full body, centered, facing the viewer, ` +
    'flat cartoon style, bold outline, plain solid white background, no text, no shadow, no scenery.'
  );
}

/* The moods a kept pet gets its own picture for; chilling is the kept picture itself. */
export const MOODS = ['happy', 'sleepy', 'nervous', 'focused'];
const MOOD_LOOKS = {
  happy: 'happy: a big smile and sparkling eyes',
  sleepy: 'sleepy: eyes closed, drowsy, slightly slumped',
  nervous: 'nervous: wide open worried eyes, a sweat drop, a wobbly worried mouth',
  focused: 'focused: determined eyes, slightly furrowed brows, concentrating',
};

/** What the model is asked for to redraw a kept pet in a mood (an edit of its picture). */
export function moodPrompt(mood) {
  return (
    'The same character as in the image, same colors, same art style, same size and framing, full body, centered, ' +
    `facing the viewer. Change only its expression and pose to look ${MOOD_LOOKS[mood]}. ` +
    'Plain solid white background, no text, no shadow, no scenery.'
  );
}

/**
 * Draw every mood of a kept pet with `edit({ prompt, image, signal })`, at once.
 * Resolves { ok: true, moods: { [mood]: png } } with the moods that came back,
 * or { ok: false, error } when none did (refused if any edit was refused).
 */
export async function drawMoodsWith(edit, image, signal) {
  const results = await Promise.all(MOODS.map((mood) => edit({ prompt: moodPrompt(mood), image, signal }).catch(() => ({ ok: false, error: { kind: 'error' } }))));
  const moods = {};
  results.forEach((r, i) => {
    if (r.ok && r.images[0]) moods[MOODS[i]] = r.images[0];
  });
  if (Object.keys(moods).length) return { ok: true, moods };
  if (signal?.aborted) return { ok: false, error: { kind: 'cancelled' } };
  return { ok: false, error: { kind: results.some((r) => r.error?.kind === 'refused') ? 'refused' : (results[0]?.error?.kind ?? 'error') } };
}

/**
 * Fixture images instead of a model. `delayMs` mimics model latency; a prompt
 * containing "#refused", "#busy", "#limit", "#offline" or "#error" fails with
 * that kind, so every error state can be tried by hand.
 */
export function createFakeGenerator({ dir, delayMs = 1500, fsImpl = fs } = {}) {
  const files = () =>
    fsImpl
      .readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .sort()
      .map((f) => path.join(dir, f));
  return {
    kind: 'fake',
    async generate({ prompt, n = CANDIDATES, signal } = {}) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, delayMs);
        signal?.addEventListener('abort', () => (clearTimeout(t), resolve()));
      });
      if (signal?.aborted) return { ok: false, error: { kind: 'cancelled' } };
      const forced = GENERATE_ERRORS.find((k) => String(prompt).includes(`#${k}`));
      if (forced) return { ok: false, error: { kind: forced } };
      const all = files();
      if (all.length === 0) return { ok: false, error: { kind: 'error' } };
      return { ok: true, images: Array.from({ length: n }, (_, i) => fsImpl.readFileSync(all[i % all.length])) };
    },
  };
}

/* Image models Mochi can call through Meta Model API (same request shape). */
export const MODELS = {
  muse: { endpoint: 'https://api.meta.ai/v1/images/generations', editEndpoint: 'https://api.meta.ai/v1/images/edits', model: 'muse-image-1.0-eval' },
  openai: {
    endpoint: 'https://api.meta.ai/v1/passthrough/openai/v1/images/generations',
    editEndpoint: 'https://api.meta.ai/v1/passthrough/openai/v1/images/edits',
    model: 'gpt-image-2',
    /* OpenAI can draw on a transparent background, which skips the cutout. */
    extra: { background: 'transparent' },
  },
};

const REFUSED_CODES = new Set(['content_policy_violation', 'moderation_blocked', 'user_blocked']);

/** A Model API error response → the error kind the UI words. */
export function errorKind(status, body) {
  const err = body?.error ?? {};
  const code = String(err.code ?? err.type ?? '');
  const message = String(err.message ?? '');
  if (REFUSED_CODES.has(code) || /content.?policy|safety system/i.test(message)) return 'refused';
  if (status === 429) return /quota|daily|per day/i.test(message) ? 'limit' : 'busy';
  return 'error';
}

/**
 * The real thing: POST {model, prompt, n, user} to a Model API images endpoint.
 * `apiKey()` resolves the key (the draw server's, or a developer's Keychain);
 * `user` is Model API's per-user safety ID. `edit` redraws a picture
 * (`editEndpoint`, one image), which is how a kept pet gets its moods.
 */
export function createModelApiGenerator({ kind, endpoint, editEndpoint, model, extra = {}, apiKey, user, fetchImpl = fetch, timeoutMs = 120_000 }) {
  async function post(url, fields, signal) {
    let key;
    try {
      key = await apiKey();
    } catch {
      return { ok: false, error: { kind: 'error' } };
    }
    if (signal?.aborted) return { ok: false, error: { kind: 'cancelled' } };
    const timeout = AbortSignal.timeout(timeoutMs);
    const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, size: '1024x1024', output_format: 'png', user, ...extra, ...fields }),
        signal: both,
      });
    } catch {
      if (signal?.aborted) return { ok: false, error: { kind: 'cancelled' } };
      return { ok: false, error: { kind: timeout.aborted ? 'error' : 'offline' } };
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON: handled below */
    }
    if (signal?.aborted) return { ok: false, error: { kind: 'cancelled' } };
    if (!res.ok) return { ok: false, error: { kind: errorKind(res.status, body) } };
    const images = (Array.isArray(body?.data) ? body.data : [])
      .map((d) => (typeof d?.b64_json === 'string' ? Buffer.from(d.b64_json, 'base64') : null))
      .filter(Boolean);
    return images.length ? { ok: true, images } : { ok: false, error: { kind: 'error' } };
  }
  const edit = ({ prompt, image, signal } = {}) =>
    editEndpoint
      ? post(editEndpoint, { prompt, n: 1, images: [{ image_url: `data:image/png;base64,${image.toString('base64')}` }] }, signal)
      : Promise.resolve({ ok: false, error: { kind: 'error' } });
  return {
    kind,
    generate: ({ prompt, n = CANDIDATES, signal } = {}) => post(endpoint, { prompt, n }, signal),
    edit,
    /** A kept pet's mood pictures (see drawMoodsWith). */
    drawMoods: ({ image, signal } = {}) => drawMoodsWith(edit, image, signal),
  };
}

const SERVER_ERRORS = { 401: 'signin', 403: 'not_member', 422: 'refused', 503: 'busy' };

/**
 * Drawing through Mochi's draw server (server/), the only route allowed for
 * other people: it holds the Model API key and checks a Clerk sign-in. Sends
 * only what the person typed (the server adds Mochi's style instructions), or
 * the kept pet's picture for its moods, plus their Clerk session token;
 * resolves like the generators above, plus the kinds signin (no or rejected
 * sign-in) and not_member (not a Mochi tester).
 */
export function createProxyGenerator({ url, fetchImpl = fetch, timeoutMs = 150_000 }) {
  const base = String(url).replace(/\/+$/, '');
  async function post(route, payload, token, signal) {
    if (!token) return { ok: false, error: { kind: 'signin' } };
    const timeout = AbortSignal.timeout(timeoutMs);
    const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
      res = await fetchImpl(`${base}${route}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: both,
      });
    } catch {
      if (signal?.aborted) return { ok: false, error: { kind: 'cancelled' } };
      return { ok: false, error: { kind: timeout.aborted ? 'error' : 'offline' } };
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON: handled below */
    }
    if (signal?.aborted) return { ok: false, error: { kind: 'cancelled' } };
    if (!res.ok) {
      const kind = res.status === 429 ? (body?.error === 'daily_limit' ? 'limit' : 'busy') : (SERVER_ERRORS[res.status] ?? 'error');
      return { ok: false, error: { kind } };
    }
    return { ok: true, body };
  }
  const png = (b) => (typeof b === 'string' ? Buffer.from(b, 'base64') : null);
  return {
    kind: 'proxy',
    needsSignIn: true,
    async generate({ description, token, signal } = {}) {
      const r = await post('/v1/draw', { description }, token, signal);
      if (!r.ok) return r;
      const images = (Array.isArray(r.body?.images) ? r.body.images : []).map(png).filter(Boolean);
      return images.length ? { ok: true, images } : { ok: false, error: { kind: 'error' } };
    },
    /** The kept pet's mood pictures: { ok, moods: { [mood]: png } } with the moods the server drew. */
    async drawMoods({ image, token, signal } = {}) {
      const r = await post('/v1/moods', { image: image.toString('base64') }, token, signal);
      if (!r.ok) return r;
      const moods = {};
      for (const mood of MOODS) {
        const p = png(r.body?.moods?.[mood]);
        if (p) moods[mood] = p;
      }
      return Object.keys(moods).length ? { ok: true, moods } : { ok: false, error: { kind: 'error' } };
    },
  };
}

export const KEYCHAIN_SERVICE = 'mochi-model-api';

/** The Model API key from this Mac's login Keychain (developers only; never shipped, never logged). */
export function keychainKey({ service = KEYCHAIN_SERVICE, account = os.userInfo().username, execFileImpl = execFile } = {}) {
  let cached = null;
  return () =>
    (cached ??= new Promise((resolve, reject) => {
      execFileImpl('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: 10_000 }, (err, stdout) => {
        const key = String(stdout ?? '').trim();
        if (err || !key) reject(new Error(`no ${service} key in the Keychain`));
        else resolve(key);
      });
    }).catch((err) => {
      /* not there yet: ask again next time */
      cached = null;
      throw err;
    }));
}

/**
 * Which generator this build uses, from MOCHI_PET_GENERATOR:
 *   packaged builds: `proxy` when a draw server is set (DRAW_URL in clerkConfig.mjs, or
 *   MOCHI_DRAW_URL), otherwise none (Customize stays hidden); or `fake`;
 *   from source: `fake` (default), `proxy` (MOCHI_DRAW_URL, default a server on this Mac),
 *   or `muse` / `openai` with MOCHI_PET_USER (your FBID) and the key in the Keychain under
 *   `mochi-model-api`.
 * Resolves { generator, note } where note explains a fallback.
 */
export function pickGenerator({ packaged, env, fixturesDir, apiKey = keychainKey(), fetchImpl, drawUrl = DRAW_URL }) {
  const draw = env.MOCHI_DRAW_URL || (packaged ? drawUrl : null);
  const want = env.MOCHI_PET_GENERATOR ?? (packaged ? (draw ? 'proxy' : '') : 'fake');
  const fake = () => createFakeGenerator({ dir: fixturesDir });
  if (want === 'fake') return { generator: fake() };
  // Through the draw server, with Clerk sign-in. Sign-in tokens only go to https, or to this Mac.
  if (want === 'proxy') {
    const url = draw || (packaged ? null : 'http://127.0.0.1:8787');
    if (!url || !isDrawUrl(url)) return { generator: null, note: url ? `draw server ${url} must be https (or on this Mac); Customize is off` : undefined };
    return { generator: createProxyGenerator({ url, ...(fetchImpl ? { fetchImpl } : {}) }) };
  }
  if (packaged || !MODELS[want]) return { generator: null };
  const user = String(env.MOCHI_PET_USER ?? '').trim();
  if (!/^\d{5,20}$/.test(user)) {
    return { generator: fake(), note: `MOCHI_PET_GENERATOR=${want} needs MOCHI_PET_USER (your FBID); using practice drawings` };
  }
  return { generator: createModelApiGenerator({ kind: want, ...MODELS[want], apiKey, user, ...(fetchImpl ? { fetchImpl } : {}) }) };
}
