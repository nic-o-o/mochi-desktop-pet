/* End-to-end: the same scenarios/*.yaml as `npm test`, run against the real
 * Electron app (main process, preload bridge, IPC, window) with a fake
 * codimango CLI. Links are captured in the main process instead of opening a
 * browser, the clipboard is the real one, and events are read back from the
 * real events.jsonl. See e2e/README.md.
 *
 *   npm run e2e                                  # dev build (dist/)
 *   MOCHI_E2E_APP=out/Mochi-darwin-arm64/Mochi.app npm run e2e:app   # the packaged app
 */
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { toSnapshot } from '../src/test/scenarios/fixtures.ts';
import type { ShorthandSnapshot } from '../src/test/scenarios/fixtures.ts';
import { liveSpecs, matches, taskNames } from '../src/test/scenarios/model.ts';
import type { Expectation, LiveSpec, Scenario, ScenarioFile } from '../src/test/scenarios/model.ts';
import type { UsageEvent } from '../src/mochi/shell.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_CLI = path.join(ROOT, 'e2e', 'fake-codimango.mjs');
const REPORT_URL = 'https://fb.enterprise.slack.com/archives/C0CDVU0LLLQ';
const EXPECT_TIMEOUT_MS = 5000;

/** The packaged app's executable, or null for the dev build. */
function packagedExecutable(): string | null {
  const app = process.env.MOCHI_E2E_APP;
  if (!app) return null;
  return app.endsWith('.app') ? path.join(app, 'Contents', 'MacOS', 'Mochi') : app;
}

/* ------------------------------------------------------------ fake data -- */

let work = '';
const binPath = () => path.join(work, 'bin', 'codimango');

function resolveLive(spec: LiveSpec, fixtures: ScenarioFile['fixtures'], now: number) {
  if (typeof spec === 'object' && 'error' in spec) return { error: spec.error };
  const short = typeof spec === 'string' ? fixtures?.[spec] : spec;
  if (!short) throw new Error(`Unknown fixture "${String(spec)}"`);
  const snap = toSnapshot(short as ShorthandSnapshot, now);
  return { reviewing: snap.reviewing, mine: snap.mine };
}

/** What the next refreshes return. "CLI missing" removes the program from Mochi's path. */
function setLive(specs: LiveSpec[], fixtures: ScenarioFile['fixtures']) {
  const now = Date.now();
  const queue = specs.map((s) => resolveLive(s, fixtures, now));
  if (queue.slice(1).some((q) => 'error' in q && q.error === 'cli_missing')) {
    throw new Error('cli_missing is only supported as the first fetch or via next_fetch');
  }
  fs.writeFileSync(path.join(work, 'queue.json'), JSON.stringify(queue.length ? queue : [{ error: 'error' }]));
  for (const f of ['count-reviewing', 'count-mine']) fs.rmSync(path.join(work, f), { force: true });
  fs.rmSync(binPath(), { force: true });
  if (!(queue[0] && 'error' in queue[0] && queue[0].error === 'cli_missing')) fs.symlinkSync(FAKE_CLI, binPath());
}

/* ----------------------------------------------------------------- app -- */

let app: ElectronApplication;
let page: Page;
let appUrl = '';
let eventsFile = '';

test.beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-e2e-'));
  fs.mkdirSync(path.join(work, 'bin'));
  setLive([{ error: 'offline' }], {});
  const exe = packagedExecutable();
  app = await electron.launch({
    ...(exe ? { executablePath: exe, args: [] } : { args: [path.join(ROOT, 'electron', 'main.mjs')] }),
    env: {
      ...process.env,
      MOCHI_USER_DATA_DIR: path.join(work, 'profile'),
      MOCHI_CODIMANGO_BIN: binPath(),
      MOCHI_FAKE_CODIMANGO_DIR: work,
      MOCHI_LOAD_DIST: '1',
    },
  });
  page = await app.firstWindow();
  await page.waitForSelector('[aria-label^="Mochi is"]');
  appUrl = page.url();
  eventsFile = path.join(work, 'profile', 'logs', 'events.jsonl');
  /* Capture links in the main process instead of opening a browser. */
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] };
    g.__opened = [];
    shell.openExternal = async (url: string) => {
      g.__opened.push(url);
    };
  });
});

test.afterAll(async () => {
  await app?.close();
  if (work && !process.env.MOCHI_E2E_KEEP) fs.rmSync(work, { recursive: true, force: true });
});

// Playwright requires an object pattern for the fixtures argument, even when unused.
// oxlint-disable-next-line no-empty-pattern
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page) {
    await info.attach('window', { body: await page.screenshot(), contentType: 'image/png' });
    await info.attach('events.jsonl', { body: eventsSince(0).map((e) => JSON.stringify(e)).join('\n'), contentType: 'text/plain' });
  }
});

/* -------------------------------------------------------------- reading -- */

let eventsOffset = 0;

function eventsSince(offset: number): UsageEvent[] {
  if (!fs.existsSync(eventsFile)) return [];
  return fs
    .readFileSync(eventsFile, 'utf8')
    .slice(offset)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as UsageEvent);
}
const scenarioEvents = () => eventsSince(eventsOffset);
const opened = () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
const clipboardText = () => app.evaluate(({ clipboard }) => clipboard.readText());

/** What's on screen, read in the page (the mock backdrop page is not Mochi's UI). */
function screen() {
  return page.evaluate(() => {
    const body = document.body.cloneNode(true) as HTMLElement;
    body.querySelectorAll('.page').forEach((el) => el.remove());
    const disabled = [...document.querySelectorAll<HTMLLabelElement>('.section-option')]
      .filter((l) => l.querySelector('input')?.disabled)
      .map((l) => (l.textContent ?? '').trim());
    return {
      text: (body.textContent ?? '').replace(/\s+/g, ' '),
      badge: document.querySelector('.bell-badge')?.textContent ?? 'none',
      panel: document.querySelector('.overview-panel') ? 'open' : 'closed',
      bubble: document.querySelector('.notif-bubble')?.textContent?.replace(/\s+/g, ' ') ?? 'none',
      disabled,
    };
  });
}

async function check(e: Expectation) {
  await expect(async () => {
    const s = await screen();
    for (const t of e.see ?? []) expect(s.text, `expected to see "${t}"`).toContain(t);
    for (const t of e.not_see ?? []) expect(s.text, `expected not to see "${t}"`).not.toContain(t);
    if (e.in_order) {
      const at = e.in_order.map((t) => s.text.indexOf(t));
      expect(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), `expected in this order: ${e.in_order.join(' → ')}`).toBe(true);
    }
    if (e.badge !== undefined) expect(s.badge, 'bell badge').toBe(String(e.badge));
    if (e.panel) expect(s.panel, 'panel').toBe(e.panel);
    if (e.bubble === 'none') expect(s.bubble, 'bubble').toBe('none');
    else if (e.bubble !== undefined) expect(s.bubble, 'bubble').toContain(e.bubble);
    for (const label of e.disabled ?? []) expect(s.disabled.some((d) => d.includes(label)), `"${label}" disabled`).toBe(true);
    if (e.opened) {
      const links = await opened();
      for (const t of e.opened) expect(links.some((u) => u.includes(t)), `expected a link containing "${t}"; opened: ${JSON.stringify(links)}`).toBe(true);
    }
    if (e.clipboard) {
      const clip = await clipboardText();
      for (const t of e.clipboard) expect(clip, 'clipboard').toContain(t);
    }
    if (e.report) {
      /* End to end, a report is what the tester gets: diagnostics on the clipboard and the Slack channel opened. */
      expect(await opened(), 'Report a Problem opens the Slack channel').toContain(REPORT_URL);
      const clip = await clipboardText();
      expect(clip, 'diagnostics on the clipboard').toContain('--- Mochi diagnostics');
      if (e.report.status) expect(clip).toContain(`Data: ${e.report.status}`);
      if (e.report.failureKind === null) expect(clip).not.toContain('(last error:');
      else if (e.report.failureKind) expect(clip).toContain(`(last error: ${e.report.failureKind})`);
      const c: Partial<Record<'reviews' | 'revisions' | 'drafts', number>> = e.report.counts ?? {};
      if (c.reviews !== undefined) expect(clip).toContain(`${c.reviews} to review`);
      if (c.revisions !== undefined) expect(clip).toContain(`${c.revisions} revisions`);
      if (c.drafts !== undefined) expect(clip).toContain(`${c.drafts} drafts`);
    }
    const events = scenarioEvents();
    const logged = events.map((ev) => [ev.event_name, ev.surface, ev.component].filter(Boolean).join(' ')).join('; ');
    for (const want of e.events ?? []) expect(events.some((ev) => matches(ev, want)), `expected event ${JSON.stringify(want)}; logged: ${logged}`).toBe(true);
    for (const want of e.not_events ?? []) expect(events.some((ev) => matches(ev, want)), `expected no event ${JSON.stringify(want)}`).toBe(false);
    if (e.event_count) {
      const n = events.filter((ev) => matches(ev, e.event_count!.match)).length;
      expect(n, `events matching ${JSON.stringify(e.event_count.match)}`).toBe(e.event_count.count);
    }
  }).toPass({ timeout: EXPECT_TIMEOUT_MS });
}

/* ---------------------------------------------------------------- steps -- */

const clickable = (text: string) => page.locator('button, a, label, [role="button"]').filter({ hasText: text }).first();

async function runScenario(file: ScenarioFile, sc: Scenario) {
  /* Fresh renderer state: clear storage, preset what Mochi "saved last time", leave the page. */
  setLive(liveSpecs(sc), file.fixtures);
  const saved = sc.given?.saved;
  const savedJson = saved
    ? JSON.stringify(toSnapshot((typeof saved === 'string' ? file.fixtures?.[saved] : saved) as ShorthandSnapshot, Date.now() - 1))
    : null;
  await page.evaluate(
    ({ savedJson, sections }) => {
      localStorage.clear();
      if (savedJson) localStorage.setItem('mochi.codimango.v1', savedJson);
      if (sections) localStorage.setItem('mochi.sections.v1', JSON.stringify(sections));
    },
    { savedJson, sections: sc.given?.sections ?? null },
  );
  await page.goto('about:blank');
  await app.evaluate(() => {
    (globalThis as unknown as { __opened: string[] }).__opened = [];
  });
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await page.waitForTimeout(200); // let the last page's events reach the file
  eventsOffset = fs.existsSync(eventsFile) ? fs.statSync(eventsFile).size : 0;

  for (const step of sc.steps) {
    const [action, arg] = typeof step === 'string' ? [step, undefined] : Object.entries(step)[0];
    switch (action) {
      case 'start':
        await page.goto(appUrl);
        await expect.poll(() => scenarioEvents().some((e) => e.event_name === 'mochi_fetch'), { timeout: 15_000 }).toBe(true);
        break;
      case 'next_fetch':
        setLive([arg as LiveSpec], file.fixtures);
        break;
      case 'click_pet':
        await page.locator('[aria-label^="Mochi is"]').click();
        break;
      case 'click_bell':
        await page.locator('[aria-label^="Notifications"]').click();
        break;
      case 'click_bubble':
        await page.locator('.bubble-main').click();
        break;
      case 'bubble_older':
        await page.getByLabel('Show older notification').click();
        break;
      case 'bubble_newer':
        await page.getByLabel('Show newer notification').click();
        break;
      case 'close_bubble':
        await page.getByLabel('Dismiss notification').click();
        break;
      case 'open_menu':
        await page.getByLabel('Choose sections').click();
        break;
      case 'refresh_now':
        await page.getByLabel('Refresh now').click();
        break;
      case 'close_panel':
        await page.getByLabel('Close task panel').click();
        break;
      case 'hide_pet':
        await page.getByLabel('Hide Mochi').click();
        break;
      case 'restore_pet':
        await page.getByLabel('Show Mochi').click();
        break;
      case 'toggle_section':
        await page.locator('.section-option').filter({ hasText: String(arg) }).locator('input').click();
        break;
      case 'click':
        await clickable(String(arg)).click();
        break;
      case 'press':
        await page.locator(`[aria-label="${String(arg)}"]`).click();
        break;
      case 'wake':
        await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
        break;
      case 'dock_report':
        /* The Dock menu item's own action: ask the renderer to start a report. */
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('mochi:report-request'));
        break;
      case 'wait':
        await page.waitForTimeout(Number(arg));
        break;
      case 'expect':
        await check(arg as Expectation);
        break;
      default:
        throw new Error(`Unknown step "${action}" (see scenarios/README.md)`);
    }
  }

  /* Privacy: what reached events.jsonl carries IDs and enums, never task names. */
  const names = taskNames(file, sc);
  for (const ev of scenarioEvents()) {
    const leaked = names.find((n) => JSON.stringify(ev).includes(n));
    expect(leaked, `${ev.event_name} in events.jsonl carries task name "${leaked}"`).toBeUndefined();
  }
}

/* ---------------------------------------------------------------- tests -- */

const dir = path.join(ROOT, 'scenarios');
for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
  const file = parse(fs.readFileSync(path.join(dir, name), 'utf8')) as ScenarioFile;
  test.describe(name, () => {
    for (const sc of file.scenarios) {
      test(`${sc.id}: ${sc.title}`, () => runScenario(file, sc));
    }
  });
}
