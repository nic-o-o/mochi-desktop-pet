/* Generated image → pet sprite (main process).
 *
 * Image models draw the pet on a plain background (the prompt asks for white)
 * and can't be relied on for transparency, so Mochi cuts the background out:
 * a flood fill from every edge pixel that is close to the corner colour, then a
 * 1px soft edge. When the cut looks wrong (almost nothing removed: a busy
 * background; or almost everything: a white pet on white) the image gets a
 * soft circular frame instead. Then it's cropped to the character and fitted
 * in SPRITE_SIZE (twice the 124px display size, so it stays sharp on Retina).
 *
 * Pixels are plain RGBA arrays so all of this is unit-tested in Node; decoding,
 * encoding and resizing come from a codec (Electron's nativeImage in the app).
 */

export const SPRITE_SIZE = 248;
/* Models return 1024–1600px images; the cutout runs on a smaller copy (fast, and plenty for a 248px sprite). */
const WORK_SIZE = 512;
const TOLERANCE = 48;
/* Share of pixels the fill must remove for the cut to count as a cutout. */
const MIN_REMOVED = 0.08;
const MAX_REMOVED = 0.97;
const PAD = 6;

/** True when every corner is fully transparent: the image arrived cut out. */
export function alreadyCutOut({ width, height, data }) {
  return [0, width - 1, (height - 1) * width, height * width - 1].every((p) => data[p * 4 + 3] === 0);
}

/** Average colour of the four corners: the background the fill removes. */
function cornerColor({ width, height, data }) {
  const at = (x, y) => (y * width + x) * 4;
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  return [0, 1, 2].map((c) => corners.reduce((sum, i) => sum + data[i + c], 0) / 4);
}

/**
 * Remove the background in place: flood fill from the edges over pixels within
 * `tolerance` of the corner colour, then soften the boundary by one pixel.
 * Returns the share of pixels removed.
 */
export function removeBackground(img, tolerance = TOLERANCE) {
  const { width, height, data } = img;
  const bg = cornerColor(img);
  const close = (p) =>
    Math.abs(data[p * 4] - bg[0]) <= tolerance &&
    Math.abs(data[p * 4 + 1] - bg[1]) <= tolerance &&
    Math.abs(data[p * 4 + 2] - bg[2]) <= tolerance;
  const removed = new Uint8Array(width * height);
  const stack = [];
  const seed = (x, y) => {
    const p = y * width + x;
    if (!removed[p] && close(p)) {
      removed[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x, 0);
    seed(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    seed(0, y);
    seed(width - 1, y);
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) seed(x - 1, y);
    if (x < width - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < height - 1) seed(x, y + 1);
  }
  let count = 0;
  for (let p = 0; p < removed.length; p++) {
    if (removed[p]) {
      data[p * 4 + 3] = 0;
      count++;
    }
  }
  // Soft edge: kept pixels touching a removed one go half transparent.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (removed[p]) continue;
      const touches =
        (x > 0 && removed[p - 1]) ||
        (x < width - 1 && removed[p + 1]) ||
        (y > 0 && removed[p - width]) ||
        (y < height - 1 && removed[p + width]);
      if (touches) data[p * 4 + 3] = Math.min(data[p * 4 + 3], 128);
    }
  }
  return count / removed.length;
}

/** Fallback: keep the largest centred circle, softly faded at its rim. */
export function circleFrame(img) {
  const { width, height, data } = img;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const r = Math.min(width, height) / 2 - 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const i = (y * width + x) * 4 + 3;
      if (d > r) data[i] = 0;
      else if (d > r - 2) data[i] = Math.round(data[i] * ((r - d) / 2));
    }
  }
}

/** Bounding box of the visible pixels plus a little padding; null if nothing is visible. */
export function contentBox({ width, height, data }, pad = PAD) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** A new image holding `box` of `img`, centred on a transparent square. */
export function cropToSquare(img, box) {
  const side = Math.max(box.width, box.height);
  const out = { width: side, height: side, data: new Uint8ClampedArray(side * side * 4) };
  const ox = Math.floor((side - box.width) / 2);
  const oy = Math.floor((side - box.height) / 2);
  for (let y = 0; y < box.height; y++) {
    const from = ((box.y + y) * img.width + box.x) * 4;
    out.data.set(img.data.subarray(from, from + box.width * 4), ((oy + y) * side + ox) * 4);
  }
  return out;
}

/**
 * One generated PNG → { png, framed }: the cut-out sprite at SPRITE_SIZE, and
 * whether the circular frame was used instead of a cutout.
 * `codec` = { decode(png) → {width, height, data RGBA}, encode(img) → png, resize(png, size) → png }.
 */
export function makeSprite(png, codec) {
  const img = codec.decode(codec.resize(png, WORK_SIZE));
  const original = new Uint8ClampedArray(img.data);
  /* Already transparent (a model that can draw without a background): nothing to cut. */
  const share = alreadyCutOut(img) ? null : removeBackground(img);
  let framed = false;
  if (share !== null && (share < MIN_REMOVED || share > MAX_REMOVED)) {
    img.data.set(original);
    circleFrame(img);
    framed = true;
  }
  const box = contentBox(img) ?? { x: 0, y: 0, width: img.width, height: img.height };
  return { png: codec.resize(codec.encode(cropToSquare(img, box)), SPRITE_SIZE), framed };
}
