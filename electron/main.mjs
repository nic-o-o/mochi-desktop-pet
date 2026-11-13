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
 * Dock icon's menu offers "Open at Login". Usage events (dev and packaged) go
 * to events.jsonl in the same folder (electron/events.mjs). "Ask agents to
 * review" runs Claude Code or Codex in the background (electron/agentReview.mjs).
 * "Delegate to agent" launches Green on the devserver instead
 * (electron/delegate.mjs).
 */
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, powerMonitor, screen, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAddedSkills, createAgentReviews, listReviewSkills, resolveReviewSkill } from './agentReview.mjs';
import { checkDelegateStatus, checkTaskHandler, delegateToGreen, installDocker, stopGreenWorker } from './delegate.mjs';
import { fetchCodimango, fetchSubmitSha, isAllowedLink, submitDryRun, submitTask } from './codimango.mjs';
import { allDisplayBounds } from './displays.mjs';
import { createEventLog } from './events.mjs';
import { FLUSH_MS, flushSender, loadSharing, setSharing } from './sender.mjs';
import { installFileLog } from './logfile.mjs';
import { REPORT_URL, diagnostics, logTail } from './report.mjs';
import { createSevWatch } from './sevs.mjs';
import { createCustomizer } from './customize.mjs';
import { createLookStore } from './looks.mjs';
import { pickGenerator } from './petGenerator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/* null in the packaged app: load the built files instead of the Vite server. */
const DEV_URL = process.env.MOCHI_DEV_URL ?? (app.isPackaged ? null : 'http://localhost:5173/');
const SYNC_WARN_MS = 5000;
const SIMULATE_ACCELERATOR = 'CommandOrControl+Shift+M';
const RESOURCE_SAMPLE_MS = 60 * 60_000;

let win = null;
let lastBoundsKey = '';
let syncedOnce = false;
/* Usage events (electron/events.mjs); created once the app is ready. */
let events = null;
/* Customize Mochi (electron/customize.mjs); created once the app is ready. */
let customizer = null;

/* PNG ⇄ RGBA through nativeImage. Its bitmaps are BGRA; decode and encode swap
   the same two channels, so colours round-trip whichever order the platform uses. */
const swapRB = (buf) => {
  const out = new Uint8ClampedArray(buf);
  for (let i = 0; i < out.length; i += 4) [out[i], out[i + 2]] = [out[i + 2], out[i]];
  return out;
};
const imageCodec = {
  decode(png) {
    const img = nativeImage.createFromBuffer(png);
    const { width, height } = img.getSize();
    if (!width || !height) throw new Error('not an image');
    return { width, height, data: swapRB(img.toBitmap()) };
  },
  encode({ width, height, data }) {
    return nativeImage.createFromBitmap(Buffer.from(swapRB(data)), { width, height }).toPNG();
  },
  /* Fit the longer side to `size`, keeping the aspect ratio. */
  resize(png, size) {
    const img = nativeImage.createFromBuffer(png);
    const { width, height } = img.getSize();
    const scale = size / Math.max(width, height, 1);
    return img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }).toPNG();
  },
};

/* Agent review jobs (electron/agentReview.mjs); created once the app is ready. */
let agentReviews = null;
/* Review skills added with the file picker (userData/review-skills.json). */
let addedSkills = null;
/** Codimango SEVs (bubble and panel line), read every ten minutes. */
let sevWatch = null;

function defaultBounds() {
  const b = screen.getPrimaryDisplay().bounds;
  return {
    x: Math.round(b.x + b.width - 224),
    y: Math.round(b.y + b.height - 326),
    width: 200,
    height: 230,
  };
}

/* On every desktop (Space) and over full-screen apps. */
function showOnAllDesktops(target) {
  target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
  showOnAllDesktops(win);
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

ipcMain.handle('mochi:get-display-bounds', () => allDisplayBounds(screen.getAllDisplays()));

// Codimango reads go through the user's CLI login (electron/codimango.mjs).
ipcMain.handle('mochi:fetch-codimango', () => fetchCodimango());

/* Direct submit: each step is one explicit user-confirmed action from the
   panel. Dry-run preflight first, then the pinned submit — never retried. */
ipcMain.handle('mochi:submit-dry-run', (_event, id) => submitDryRun(String(id ?? '')));
ipcMain.handle('mochi:submit-sha', (_event, id) => fetchSubmitSha(String(id ?? '')));
ipcMain.handle('mochi:submit-task', (_event, id, sha) => submitTask(String(id ?? ''), String(sha ?? '')));

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

ipcMain.on('mochi:log-event', (_event, raw) => {
  events?.log(raw);
});

// Codimango SEVs, already filtered; changes are pushed on 'mochi:sevs'.
ipcMain.handle('mochi:sevs-list', () => sevWatch?.list() ?? []);

// Ask agents to review: the renderer sends the task and the chosen agents; runs
// and reports live in the main process and are pushed back on every change.
ipcMain.handle('mochi:agent-reviews-list', () => agentReviews?.list() ?? []);

// Delegate a "needs revision" task to Green on the devserver: the renderer
// sends only the task slug; every check and the launch happen here.
ipcMain.handle('mochi:green-delegate', (_event, taskSlug, node, agent) =>
  delegateToGreen({ taskSlug: String(taskSlug ?? ''), node: String(node ?? ''), agent: typeof agent === 'string' ? agent : undefined }),
);
ipcMain.handle('mochi:green-delegate-status', (_event, req) =>
  checkDelegateStatus({
    taskSlug: String(req?.taskSlug ?? ''),
    node: String(req?.node ?? ''),
    pid: Number(req?.pid),
    logPath: String(req?.logPath ?? ''),
  }),
);
ipcMain.handle('mochi:green-handler-status', (_event, req) =>
  checkTaskHandler({
    taskSlug: String(req?.taskSlug ?? ''),
    node: String(req?.node ?? ''),
    pid: req?.pid == null ? null : Number(req.pid),
    logPath: String(req?.logPath ?? ''),
  }),
);
ipcMain.handle('mochi:green-stop-worker', (_event, req) =>
  stopGreenWorker({
    taskSlug: String(req?.taskSlug ?? ''),
    node: String(req?.node ?? ''),
    pid: Number(req?.pid),
    logPath: String(req?.logPath ?? ''),
  }),
);
ipcMain.handle('mochi:green-install-docker', (_event, taskSlug, node) => installDocker({ taskSlug: String(taskSlug ?? ''), node: String(node ?? '') }));

ipcMain.handle('mochi:agent-review-start', (_event, req) =>
  agentReviews?.start({
    taskId: String(req?.taskId ?? ''),
    taskName: String(req?.taskName ?? ''),
    taskUpdatedAtMs: Number(req?.taskUpdatedAtMs),
    agents: Array.isArray(req?.agents) ? req.agents.map(String) : [],
    skillId: typeof req?.skillId === 'string' ? req.skillId : undefined,
  }) ?? [],
);

// Skills the Ask agents picker offers (ids and labels only; paths stay in this process).
ipcMain.handle('mochi:review-skills-list', () => listReviewSkills(os.homedir(), undefined, addedSkills?.list() ?? []));

// "Add a skill…": the person picks a skill folder or SKILL.md; resolves { id, skills } or null.
ipcMain.handle('mochi:review-skill-add', async () => {
  if (!addedSkills) return null;
  const picked = await dialog.showOpenDialog(win ?? undefined, {
    title: 'Add a review skill',
    message: 'Choose a skill folder (one with a SKILL.md) or its SKILL.md file.',
    buttonLabel: 'Add skill',
    defaultPath: path.join(os.homedir(), '.claude', 'skills'),
    properties: ['openFile', 'openDirectory'],
  });
  if (picked.canceled || picked.filePaths.length === 0) return null;
  const id = addedSkills.add(picked.filePaths[0]);
  return { id, skills: listReviewSkills(os.homedir(), undefined, addedSkills.list()) };
});

ipcMain.handle('mochi:review-skill-remove', (_event, id) => {
  if (typeof id === 'string') addedSkills?.remove(id);
  return listReviewSkills(os.homedir(), undefined, addedSkills?.list() ?? []);
});

// Customize Mochi: availability and saved looks, drawing candidates, keeping one.
/* Panel Settings menu: Open at Login (packaged app only, since from source it
   would register the Electron binary) and Share Usage Data, same as the dock menu. */
function appSettings() {
  return {
    openAtLogin: app.isPackaged ? app.getLoginItemSettings().openAtLogin : null,
    sharing: loadSharing(app.getPath('userData')).sharing,
  };
}
ipcMain.handle('mochi:app-settings', () => appSettings());
ipcMain.handle('mochi:app-setting-set', (_event, key, value) => {
  const on = value === true;
  if (key === 'openAtLogin' && app.isPackaged) app.setLoginItemSettings({ openAtLogin: on });
  else if (key === 'sharing') setSharing(app.getPath('userData'), on);
  else return appSettings();
  if (app.isPackaged) setDockMenu();
  return appSettings();
});
ipcMain.handle('mochi:looks-state', () => ({ available: customizer?.available() ?? false, practice: customizer?.practice() ?? false, ...(customizer?.state() ?? { looks: [], currentId: null }) }));
ipcMain.handle('mochi:pet-generate', (_event, text) => customizer?.generate(String(text ?? '')) ?? { ok: false, error: { kind: 'error' } });
ipcMain.handle('mochi:pet-generate-cancel', () => customizer?.cancel());
ipcMain.handle('mochi:look-keep', (_event, candidateId) => customizer?.keep(String(candidateId ?? '')) ?? null);
ipcMain.handle('mochi:look-set-current', (_event, id) => customizer?.setCurrent(typeof id === 'string' ? id : null) ?? null);
ipcMain.handle('mochi:look-delete', (_event, id) => customizer?.remove(String(id ?? '')) ?? null);

ipcMain.handle('mochi:agent-review-cancel', (_event, id) => agentReviews?.cancel(String(id)) ?? []);


/** Hourly CPU and memory across Mochi's processes (logging plan: mochi_resource). */
function sampleResources() {
  const metrics = app.getAppMetrics();
  const cpu = metrics.reduce((sum, m) => sum + m.cpu.percentCPUUsage, 0);
  const memoryKb = metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0);
  events?.log({ event_name: 'mochi_resource', cpu_percent: Math.round(cpu * 10) / 10, memory_mb: Math.round(memoryKb / 1024) });
}

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
    // Again once visible: macOS can drop it for a window that was created hidden,
    // leaving the pet on one desktop only.
    showOnAllDesktops(target);
  }
});

/** Dock icon right-click → "Open at Login" (packaged app only). */
function setDockMenu() {
  const { openAtLogin } = app.getLoginItemSettings();
  const sharing = loadSharing(app.getPath('userData')).sharing;
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open at Login',
        type: 'checkbox',
        checked: openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
          events?.log({ event_name: 'mochi_click', surface: 'dock_menu', component: 'open_at_login', enabled: item.checked });
        },
      },
      {
        label: 'Share Usage Data',
        type: 'checkbox',
        checked: sharing,
        click: (item) => {
          setSharing(app.getPath('userData'), item.checked);
          events?.log({ event_name: 'mochi_click', surface: 'dock_menu', component: 'share_usage', enabled: item.checked });
          setDockMenu();
        },
      },
      { type: 'separator' },
      ...(customizer?.available()
        ? [
            {
              label: 'Customize Mochi…',
              click: () => {
                events?.log({ event_name: 'mochi_click', surface: 'dock_menu', component: 'customize' });
                win?.webContents.send('mochi:open-customize');
              },
            },
          ]
        : []),
      {
        // The renderer holds status and counts, so ask it to start the report.
        label: 'Report a Problem…',
        click: () => {
          events?.log({ event_name: 'mochi_click', surface: 'dock_menu', component: 'report_problem' });
          win?.webContents.send('mochi:report-request');
        },
      },
    ]),
  );
}

app.whenReady().then(() => {
  if (!isPrimary) return;
  // Practice drawings from source by default; a real model with MOCHI_PET_GENERATOR=muse|openai.
  // Packaged builds keep Customize hidden until the key-holding proxy exists (B3).
  const pets = pickGenerator({
    packaged: app.isPackaged,
    env: process.env,
    fixturesDir: path.join(here, 'fixtures', 'pets'),
    /* Chromium's network stack: the Mac's proxy and VPN settings apply, unlike Node's fetch. */
    fetchImpl: (url, init) => net.fetch(url, init),
  });
  if (pets.note) console.warn(`[mochi] ${pets.note}`);
  customizer = createCustomizer({
    store: createLookStore(path.join(app.getPath('userData'), 'pet-looks')),
    generator: pets.generator,
    codec: imageCodec,
    log: (fields) => events?.log({ event_name: 'mochi_pet_generate', source: pets.generator?.kind, ...fields }),
  });
  if (app.isPackaged) {
    console.log(`[mochi] logging to ${installFileLog(app.getPath('logs'))}`);
    setDockMenu();
  }
  events = createEventLog(app.getPath('logs'), {
    app_session_id: randomUUID(),
    app_version: app.getVersion(),
    os_version: process.getSystemVersion(),
    unixname: os.userInfo().username,
  });
  events.log({ event_name: 'mochi_app_start', launched_at_login: app.getLoginItemSettings().wasOpenedAtLogin === true });
  addedSkills = createAddedSkills(path.join(app.getPath('userData'), 'review-skills.json'));
  agentReviews = createAgentReviews({
    dir: path.join(app.getPath('userData'), 'agent-reviews'),
    findSkill: (id) => resolveReviewSkill(id, os.homedir(), undefined, addedSkills.list()),
    onChange: (jobs) => win?.webContents.send('mochi:agent-reviews', jobs),
    onFinished: (job) =>
      events?.log({
        event_name: 'mochi_agent_review',
        task_id: job.taskId,
        kind: job.agent,
        status: job.status,
        result: job.failure?.kind ?? 'report',
        duration_ms: job.startedAtMs ? job.endedAtMs - job.startedAtMs : 0,
      }),
  });
  sevWatch = createSevWatch({ onChange: (sevs) => win?.webContents.send('mochi:sevs', sevs) });
  sevWatch.start();
  /* Scuba sender: no-op while sharing is off; never throws. */
  const flush = () => {
    if (!events) return;
    flushSender({ logFile: events.file, userDataDir: app.getPath('userData') }).catch((e) => {
      console.warn('[mochi] sender flush failed', String(e));
    });
  };
  setTimeout(flush, 60_000).unref();
  setInterval(flush, FLUSH_MS).unref();
  setInterval(sampleResources, RESOURCE_SAMPLE_MS).unref();
  createWindow();
  // `screen` is unusable before ready — this must live in here, not at module scope.
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(event, () => win?.webContents.send('mochi:display-changed'));
  }
  // After sleep or a locked screen the snapshot is stale: ask the renderer to refresh.
  for (const event of ['resume', 'unlock-screen']) {
    powerMonitor.on(event, () => {
      win?.webContents.send('mochi:system-resumed');
      void sevWatch?.refresh();
    });
  }
  // Panel and bubble time on screen excludes a locked screen (sleep already pauses the renderer clock).
  powerMonitor.on('lock-screen', () => win?.webContents.send('mochi:screen-lock', true));
  powerMonitor.on('unlock-screen', () => win?.webContents.send('mochi:screen-lock', false));
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
  agentReviews?.stopAll();
  sevWatch?.stop();
  void events?.close();
});

app.on('window-all-closed', () => {
  // Quit everywhere (including macOS) — a pet with no windows is just
  // a dock icon, and the prototype has no tray menu yet.
  app.quit();
});
