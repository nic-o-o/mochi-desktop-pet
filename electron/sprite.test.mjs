import { describe, expect, it } from 'vitest';
import { SPRITE_SIZE, contentBox, cropToSquare, makeSprite, removeBackground } from './sprite.mjs';

/** w×h image filled with `bg`, plus a filled rectangle of `fg`. */
function image(w, h, bg, rect, fg) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      data.set([...(inside ? fg : bg), 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}
const alpha = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];
const fakeCodec = (img) => ({ decode: () => img, encode: (i) => i, resize: (i, size) => ({ ...i, resizedTo: size }) });

describe('removeBackground', () => {
  it('clears a plain background and keeps the character, with a soft edge', () => {
    const img = image(40, 40, [255, 255, 255], { x: 10, y: 10, w: 20, h: 20 }, [240, 150, 60]);
    const share = removeBackground(img);
    expect(share).toBeCloseTo(1 - 400 / 1600, 2);
    expect(alpha(img, 0, 0)).toBe(0);
    expect(alpha(img, 20, 20)).toBe(255);
    expect(alpha(img, 10, 20)).toBe(128);
  });

  it('keeps background-coloured pixels the fill cannot reach (inside the outline)', () => {
    const img = image(30, 30, [255, 255, 255], { x: 5, y: 5, w: 20, h: 20 }, [40, 40, 40]);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) img.data.set([255, 255, 255, 255], (y * 30 + x) * 4);
    removeBackground(img);
    expect(alpha(img, 15, 15)).toBe(255);
  });

  it('tolerates near-white noise in the background', () => {
    const img = image(20, 20, [250, 248, 252], { x: 5, y: 5, w: 10, h: 10 }, [0, 0, 200]);
    img.data.set([232, 236, 228, 255], (2 * 20 + 2) * 4);
    removeBackground(img);
    expect(alpha(img, 2, 2)).toBe(0);
  });
});

describe('contentBox / cropToSquare', () => {
  it('finds the visible pixels with padding and centres them on a square', () => {
    const img = image(50, 50, [255, 255, 255], { x: 20, y: 10, w: 10, h: 30 }, [0, 0, 0]);
    removeBackground(img);
    const box = contentBox(img, 2);
    expect(box).toEqual({ x: 18, y: 8, width: 14, height: 34 });
    const sq = cropToSquare(img, box);
    expect([sq.width, sq.height]).toEqual([34, 34]);
    expect(sq.data[(17 * 34 + 17) * 4 + 3]).toBe(255);
    expect(sq.data[(17 * 34 + 1) * 4 + 3]).toBe(0);
  });
});

describe('makeSprite', () => {
  it('cuts out a clean image and resizes it to the sprite size', () => {
    const img = image(64, 64, [255, 255, 255], { x: 16, y: 16, w: 32, h: 32 }, [200, 80, 80]);
    const out = makeSprite(Buffer.from('png'), fakeCodec(img));
    expect(out.framed).toBe(false);
    expect(out.png.resizedTo).toBe(SPRITE_SIZE);
  });

  it('falls back to a circular frame when the background is busy', () => {
    const img = image(32, 32, [0, 0, 0]);
    for (let p = 0; p < 32 * 32; p++) img.data.set([(p * 37) % 256, (p * 91) % 256, (p * 53) % 256, 255], p * 4);
    const out = makeSprite(Buffer.from('png'), fakeCodec(img));
    expect(out.framed).toBe(true);
    expect(out.png.data[3]).toBe(0);
    expect(out.png.data[(16 * out.png.width + 16) * 4 + 3]).toBe(255);
  });

  it('falls back to the frame for a white pet on white (nearly everything removed)', () => {
    const img = image(40, 40, [255, 255, 255], { x: 19, y: 19, w: 2, h: 2 }, [0, 0, 0]);
    expect(makeSprite(Buffer.from('png'), fakeCodec(img)).framed).toBe(true);
  });
});
