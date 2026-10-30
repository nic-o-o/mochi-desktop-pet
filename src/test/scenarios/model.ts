/* The scenario format (scenarios/README.md), shared by the jsdom runner
 * (src/test/scenarios/runner.tsx) and the Electron end-to-end runner (e2e/).
 */
import type { ProblemReportState, UsageEvent } from '../../mochi/shell.ts';
import type { ShorthandSnapshot } from './fixtures.ts';

export type FailureKind = 'cli_missing' | 'login_required' | 'offline' | 'error';
export type LiveSpec = string | ShorthandSnapshot | { error: FailureKind };

export interface Expectation {
  see?: string[];
  not_see?: string[];
  /** These strings appear on screen in this order (e.g. row ranking). */
  in_order?: string[];
  /** Unread number on the bell; `none` for no badge. */
  badge?: number | 'none';
  panel?: 'open' | 'closed';
  /** Text the notification bubble contains, or `none`. */
  bubble?: string | 'none';
  /** Every opened link so far, by substring. */
  opened?: string[];
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
}

export type ExpectedEvent = { event?: string } & Record<string, string | number | boolean>;

export type Step = string | Record<string, unknown>;

export interface Scenario {
  id: string;
  title: string;
  given?: {
    /** Snapshot Mochi saved last time (shown before the first fetch). */
    saved?: string | ShorthandSnapshot;
    /** What each Codimango fetch returns, in order; the last one repeats. */
    live?: LiveSpec | LiveSpec[];
    sections?: Record<string, boolean>;
  };
  steps: Step[];
}

export interface ScenarioFile {
  fixtures?: Record<string, ShorthandSnapshot>;
  scenarios: Scenario[];
}

/** What each fetch returns, in order (the last one repeats). */
export function liveSpecs(sc: Scenario): LiveSpec[] {
  const live = sc.given?.live;
  return live === undefined ? [] : Array.isArray(live) ? live : [live];
}

/** Every task name in the scenario's data: no usage event may contain one. */
export function taskNames(file: ScenarioFile, sc: Scenario): string[] {
  const snaps = [...Object.values(file.fixtures ?? {}), sc.given?.saved, ...[sc.given?.live ?? []].flat()];
  return snaps.flatMap((x) =>
    x && typeof x === 'object' && !('error' in x) ? [...(x.reviewing ?? []), ...(x.mine ?? [])].flatMap((r) => (r.name ? [r.name] : [])) : [],
  );
}

export function matches(e: UsageEvent, want: ExpectedEvent): boolean {
  return Object.entries(want).every(([k, v]) => (k === 'event' ? e.event_name === v : e[k] === v));
}
