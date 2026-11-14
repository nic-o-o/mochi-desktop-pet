import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSP, ORIGIN, isAppNavigation, registerRendererScheme, rendererResponse, resolveRendererFile } from './rendererProtocol.mjs';

const DIST = path.resolve('/app/dist');

describe('resolveRendererFile', () => {
  it('serves files from dist on mochi://renderer, and index.html for the root and routes', () => {
    expect(resolveRendererFile(DIST, 'mochi://renderer/')).toBe(path.join(DIST, 'index.html'));
    expect(resolveRendererFile(DIST, 'mochi://renderer/index.html?mochi-shell=1')).toBe(path.join(DIST, 'index.html'));
    expect(resolveRendererFile(DIST, 'mochi://renderer/assets/index-abc.js')).toBe(path.join(DIST, 'assets/index-abc.js'));
    expect(resolveRendererFile(DIST, 'mochi://renderer/sign-in')).toBe(path.join(DIST, 'index.html'));
    expect(resolveRendererFile(DIST, 'mochi://renderer/assets/my%20pet.png')).toBe(path.join(DIST, 'assets/my pet.png'));
  });

  it('refuses anything outside dist, another host or scheme, and malformed paths', () => {
    // Plain or %2e-encoded `..` never gets here: the URL parser drops dot segments, so it stays inside dist.
    expect(resolveRendererFile(DIST, 'mochi://renderer/../../etc/passwd.txt')).toBe(path.join(DIST, 'etc/passwd.txt'));
    expect(resolveRendererFile(DIST, 'mochi://renderer/%2e%2e/%2e%2e/etc/passwd.txt')).toBe(path.join(DIST, 'etc/passwd.txt'));
    // Encoded separators do get here, and are refused.
    for (const url of [
      'mochi://renderer/assets/..%2f..%2f..%2fsecret.json',
      'mochi://renderer/a%5c..%5csecret.json',
      'mochi://renderer/x%00.js',
      'mochi://renderer/%E0%A4%A.js',
      'mochi://other/index.html',
      'file:///app/dist/index.html',
      'not a url',
    ]) {
      expect(resolveRendererFile(DIST, url), url).toBeNull();
    }
  });
});

describe('rendererResponse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-dist-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Mochi</title>');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
  const read = fs.promises.readFile;

  it('answers with the file, its type, and the Content Security Policy', async () => {
    const res = await rendererResponse(dir, 'mochi://renderer/assets/app.js', read);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('Content-Security-Policy')).toBe(CSP);
    expect(await res.text()).toBe('console.log(1)');
    expect(await (await rendererResponse(dir, 'mochi://renderer/?mochi-shell=1', read)).text()).toContain('<title>Mochi</title>');
  });

  it('is a 404, still with the policy, for missing or refused files', async () => {
    for (const url of ['mochi://renderer/assets/missing.js', 'mochi://renderer/../outside.js']) {
      const res = await rendererResponse(dir, url, read);
      expect(res.status).toBe(404);
      expect(res.headers.get('Content-Security-Policy')).toBe(CSP);
    }
  });
});

describe('policy and navigation', () => {
  it('runs only bundled scripts and loads nothing from the network', () => {
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toMatch(/https?:/);
    expect(CSP).not.toContain('unsafe-eval');
    expect(CSP).toContain("object-src 'none'");
  });

  it('allows navigation within the app or its dev server only', () => {
    expect(isAppNavigation(`${ORIGIN}/index.html`, null)).toBe(true);
    expect(isAppNavigation('http://localhost:5173/?mochi-shell=1', 'http://localhost:5173/')).toBe(true);
    expect(isAppNavigation('https://evil.example/', 'http://localhost:5173/')).toBe(false);
    expect(isAppNavigation('http://localhost:5173/', null)).toBe(false);
    expect(isAppNavigation('file:///etc/passwd', null)).toBe(false);
  });

  it('registers the scheme as a privileged, secure standard scheme', () => {
    const calls = [];
    registerRendererScheme({ registerSchemesAsPrivileged: (s) => calls.push(s) });
    expect(calls[0][0]).toMatchObject({ scheme: 'mochi', privileges: { standard: true, secure: true, supportFetchAPI: true } });
  });
});
