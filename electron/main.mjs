/* Mochi desktop shell — main process (Mac-first prototype).
 *
 * A single SMALL transparent window shrink-wrapped around the visible UI:
 * pet-sized normally, growing to cover the panel/bubble/expanded card while
 * open, paw-sized when hidden. The renderer (the same React app) computes the
 * union of visible rects in screen coordinates and pushes it here via
 * `mochi:sync-bounds`; the first sync also reveals the window, so a failed
 * load stays invisible instead of flashing at a wrong spot.
 *
 * Clicks need no hover toggling: mouse events stay enabled permanently and
 * unpainted (fully transparent) pixels pass through to the apps below
 * natively. The Simulate control lives outside the union window — it is a
 * global shortcut (Cmd/Ctrl+Shift+M) instead of an on-screen button.
 *
 * Run on a Mac with a display server: `npm run desktop` (starts Vite + this).
 * This cannot open a window on a headless devserver.
 */
import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCodimango, isCodimangoUrl } from './codimango.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.MOCHI_DEV_URL ?? 'http://localhost:5173/';
const SYNC_WARN_MS = 5000;
const SIMULATE_ACCELERATOR = 'CommandOrControl+Shift+M';

let win = null;
let lastBoundsKey = '';
let syncedOnce = false;

function defaultBounds() {
  const b = screen.getPrimaryDisplay().bounds;
  return {
    x: Math.round(b.x + b.width - 224),
    y: Math.round(b.y + b.height - 326),
    width: 200,
    height: 230,
  };
}

function createWindow() {
  win = new BrowserWindow({
    ...defaultBounds(),
    transparent: true,
    frame: false,
    hasShadow: false,
    // Must stay true: on some platforms a non-resizable window ignores
    // programmatic setBounds, freezing the pet in place. Frameless windows
    // expose no resize handles, so users still can't resize it.
    resizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Permanently enabled: only painted Mochi pixels hit-test, transparent gaps
  // fall through natively — no enter/leave toggling, no race with clicks.
  win.setIgnoreMouseEvents(false);

  // `?mochi-shell=1` switches the renderer to shell mode (pet-only backdrop,
  // screen-coordinate layout) without depending on the preload bridge.
  win.loadURL(`${DEV_URL}${DEV_URL.includes('?') ? '&' : '?'}mochi-shell=1`);

  // Permanent observability: bridge/render proof in the terminal.
  win.webContents.on('console-message', (event) => {
    const message = event.message;
    if (typeof message === 'string' && message.startsWith('[mochi]')) {
      console.log('[renderer]', message);
    }
  });

  setTimeout(() => {
    if (!syncedOnce) {
      console.warn(
        '[mochi] no bounds sync from the renderer yet — is the preload bridge loading?',
      );
    }
  }, SYNC_WARN_MS);

  return win;
}

app.setName('Mochi');

ipcMain.handle('mochi:get-display-bounds', () => {
  const b = screen.getPrimaryDisplay().bounds;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
});

// Codimango reads go through the user's CLI login (electron/codimango.mjs).
ipcMain.handle('mochi:fetch-codimango', () => fetchCodimango());

ipcMain.handle('mochi:open-codimango', (_event, url) => {
  if (!isCodimangoUrl(url)) return false;
  return shell.openExternal(url).then(() => true);
});

ipcMain.on('mochi:sync-bounds', (event, rect) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return;
  const next = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
  const key = JSON.stringify(next);
  if (key === lastBoundsKey) return;
  lastBoundsKey = key;
  // TEMP-DEBUG: prove syncs arrive during drag + whether setBounds takes.
  console.log('[mochi] sync request', key);
  target.setBounds(next);
  console.log('[mochi] sync actual', JSON.stringify(target.getBounds()));
  if (!syncedOnce) {
    syncedOnce = true;
    target.show();
  }
});

app.whenReady().then(() => {
  createWindow();
  // `screen` is unusable before ready — this must live in here, not at module scope.
  screen.on('display-metrics-changed', () => {
    win?.webContents.send('mochi:display-changed');
  });
  const ok = globalShortcut.register(SIMULATE_ACCELERATOR, () => {
    win?.webContents.send('mochi:simulate-notification');
  });
  if (ok) {
    console.log(`[mochi] simulate shortcut: ${SIMULATE_ACCELERATOR}`);
  } else {
    console.warn(`[mochi] global shortcut ${SIMULATE_ACCELERATOR} is taken by another app`);
  }
  // Dock icon stays visible in this prototype so the pet can be quit with
  // Cmd+Q / right-click. Hiding it (app.dock.hide) is a one-liner for later.
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Quit everywhere (including macOS) — a pet with no windows is just
  // a dock icon, and the prototype has no tray menu yet.
  app.quit();
});
