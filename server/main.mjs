/* Run the draw server.
 *
 *   CLERK_PUBLISHABLE_KEY=pk_test_… node server/main.mjs
 *
 * Environment:
 *   CLERK_PUBLISHABLE_KEY  Clerk instance whose tokens are accepted (required)
 *   MOCHI_ORG_ID           Mochi's Clerk organization; unset = any signed-in user (local testing only)
 *   MOCHI_ALLOWED_PARTIES  origins a token may be minted for (its azp), comma-separated; default
 *                          mochi://renderer, plus http://localhost:5173 on a Development (pk_test_) instance
 *   MOCHI_MODEL            muse (development) or openai (gpt-image-2 via the AAI Labs team set); default openai
 *   MODEL_API_KEY          the key; unset = this Mac's Keychain (service mochi-model-api), developers only
 *   DAILY_PER_USER         drawings per person per day (default 10; a kept pet's set of moods counts as one)
 *   DAILY_TOTAL            drawings per day for everyone (default 200)
 *   HOST, PORT             default 127.0.0.1:8787
 *
 * The key is read on each use (cached a few minutes), not at startup, because
 * Model API rotates keys with public internet access about every 30 days.
 */
import http from 'node:http';
import { createModelApiGenerator, keychainKey, MODELS } from '../electron/petGenerator.mjs';
import { createClerkVerifier, frontendApiHost } from './clerk.mjs';
import { createDailyLimits, createDrawHandler } from './drawServer.mjs';

const KEY_TTL_MS = 5 * 60_000;

/** A key provider that re-reads its source every few minutes. */
export function freshKey(read, { ttlMs = KEY_TTL_MS, now = () => Date.now() } = {}) {
  let value = null;
  let at = 0;
  return async () => {
    if (value && now() - at < ttlMs) return value;
    value = await read();
    at = now();
    return value;
  };
}

export function configFromEnv(env) {
  const host = frontendApiHost(env.CLERK_PUBLISHABLE_KEY);
  if (!host) throw new Error('Set CLERK_PUBLISHABLE_KEY to the Clerk instance whose sign-ins this server accepts.');
  const model = MODELS[env.MOCHI_MODEL ?? 'openai'];
  if (!model) throw new Error(`MOCHI_MODEL must be one of: ${Object.keys(MODELS).join(', ')}`);
  return {
    issuer: `https://${host}`,
    orgId: env.MOCHI_ORG_ID?.trim() || null,
    // Labs auth policy: the backend checks azp is the app's own origin. The dev server's origin only on Development.
    allowedParties: env.MOCHI_ALLOWED_PARTIES
      ? env.MOCHI_ALLOWED_PARTIES.split(',').map((s) => s.trim()).filter(Boolean)
      : ['mochi://renderer', ...(String(env.CLERK_PUBLISHABLE_KEY).startsWith('pk_test_') ? ['http://localhost:5173'] : [])],
    model,
    perUser: Number(env.DAILY_PER_USER ?? 10),
    total: Number(env.DAILY_TOTAL ?? 200),
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 8787),
  };
}

export function createServer(cfg, { env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const apiKey = freshKey(env.MODEL_API_KEY ? async () => env.MODEL_API_KEY : () => keychainKey()());
  const verify = createClerkVerifier({ issuer: cfg.issuer, orgId: cfg.orgId, allowedParties: cfg.allowedParties, fetchImpl });
  const handle = createDrawHandler({
    verify,
    limits: createDailyLimits({ perUser: cfg.perUser, total: cfg.total }),
    draw: ({ prompt, user }) => createModelApiGenerator({ kind: 'proxy', ...cfg.model, apiKey, user, fetchImpl }).generate({ prompt }),
    drawMoods: ({ image, user }) => createModelApiGenerator({ kind: 'proxy', ...cfg.model, apiKey, user, fetchImpl }).drawMoods({ image }),
    log,
  });
  return http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"internal"}');
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = configFromEnv(process.env);
  if (!cfg.orgId) console.warn('[draw] MOCHI_ORG_ID is not set: any signed-in user of this Clerk instance can draw. Local testing only.');
  createServer(cfg).listen(cfg.port, cfg.host, () => console.log(`[draw] listening on http://${cfg.host}:${cfg.port}, accepting ${cfg.issuer}`));
}
