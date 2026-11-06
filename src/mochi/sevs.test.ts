import { describe, expect, it } from 'vitest';
import type { Sev } from './sevs.ts';
import { sevBubbles, sevHeadline } from './sevs.ts';

describe('sevHeadline', () => {
  it('keeps the clause before a parenthesis, semicolon or dash', () => {
    expect(sevHeadline('Oracle runs stuck or never return results ("not settled"); error rate 2–9x')).toBe('Oracle runs stuck or never return results');
    expect(sevHeadline('Harbor ingest stopped - backlog growing')).toBe('Harbor ingest stopped');
    expect(sevHeadline('TBR mac_swe lane increased job timeouts')).toBe('TBR mac_swe lane increased job timeouts');
  });

  it('cuts a long clause on a word boundary', () => {
    const h = sevHeadline('Validation results recorded forty to sixty minutes late for every legacy and VE job');
    expect(h.length).toBeLessThanOrEqual(48);
    expect(h).toBe('Validation results recorded forty to sixty…');
  });
});

const sev = (over: Partial<Sev> = {}): Sev => ({ id: 'S1', level: 3, open: true, title: 't', url: 'u', createdAtMs: 0, ...over });

describe('sevBubbles', () => {
  it('bubbles a fresh open SEV once, then its mitigation once', () => {
    const first = sevBubbles({ open: [], mitigated: [] }, [sev()], 1000);
    expect(first.bubbles.map((b) => b.kind)).toEqual(['sev_open']);
    expect(sevBubbles(first.memory, [sev()], 2000).bubbles).toEqual([]);
    const fixed = sevBubbles(first.memory, [sev({ open: false })], 3000);
    expect(fixed.bubbles.map((b) => b.kind)).toEqual(['sev_mitigated']);
    expect(sevBubbles(fixed.memory, [sev({ open: false })], 4000).bubbles).toEqual([]);
  });
});
