/* Customize Mochi's sign-in and draw server, for the main process (and server/).
 *
 * The publishable key is public by design; src/mochi/clerkConfig.ts holds the
 * same default for the renderer (clerkConfig.test.mjs checks they match).
 */

/** The Ember lab's Clerk Development instance, which Mochi shares. */
export const CLERK_PUBLISHABLE_KEY = 'pk_test_cGlja2VkLWJ1bGxkb2ctODg4OC5jbGVyay5hY2NvdW50cy5kZXYk';

/**
 * Where packaged builds draw: Mochi's deployed draw server (https), or null
 * while it isn't deployed, which keeps Customize hidden in packaged builds.
 * MOCHI_DRAW_URL overrides it, e.g. to try a packaged build against a local server.
 */
export const DRAW_URL = null;

/** The Frontend API host a publishable key encodes, e.g. pk_test_… → picked-bulldog-8888.clerk.accounts.dev. */
export function frontendApiHost(publishableKey) {
  const m = /^pk_(test|live)_(.+)$/.exec(String(publishableKey ?? '').trim());
  if (!m) return null;
  const host = Buffer.from(m[2], 'base64').toString('utf8').replace(/\$$/, '');
  return /^[a-z0-9.-]+$/i.test(host) ? host : null;
}

/** A draw server address Mochi will send sign-in tokens to: https, or http only on this Mac. */
export function isDrawUrl(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}
