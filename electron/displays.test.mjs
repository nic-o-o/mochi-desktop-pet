import { describe, expect, it } from 'vitest';
import { PET_GRAB, allDisplayBounds, clampPetBounds } from './displays.mjs';

describe('allDisplayBounds', () => {
  it('spans every display, including one left of and above the primary', () => {
    const out = allDisplayBounds([
      { bounds: { x: 0, y: 0, width: 1512, height: 982 } },
      { bounds: { x: -2560, y: -458, width: 2560, height: 1440 } },
    ]);
    expect(out).toMatchObject({ x: -2560, y: -458, width: 4072, height: 1440 });
    expect(out.displays).toHaveLength(2);
  });

  it('is just the display when there is one', () => {
    expect(allDisplayBounds([{ bounds: { x: 0, y: 0, width: 1512, height: 982 } }])).toEqual({
      x: 0,
      y: 0,
      width: 1512,
      height: 982,
      displays: [{ x: 0, y: 0, width: 1512, height: 982 }],
    });
  });
});

describe('clampPetBounds', () => {
  const areas = [
    { x: 0, y: 0, width: 1728, height: 1117 },
    { x: -85, y: 1117, width: 1920, height: 1080 },
  ];
  const fallback = { x: 1504, y: 791, width: 200, height: 230 };

  it('leaves an on-screen rect alone', () => {
    const rect = { x: 583, y: 278, width: 176, height: 244 };
    expect(clampPetBounds(rect, areas, fallback, true)).toEqual(rect);
    expect(clampPetBounds(rect, areas, fallback, false)).toEqual(rect);
  });

  it('pulls a fully off-screen launch position back on-screen', () => {
    expect(clampPetBounds({ x: 1168, y: -524, width: 176, height: 244 }, areas, fallback, true)).toEqual({
      x: 1168,
      y: 0,
      width: 176,
      height: 244,
    });
  });

  it('keeps a grab strip visible on drags instead of losing the pet', () => {
    expect(clampPetBounds({ x: 1168, y: -524, width: 176, height: 244 }, areas, fallback, false)).toEqual({
      x: 1168,
      y: 0 - 244 + PET_GRAB,
      width: 176,
      height: 244,
    });
  });

  it('falls back when the center lands in a gap between monitors', () => {
    // Void right of the laptop display, above the external one.
    expect(clampPetBounds({ x: 1750, y: 500, width: 176, height: 244 }, areas, fallback, true)).toEqual({
      ...fallback,
      width: 176,
      height: 244,
    });
  });
});
