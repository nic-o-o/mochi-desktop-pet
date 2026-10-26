/** Ring fill, capped at 100%. Counts shown as text may exceed the goal. */
export function progressFraction(done: number, goal: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(goal) || goal <= 0) return 0;
  return Math.min(1, Math.max(0, done / goal));
}

export function formatDue(dueInMinutes: number): string {
  if (dueInMinutes < 1) return 'due now';
  if (dueInMinutes < 60) return `${Math.floor(dueInMinutes)}m left`;
  const hours = Math.floor(dueInMinutes / 60);
  const minutes = Math.floor(dueInMinutes % 60);
  if (hours < 24) {
    return minutes > 0 ? `${hours}h ${minutes}m left` : `${hours}h left`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}d ${restHours}h left` : `${days}d left`;
}

export interface Box {
  w: number;
  h: number;
}

export interface Rect extends Box {
  x: number;
  y: number;
}

/**
 * Place a floating box next to the pet, flipping to the other side when
 * there is not enough room so it is never clipped by the viewport edge.
 */
export function placeBesidePet(
  pet: Rect,
  box: Box,
  viewport: Box,
  gap = 12,
): { left: number; top: number } {
  let left = pet.x + pet.w + gap;
  if (left + box.w > viewport.w - 8) {
    left = pet.x - box.w - gap;
  }
  left = Math.min(Math.max(8, left), Math.max(8, viewport.w - box.w - 8));

  let top = pet.y;
  if (top + box.h > viewport.h - 8) {
    top = viewport.h - box.h - 8;
  }
  top = Math.max(8, top);
  return { left, top };
}

/**
 * Place the notification bubble above the pet, flipping below it when
 * there is no room above. Horizontally clamped to the viewport.
 */
export function placeBubbleAbovePet(
  pet: Rect,
  box: Box,
  viewport: Box,
  gap = 10,
): { left: number; top: number } {
  let left = pet.x + pet.w / 2 - box.w / 2;
  left = Math.min(Math.max(8, left), Math.max(8, viewport.w - box.w - 8));

  let top = pet.y - box.h - gap;
  if (top < 8) {
    top = pet.y + pet.h + gap;
  }
  top = Math.min(top, Math.max(8, viewport.h - box.h - 8));
  return { left, top };
}
