/* Interaction-scenario runner: renders the real App with a fake desktop bridge
 * and fake Codimango data, performs each scenario step, and checks what is on
 * screen, which links opened, what was copied and which reports were sent.
 * Scenario format: scenarios/README.md.
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import App from '../../App.tsx';
import type { CodimangoFetchResult, CodimangoSnapshot } from '../../mochi/codimango.ts';
import type { ProblemReportState, UsageEvent } from '../../mochi/shell.ts';
import { resetUsageForTests } from '../../mochi/usage.ts';
import { toSnapshot } from './fixtures.ts';
import type { ShorthandSnapshot } from './fixtures.ts';
import { liveSpecs, matches, taskNames } from './model.ts';
import type { Expectation, FailureKind, LiveSpec, Scenario, ScenarioFile } from './model.ts';

export type { ScenarioFile } from './model.ts';

interface Harness {
  opened: string[];
  clipboard: string[];
  reports: ProblemReportState[];
  events: UsageEvent[];
  fetchCalls: number;
  queue: CodimangoFetchResult[];
  resume?: () => void;
  reportRequest?: () => void;
}

const FAILURE_MESSAGES: Record<FailureKind, string> = {
  cli_missing: 'The codimango CLI is not installed.',
  login_required: 'Codimango login missing or expired.',
  offline: 'Could not reach Codimango (VPN or network?).',
  error: 'codimango exited with 2',
};

function resolveSnapshot(spec: string | ShorthandSnapshot, fixtures: ScenarioFile['fixtures'], now: number): CodimangoSnapshot {
  const short = typeof spec === 'string' ? fixtures?.[spec] : spec;
  if (!short) throw new Error(`Unknown fixture "${String(spec)}"`);
  return toSnapshot(short, now);
}

function resolveLive(spec: LiveSpec, fixtures: ScenarioFile['fixtures'], now: number): CodimangoFetchResult {
  if (typeof spec === 'object' && 'error' in spec) {
    const kind = spec.error;
    return { ok: false, error: { kind, message: FAILURE_MESSAGES[kind], ...(kind === 'login_required' ? { fix: 'codimango auth setup' } : {}) } };
  }
  /* A live fetch happens now: age_min only describes what Mochi saved earlier. */
  const live = resolveSnapshot(spec as string | ShorthandSnapshot, fixtures, now);
  return { ok: true, snapshot: { ...live, fetchedAtMs: now } };
}

/* Mochi's own UI only: the mock backdrop page (.page) is not part of the product. */
const describeEvents = (events: UsageEvent[]) =>
  events.map((e) => [e.event_name, e.surface, e.component, e.section ?? e.reason ?? e.trigger ?? ''].filter(Boolean).join(' ')).join('; ');

/* jsdom has no layout: everything observed counts as fully on screen. Rows behind
   "View N more" aren't rendered, so they still never log a VPV. */
class VisibleIntersectionObserver {
  private readonly cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element) {
    queueMicrotask(() => this.cb([{ target, intersectionRatio: 1, isIntersecting: true } as IntersectionObserverEntry], this as never));
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const text = () => {
  const body = document.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll('.page').forEach((el) => el.remove());
  return (body.textContent ?? '').replace(/\s+/g, ' ');
};
const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const flush = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

function mustFind(selector: string, what: string): HTMLElement {
  const el = q(selector);
  if (!el) throw new Error(`Step failed: ${what} is not on screen (${selector})`);
  return el;
}

function findByText(label: string): HTMLElement {
  const candidates = [...document.querySelectorAll<HTMLElement>('button, a, label, [role="button"]')];
  const el = candidates.find((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim().includes(label));
  if (!el) throw new Error(`Step failed: nothing clickable shows "${label}"`);
  return el;
}

/** Run one scenario; throws on the first step or expectation that fails. */
export async function runScenario(file: ScenarioFile, sc: Scenario): Promise<void> {
  const now = Date.now();
  const h: Harness = { opened: [], clipboard: [], reports: [], events: [], fetchCalls: 0, queue: [] };
  h.queue = liveSpecs(sc).map((l) => resolveLive(l, file.fixtures, now));

  localStorage.clear();
  resetUsageForTests();
  window.IntersectionObserver = VisibleIntersectionObserver as unknown as typeof IntersectionObserver;
  if (sc.given?.saved) {
    localStorage.setItem('mochi.codimango.v1', JSON.stringify(resolveSnapshot(sc.given.saved, file.fixtures, now - 1)));
  }
  if (sc.given?.sections) localStorage.setItem('mochi.sections.v1', JSON.stringify(sc.given.sections));

  window.mochiShell = {
    getDisplayBounds: () => Promise.resolve({ x: 0, y: 0, width: 1280, height: 800 }),
    onDisplayChanged: () => () => {},
    onSimulateNotification: () => () => {},
    syncBounds: () => {},
    onSystemResumed: (cb) => ((h.resume = cb), () => {}),
    onReportRequest: (cb) => ((h.reportRequest = cb), () => {}),
    fetchCodimango: () => {
      h.fetchCalls += 1;
      const next = h.queue.length > 1 ? h.queue.shift()! : h.queue[0];
      return Promise.resolve(next ?? { ok: false, error: { kind: 'error', message: 'scenario gave no live data' } });
    },
    openLink: (url) => (h.opened.push(url), Promise.resolve(true)),
    reportProblem: (state) => (h.reports.push(state), Promise.resolve(true)),
    logEvent: (event) => void h.events.push(event),
    usageSummary: () => Promise.resolve('Mochi usage (last 7 days on this Mac; counts only)'),
  };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t: string) => (h.clipboard.push(t), Promise.resolve()) },
  });

  try {
    for (const step of sc.steps) {
      const [action, arg] = typeof step === 'string' ? [step, undefined] : Object.entries(step)[0];
      switch (action) {
        case 'start':
          render(<App />);
          await waitFor(() => expect(h.fetchCalls).toBeGreaterThan(0));
          await flush(60);
          break;
        case 'next_fetch':
          h.queue = [resolveLive(arg as LiveSpec, file.fixtures, Date.now())];
          break;
        case 'click_pet': {
          const pet = mustFind('[aria-label^="Mochi is"]', 'the pet');
          fireEvent.pointerDown(pet, { pointerId: 1, clientX: 10, clientY: 10 });
          fireEvent.pointerUp(pet, { pointerId: 1, clientX: 10, clientY: 10 });
          break;
        }
        case 'click_bell':
          fireEvent.click(mustFind('[aria-label^="Notifications"]', 'the bell'));
          break;
        case 'click_bubble':
          fireEvent.click(mustFind('.bubble-main', 'the bubble'));
          break;
        case 'bubble_older':
          fireEvent.click(mustFind('[aria-label="Show older notification"]', 'the › button'));
          break;
        case 'bubble_newer':
          fireEvent.click(mustFind('[aria-label="Show newer notification"]', 'the ‹ button'));
          break;
        case 'close_bubble':
          fireEvent.click(mustFind('[aria-label="Dismiss notification"]', 'the bubble ×'));
          break;
        case 'open_menu':
          fireEvent.click(mustFind('[aria-label="Choose sections"]', 'the ≡ menu button'));
          break;
        case 'refresh_now':
          fireEvent.click(mustFind('[aria-label="Refresh now"]', 'the ↻ button'));
          break;
        case 'toggle_section': {
          const label = findByText(String(arg));
          const box = label.querySelector('input');
          if (!box) throw new Error(`Step failed: "${String(arg)}" has no checkbox`);
          fireEvent.click(box);
          break;
        }
        case 'click':
          fireEvent.click(findByText(String(arg)));
          break;
        case 'press':
          fireEvent.click(mustFind(`[aria-label="${String(arg)}"]`, `"${String(arg)}"`));
          break;
        case 'hide_pet':
          fireEvent.click(mustFind('[aria-label="Hide Mochi"]', 'the hide button'));
          break;
        case 'restore_pet':
          fireEvent.click(mustFind('[aria-label="Show Mochi"]', 'the paw'));
          break;
        case 'close_panel':
          fireEvent.click(mustFind('[aria-label="Close task panel"]', 'the panel ×'));
          break;
        case 'wake':
          h.resume?.();
          break;
        case 'dock_report':
          if (!h.reportRequest) throw new Error('Step failed: the app never subscribed to Dock "Report a Problem"');
          h.reportRequest();
          break;
        case 'wait':
          await flush(Number(arg));
          break;
        case 'expect':
          await checkExpectation(arg as Expectation, h);
          break;
        default:
          throw new Error(`Unknown step "${action}" (see scenarios/README.md)`);
      }
      await flush();
    }
    /* Privacy: events carry IDs and enums, never task names (logging plan). */
    const names = taskNames(file, sc);
    for (const ev of h.events) {
      for (const value of Object.values(ev)) {
        if (typeof value !== 'string') continue;
        const leaked = names.find((n) => value.includes(n));
        expect(leaked, `event ${ev.event_name} carries task name "${leaked}"`).toBeUndefined();
      }
    }
  } finally {
    cleanup();
    delete window.mochiShell;
  }
}

async function checkExpectation(e: Expectation, h: Harness) {
  await waitFor(
    () => {
      for (const s of e.see ?? []) expect(text(), `expected to see "${s}"`).toContain(s);
      for (const s of e.not_see ?? []) expect(text(), `expected not to see "${s}"`).not.toContain(s);
      if (e.in_order) {
        const at = e.in_order.map((s) => text().indexOf(s));
        expect(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), `expected in this order: ${e.in_order.join(' → ')}`).toBe(true);
      }
      if (e.badge !== undefined) {
        const badge = q('.bell-badge')?.textContent ?? 'none';
        expect(badge, 'bell badge').toBe(String(e.badge));
      }
      if (e.panel) expect(q('.overview-panel') ? 'open' : 'closed', 'panel').toBe(e.panel);
      if (e.bubble !== undefined) {
        const bubble = q('.notif-bubble')?.textContent?.replace(/\s+/g, ' ') ?? 'none';
        if (e.bubble === 'none') expect(bubble, 'bubble').toBe('none');
        else expect(bubble, 'bubble').toContain(e.bubble);
      }
      for (const s of e.opened ?? []) {
        expect(h.opened.some((u) => u.includes(s)), `expected a link containing "${s}" to open; opened: ${JSON.stringify(h.opened)}`).toBe(true);
      }
      for (const s of e.clipboard ?? []) expect(h.clipboard.at(-1) ?? '', 'clipboard').toContain(s);
      if (e.report) {
        const last = h.reports.at(-1);
        expect(last, 'a problem report was sent').toBeDefined();
        expect(last).toMatchObject(e.report);
      }
      for (const want of e.events ?? []) {
        expect(h.events.some((ev) => matches(ev, want)), `expected event ${JSON.stringify(want)}; logged: ${describeEvents(h.events)}`).toBe(true);
      }
      for (const want of e.not_events ?? []) {
        expect(h.events.some((ev) => matches(ev, want)), `expected no event ${JSON.stringify(want)}`).toBe(false);
      }
      if (e.event_count) {
        const n = h.events.filter((ev) => matches(ev, e.event_count!.match)).length;
        expect(n, `events matching ${JSON.stringify(e.event_count.match)}`).toBe(e.event_count.count);
      }
      for (const label of e.disabled ?? []) {
        const box = findByText(label).querySelector('input');
        expect(box?.disabled, `"${label}" checkbox disabled`).toBe(true);
      }
    },
    { timeout: 1500 },
  );
}
