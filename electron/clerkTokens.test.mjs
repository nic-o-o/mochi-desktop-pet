import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OAUTH_CHANNELS, TOKEN_CHANNELS, createTokenStore, registerClerkBridge } from './clerkTokens.mjs';

/* Reversible stand-in for Electron's safeStorage. */
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => {
    const s = b.toString();
    if (!s.startsWith('enc:')) throw new Error('bad');
    return s.slice(4);
  },
});

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-clerk-')), 'clerk-tokens.json');

describe('createTokenStore', () => {
  it('keeps tokens encrypted on disk, readable after a restart', () => {
    const file = tmpFile();
    const store = createTokenStore({ file, safeStorage: fakeSafeStorage(), fs });
    store.save('__clerk_client_jwt', 'eyJ.secret');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('eyJ.secret');
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    const again = createTokenStore({ file, safeStorage: fakeSafeStorage(), fs });
    expect(again.get('__clerk_client_jwt')).toBe('eyJ.secret');
    again.clear('__clerk_client_jwt');
    expect(again.get('__clerk_client_jwt')).toBeNull();
  });

  it('never writes tokens to disk when encryption is unavailable', () => {
    const file = tmpFile();
    const store = createTokenStore({ file, safeStorage: fakeSafeStorage(false), fs });
    store.save('k', 'v');
    expect(store.get('k')).toBe('v');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('treats undecryptable entries as signed out', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ k: Buffer.from('garbage').toString('base64') }));
    expect(createTokenStore({ file, safeStorage: fakeSafeStorage(), fs }).get('k')).toBeNull();
  });
});

describe('registerClerkBridge', () => {
  function bridge() {
    const handlers = {};
    registerClerkBridge({ handle: (ch, fn) => (handlers[ch] = fn) }, createTokenStore({ file: tmpFile(), safeStorage: fakeSafeStorage(), fs }));
    const main = {};
    const ev = { sender: { mainFrame: main }, senderFrame: main };
    return { handlers, ev };
  }

  it('answers the SDK token channels from the main frame, and refuses OAuth', async () => {
    const { handlers, ev } = bridge();
    await handlers[TOKEN_CHANNELS.saveToken](ev, 'k', 'v');
    expect(await handlers[TOKEN_CHANNELS.getToken](ev, 'k')).toBe('v');
    await handlers[TOKEN_CHANNELS.clearToken](ev, 'k');
    expect(await handlers[TOKEN_CHANNELS.getToken](ev, 'k')).toBeNull();
    expect(() => handlers[OAUTH_CHANNELS.open](ev, 'https://x')).toThrow(/email code/);
  });

  it('refuses subframes and malformed input', async () => {
    const { handlers, ev } = bridge();
    expect(() => handlers[TOKEN_CHANNELS.getToken]({ sender: ev.sender, senderFrame: {} }, 'k')).toThrow(/main frame/);
    await handlers[TOKEN_CHANNELS.saveToken](ev, 'k', 'x'.repeat(70_000));
    await handlers[TOKEN_CHANNELS.saveToken](ev, '', 'v');
    expect(await handlers[TOKEN_CHANNELS.getToken](ev, 'k')).toBeNull();
  });
});

describe('SDK channel names', () => {
  it('match the installed @clerk/electron, so an upgrade that renames them fails here', () => {
    const dir = path.resolve('node_modules/@clerk/electron/dist/esm');
    const ipc = fs.readdirSync(dir).find((f) => /^ipc-.*\.js$/.test(f));
    const src = fs.readFileSync(path.join(dir, ipc), 'utf8');
    for (const name of [...Object.values(TOKEN_CHANNELS), ...Object.values(OAUTH_CHANNELS)]) expect(src).toContain(`"${name}"`);
    const preload = fs.readFileSync(path.resolve('electron/preload.cjs'), 'utf8');
    for (const name of Object.values(TOKEN_CHANNELS)) expect(preload).toContain(`'${name}'`);
    expect(preload).toContain('__clerk_internal_electron');
  });
});
