import { describe, expect, it } from 'vitest';
import { MODELS, createModelApiGenerator, createProxyGenerator, errorKind, keychainKey, pickGenerator } from './petGenerator.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

function generator(fetchImpl, apiKey = async () => 'sk-test') {
  const calls = [];
  const g = createModelApiGenerator({
    kind: 'muse',
    ...MODELS.muse,
    apiKey,
    user: '478256448063430',
    fetchImpl: async (url, init) => (calls.push({ url, init }), fetchImpl(url, init)),
  });
  return { g, calls };
}

describe('Model API generator', () => {
  it('asks for n images for the end user and decodes them', async () => {
    const b64 = PNG.toString('base64');
    const { g, calls } = generator(reply(200, { data: [{ b64_json: b64 }, { b64_json: b64 }, { b64_json: b64 }] }));
    const r = await g.generate({ prompt: 'a pet', n: 3 });
    expect(r.ok).toBe(true);
    expect(r.images).toHaveLength(3);
    expect(r.images[0].equals(PNG)).toBe(true);
    expect(calls[0].url).toBe('https://api.meta.ai/v1/images/generations');
    expect(calls[0].init.headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      model: 'muse-image-1.0-eval',
      prompt: 'a pet',
      n: 3,
      size: '1024x1024',
      output_format: 'png',
      user: '478256448063430',
    });
  });

  it('maps refusals, rate limits, daily caps and other failures', async () => {
    const kind = async (status, body) => (await generator(reply(status, body)).g.generate({ prompt: 'x' })).error?.kind;
    expect(await kind(400, { error: { code: 'content_policy_violation', message: 'nope' } })).toBe('refused');
    expect(await kind(400, { error: { code: 'moderation_blocked' } })).toBe('refused');
    expect(await kind(403, { error: { code: 'user_blocked' } })).toBe('refused');
    expect(await kind(429, { error: { message: 'Rate limit reached, try again in 20s' } })).toBe('busy');
    expect(await kind(429, { error: { message: 'You exceeded your daily quota' } })).toBe('limit');
    expect(await kind(401, { error: { message: 'bad key' } })).toBe('error');
    expect(await kind(500, null)).toBe('error');
    expect(await kind(200, { data: [] })).toBe('error');
    expect(errorKind(400, { error: { message: 'Your request was rejected by the safety system' } })).toBe('refused');
  });

  it('is offline when the request never reaches the service, and an error when the key is missing', async () => {
    const offline = generator(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await offline.g.generate({ prompt: 'x' })).error.kind).toBe('offline');
    const noKey = generator(reply(200, {}), async () => {
      throw new Error('no key');
    });
    expect((await noKey.g.generate({ prompt: 'x' })).error.kind).toBe('error');
    expect(noKey.calls).toHaveLength(0);
  });

  it('is cancelled when the person cancels mid-request', async () => {
    const ac = new AbortController();
    const { g } = generator(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = g.generate({ prompt: 'x', signal: ac.signal });
    /* abort once the request is in flight */
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    expect((await pending).error.kind).toBe('cancelled');
  });
});

describe('pickGenerator', () => {
  const fixturesDir = '/nowhere';
  it('uses practice drawings from source and nothing in packaged builds by default', () => {
    expect(pickGenerator({ packaged: false, env: {}, fixturesDir }).generator.kind).toBe('fake');
    expect(pickGenerator({ packaged: true, env: {}, fixturesDir }).generator).toBeNull();
    expect(pickGenerator({ packaged: true, env: { MOCHI_PET_GENERATOR: 'muse', MOCHI_PET_USER: '478256448063430' }, fixturesDir }).generator).toBeNull();
    expect(pickGenerator({ packaged: true, env: { MOCHI_PET_GENERATOR: 'fake' }, fixturesDir }).generator.kind).toBe('fake');
  });

  it('uses the real model from source with an FBID, and explains the fallback without one', () => {
    const real = pickGenerator({ packaged: false, env: { MOCHI_PET_GENERATOR: 'muse', MOCHI_PET_USER: '478256448063430' }, fixturesDir, apiKey: async () => 'k' });
    expect(real.generator.kind).toBe('muse');
    const missing = pickGenerator({ packaged: false, env: { MOCHI_PET_GENERATOR: 'openai' }, fixturesDir, apiKey: async () => 'k' });
    expect(missing.generator.kind).toBe('fake');
    expect(missing.note).toMatch(/MOCHI_PET_USER/);
  });
});

describe('keychainKey', () => {
  it('reads the key once, and tries again after a failure', async () => {
    let calls = 0;
    let fail = true;
    const execFileImpl = (bin, args, _opts, cb) => {
      calls++;
      expect(bin).toBe('/usr/bin/security');
      expect(args).toEqual(['find-generic-password', '-s', 'mochi-model-api', '-a', 'me', '-w']);
      if (fail) cb(new Error('not found'), '');
      else cb(null, 'sk-123\n');
    };
    const key = keychainKey({ account: 'me', execFileImpl });
    await expect(key()).rejects.toThrow(/mochi-model-api/);
    fail = false;
    expect(await key()).toBe('sk-123');
    expect(await key()).toBe('sk-123');
    expect(calls).toBe(2);
  });
});

describe('createProxyGenerator (the draw server)', () => {
  const ok = (body, status = 200) => new Response(JSON.stringify(body), { status });
  it('sends only the description and the Clerk token, and returns the drawings', async () => {
    const calls = [];
    const gen = createProxyGenerator({ url: 'http://127.0.0.1:8787/', fetchImpl: async (u, init) => (calls.push({ u, init }), ok({ images: [Buffer.from('png').toString('base64')] })) });
    const r = await gen.generate({ prompt: 'A small cute desktop pet character: cat…', description: 'cat', token: 'tok' });
    expect(r).toEqual({ ok: true, images: [Buffer.from('png')] });
    expect(calls[0].u).toBe('http://127.0.0.1:8787/v1/draw');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0].init.body)).toEqual({ description: 'cat' });
    expect(gen.needsSignIn).toBe(true);
  });

  it('asks for sign-in without a token, and maps the server answers to error kinds', async () => {
    const gen = (status, body = {}) => createProxyGenerator({ url: 'http://x', fetchImpl: async () => ok(body, status) });
    expect((await createProxyGenerator({ url: 'http://x', fetchImpl: async () => ok({}) }).generate({ description: 'cat' })).error.kind).toBe('signin');
    expect((await gen(401).generate({ description: 'cat', token: 't' })).error.kind).toBe('signin');
    expect((await gen(403).generate({ description: 'cat', token: 't' })).error.kind).toBe('not_member');
    expect((await gen(429, { error: 'daily_limit' }).generate({ description: 'cat', token: 't' })).error.kind).toBe('limit');
    expect((await gen(429, { error: 'service_limit' }).generate({ description: 'cat', token: 't' })).error.kind).toBe('busy');
    expect((await gen(422).generate({ description: 'cat', token: 't' })).error.kind).toBe('refused');
    expect((await createProxyGenerator({ url: 'http://x', fetchImpl: async () => { throw new Error('down'); } }).generate({ description: 'cat', token: 't' })).error.kind).toBe('offline');
  });

  it('is what MOCHI_PET_GENERATOR=proxy picks from source, and what packaged builds use once a draw server is set', () => {
    const pick = (packaged, env, drawUrl = null) => pickGenerator({ packaged, env, fixturesDir: '/x', drawUrl }).generator;
    expect(pick(false, { MOCHI_PET_GENERATOR: 'proxy' }).kind).toBe('proxy');
    // Packaged: hidden until the draw server is deployed, then on by default.
    expect(pick(true, {})).toBeNull();
    expect(pick(true, { MOCHI_PET_GENERATOR: 'proxy' })).toBeNull();
    expect(pick(true, {}, 'https://mochi.example.com').kind).toBe('proxy');
    expect(pick(true, { MOCHI_DRAW_URL: 'http://127.0.0.1:8787' }).kind).toBe('proxy');
    // Sign-in tokens never go to a plain-http server elsewhere.
    const insecure = pickGenerator({ packaged: true, env: {}, fixturesDir: '/x', drawUrl: 'http://mochi.example.com' });
    expect(insecure.generator).toBeNull();
    expect(insecure.note).toMatch(/https/);
    expect(pick(false, { MOCHI_PET_GENERATOR: 'proxy', MOCHI_DRAW_URL: 'http://mochi.example.com' })).toBeNull();
  });
});

