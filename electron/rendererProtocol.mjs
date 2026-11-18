/* The packaged renderer's address: mochi://renderer/ (main process only).
 *
 * Packaged builds used to load dist/index.html over file://. Clerk's Electron
 * SDK (sign-in for Customize Mochi) needs the renderer on a custom scheme with
 * a stable origin it can list as allowed, so the packaged app now serves dist/
 * through this scheme instead. The dev build keeps loading from Vite.
 *
 * Every response carries the Content Security Policy below: the renderer runs
 * only its own bundled code and shows only bundled or data: images; anything
 * on the network goes through the main process. The one exception is Customize
 * Mochi's Clerk sign-in, which runs in the renderer: when it's on, rendererCsp
 * adds the Clerk addresses its Electron SDK documents, and nothing else.
 */
import path from 'node:path';

export const SCHEME = 'mochi';
export const HOST = 'renderer';
export const ORIGIN = `${SCHEME}://${HOST}`;

/** What the renderer may load. Inline styles stay allowed: React style props use them. */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** CSP, plus Clerk's documented sources when sign-in is on (`clerkHost`: the instance's Frontend API host). */
export function rendererCsp(clerkHost) {
  if (!clerkHost) return CSP;
  const add = {
    'script-src': `'unsafe-inline' https://${clerkHost} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    'connect-src': `https://${clerkHost} https://*.protect.clerk.com:* https://clerk-telemetry.com`,
    'img-src': 'https://img.clerk.com',
  };
  const directives = CSP.split('; ').map((d) => {
    const name = d.split(' ')[0];
    return add[name] ? `${d} ${add[name]}` : d;
  });
  directives.push("worker-src 'self' blob:", "frame-src 'self' https://challenges.cloudflare.com https://*.protect.clerk.com");
  return directives.join('; ');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/** Must run before app `ready`: the scheme behaves like https (fetch, CORS, secure context). */
export function registerRendererScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

/**
 * The file in `distDir` a renderer URL names, or null. Only mochi://renderer/
 * is served, nothing outside dist/ (no `..`, no encoded separators), and a
 * path with no file extension is a route, answered with index.html.
 */
export function resolveRendererFile(distDir, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEME}:` || u.host !== HOST) return null;
  let rel;
  try {
    rel = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  // `..` left after decoding came from an encoded separator (%2f); the URL parser already removed plain ones.
  if (rel.includes('\0') || rel.includes('\\') || rel.split('/').includes('..')) return null;
  if (rel === '/' || rel === '' || !path.posix.extname(rel)) rel = '/index.html';
  const root = path.resolve(distDir);
  const file = path.resolve(root, `.${path.posix.normalize(rel)}`);
  return file.startsWith(root + path.sep) ? file : null;
}

/** A blank page on this origin, where the one-time storage migration writes (storageMigration.mjs). */
export const STORAGE_PAGE = `${ORIGIN}/__storage`;

/** The response for one renderer request; `readFile` is fs.promises.readFile, `csp` from rendererCsp. */
export async function rendererResponse(distDir, url, readFile, csp = CSP) {
  if (url.split(/[?#]/)[0] === STORAGE_PAGE) {
    return new Response('<!doctype html><title>Mochi</title>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp },
    });
  }
  const file = resolveRendererFile(distDir, url);
  if (!file) return new Response('Not found', { status: 404, headers: { 'Content-Security-Policy': csp } });
  let body;
  try {
    body = await readFile(file);
  } catch {
    return new Response('Not found', { status: 404, headers: { 'Content-Security-Policy': csp } });
  }
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** Navigation the window allows: its own origin, or the dev server it was loaded from. */
export function isAppNavigation(url, devUrl) {
  try {
    const u = new URL(url);
    if (u.protocol === `${SCHEME}:` && u.host === HOST) return true;
    return Boolean(devUrl) && u.origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
}
