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
