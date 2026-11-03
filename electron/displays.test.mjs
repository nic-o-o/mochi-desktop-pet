import { describe, expect, it } from 'vitest';
import { allDisplayBounds } from './displays.mjs';

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
