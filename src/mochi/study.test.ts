import { describe, expect, it } from 'vitest';
import { advanceStudy, parseStudy, studyReport, turnaroundStats } from './study.ts';
import type { CodimangoRow, CodimangoSnapshot } from './codimango.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const INSTALL = Date.parse('2026-10-28T12:00:00.000Z');
const iso = (t: number) => new Date(t).toISOString();

function review(id: string, pooledMs: number, hoursToVerdict: number, status = 'accepted'): CodimangoRow {
  return {
    id,
    name: `task-${id}`,
    status,
    reviewStatus: status,
    track: 'swe-bench-pro',
    reviewSlaDeadline: null,
    enteredPoolAt: iso(pooledMs),
    claimedAt: null,
    updatedAt: null,
    reviewedAt: status === 'being_reviewed' ? null : iso(pooledMs + hoursToVerdict * HOUR),
    escalationLevel: 0,
    validationStatus: null,
    validationFailedSince: null,
    staleArchiveWarnedAt: null,
    validationDetails: null,
    oraclePassCount: null,
    oracleTotalCount: null,
  };
}

const snap = (reviewing: CodimangoRow[]): CodimangoSnapshot => ({ fetchedAtMs: INSTALL, reviewing, mine: [] });

describe('turnaroundStats', () => {
  it('measures pool-to-verdict hours for delivered reviews in the window', () => {
    const rows = [
      review('a', INSTALL - 10 * DAY, 10),
      review('b', INSTALL - 5 * DAY, 20),
      review('c', INSTALL - 3 * DAY, 30),
      review('d', INSTALL - 2 * DAY, 0, 'being_reviewed'), // still open: ignored
      review('e', INSTALL - 60 * DAY, 5), // outside the window
    ];
    expect(turnaroundStats(rows, INSTALL - 30 * DAY, INSTALL)).toEqual({ count: 3, medianHours: 20, p90Hours: 30 });
    expect(turnaroundStats([], 0, INSTALL)).toEqual({ count: 0, medianHours: null, p90Hours: null });
  });
});

describe('advanceStudy', () => {
  it('starts on first launch before any data, then fills "before" once', () => {
    const started = advanceStudy(null, null, INSTALL);
    expect(started).toEqual({ installedAtMs: INSTALL, before: null });
    const withBefore = advanceStudy(started, snap([review('a', INSTALL - 2 * DAY, 12)]), INSTALL + HOUR);
    expect(withBefore.installedAtMs).toBe(INSTALL);
    expect(withBefore.before).toEqual({ count: 1, medianHours: 12, p90Hours: 12 });
    // Later snapshots never rewrite the baseline.
    expect(advanceStudy(withBefore, snap([]), INSTALL + 5 * DAY)).toBe(withBefore);
  });

  it('round-trips through storage and rejects junk', () => {
    const s = { installedAtMs: INSTALL, before: { count: 2, medianHours: 8, p90Hours: 9 } };
    expect(parseStudy(JSON.stringify(s))).toEqual(s);
    expect(parseStudy('{"before":null}')).toBeNull();
    expect(parseStudy('nope')).toBeNull();
  });
});

describe('studyReport', () => {
  it('summarizes before and since install, plus a JSON line', () => {
    const study = { installedAtMs: INSTALL, before: { count: 24, medianHours: 16.4, p90Hours: 74.7 } };
    const rows = [
      review('x', INSTALL + DAY, 6),
      review('y', INSTALL + 2 * DAY, 10),
      review('old', INSTALL - 3 * DAY, 50), // verdict before install, so not counted
    ];
    const text = studyReport(study, snap(rows), INSTALL + 12 * DAY);
    const lines = text.split('\n');
    expect(lines[1]).toBe('Installed: 2026-10-28 (12d ago)');
    expect(lines[2]).toBe('Before Mochi (30 days before install): 24 reviews · median 16.4 h · p90 74.7 h');
    expect(lines[3]).toBe('Since install: 2 reviews · median 6 h · p90 10 h');
    const json = JSON.parse(lines[4]);
    expect(json.after).toEqual({ count: 2, medianHours: 6, p90Hours: 10 });
    expect(json.before.count).toBe(24);
  });
});
