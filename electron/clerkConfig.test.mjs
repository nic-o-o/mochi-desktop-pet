import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLERK_PUBLISHABLE_KEY, DRAW_URL, frontendApiHost, isDrawUrl } from './clerkConfig.mjs';

describe('clerkConfig', () => {
  it('uses the same Clerk instance as the renderer', () => {
    const renderer = fs.readFileSync(path.resolve('src/mochi/clerkConfig.ts'), 'utf8');
    expect(renderer).toContain(`'${CLERK_PUBLISHABLE_KEY}'`);
    expect(frontendApiHost(CLERK_PUBLISHABLE_KEY)).toBe('picked-bulldog-8888.clerk.accounts.dev');
  });

  it('sends sign-in tokens only to https, or to a server on this Mac', () => {
    expect(isDrawUrl('https://mochi.example.com')).toBe(true);
    expect(isDrawUrl('http://127.0.0.1:8787')).toBe(true);
    expect(isDrawUrl('http://localhost:8787')).toBe(true);
    expect(isDrawUrl('http://mochi.example.com')).toBe(false);
    expect(isDrawUrl('https://user:pw@mochi.example.com')).toBe(false);
    expect(isDrawUrl('file:///tmp/x')).toBe(false);
    expect(isDrawUrl('not a url')).toBe(false);
    if (DRAW_URL !== null) expect(isDrawUrl(DRAW_URL)).toBe(true);
  });
});
