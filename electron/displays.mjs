/* Display geometry for the overlay window (main process; pure, so it is testable). */

/** Every display in global coordinates plus the box around them all, so the pet can be dragged to any monitor. */
export function allDisplayBounds(displays) {
  const rects = displays.map(({ bounds: b }) => ({ x: b.x, y: b.y, width: b.width, height: b.height }));
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const width = Math.max(...rects.map((r) => r.x + r.width)) - x;
  const height = Math.max(...rects.map((r) => r.y + r.height)) - y;
  return { x, y, width, height, displays: rects };
}

/* Minimum on-screen strip (px) kept grabbable when the pet is dragged. */
export const PET_GRAB = 60;

/**
 * Keep the pet reachable: on launch (`full`) the whole window must land
 * inside the display union (falling back to `fallback` when its center is in
 * a gap between monitors); on drags at least a grab strip must stay visible.
 * Pure, so it is unit-testable.
 */
export function clampPetBounds(rect, areas, fallback, full = false) {
  let { x, y } = rect;
  const { width, height } = rect;
  const minX = Math.min(...areas.map((a) => a.x));
  const minY = Math.min(...areas.map((a) => a.y));
  const maxX = Math.max(...areas.map((a) => a.x + a.width));
  const maxY = Math.max(...areas.map((a) => a.y + a.height));
  if (full) {
    x = Math.min(Math.max(x, minX), maxX - width);
    y = Math.min(Math.max(y, minY), maxY - height);
  } else {
    x = Math.min(Math.max(x, minX - width + PET_GRAB), maxX - PET_GRAB);
    y = Math.min(Math.max(y, minY - height + PET_GRAB), maxY - PET_GRAB);
  }
  const cx = x + width / 2;
  const cy = y + height / 2;
  const onScreen = areas.some(
    (a) => cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height,
  );
  if (!onScreen && full) return { ...fallback, width, height };
  return { x: Math.round(x), y: Math.round(y), width, height };
}
