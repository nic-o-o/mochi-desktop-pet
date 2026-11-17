/* Verifying a Clerk session token on the draw server.
 *
 * Labs policy: the server trusts only Clerk-issued tokens, and verifies each
 * one itself. Verification needs only the instance's PUBLIC keys (its JWKS),
 * never a Clerk secret key, so the server can't manage anyone's account.
 *
 * Mochi signs in with the Ember lab's Clerk application (one app per lab), so
 * a valid token alone isn't enough: the user must also be a member of Mochi's
 * organization ("Codimango Companion") when `orgId` is set.
 */
import crypto from 'node:crypto';

export { frontendApiHost } from '../electron/clerkConfig.mjs';

const b64url = (s) => Buffer.from(s, 'base64url');

function decodeJwt(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(b64url(parts[0]).toString('utf8')),
      payload: JSON.parse(b64url(parts[1]).toString('utf8')),
      signed: `${parts[0]}.${parts[1]}`,
      signature: b64url(parts[2]),
    };
  } catch {
    return null;
  }
}

/** The organization a token is for: session token v2 (`o.id`) or v1 (`org_id`). */
function tokenOrgId(payload) {
  return (payload?.o && typeof payload.o.id === 'string' ? payload.o.id : null) ?? (typeof payload?.org_id === 'string' ? payload.org_id : null);
}

/**
 * `verify(token)` → { ok: true, userId } or { ok: false, reason }.
 * Reasons: malformed, unsupported, unknown_key, bad_signature, wrong_issuer,
 * expired, not_yet_valid, wrong_party, not_member, jwks_unavailable.
 */
export function createClerkVerifier({
  issuer,
  jwksUrl = `${issuer}/.well-known/jwks.json`,
  orgId = null,
  allowedParties = null,
  fetchImpl = fetch,
  now = () => Date.now(),
  skewSec = 5,
  jwksTtlMs = 60 * 60_000,
  minRefetchMs = 30_000,
}) {
  let keys = new Map();
  let fetchedAt = 0;
  let inflight = null;

  async function loadKeys(force) {
    const age = now() - fetchedAt;
    if (!force && keys.size && age < jwksTtlMs) return;
    if (force && age < minRefetchMs) return; // an unknown kid can't make us hammer the JWKS
    inflight ??= (async () => {
      const res = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`jwks ${res.status}`);
      const body = await res.json();
      const next = new Map();
      for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
        if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
        next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
      }
      keys = next;
      fetchedAt = now();
    })().finally(() => {
      inflight = null;
    });
    await inflight;
  }

  return async function verify(token) {
    const jwt = decodeJwt(token);
    if (!jwt) return { ok: false, reason: 'malformed' };
    if (jwt.header?.alg !== 'RS256' || typeof jwt.header?.kid !== 'string') return { ok: false, reason: 'unsupported' };
    try {
      await loadKeys(false);
      if (!keys.has(jwt.header.kid)) await loadKeys(true);
    } catch {
      return { ok: false, reason: 'jwks_unavailable' };
    }
    const key = keys.get(jwt.header.kid);
    if (!key) return { ok: false, reason: 'unknown_key' };
    if (!crypto.verify('RSA-SHA256', Buffer.from(jwt.signed), key, jwt.signature)) return { ok: false, reason: 'bad_signature' };
    const p = jwt.payload ?? {};
    const t = now() / 1000;
    if (p.iss !== issuer) return { ok: false, reason: 'wrong_issuer' };
    if (typeof p.exp !== 'number' || p.exp + skewSec < t) return { ok: false, reason: 'expired' };
    if (typeof p.nbf === 'number' && p.nbf - skewSec > t) return { ok: false, reason: 'not_yet_valid' };
    if (typeof p.sub !== 'string' || !p.sub.startsWith('user_')) return { ok: false, reason: 'malformed' };
    if (allowedParties && p.azp !== undefined && !allowedParties.includes(p.azp)) return { ok: false, reason: 'wrong_party' };
    if (orgId && tokenOrgId(p) !== orgId) return { ok: false, reason: 'not_member' };
    return { ok: true, userId: p.sub };
  };
}
