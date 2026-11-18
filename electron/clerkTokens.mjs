/* Clerk sign-in storage for the renderer (main process only).
 *
 * Customize Mochi signs people in with Clerk's Electron SDK. Its renderer part
 * (@clerk/electron/react, bundled by Vite) keeps the session through a small
 * bridge the preload exposes as `window.__clerk_internal_electron`, answered
 * here over Clerk's IPC channels. Mochi answers them itself instead of loading
 * @clerk/electron in the main process, because the packaged app ships no
 * node_modules.
 *
 * Tokens are encrypted with Electron's safeStorage (the macOS Keychain) and
 * kept in one file in userData. When encryption isn't available they are not
 * written to disk at all, so the person signs in again after a restart:
 * Clerk's own default, secure over convenient. OAuth isn't offered (email
 * codes only while dogfooding), so its channels refuse.
 */

/* The SDK's channel names (@clerk/electron 0.1.12, pinned; clerkTokens.test.mjs checks them). */
export const TOKEN_CHANNELS = {
  getToken: 'clerk:token-cache:get',
  saveToken: 'clerk:token-cache:save',
  clearToken: 'clerk:token-cache:clear',
};
export const OAUTH_CHANNELS = {
  getRedirectUrl: 'clerk:oauth-transport:get-redirect-url',
  open: 'clerk:oauth-transport:open',
};

const MAX_KEY = 256;
const MAX_VALUE = 64 * 1024;

/** The encrypted token file: { [key]: base64 ciphertext }. */
export function createTokenStore({ file, safeStorage, fs }) {
  const memory = new Map();
  const persist = () => typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable();
  function readAll() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }
  function writeAll(data) {
    fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  }
  return {
    get(key) {
      if (!persist()) return memory.get(key) ?? null;
      const enc = readAll()[key];
      if (typeof enc !== 'string') return null;
      try {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'));
      } catch {
        return null; // written by another build or a reset Keychain: signed out, not broken
      }
    },
    save(key, value) {
      if (!persist()) return void memory.set(key, value);
      const data = readAll();
      data[key] = safeStorage.encryptString(value).toString('base64');
      writeAll(data);
    },
    clear(key) {
      memory.delete(key);
      if (!persist()) return;
      const data = readAll();
      if (key in data) {
        delete data[key];
        writeAll(data);
      }
    },
  };
}

const validKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= MAX_KEY;

/** Answer the SDK's channels; only a window's main frame may ask. */
export function registerClerkBridge(ipcMain, store) {
  const fromMainFrame = (event) => !event?.sender?.mainFrame || event.senderFrame === event.sender.mainFrame;
  const guard = (fn) => (event, ...args) => {
    if (!fromMainFrame(event)) throw new Error('Clerk: request did not come from the main frame.');
    return fn(...args);
  };
  ipcMain.handle(TOKEN_CHANNELS.getToken, guard((key) => (validKey(key) ? store.get(key) : null)));
  ipcMain.handle(
    TOKEN_CHANNELS.saveToken,
    guard((key, value) => {
      if (validKey(key) && typeof value === 'string' && value.length <= MAX_VALUE) store.save(key, value);
    }),
  );
  ipcMain.handle(TOKEN_CHANNELS.clearToken, guard((key) => (validKey(key) ? store.clear(key) : undefined)));
  const noOAuth = () => {
    throw new Error('Mochi signs in with an email code only.');
  };
  ipcMain.handle(OAUTH_CHANNELS.getRedirectUrl, noOAuth);
  ipcMain.handle(OAUTH_CHANNELS.open, noOAuth);
}
