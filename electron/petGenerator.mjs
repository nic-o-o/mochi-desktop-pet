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
  muse: { endpoint: 'https://api.meta.ai/v1/images/generations', model: 'muse-image-1.0-eval' },
  openai: {
    endpoint: 'https://api.meta.ai/v1/passthrough/openai/v1/images/generations',
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
 * `apiKey()` resolves the key (from the developer's Keychain until the proxy
 * exists); `user` is the end user's FBID, which Model API requires for safety.
 */
export function createModelApiGenerator({ kind, endpoint, model, extra = {}, apiKey, user, fetchImpl = fetch, timeoutMs = 120_000 }) {
  return {
    kind,
    async generate({ prompt, n = CANDIDATES, signal } = {}) {
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
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt, n, size: '1024x1024', output_format: 'png', user, ...extra }),
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
    },
  };
}

const SERVER_ERRORS = { 401: 'signin', 403: 'not_member', 422: 'refused', 503: 'busy' };

/**
 * Drawing through Mochi's draw server (server/), the only route allowed for
 * other people: it holds the Model API key and checks a Clerk sign-in. Sends
 * only what the person typed (the server adds Mochi's style instructions) and
 * their Clerk session token; resolves like the generators above, plus the
 * kinds signin (no or rejected sign-in) and not_member (not a Mochi tester).
 */
export function createProxyGenerator({ url, fetchImpl = fetch, timeoutMs = 150_000 }) {
  const endpoint = `${String(url).replace(/\/+$/, '')}/v1/draw`;
  return {
    kind: 'proxy',
    needsSignIn: true,
    async generate({ description, token, signal } = {}) {
      if (!token) return { ok: false, error: { kind: 'signin' } };
      const timeout = AbortSignal.timeout(timeoutMs);
      const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ description }),
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
      const images = (Array.isArray(body?.images) ? body.images : []).filter((b) => typeof b === 'string').map((b) => Buffer.from(b, 'base64'));
      return images.length ? { ok: true, images } : { ok: false, error: { kind: 'error' } };
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
