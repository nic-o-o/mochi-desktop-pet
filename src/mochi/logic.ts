/* Pure, UI-independent logic for the Mochi desktop pet prototype.
 * Kept free of React/DOM imports so it can be unit-tested with Vitest in Node.
 */

export type PetState = 'chilling' | 'sleepy' | 'happy' | 'nervous' | 'focused';

/** Seconds without interaction with the pet UI before Mochi gets sleepy. */
export const IDLE_SLEEPY_SECONDS = 10;

/** Pixels the pointer must move before a press counts as a drag (not a click). */
export const DRAG_THRESHOLD_PX = 6;

export interface PetStateInput {
  panelOpen: boolean;
  bubbleVisible: boolean;
  hoveringOrDragging: boolean;
  idleSeconds: number;
}

/**
 * Deterministic state resolution. Priority: Focused > Nervous > Happy > Sleepy > Chilling.
 * Higher-priority states are never overridden by lower-priority ones.
 */
export function resolvePetState(input: PetStateInput): PetState {
  if (input.panelOpen) return 'focused';
  if (input.bubbleVisible) return 'nervous';
  if (input.hoveringOrDragging) return 'happy';
  if (input.idleSeconds >= IDLE_SLEEPY_SECONDS) return 'sleepy';
  return 'chilling';
}

/* ------------------------------------------------------------------ tasks -- */

export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low';
export type TaskStatus = 'pending_review' | 'revision_required' | 'draft';

/** Draft rows: where validation stands (READY = passing, can be submitted). */
export type DraftState = 'ready' | 'failing' | 'running' | 'new';

export interface TaskItem {
  id: string;
  title: string;
  type: string;
  priority: TaskPriority;
  status: TaskStatus;
  /** Absolute epoch-ms deadline used for SLA ordering/display. */
  slaDueMs: number;
  description: string;
  requester: string;
  /** Revision rows: validation detail, shown as "Validation failed · <summary>". */
  checkSummary?: string;
  /** Waiting rows: shown as "Submitted by …" instead of "Assigned by …" when present. */
  submittedBy?: string;
  /** Row subtitle override (Codimango rows, e.g. "Assigned to you"); wins over the rules above. */
  subtitle?: string;
  /** Codimango page for this task (review or submission). */
  url?: string;
  /** Draft rows only. */
  draftState?: DraftState;
}

export const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/** Sort by priority first, then nearest SLA deadline. Never mutates the input. */
export function sortTasks(tasks: TaskItem[]): TaskItem[] {
  return [...tasks].sort((a, b) => {
    const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (byPriority !== 0) return byPriority;
    if (a.slaDueMs !== b.slaDueMs) return a.slaDueMs - b.slaDueMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function filterTasks(tasks: TaskItem[], query: string): TaskItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter((t) =>
    `${t.title} ${t.type} ${t.id}`.toLowerCase().includes(q),
  );
}

/** "3h 20m left" / "45m left" / "2d 1h left" / "Overdue 15m". */
export function formatSla(slaDueMs: number, nowMs: number): string {
  const diff = slaDueMs - nowMs;
  const abs = Math.abs(diff);
  const totalMinutes = Math.floor(abs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const days = Math.floor(hours / 24);
  const label =
    days >= 1
      ? `${days}d ${hours % 24}h`
      : hours >= 1
        ? `${hours}h ${totalMinutes % 60}m`
        : `${totalMinutes}m`;
  return diff < 0 ? `Overdue ${label}` : `${label} left`;
}

/* -------------------------------------------------------- glance flags -- */

export type GlanceFlagTone = 'danger' | 'warn' | 'ok' | 'dark' | 'light';

export interface GlanceFlag {
  text: string;
  tone: GlanceFlagTone;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Right-side badge for "Needs revision" rows: HI PRI (dark grey) or LOW PRI (light grey). */
export function revisionRowFlag(priority: TaskPriority): GlanceFlag {
  const hi = priority === 'urgent' || priority === 'high';
  return hi ? { text: 'HI PRI', tone: 'dark' } : { text: 'LOW PRI', tone: 'light' };
}

/** Right-side badge for "Waiting for your review" rows, bucketed by day. */
export function pendingRowFlag(slaDueMs: number, nowMs: number): GlanceFlag {
  const diff = slaDueMs - nowMs;
  if (diff < 0) return { text: 'Past due', tone: 'danger' };
  const days = Math.floor(diff / DAY_MS);
  if (days < 1) return { text: '0d left', tone: 'warn' };
  return { text: `${days}d left`, tone: 'ok' };
}

/** Right-side badge for "Drafts" rows: READY (validation passing) stands out. */
export function draftRowFlag(state: DraftState | undefined): GlanceFlag {
  switch (state) {
    case 'ready':
      return { text: 'READY', tone: 'ok' };
    case 'failing':
      return { text: 'FAILING', tone: 'light' };
    case 'running':
      return { text: 'RUNNING', tone: 'light' };
    default:
      return { text: 'NEW', tone: 'light' };
  }
}

/** Glance ordering for revision rows: HI PRI (0) always precedes LOW PRI (1). */
export function revisionRank(priority: TaskPriority): number {
  return priority === 'urgent' || priority === 'high' ? 0 : 1;
}

/**
 * Glance ordering for waiting-review rows: Past due (0) first,
 * then days-left ascending — 0d left (1), 1d left (2), and so on.
 */
export function pendingRank(slaDueMs: number, nowMs: number): number {
  const diff = slaDueMs - nowMs;
  if (diff < 0) return 0;
  return 1 + Math.floor(diff / DAY_MS);
}

/* -------------------------------------------------------------- freshness -- */

export type FreshnessState = 'idle' | 'refreshing' | 'offline' | 'error';

function sinceLabel(fromMs: number, nowMs: number): string {
  const mins = Math.floor(Math.max(0, nowMs - fromMs) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Panel line under the header: how old the data is, or why it isn't fresh. */
export function freshnessLabel(fetchedAtMs: number | null, nowMs: number, state: FreshnessState): string {
  if (state === 'refreshing') return 'Refreshing…';
  const since = fetchedAtMs === null ? null : sinceLabel(fetchedAtMs, nowMs);
  if (state === 'offline') return since ? `Offline · showing data from ${since}` : 'Offline';
  if (state === 'error') return since ? `Couldn't refresh · showing data from ${since}` : "Couldn't refresh";
  return since ? `Updated ${since}` : 'Not updated yet';
}

/* ------------------------------------------------------------------ goals -- */

export interface WeeklyGoals {
  reviewGoal: number;
  submissionGoal: number;
}

/** Returns an error message for invalid input, or null when valid. */
export function validateGoalInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return 'Enter a goal (a positive whole number).';
  if (!/^\d+$/.test(trimmed)) return 'Use a positive whole number (no decimals or symbols).';
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 1) return 'Goal must be at least 1.';
  return null;
}

/** Parses raw input to a positive integer, or null when invalid. */
export function parseGoalInput(raw: string): number | null {
  if (validateGoalInput(raw) !== null) return null;
  return Number(raw.trim());
}

/** Step a goal up/down by one, never dropping below 1. */
export function stepGoal(goal: number, delta: 1 | -1): number {
  return Math.max(1, goal + delta);
}

/** Ring fill fraction, capped at 100%. Text counts may still exceed the goal. */
export function ringFraction(done: number, goal: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(goal) || goal <= 0) return 0;
  return Math.min(1, Math.max(0, done / goal));
}

/* --------------------------------------------------------------- geometry -- */

export interface XY {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface PlacedRect extends XY {
  w: number;
  h: number;
}

/**
 * Bounding box of the visible UI rects, padded and clamped to the viewport.
 * Pure helper behind the desktop shell window union: the shell window is
 * resized to exactly this (plus the display origin), so only Mochi pixels
 * ever exist as a window.
 */
export function unionBounds(
  rects: PlacedRect[],
  viewport: Size,
  pad: number,
): { x: number; y: number; width: number; height: number } {
  if (rects.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const minX = Math.max(0, Math.min(...rects.map((r) => r.x)) - pad);
  const minY = Math.max(0, Math.min(...rects.map((r) => r.y)) - pad);
  const maxX = Math.min(viewport.w, Math.max(...rects.map((r) => r.x + r.w)) + pad);
  const maxY = Math.min(viewport.h, Math.max(...rects.map((r) => r.y + r.h)) + pad);
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/** Constrain the pet's top-left corner so the whole pet stays in view. */
export function clampPetPosition(pos: XY, viewport: Size, petSize: number): XY {
  return {
    x: Math.min(Math.max(0, pos.x), Math.max(0, viewport.w - petSize)),
    y: Math.min(Math.max(0, pos.y), Math.max(0, viewport.h - petSize)),
  };
}

export interface Rect extends XY, Size {}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function clampSpot(x: number, y: number, float: Size, viewport: Size): XY {
  x = Math.max(8, x);
  const maxX = viewport.w - float.w - 8;
  if (maxX >= 8) x = Math.min(x, maxX);
  y = Math.max(8, y);
  const maxY = viewport.h - float.h - 8;
  if (maxY >= 8) y = Math.min(y, maxY);
  return { x, y };
}

/**
 * Edge-aware placement for the bubble/panel near the pet.
 * Prefers the right side of the pet; flips to the left near the right edge,
 * shifts up near the bottom edge, and clamps to an 8px margin.
 * Rects in `avoid` (e.g. the open panel for the bubble) are sidestepped: above
 * the obstacle first (`aboveGap`), then hugging the pet above and below it,
 * then left of the pet and below the obstacle. The preferred spot is kept
 * when nothing fits.
 */
export function placeFloating(
  pet: Rect,
  float: Size,
  viewport: Size,
  gap = 12,
  avoid: Rect[] = [],
  aboveGap = gap,
): XY {
  const fitsRight = pet.x + pet.w + gap + float.w <= viewport.w;
  let x = fitsRight ? pet.x + pet.w + gap : pet.x - gap - float.w;
  x = Math.max(8, x);
  const maxX = viewport.w - float.w - 8;
  if (maxX >= 8) x = Math.min(x, maxX);

  let y = Math.min(pet.y, Math.max(8, viewport.h - float.h - 8));
  y = Math.max(8, y);
  if (!avoid.some((r) => rectsOverlap({ x, y, ...float }, r))) return { x, y };

  /* Above the obstacle (bubble over the panel), then hugging the pet above and
     below it. */
  const spots: XY[] = [];
  for (const r of avoid) spots.push({ x: r.x, y: r.y - aboveGap - float.h });
  spots.push(
    { x: pet.x, y: pet.y - aboveGap - float.h },
    { x: pet.x, y: pet.y + pet.h + aboveGap },
  );
  spots.push({ x: pet.x - gap - float.w, y });
  for (const r of avoid) spots.push({ x: r.x, y: r.y + r.h + gap });
  for (const s of spots) {
    const c = clampSpot(s.x, s.y, float, viewport);
    if (!avoid.some((r) => rectsOverlap({ ...c, ...float }, r))) return c;
  }
  return { x, y };
}
