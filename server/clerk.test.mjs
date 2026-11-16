import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createClerkVerifier, frontendApiHost } from './clerk.mjs';

const ISSUER = 'https://picked-bulldog-8888.clerk.accounts.dev';
const NOW = Date.parse('2026-11-16T12:00:00Z');
const T = NOW / 1000;

/* A fake Clerk instance: an RSA key pair, its JWKS, and tokens signed with it. */
function fakeClerk(kid = 'ins_1') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const sign = (payload, header = { alg: 'RS256', kid, typ: 'JWT' }, key = privateKey) => {
    const head = Buffer.from(JSON.stringify(header)).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
    return `${head}.${body}.${sig}`;
  };
  let fetches = 0;
  const fetchImpl = async (url) => {
    fetches += 1;
    expect(url).toBe(`${ISSUER}/.well-known/jwks.json`);
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  };
  return { sign, fetchImpl, fetches: () => fetches, privateKey };
}

const valid = (over = {}) => ({ iss: ISSUER, sub: 'user_2abc', iat: T - 10, nbf: T - 10, exp: T + 50, azp: 'mochi://renderer', ...over });

describe('frontendApiHost', () => {
  it('reads the Frontend API host out of a publishable key', () => {
    expect(frontendApiHost('pk_test_cGlja2VkLWJ1bGxkb2ctODg4OC5jbGVyay5hY2NvdW50cy5kZXYk')).toBe('picked-bulldog-8888.clerk.accounts.dev');
    expect(frontendApiHost('sk_test_secret')).toBeNull();
    expect(frontendApiHost('')).toBeNull();
  });
});

describe('createClerkVerifier', () => {
  it('accepts a valid token signed by the instance, and caches its keys', async () => {
    const c = fakeClerk();
    const verify = createClerkVerifier({ issuer: ISSUER, fetchImpl: c.fetchImpl, now: () => NOW });
    expect(await verify(c.sign(valid()))).toEqual({ ok: true, userId: 'user_2abc' });
    expect(await verify(c.sign(valid({ sub: 'user_other' })))).toEqual({ ok: true, userId: 'user_other' });
    expect(c.fetches()).toBe(1);
  });

  it('refuses forged, expired, foreign and malformed tokens', async () => {
    const c = fakeClerk();
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const verify = createClerkVerifier({ issuer: ISSUER, fetchImpl: c.fetchImpl, now: () => NOW, allowedParties: ['mochi://renderer', 'http://localhost:5173'] });
    const reason = async (token) => (await verify(token)).reason;
    expect(await reason(c.sign(valid(), undefined, other))).toBe('bad_signature');
    expect(await reason(c.sign(valid({ exp: T - 60 })))).toBe('expired');
    expect(await reason(c.sign(valid({ nbf: T + 60 })))).toBe('not_yet_valid');
    expect(await reason(c.sign(valid({ iss: 'https://evil.clerk.accounts.dev' })))).toBe('wrong_issuer');
    expect(await reason(c.sign(valid({ azp: 'https://ember.example' })))).toBe('wrong_party');
    expect(await reason(c.sign(valid({ sub: 'org_123' })))).toBe('malformed');
    expect(await reason(c.sign(valid(), { alg: 'HS256', kid: 'ins_1' }))).toBe('unsupported');
    expect(await reason(c.sign(valid(), { alg: 'none', kid: 'ins_1' }))).toBe('unsupported');
    expect(await reason('not.a.token')).toBe('malformed');
    expect(await reason('')).toBe('malformed');
  });

  it('requires membership in Mochi\'s organization when one is set (session token v2 or v1 claims)', async () => {
    const c = fakeClerk();
    const verify = createClerkVerifier({ issuer: ISSUER, orgId: 'org_mochi', fetchImpl: c.fetchImpl, now: () => NOW });
    expect((await verify(c.sign(valid({ o: { id: 'org_mochi', rol: 'member' } })))).ok).toBe(true);
    expect((await verify(c.sign(valid({ org_id: 'org_mochi' })))).ok).toBe(true);
    expect((await verify(c.sign(valid({ o: { id: 'org_ember' } })))).reason).toBe('not_member');
    expect((await verify(c.sign(valid()))).reason).toBe('not_member');
  });

  it('refetches keys once for an unknown key id, but not on every request', async () => {
    const c = fakeClerk('ins_1');
    let t = NOW;
    const verify = createClerkVerifier({ issuer: ISSUER, fetchImpl: c.fetchImpl, now: () => t });
    const unknown = c.sign(valid(), { alg: 'RS256', kid: 'ins_rotated' });
    expect((await verify(unknown)).reason).toBe('unknown_key');
    expect((await verify(unknown)).reason).toBe('unknown_key');
    expect(c.fetches()).toBe(1);
    t += 31_000;
    await verify(unknown);
    expect(c.fetches()).toBe(2);
  });

  it('says the keys are unavailable instead of accepting anything when the JWKS fails', async () => {
    const c = fakeClerk();
    const verify = createClerkVerifier({ issuer: ISSUER, fetchImpl: async () => new Response('down', { status: 503 }), now: () => NOW });
    expect((await verify(c.sign(valid()))).reason).toBe('jwks_unavailable');
  });
});
