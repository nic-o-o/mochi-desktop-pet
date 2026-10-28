import { describe, expect, it } from 'vitest';
import {
  clampPetPosition,
  formatSla,
  freshnessLabel,
  IDLE_SLEEPY_SECONDS,
  parseGoalInput,
  pendingRank,
  pendingRowFlag,
  placeFloating,
  resolvePetState,
  revisionRank,
  revisionRowFlag,
  ringFraction,
  sortTasks,
  stepGoal,
  unionBounds,
  validateGoalInput,
} from './logic.ts';
import type { PetStateInput, TaskItem } from './logic.ts';

function stateInput(overrides: Partial<PetStateInput> = {}): PetStateInput {
  return {
    panelOpen: false,
    bubbleVisible: false,
    hoveringOrDragging: false,
    idleSeconds: 0,
    ...overrides,
  };
}

function task(overrides: Partial<TaskItem> & { id: string }): TaskItem {
  return {
    title: overrides.id,
    type: 'Code review',
    priority: 'normal',
    status: 'pending_review',
    slaDueMs: 1_000_000,
    description: '',
    requester: '',
    ...overrides,
  };
}

describe('resolvePetState — Focused > Nervous > Happy > Sleepy > Chilling', () => {
  it('is chilling by default (no other active state)', () => {
    expect(resolvePetState(stateInput())).toBe('chilling');
  });

  it('is sleepy only after 10 idle seconds with nothing else active', () => {
    expect(resolvePetState(stateInput({ idleSeconds: 9 }))).toBe('chilling');
    expect(resolvePetState(stateInput({ idleSeconds: IDLE_SLEEPY_SECONDS }))).toBe('sleepy');
    expect(resolvePetState(stateInput({ idleSeconds: 3600 }))).toBe('sleepy');
  });

  it('is happy while hovering or dragging', () => {
    expect(resolvePetState(stateInput({ hoveringOrDragging: true }))).toBe('happy');
    // happy outranks sleepy even after a long idle stretch
    expect(
      resolvePetState(stateInput({ hoveringOrDragging: true, idleSeconds: 999 })),
    ).toBe('happy');
  });

  it('is nervous while a notification bubble is visible', () => {
    expect(resolvePetState(stateInput({ bubbleVisible: true }))).toBe('nervous');
    // nervous outranks happy: hovering does not override the bubble state
    expect(
      resolvePetState(stateInput({ bubbleVisible: true, hoveringOrDragging: true, idleSeconds: 999 })),
    ).toBe('nervous');
  });

  it('is focused while the panel is open and nothing overrides it', () => {
    expect(resolvePetState(stateInput({ panelOpen: true }))).toBe('focused');
    // focused outranks everything below it at once
    expect(
      resolvePetState(
        stateInput({ panelOpen: true, bubbleVisible: true, hoveringOrDragging: true, idleSeconds: 999 }),
      ),
    ).toBe('focused');
  });
});

describe('sortTasks — priority first, then nearest SLA', () => {
  it('orders urgent > high > normal > low regardless of deadline', () => {
    const tasks = [
      task({ id: 'low', priority: 'low', slaDueMs: 100 }),
      task({ id: 'urgent', priority: 'urgent', slaDueMs: 999_999 }),
      task({ id: 'normal', priority: 'normal', slaDueMs: 200 }),
      task({ id: 'high', priority: 'high', slaDueMs: 300 }),
    ];
    expect(sortTasks(tasks).map((t) => t.id)).toEqual(['urgent', 'high', 'normal', 'low']);
  });

  it('orders nearest SLA deadline first within the same priority', () => {
    const tasks = [
      task({ id: 'c', priority: 'high', slaDueMs: 3000 }),
      task({ id: 'a', priority: 'high', slaDueMs: 1000 }),
      task({ id: 'b', priority: 'high', slaDueMs: 2000 }),
    ];
    expect(sortTasks(tasks).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps an overdue low-priority task behind on-time higher-priority tasks', () => {
    const tasks = [
      task({ id: 'overdue-low', priority: 'low', slaDueMs: -50_000 }),
      task({ id: 'normal-soon', priority: 'normal', slaDueMs: 60_000 }),
    ];
    expect(sortTasks(tasks).map((t) => t.id)).toEqual(['normal-soon', 'overdue-low']);
  });

  it('breaks exact ties deterministically by id and never mutates the input', () => {
    const a = task({ id: 'a', priority: 'high', slaDueMs: 5000 });
    const b = task({ id: 'b', priority: 'high', slaDueMs: 5000 });
    const input = [b, a];
    const sorted = sortTasks(input);
    expect(sorted.map((t) => t.id)).toEqual(['a', 'b']);
    expect(input.map((t) => t.id)).toEqual(['b', 'a']);
    expect(sorted).not.toBe(input);
  });
});

describe('validateGoalInput / parseGoalInput — positive integers only', () => {
  it.each(['1', '5', '42', ' 7 ', '007'])('accepts %j', (raw) => {
    expect(validateGoalInput(raw)).toBeNull();
    expect(parseGoalInput(raw)).toBe(Number(raw.trim()));
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['0', 'zero'],
    ['-3', 'negative'],
    ['2.5', 'decimal'],
    ['abc', 'text'],
    ['5 tasks', 'trailing text'],
    ['1e3', 'exponent notation'],
    ['+4', 'explicit plus sign'],
    ['4,000', 'grouped digits'],
  ])('rejects %j (%s) with a message', (raw) => {
    expect(validateGoalInput(raw)).toEqual(expect.any(String));
    expect(parseGoalInput(raw)).toBeNull();
  });
});

describe('stepGoal — card steppers never drop below 1', () => {
  it('steps the goal up and down by one', () => {
    expect(stepGoal(4, 1)).toBe(5);
    expect(stepGoal(4, -1)).toBe(3);
  });

  it('clamps at 1 instead of reaching 0', () => {
    expect(stepGoal(1, -1)).toBe(1);
    expect(stepGoal(2, -1)).toBe(1);
  });
});

describe('ringFraction — capped at 100%, text counts unaffected', () => {
  it('caps over-goal counts at 1 while partial progress stays proportional', () => {
    expect(ringFraction(7, 5)).toBe(1);
    expect(ringFraction(2, 4)).toBe(0.5);
    expect(ringFraction(0, 5)).toBe(0);
  });

  it('returns 0 for degenerate goals instead of NaN/Infinity', () => {
    expect(ringFraction(3, 0)).toBe(0);
    expect(ringFraction(3, -2)).toBe(0);
  });
});

describe('formatSla', () => {
  it('formats remaining and overdue time compactly', () => {
    const now = 1_000_000_000;
    expect(formatSla(now + 45 * 60_000, now)).toBe('45m left');
    expect(formatSla(now + 200 * 60_000, now)).toBe('3h 20m left');
    expect(formatSla(now + 49 * 3_600_000, now)).toBe('2d 1h left');
    expect(formatSla(now - 15 * 60_000, now)).toBe('Overdue 15m');
  });
});

describe('glance flags — panel row badges', () => {
  it('marks revision rows HI PRI dark grey, LOW PRI light grey', () => {
    expect(revisionRowFlag('urgent')).toEqual({ text: 'HI PRI', tone: 'dark' });
    expect(revisionRowFlag('high')).toEqual({ text: 'HI PRI', tone: 'dark' });
    expect(revisionRowFlag('normal')).toEqual({ text: 'LOW PRI', tone: 'light' });
    expect(revisionRowFlag('low')).toEqual({ text: 'LOW PRI', tone: 'light' });
  });

  it('buckets waiting-review SLAs into Past due / 0d left / Nd left', () => {
    const now = 1_000_000_000;
    expect(pendingRowFlag(now - 1, now)).toEqual({ text: 'Past due', tone: 'danger' });
    expect(pendingRowFlag(now + 60_000, now)).toEqual({ text: '0d left', tone: 'warn' });
    expect(pendingRowFlag(now + 23 * 3_600_000, now)).toEqual({ text: '0d left', tone: 'warn' });
    expect(pendingRowFlag(now + 26 * 3_600_000, now)).toEqual({ text: '1d left', tone: 'ok' });
    expect(pendingRowFlag(now + 3 * 86_400_000, now)).toEqual({ text: '3d left', tone: 'ok' });
  });

  it('ranks HI PRI revision rows above LOW PRI rows', () => {
    expect(revisionRank('urgent')).toBeLessThan(revisionRank('low'));
    expect(revisionRank('high')).toBeLessThan(revisionRank('normal'));
    expect(revisionRank('urgent')).toBe(revisionRank('high'));
    expect(revisionRank('normal')).toBe(revisionRank('low'));
  });

  it('ranks waiting-review rows Past due first, then days ascending', () => {
    const now = 1_000_000_000;
    const overdue = pendingRank(now - 1, now);
    const d0 = pendingRank(now + 60_000, now);
    const d1 = pendingRank(now + 26 * 3_600_000, now);
    const d2 = pendingRank(now + 2 * 86_400_000, now);
    expect(overdue).toBeLessThan(d0);
    expect(d0).toBeLessThan(d1);
    expect(d1).toBeLessThan(d2);
  });
});

describe('unionBounds — shell window shrink-wraps visible UI', () => {
  const viewport = { w: 1280, h: 800 };

  it('wraps a lone pet with padding', () => {
    expect(unionBounds([{ x: 1000, y: 500, w: 168, h: 212 }], viewport, 16)).toEqual({
      x: 984,
      y: 484,
      width: 200,
      height: 244,
    });
  });

  it('spans pet plus an open panel', () => {
    expect(
      unionBounds(
        [
          { x: 1000, y: 500, w: 168, h: 212 },
          { x: 664, y: 230, w: 384, h: 518 },
        ],
        viewport,
        16,
      ),
    ).toEqual({ x: 648, y: 214, width: 536, height: 550 });
  });

  it('shrinks to the paw when hidden', () => {
    expect(unionBounds([{ x: 1200, y: 720, w: 96, h: 96 }], viewport, 16)).toEqual({
      x: 1184,
      y: 704,
      width: 96,
      height: 96,
    });
  });

  it('clamps the union inside the viewport at screen edges', () => {
    expect(unionBounds([{ x: 0, y: 0, w: 168, h: 212 }], viewport, 16)).toEqual({
      x: 0,
      y: 0,
      width: 184,
      height: 228,
    });
    expect(unionBounds([{ x: 1200, y: 750, w: 168, h: 212 }], viewport, 16)).toEqual({
      x: 1184,
      y: 734,
      width: 96,
      height: 66,
    });
  });

  it('never returns an empty rect', () => {
    expect(unionBounds([], viewport, 16)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe('geometry — pet stays visible, floats flip at edges', () => {
  it('clamps the pet inside the viewport', () => {
    expect(clampPetPosition({ x: -50, y: -20 }, { w: 800, h: 600 }, 168)).toEqual({ x: 0, y: 0 });
    expect(clampPetPosition({ x: 700, y: 500 }, { w: 800, h: 600 }, 168)).toEqual({ x: 632, y: 432 });
    expect(clampPetPosition({ x: 100, y: 100 }, { w: 800, h: 600 }, 168)).toEqual({ x: 100, y: 100 });
  });

  it('prefers the right side but flips left near the right edge', () => {
    const viewport = { w: 1000, h: 700 };
    const left = placeFloating({ x: 60, y: 100, w: 168, h: 168 }, { w: 320, h: 470 }, viewport);
    expect(left.x).toBe(60 + 168 + 12);
    const right = placeFloating({ x: 800, y: 100, w: 168, h: 168 }, { w: 320, h: 470 }, viewport);
    expect(right.x).toBeLessThan(800);
    expect(right.x + 320).toBeLessThanOrEqual(1000 - 8);
  });

  it('shifts up near the bottom edge and never leaves the screen', () => {
    const viewport = { w: 1000, h: 700 };
    const pos = placeFloating({ x: 100, y: 600, w: 168, h: 168 }, { w: 320, h: 470 }, viewport);
    expect(pos.y + 470).toBeLessThanOrEqual(700 - 8);
    expect(pos.y).toBeGreaterThanOrEqual(8);
    expect(pos.x).toBeGreaterThanOrEqual(8);
  });

  it('sits above the obstacle when the preferred spot is blocked', () => {
    const viewport = { w: 1000, h: 700 };
    const pet = { x: 60, y: 200, w: 168, h: 168 };
    const bubble = { w: 264, h: 132 };
    /* Narrow obstacle covering only the preferred right-of-pet band. */
    const obstacle = { x: 60 + 168 + 8, y: 200, w: 64, h: 132 };
    const pos = placeFloating(pet, bubble, viewport, 8, [obstacle], 4);
    expect(pos.x).toBe(obstacle.x);
    expect(pos.y).toBe(obstacle.y - 4 - bubble.h);
  });

  it('hugs above the pet when above the obstacle is blocked', () => {
    const viewport = { w: 1000, h: 700 };
    const pet = { x: 60, y: 200, w: 168, h: 168 };
    const bubble = { w: 264, h: 132 };
    /* Tall block right of the bubble's above-obstacle slot. */
    const obstacle = { x: 330, y: 0, w: 200, h: 400 };
    const pos = placeFloating(pet, bubble, viewport, 8, [obstacle], 4);
    expect(pos.x).toBe(pet.x);
    expect(pos.y).toBe(pet.y - 4 - bubble.h);
  });

  it('hugs below the pet when above it is blocked', () => {
    const viewport = { w: 1000, h: 700 };
    const pet = { x: 60, y: 200, w: 168, h: 168 };
    const bubble = { w: 264, h: 132 };
    const prefBlock = { x: 60 + 168 + 8, y: 200, w: 64, h: 132 };
    const cap = { x: 0, y: 0, w: 400, h: 100 };
    const pos = placeFloating(pet, bubble, viewport, 8, [prefBlock, cap], 4);
    expect(pos.x).toBe(pet.x);
    expect(pos.y).toBe(pet.y + pet.h + 4);
  });

  it('goes above the obstacle when both pet hugs are blocked', () => {
    const viewport = { w: 1000, h: 700 };
    const pet = { x: 60, y: 200, w: 168, h: 168 };
    const bubble = { w: 264, h: 132 };
    const prefBlock = { x: 60 + 168 + 8, y: 200, w: 64, h: 132 };
    const cap = { x: 0, y: 0, w: 200, h: 100 };
    const belowBlock = { x: 0, y: 350, w: 400, h: 100 };
    const pos = placeFloating(pet, bubble, viewport, 8, [prefBlock, cap, belowBlock], 4);
    expect(pos.x).toBe(prefBlock.x);
    expect(pos.y).toBe(prefBlock.y - 4 - bubble.h);
  });

  it('keeps the preferred spot when nothing is avoided', () => {
    const viewport = { w: 1000, h: 700 };
    const pet = { x: 60, y: 100, w: 168, h: 168 };
    const plain = placeFloating(pet, { w: 264, h: 132 }, viewport, 8);
    const far = placeFloating(pet, { w: 264, h: 132 }, viewport, 8, [{ x: 900, y: 600, w: 10, h: 10 }]);
    expect(far).toEqual(plain);
  });
});

describe('freshnessLabel', () => {
  const NOW = 1_800_000_000_000;
  const MIN = 60_000;
  it('says how old the data is', () => {
    expect(freshnessLabel(NOW - 20_000, NOW, 'idle')).toBe('Updated just now');
    expect(freshnessLabel(NOW - 2 * MIN, NOW, 'idle')).toBe('Updated 2 min ago');
    expect(freshnessLabel(NOW - 3 * 60 * MIN, NOW, 'idle')).toBe('Updated 3h ago');
    expect(freshnessLabel(NOW - 2 * 24 * 60 * MIN, NOW, 'idle')).toBe('Updated 2d ago');
    expect(freshnessLabel(null, NOW, 'idle')).toBe('Not updated yet');
  });

  it('explains stale data when offline or failing, and shows refreshing', () => {
    expect(freshnessLabel(NOW - 2 * 60 * MIN, NOW, 'offline')).toBe('Offline · showing data from 2h ago');
    expect(freshnessLabel(NOW - 5 * MIN, NOW, 'error')).toBe("Couldn't refresh · showing data from 5 min ago");
    expect(freshnessLabel(null, NOW, 'offline')).toBe('Offline');
    expect(freshnessLabel(NOW, NOW, 'refreshing')).toBe('Refreshing…');
  });
});
