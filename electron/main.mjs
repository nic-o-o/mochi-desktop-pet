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
 *
 * Packaged (`npm run package` → Mochi.app) it loads the built `dist/` files
 * instead of the Vite server, logs to ~/Library/Logs/Mochi/main.log, and the
 * Dock icon's menu offers "Open at Login".
 */
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, powerMonitor, screen, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCodimango, isAllowedLink } from './codimango.mjs';
import { installFileLog } from './logfile.mjs';
import { REPORT_URL, diagnostics, logTail } from './report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/* null in the packaged app: load the built files instead of the Vite server. */
const DEV_URL = process.env.MOCHI_DEV_URL ?? (app.isPackaged ? null : 'http://localhost:5173/');
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
  if (DEV_URL) {
    win.loadURL(`${DEV_URL}${DEV_URL.includes('?') ? '&' : '?'}mochi-shell=1`);
  } else {
    win.loadFile(path.join(here, '..', 'dist', 'index.html'), { query: { 'mochi-shell': '1' } });
  }

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

// One pet at a time: a second launch quits and brings the running pet forward.
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) {
  console.warn('[mochi] already running, so this copy quits');
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('[mochi] second launch ignored; Mochi is already running');
    if (win && !win.isDestroyed() && syncedOnce) win.show();
  });
}

ipcMain.handle('mochi:get-display-bounds', () => {
  const b = screen.getPrimaryDisplay().bounds;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
});

// Codimango reads go through the user's CLI login (electron/codimango.mjs).
ipcMain.handle('mochi:fetch-codimango', () => fetchCodimango());

ipcMain.handle('mochi:open-link', (_event, url) => {
  if (!isAllowedLink(url)) return false;
  return shell.openExternal(url).then(() => true);
});

// Report a Problem: the renderer sends status and counts; we add version, OS
// and the log tail, copy it, and open #mochi-dogfood-feedback in Slack.
ipcMain.handle('mochi:report-problem', async (_event, state) => {
  const text = diagnostics({
    state,
    appVersion: app.getVersion(),
    osVersion: process.getSystemVersion(),
    arch: process.arch,
    log: logTail(path.join(app.getPath('logs'), 'main.log')),
  });
  clipboard.writeText(text);
  await shell.openExternal(REPORT_URL);
  return true;
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

/** Dock icon right-click → "Open at Login" (packaged app only). */
function setDockMenu() {
  const { openAtLogin } = app.getLoginItemSettings();
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open at Login',
        type: 'checkbox',
        checked: openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: 'separator' },
      {
        // The renderer holds status and counts, so ask it to start the report.
        label: 'Report a Problem…',
        click: () => win?.webContents.send('mochi:report-request'),
      },
    ]),
  );
}

app.whenReady().then(() => {
  if (!isPrimary) return;
  if (app.isPackaged) {
    console.log(`[mochi] logging to ${installFileLog(app.getPath('logs'))}`);
    setDockMenu();
  }
  createWindow();
  // `screen` is unusable before ready — this must live in here, not at module scope.
  screen.on('display-metrics-changed', () => {
    win?.webContents.send('mochi:display-changed');
  });
  // After sleep or a locked screen the snapshot is stale: ask the renderer to refresh.
  for (const event of ['resume', 'unlock-screen']) {
    powerMonitor.on(event, () => win?.webContents.send('mochi:system-resumed'));
  }
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
