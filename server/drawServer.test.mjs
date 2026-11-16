import crypto from 'node:crypto';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createDailyLimits, createDrawHandler, safetyId } from './drawServer.mjs';
import { configFromEnv, freshKey } from './main.mjs';

const servers = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/* A real HTTP server around the handler, with a fake verifier and image model. */
async function serve({ verify, draw, perUser = 2, total = 100 } = {}) {
  const draws = [];
  const logs = [];
  const handle = createDrawHandler({
    verify: verify ?? (async (token) => (token === 'good' ? { ok: true, userId: 'user_2abc' } : token === 'outsider' ? { ok: false, reason: 'not_member' } : { ok: false, reason: 'bad_signature' })),
    limits: createDailyLimits({ perUser, total }),
    draw: async (req) => (draws.push(req), draw ? draw(req) : { ok: true, images: [Buffer.from('png1'), Buffer.from('png2')] }),
    log: (l) => logs.push(l),
  });
  const server = http.createServer((req, res) => void handle(req, res));
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, token = 'good') =>
    fetch(`${base}/v1/draw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { base, post, draws, logs };
}

describe('safetyId', () => {
  it('is the 64-character SHA-256 hex of the Clerk user ID, with no prefix', () => {
    const id = safetyId('user_2abc');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(crypto.createHash('sha256').update('user_2abc').digest('hex'));
  });
});

describe('draw server', () => {
  it('draws for a signed-in member, sending the model only the description and the hashed user', async () => {
    const s = await serve();
    const res = await s.post({ description: '  a sleepy orange cat with a scarf  ', unixname: 'debrax', fbid: '4782' });
    expect(res.status).toBe(200);
    expect(res.body.images).toEqual([Buffer.from('png1').toString('base64'), Buffer.from('png2').toString('base64')]);
    expect(s.draws).toEqual([{ prompt: 'a sleepy orange cat with a scarf', user: safetyId('user_2abc') }]);
    expect(s.logs.join('\n')).not.toMatch(/sleepy|user_2abc/);
  });

  it('refuses without a valid token, and outsiders to the organization', async () => {
    const s = await serve();
    expect((await s.post({ description: 'cat' }, null)).status).toBe(401);
    expect((await s.post({ description: 'cat' }, 'forged')).status).toBe(401);
    expect(await s.post({ description: 'cat' }, 'outsider')).toEqual({ status: 403, body: { error: 'not_member' } });
    expect(s.draws).toHaveLength(0);
  });

  it('rejects empty, oversized or malformed requests before drawing', async () => {
    const s = await serve();
    expect((await s.post({ description: '   ' })).status).toBe(400);
    expect((await s.post({ description: 'x'.repeat(401) })).status).toBe(400);
    expect((await s.post('{not json')).status).toBe(400);
    expect((await fetch(`${s.base}/v1/draw`)).status).toBe(405);
    expect((await fetch(`${s.base}/healthz`)).status).toBe(200);
    expect(s.draws).toHaveLength(0);
  });

  it('applies the per-person daily limit; our failures are refunded, refusals are not', async () => {
    let next = { ok: false, error: { kind: 'busy' } };
    const s = await serve({ perUser: 2, draw: async () => next });
    expect((await s.post({ description: 'cat' })).status).toBe(503); // busy: refunded
    next = { ok: false, error: { kind: 'refused' } };
    expect((await s.post({ description: 'cat' })).status).toBe(422); // refused: counts
    next = { ok: true, images: [Buffer.from('p')] };
    expect((await s.post({ description: 'cat' })).body.left).toBe(0);
    expect(await s.post({ description: 'cat' })).toEqual({ status: 429, body: { error: 'daily_limit' } });
  });

  it('applies the overall daily limit across people, and resets each UTC day', () => {
    let t = Date.parse('2026-11-16T23:59:00Z');
    const limits = createDailyLimits({ perUser: 5, total: 2, now: () => t });
    expect(limits.take('a').ok).toBe(true);
    expect(limits.take('b').ok).toBe(true);
    expect(limits.take('c')).toEqual({ ok: false, scope: 'total' });
    t = Date.parse('2026-11-17T00:01:00Z');
    expect(limits.take('c').ok).toBe(true);
  });
});

describe('config and key', () => {
  it('reads the Clerk issuer from the publishable key and refuses to start without one', () => {
    const cfg = configFromEnv({ CLERK_PUBLISHABLE_KEY: 'pk_test_cGlja2VkLWJ1bGxkb2ctODg4OC5jbGVyay5hY2NvdW50cy5kZXYk', MOCHI_MODEL: 'muse' });
    expect(cfg).toMatchObject({ issuer: 'https://picked-bulldog-8888.clerk.accounts.dev', orgId: null, perUser: 10, total: 200, host: '127.0.0.1', port: 8787 });
    expect(cfg.model.model).toBe('muse-image-1.0-eval');
    expect(() => configFromEnv({})).toThrow(/CLERK_PUBLISHABLE_KEY/);
    expect(() => configFromEnv({ CLERK_PUBLISHABLE_KEY: 'pk_test_cGlja2VkLWJ1bGxkb2ctODg4OC5jbGVyay5hY2NvdW50cy5kZXYk', MOCHI_MODEL: 'gemini' })).toThrow(/MOCHI_MODEL/);
  });

  it('re-reads the Model API key after a few minutes, so a rotated key is picked up', async () => {
    let t = 0;
    let n = 0;
    const key = freshKey(async () => `key-${++n}`, { ttlMs: 1000, now: () => t });
    expect(await key()).toBe('key-1');
    expect(await key()).toBe('key-1');
    t = 1500;
    expect(await key()).toBe('key-2');
  });
});
