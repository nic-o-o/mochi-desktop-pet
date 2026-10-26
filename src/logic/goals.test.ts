import { describe, expect, it } from 'vitest';
import { validateGoalInput } from './goals';

describe('validateGoalInput', () => {
  it('accepts positive integers', () => {
    expect(validateGoalInput('1')).toEqual({ ok: true, value: 1 });
    expect(validateGoalInput('10')).toEqual({ ok: true, value: 10 });
    expect(validateGoalInput('999')).toEqual({ ok: true, value: 999 });
  });

  it('trims surrounding whitespace', () => {
    expect(validateGoalInput('  7  ')).toEqual({ ok: true, value: 7 });
  });

  it('rejects empty input with a message', () => {
    const result = validateGoalInput('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/enter a number/i);
  });

  it('rejects zero', () => {
    const result = validateGoalInput('0');
    expect(result.ok).toBe(false);
  });

  it('rejects negative numbers', () => {
    expect(validateGoalInput('-5').ok).toBe(false);
  });

  it('rejects decimals', () => {
    expect(validateGoalInput('2.5').ok).toBe(false);
    expect(validateGoalInput('10.0').ok).toBe(false);
  });

  it('rejects letters and mixed input', () => {
    expect(validateGoalInput('ten').ok).toBe(false);
    expect(validateGoalInput('12abc').ok).toBe(false);
    expect(validateGoalInput('+5').ok).toBe(false);
  });

  it('rejects values above the maximum', () => {
    const result = validateGoalInput('1000');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/999/);
  });

  it('always explains invalid input', () => {
    for (const bad of ['', '0', '-3', '1.5', 'x']) {
      const result = validateGoalInput(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
