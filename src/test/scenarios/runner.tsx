/* Interaction-scenario runner: renders the real App with a fake desktop bridge
 * and fake Codimango data, performs each scenario step, and checks what is on
 * screen, which links opened, what was copied and which reports were sent.
 * Scenario format: scenarios/README.md.
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import App from '../../App.tsx';
import type { AgentId, AgentJob, AgentReviewStart } from '../../mochi/agentReviews.ts';
import type { CodimangoFetchResult, CodimangoSnapshot } from '../../mochi/codimango.ts';
import type { Sev } from '../../mochi/sevs.ts';
import type { LooksState, PetLook } from '../../mochi/looks.ts';
import type { AppSettings, HarvesterTaskStatus, ProblemReportState, UsageEvent } from '../../mochi/shell.ts';
import { resetUsageForTests } from '../../mochi/usage.ts';
import { toSnapshot } from './fixtures.ts';
import type { ShorthandSnapshot } from './fixtures.ts';

type FailureKind = 'cli_missing' | 'login_required' | 'offline' | 'error';
export type LiveSpec = string | ShorthandSnapshot | { error: FailureKind };

export interface Expectation {
  see?: string[];
  not_see?: string[];
  /** These strings appear on screen in this order (e.g. row ranking). */
  in_order?: string[];
  /** Unread number on the bell; `none` for no badge. */
  badge?: number | 'none';
  panel?: 'open' | 'closed';
  /** The pet is lifted above the full view's scrim, so it can be dragged while the view is open. */
  pet_over_view?: boolean;
  /** Text the notification bubble contains, or `none`. */
  bubble?: string | 'none';
  /** Every opened link so far, by substring. */
  opened?: string[];
  /** Stop / Restart calls sent to Harvester so far, e.g. "stop run-ember-x" or "restart ember-x revive". */
  harvester_calls?: string[];
  /** The last clipboard write contains each string. */
  clipboard?: string[];
  /** The last problem report sent through the bridge (partial match). */
  report?: Partial<ProblemReportState> & { counts?: Partial<ProblemReportState['counts']> };
  /** Checkbox labels in the ≡ menu that are disabled. */
  disabled?: string[];
  /** Usage events logged so far, each matched partially; `event` is the event name. */
  events?: ExpectedEvent[];
  /** Events that must not have been logged (same matching). */
  not_events?: ExpectedEvent[];
  /** Exactly this many logged events match, e.g. `{ match: { component: row }, count: 1 }`. */
  event_count?: { match: ExpectedEvent; count: number };
  /** Agent reviews started so far, as `task:agent` (e.g. `r2:claude`), cumulative. */
  agents_started?: string[];
  /** What the pet shows: a `custom` look or the `classic` Mochi. */
  pet_look?: 'custom' | 'classic';
}

export type ExpectedEvent = { event?: string } & Record<string, string | number | boolean>;

export type Step = string | Record<string, unknown>;

/** An agent review Mochi already knows about at launch (shorthand). */
export interface GivenAgentJob {
  task: string;
  agent: AgentId;
  status: AgentJob['status'];
  /** Name in the file's `agent_reports`, or the report text itself. */
  report?: string;
  /** Failure kind for failed runs (see AGENT_FAILURES). */
  failure?: string;
  started_ago_min?: number;
  steps?: number;
  /** The model that ran it, shown in the report. */
  model?: string;
  /** The task's updatedAt when the run started, hours ago. */
  task_updated_ago_h?: number;
}

/** A Codimango SEV as the main process would pass it on (already filtered). */
export interface GivenSev {
  id: string;
  level: number;
  open: boolean;
  title: string;
  opened_ago_h?: number;
  mitigated_ago_h?: number;
}

function givenSev(g: GivenSev, now: number): Sev {
  return {
    id: g.id,
    level: g.level,
    open: g.open,
    title: g.title,
    url: `https://www.internalfb.com/sevmanager/view/${g.id.slice(1)}`,
    createdAtMs: now - (g.opened_ago_h ?? 1) * 3_600_000,
    ...(g.mitigated_ago_h === undefined ? {} : { mitigatedAtMs: now - g.mitigated_ago_h * 3_600_000 }),
  };
}

export interface Scenario {
  id: string;
  title: string;
  given?: {
    /** Snapshot Mochi saved last time (shown before the first fetch). */
    saved?: string | ShorthandSnapshot;
    /** What each Codimango fetch returns, in order; the last one repeats. */
    live?: LiveSpec | LiveSpec[];
    sections?: Record<string, boolean>;
    section_order?: string[];
    notify?: Record<string, boolean>;
    /** Agent reviews the shell already has (running or finished). */
    agents?: GivenAgentJob[];
    /** Codimango SEVs the main process has already read. */
    sevs?: GivenSev[];
    /** Customize Mochi: whether this build can draw pets, saved looks by description, and which is current. */
    customize?: { available?: boolean; looks?: string[]; current?: number };
    /** A Harvester board on this Mac: its status per task name. */
    harvester?: Record<string, { kind: HarvesterTaskStatus['kind']; reason?: string; state?: string; intent?: 'revive' | 'revision' }>;
  };
  steps: Step[];
}

export interface ScenarioFile {
  fixtures?: Record<string, ShorthandSnapshot>;
  /** Agent review reports by name, as the skill would write them. */
  agent_reports?: Record<string, string>;
  scenarios: Scenario[];
}

interface Harness {
  delegated: Set<string>;
  opened: string[];
  clipboard: string[];
  reports: ProblemReportState[];
  events: UsageEvent[];
  fetchCalls: number;
  queue: CodimangoFetchResult[];
  resume?: () => void;
  reportRequest?: () => void;
  agentJobs: AgentJob[];
  agentStarts: AgentReviewStart[];
  agentListener?: (jobs: AgentJob[]) => void;
  sevListener?: (sevs: Sev[]) => void;
  looks: LooksState;
  /** Settings menu toggles, as the main process would answer (a packaged app). */
  appSettings: AppSettings;
  /** Harvester statuses by task name, and the Stop / Restart calls Mochi made. */
  harvester: Record<string, HarvesterTaskStatus>;
  harvesterCalls: string[];
}

/* A 1×1 PNG: stands in for every drawn pet. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const lookFor = (prompt: string, i: number): PetLook => ({ id: `look-${i}`, createdAtMs: 1000 + i, prompt, image: TINY_PNG });
const DRAW_ERRORS = ['refused', 'busy', 'limit', 'offline', 'error'] as const;

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

/* The same wording as electron/agentReview.mjs, for the failures scenarios use. */
const AGENT_FAILURES: Record<string, { message: string; fix?: string }> = {
  skill_missing: { message: "The Codimango review skill isn't installed.", fix: 'claude plugin install team-aai@agent-market' },
  codimango_login: { message: 'Codimango login missing or expired.', fix: 'codimango auth setup' },
  timeout: { message: 'The review took longer than 45 minutes and was stopped.' },
  cancelled: { message: 'You stopped this review.' },
  interrupted: { message: 'Mochi quit before the review finished.' },
};

function agentFailure(kind: string) {
  const known = AGENT_FAILURES[kind];
  if (!known) throw new Error(`Unknown agent failure "${kind}" (known: ${Object.keys(AGENT_FAILURES).join(', ')})`);
  return { kind, ...known };
}

function reportText(file: ScenarioFile, ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  return file.agent_reports?.[ref] ?? ref;
}

function taskNameFor(file: ScenarioFile, sc: Scenario, taskId: string, now: number): string {
  const lives = [sc.given?.live ?? []].flat().filter((l): l is string | ShorthandSnapshot => typeof l === 'string' || !('error' in l));
  for (const live of lives) {
    const row = resolveSnapshot(live, file.fixtures, now).reviewing.find((r) => r.id === taskId);
    if (row) return row.name;
  }
  return `task-${taskId}`;
}

function givenJob(file: ScenarioFile, sc: Scenario, g: GivenAgentJob, now: number, i: number): AgentJob {
  const started = now - (g.started_ago_min ?? 10) * 60_000;
  const finished = g.status === 'done' || g.status === 'failed';
  return {
    id: `given-${i}`,
    taskId: g.task,
    taskName: taskNameFor(file, sc, g.task, now),
    taskUpdatedAtMs: g.task_updated_ago_h === undefined ? null : now - g.task_updated_ago_h * 3_600_000,
    agent: g.agent,
    status: g.status,
    steps: g.steps ?? 0,
    model: g.model,
    createdAtMs: started,
    startedAtMs: g.status === 'queued' ? undefined : started,
    endedAtMs: finished ? now - 60_000 : undefined,
    report: reportText(file, g.report),
    failure: g.status === 'failed' ? agentFailure(g.failure ?? 'timeout') : undefined,
  };
}

/** Change one agent run as the main process would, and push the new list to the app. */
function updateAgentJob(h: Harness, arg: unknown, patch: (job: AgentJob) => Partial<AgentJob>) {
  const { task, agent } = arg as { task: string; agent: AgentId };
  const job = [...h.agentJobs].reverse().find((j) => j.taskId === String(task) && j.agent === agent);
  if (!job) throw new Error(`Step failed: no ${agent} review of ${String(task)} to update`);
  h.agentJobs = h.agentJobs.map((j) => (j === job ? { ...j, ...patch(j) } : j));
  if (!h.agentListener) throw new Error('Step failed: the app never subscribed to agent review changes');
  h.agentListener(h.agentJobs);
}

/* Mochi's own UI only: the mock backdrop page (.page) is not part of the product. */
function taskNames(file: ScenarioFile, sc: Scenario): string[] {
  const snaps = [...Object.values(file.fixtures ?? {}), sc.given?.saved, ...[sc.given?.live ?? []].flat()];
  return snaps.flatMap((x) =>
    x && typeof x === 'object' && !('error' in x) ? [...(x.reviewing ?? []), ...(x.mine ?? [])].flatMap((r) => (r.name ? [r.name] : [])) : [],
  );
}

function matches(e: UsageEvent, want: ExpectedEvent): boolean {
  return Object.entries(want).every(([k, v]) => (k === 'event' ? e.event_name === v : e[k] === v));
}

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
  const given = sc.given?.customize;
  const givenLooks = (given?.looks ?? []).map(lookFor);
  const h: Harness = {
    delegated: new Set(),
    opened: [],
    clipboard: [],
    reports: [],
    events: [],
    fetchCalls: 0,
    queue: [],
    agentJobs: [],
    agentStarts: [],
    looks: {
      available: given?.available ?? true,
      looks: givenLooks,
      currentId: given?.current !== undefined ? (givenLooks[given.current]?.id ?? null) : null,
    },
    appSettings: { openAtLogin: false },
    harvester: Object.fromEntries(
      Object.entries(sc.given?.harvester ?? {}).map(([taskName, g]) => [
        taskName,
        {
          kind: g.kind,
          state: g.state ?? (g.kind === 'working' ? 'running' : g.kind === 'done' ? 'done' : 'cancelled'),
          reason: g.reason ?? '',
          runId: `run-${taskName}`,
          intent: g.intent ?? 'revive',
          restartCount: 0,
          sinceMs: now - 5 * 60_000,
          startedMs: now - 60 * 60_000,
          taskName,
          base: 'http://127.0.0.1:44101',
          repo: 'ember',
        },
      ]),
    ),
    harvesterCalls: [],
  };
  const storeState = () => ({ looks: h.looks.looks, currentId: h.looks.currentId });
  h.agentJobs = (sc.given?.agents ?? []).map((g, i) => givenJob(file, sc, g, now, i));
  const lives = sc.given?.live === undefined ? [] : Array.isArray(sc.given.live) ? sc.given.live : [sc.given.live];
  h.queue = lives.map((l) => resolveLive(l, file.fixtures, now));

  localStorage.clear();
  resetUsageForTests();
  window.IntersectionObserver = VisibleIntersectionObserver as unknown as typeof IntersectionObserver;
  if (sc.given?.saved) {
    localStorage.setItem('mochi.codimango.v1', JSON.stringify(resolveSnapshot(sc.given.saved, file.fixtures, now - 1)));
  }
  if (sc.given?.sections) localStorage.setItem('mochi.sections.v1', JSON.stringify(sc.given.sections));
  if (sc.given?.section_order) localStorage.setItem('mochi.sections.order.v1', JSON.stringify(sc.given.section_order));
  if (sc.given?.notify) localStorage.setItem('mochi.notify.v1', JSON.stringify(sc.given.notify));
  // Delegation already asked for its devserver in this harness, so the picker shows the saved one.
  localStorage.setItem('mochi.delegate-node.v1', 'devvm7438.hil0.facebook.com');

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
    listSevs: () => Promise.resolve((sc.given?.sevs ?? []).map((g) => givenSev(g, now))),
    onSevsChanged: (cb) => ((h.sevListener = cb), () => {}),
    listAgentReviews: () => Promise.resolve(h.agentJobs),
    onAgentReviewsChanged: (cb) => ((h.agentListener = cb), () => {}),
    startAgentReview: (req) => {
      h.agentStarts.push(req);
      const t = Date.now();
      for (const agent of req.agents) {
        const prior = h.agentJobs.filter((j) => j.taskId === req.taskId && j.agent === agent);
        if (prior.some((j) => j.status === 'queued' || j.status === 'running')) continue;
        h.agentJobs = h.agentJobs.filter((j) => !prior.includes(j));
        h.agentJobs = [
          ...h.agentJobs,
          { id: `run-${h.agentStarts.length}-${agent}`, taskId: req.taskId, taskName: req.taskName, taskUpdatedAtMs: req.taskUpdatedAtMs ?? null, agent, status: 'running', steps: 0, createdAtMs: t, startedAtMs: t },
        ];
      }
      return Promise.resolve(h.agentJobs);
    },
    harvesterStatus: () => Promise.resolve({ available: Object.keys(h.harvester).length > 0, statuses: h.harvester }),
    /* Like Harvester: a stopped run reads stopped, a restarted task reads queued, on the next refresh. */
    stopHarvesterRun: (req) => {
      h.harvesterCalls.push(`stop ${req.runId}`);
      const name = Object.keys(h.harvester).find((n) => h.harvester[n].runId === req.runId);
      if (name) h.harvester = { ...h.harvester, [name]: { ...h.harvester[name], kind: 'stopped', state: 'cancelled', reason: '' } };
      return Promise.resolve({ ok: true });
    },
    restartHarvesterTask: (req) => {
      h.harvesterCalls.push(`restart ${req.taskName} ${req.intent}`);
      const prev = h.harvester[req.taskName];
      if (prev) h.harvester = { ...h.harvester, [req.taskName]: { ...prev, kind: 'working', state: 'queued', reason: 'Queued', intent: req.intent } };
      return Promise.resolve({ ok: true });
    },
    appSettings: () => Promise.resolve(h.appSettings),
    setAppSetting: (key, value) => {
      h.appSettings = { ...h.appSettings, [key]: value };
      return Promise.resolve(h.appSettings);
    },
    looksState: () => Promise.resolve(h.looks),
    /* Like the fake generator: three candidates, or the error named by "#kind" in the text. */
    generatePet: async (text) => {
      await new Promise((r) => setTimeout(r, 10));
      const forced = DRAW_ERRORS.find((k) => text.includes(`#${k}`));
      if (forced) return { ok: false, error: { kind: forced } };
      if (!text.trim()) return { ok: false, error: { kind: 'empty' } };
      return { ok: true, candidates: [0, 1, 2].map((i) => ({ id: `cand-${i}::${text}`, image: TINY_PNG, framed: false })) };
    },
    cancelPetGenerate: () => Promise.resolve(),
    keepLook: (candidateId) => {
      const prompt = candidateId.split('::')[1] ?? '';
      const look = lookFor(prompt, h.looks.looks.length + 100);
      h.looks = { ...h.looks, looks: [look, ...h.looks.looks], currentId: look.id };
      return Promise.resolve(storeState());
    },
    setCurrentLook: (id) => {
      h.looks = { ...h.looks, currentId: id };
      return Promise.resolve(storeState());
    },
    deleteLook: (id) => {
      h.looks = { ...h.looks, looks: h.looks.looks.filter((l) => l.id !== id), currentId: h.looks.currentId === id ? null : h.looks.currentId };
      return Promise.resolve(storeState());
    },
    cancelAgentReview: (id) => {
      h.agentJobs = h.agentJobs.map((j) => (j.id === id ? { ...j, status: 'failed', endedAtMs: Date.now(), failure: agentFailure('cancelled') } : j));
      return Promise.resolve(h.agentJobs);
    },
    delegateToGreen: (taskSlug) => {
      h.delegated.add(String(taskSlug));
      return Promise.resolve({
        ok: true as const,
        taskSlug: String(taskSlug),
        agent: 'codex' as const,
        repo: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember',
        pid: 424242,
        logPath: '/home/zixuanchen/logs/green-1.log',
        decision: 'DECIDE repair: validation failures',
      });
    },
    checkDelegateStatus: (req) =>
      Promise.resolve({
        ok: true as const,
        status: {
          kind: 'working' as const,
          taskSlug: String(req.taskSlug),
          pid: req.pid,
          logPath: req.logPath,
          lastDecision: 'DECIDE FIX: validation failures',
          lastActivityAgeSecs: 60,
          checkedAtMs: Date.now(),
        },
      }),
    checkTaskHandler: (req) => {
      const delegated = h.delegated.has(String(req.taskSlug));
      return Promise.resolve({
        ok: true as const,
        probe: {
          handler: delegated ? ('green' as const) : ('none' as const),
          pid: delegated ? 424242 : null,
          logPath: delegated ? '/home/zixuanchen/logs/green-1.log' : null,
          agent: delegated ? ('codex' as const) : null,
          kind: delegated ? ('working' as const) : null,
          lastDecision: delegated ? 'DECIDE FIX: validation failures' : null,
          lastActivityAgeSecs: delegated ? 60 : null,
          waitingMins: null,
          waitingReason: null,
          blockedReason: null,
          hasBlocked: false,
          hasTimingZero: false,
          leaseAgeSecs: null,
          checkedAtMs: Date.now(),
        },
      });
    },
    stopGreenWorker: (req) => Promise.resolve({ ok: true as const, taskSlug: String(req.taskSlug), pid: req.pid, stopped: true }),
    installDocker: (taskSlug) => Promise.resolve({ ok: true as const, taskSlug: String(taskSlug), alreadyInstalled: true, daemonReachable: true }),
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
        case 'drag_pet': {
          const { dx, dy } = arg as { dx: number; dy: number };
          const pet = mustFind('[aria-label^="Mochi is"]', 'the pet');
          fireEvent.pointerDown(pet, { pointerId: 1, clientX: 10, clientY: 10 });
          fireEvent.pointerMove(pet, { pointerId: 1, clientX: 10 + dx, clientY: 10 + dy });
          fireEvent.pointerUp(pet, { pointerId: 1, clientX: 10 + dx, clientY: 10 + dy });
          break;
        }
        case 'sevs': {
          const list = (arg as GivenSev[]).map((g) => givenSev(g, Date.now()));
          act(() => h.sevListener?.(list));
          await flush();
          break;
        }
        case 'click_bell':
          fireEvent.click(mustFind('[aria-label^="Notifications"]', 'the bell'));
          break;
        case 'click_bubble':
          fireEvent.click(mustFind('.bubble-main', 'the bubble'));
          break;
        case 'click_bubble_task':
          fireEvent.click(mustFind('.bubble-task', "the bubble's task name"));
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
        case 'delegate_task': {
          const title = findByText(String(arg));
          const row = title.closest('.glance-row');
          if (!row) throw new Error(`Step failed: no row for "${String(arg)}"`);
          const button = [...row.querySelectorAll('button')].find((b) => b.textContent?.includes('Delegate to agent'));
          if (!button) throw new Error(`Step failed: no Delegate to agent button for "${String(arg)}"`);
          fireEvent.click(button);
          fireEvent.click(findByText('Delegate to Codex'));
          break;
        }
        case 'open_menu':
          fireEvent.click(mustFind('[aria-label="Choose sections"]', 'the ≡ menu button'));
          break;
        case 'open_settings':
          fireEvent.click(mustFind('[aria-label="Settings"]', 'the ⚙ Settings button'));
          break;
        case 'open_notify_menu':
          fireEvent.click(mustFind('[aria-label="Notification settings"]', 'the bell button'));
          break;
        case 'drag_section': {
          const { label, dy } = arg as { label: string; dy: number };
          const handle = mustFind(`[aria-label="Drag ${label} to reorder"]`, 'the section drag handle');
          fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 10 });
          fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10, clientY: 10 + dy });
          fireEvent.pointerUp(handle, { pointerId: 1, clientX: 10, clientY: 10 + dy });
          break;
        }
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
        case 'fill': {
          // fill: { label: Describe your Mochi, text: a sleepy cat } types into that field.
          const { label, text } = arg as { label: string; text: string };
          const field = findByText(label).querySelector('textarea, input') as HTMLTextAreaElement | HTMLInputElement | null;
          if (!field) throw new Error(`Step failed: "${label}" has no text field`);
          fireEvent.change(field, { target: { value: text } });
          break;
        }
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
        case 'agent_progress': {
          const { minutes = 0, steps = 0 } = arg as { minutes?: number; steps?: number };
          updateAgentJob(h, arg, () => ({ startedAtMs: Date.now() - minutes * 60_000, steps }));
          break;
        }
        case 'agent_finishes': {
          const report = reportText(file, (arg as { report?: string }).report);
          if (!report) throw new Error('Step failed: agent_finishes needs a report');
          updateAgentJob(h, arg, () => ({ status: 'done', report, endedAtMs: Date.now() }));
          break;
        }
        case 'agent_fails': {
          const failure = agentFailure(String((arg as { kind?: string }).kind ?? 'timeout'));
          updateAgentJob(h, arg, () => ({ status: 'failed', failure, endedAtMs: Date.now() }));
          break;
        }
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
      if (e.pet_over_view !== undefined) expect(Boolean(q('.pet-widget.is-over-view')), 'pet above the full view').toBe(e.pet_over_view);
      if (e.bubble !== undefined) {
        const bubble = q('.notif-bubble')?.textContent?.replace(/\s+/g, ' ') ?? 'none';
        if (e.bubble === 'none') expect(bubble, 'bubble').toBe('none');
        else expect(bubble, 'bubble').toContain(e.bubble);
      }
      for (const s of e.opened ?? []) {
        expect(h.opened.some((u) => u.includes(s)), `expected a link containing "${s}" to open; opened: ${JSON.stringify(h.opened)}`).toBe(true);
      }
      for (const s of e.clipboard ?? []) expect(h.clipboard.at(-1) ?? '', 'clipboard').toContain(s);
      if (e.harvester_calls) expect(h.harvesterCalls, 'harvester calls').toEqual(e.harvester_calls);
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
      if (e.pet_look) {
        const img = q('.pet-pressable .mochi-svg image');
        expect(img ? 'custom' : 'classic', 'what the pet shows').toBe(e.pet_look);
      }
      for (const want of e.agents_started ?? []) {
        const started = h.agentStarts.flatMap((r) => r.agents.map((a) => `${r.taskId}:${a}`));
        expect(started, `expected agent review ${want} to start`).toContain(want);
      }
      for (const label of e.disabled ?? []) {
        const box = findByText(label).querySelector('input');
        expect(box?.disabled, `"${label}" checkbox disabled`).toBe(true);
      }
    },
    { timeout: 1500 },
  );
}
