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
export type TaskStatus = 'pending_review' | 'revision_required';

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

/**
 * Edge-aware placement for the bubble/panel near the pet.
 * Prefers the right side of the pet; flips to the left near the right edge,
 * shifts up near the bottom edge, and clamps to an 8px margin.
 */
export function placeFloating(pet: Rect, float: Size, viewport: Size, gap = 12): XY {
  const fitsRight = pet.x + pet.w + gap + float.w <= viewport.w;
  let x = fitsRight ? pet.x + pet.w + gap : pet.x - gap - float.w;
  x = Math.max(8, x);
  const maxX = viewport.w - float.w - 8;
  if (maxX >= 8) x = Math.min(x, maxX);

  let y = Math.min(pet.y, Math.max(8, viewport.h - float.h - 8));
  y = Math.max(8, y);
  return { x, y };
}
