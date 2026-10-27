import { describe, expect, it } from 'vitest';
import {
  failedCheckSummary,
  parseCachedSnapshot,
  reviewPriority,
  revisionPriority,
  toTaskItems,
  trackLabel,
  weekStartMs,
  weeklyCompleted,
} from './codimango.ts';
import type { CodimangoRow, CodimangoSnapshot } from './codimango.ts';
import { revisionRowFlag, sortTasks } from './logic.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function row(over: Partial<CodimangoRow>): CodimangoRow {
  return {
    id: '1',
    name: 'task',
    status: 'draft',
    reviewStatus: null,
    track: 'swe-bench-pro',
    reviewSlaDeadline: null,
    enteredPoolAt: null,
    claimedAt: null,
    reviewedAt: null,
    escalationLevel: 0,
    validationStatus: null,
    validationFailedSince: null,
    staleArchiveWarnedAt: null,
    validationDetails: null,
    oraclePassCount: null,
    oracleTotalCount: null,
    ...over,
  };
}

function pendingReview(id: string, dueInMs: number, over: Partial<CodimangoRow> = {}): CodimangoRow {
  return row({
    id,
    name: `review-${id}`,
    status: 'being_reviewed',
    reviewStatus: 'being_reviewed',
    reviewSlaDeadline: iso(NOW + dueInMs),
    enteredPoolAt: iso(NOW - DAY),
    ...over,
  });
}

function revision(id: string, over: Partial<CodimangoRow> = {}): CodimangoRow {
  return row({
    id,
    name: `revision-${id}`,
    status: 'needs_revision',
    reviewStatus: 'needs_revision',
    reviewedAt: iso(NOW - 3 * DAY),
    validationStatus: 'passing',
    ...over,
  });
}

function snap(reviewing: CodimangoRow[], mine: CodimangoRow[]): CodimangoSnapshot {
  return { fetchedAtMs: NOW, reviewing, mine };
}

describe('reviewPriority (time left to the review SLA)', () => {
  it('buckets past due / <24h / 24–48h / >48h', () => {
    expect(reviewPriority(NOW - 1, 0, NOW)).toBe('urgent');
    expect(reviewPriority(NOW + 23 * HOUR, 0, NOW)).toBe('high');
    expect(reviewPriority(NOW + 30 * HOUR, 0, NOW)).toBe('normal');
    expect(reviewPriority(NOW + 3 * DAY, 0, NOW)).toBe('low');
  });

  it('moves an escalated review up one level, capped at urgent', () => {
    expect(reviewPriority(NOW + 3 * DAY, 1, NOW)).toBe('normal');
    expect(reviewPriority(NOW + 2 * HOUR, 2, NOW)).toBe('urgent');
    expect(reviewPriority(NOW - 1, 1, NOW)).toBe('urgent');
  });
});

describe('revisionPriority (distance from stale auto-archive)', () => {
  it('archive warning beats everything', () => {
    expect(revisionPriority(revision('1', { staleArchiveWarnedAt: iso(NOW - DAY) }), NOW)).toBe('urgent');
  });

  it('failing 10+ days is urgent, failing is high', () => {
    expect(
      revisionPriority(revision('1', { validationStatus: 'failed', validationFailedSince: iso(NOW - 11 * DAY) }), NOW),
    ).toBe('urgent');
    expect(
      revisionPriority(revision('1', { validationStatus: 'failed', validationFailedSince: iso(NOW - 2 * DAY) }), NOW),
    ).toBe('high');
    expect(revisionPriority(revision('1', { validationStatus: 'failed' }), NOW)).toBe('high');
  });

  it('pending or passing is normal (LOW PRI badge)', () => {
    expect(revisionPriority(revision('1', { validationStatus: 'pending' }), NOW)).toBe('normal');
    const p = revisionPriority(revision('1', { validationStatus: 'passing' }), NOW);
    expect(p).toBe('normal');
    expect(revisionRowFlag(p).text).toBe('LOW PRI');
  });
});

describe('failedCheckSummary', () => {
  it('names the failed check, with oracle counts and short labels', () => {
    expect(
      failedCheckSummary(
        revision('1', {
          oraclePassCount: 1,
          oracleTotalCount: 3,
          validationDetails: [
            { label: 'Structural checks', status: 'passed' },
            { label: 'Oracle validation', status: 'failed' },
          ],
        }),
      ),
    ).toBe('Oracle 1/3');
    expect(
      failedCheckSummary(
        revision('1', { validationDetails: [{ label: 'Metacode or Opus pass/fail balance', status: 'failed' }] }),
      ),
    ).toBe('Solvability & difficulty');
  });

  it('counts extra failures and passes unknown labels through', () => {
    expect(
      failedCheckSummary(
        revision('1', {
          validationDetails: [
            { label: 'New checker', status: 'failed' },
            { label: 'AI assessment', status: 'failed' },
            { label: 'Contamination check', status: 'failed' },
          ],
        }),
      ),
    ).toBe('New checker +2');
  });

  it('is undefined when nothing failed', () => {
    expect(failedCheckSummary(revision('1', { validationDetails: [] }))).toBeUndefined();
    expect(failedCheckSummary(revision('1'))).toBeUndefined();
  });
});

describe('toTaskItems', () => {
  it('keeps only reviews still awaiting your verdict', () => {
    const delivered = row({ id: '9', status: 'accepted', reviewStatus: 'accepted', reviewedAt: iso(NOW - DAY) });
    const items = toTaskItems(snap([pendingReview('1', 5 * HOUR), delivered], []), NOW);
    expect(items.map((t) => t.id)).toEqual(['1']);
    expect(items[0]).toMatchObject({
      title: 'review-1',
      type: 'SWE-Bench Pro',
      status: 'pending_review',
      priority: 'high',
      slaDueMs: NOW + 5 * HOUR,
      subtitle: 'Assigned to you',
      url: 'https://codimango.internalmeta.com/reviews/1',
    });
  });

  it('skips a being_reviewed row without a deadline instead of inventing one', () => {
    const items = toTaskItems(snap([pendingReview('1', 0, { reviewSlaDeadline: null })], []), NOW);
    expect(items).toEqual([]);
  });

  it('maps needs_revision tasks with archive date, check summary and subtitle', () => {
    const items = toTaskItems(
      snap(
        [],
        [
          revision('2', { staleArchiveWarnedAt: iso(NOW - 4 * DAY), validationStatus: 'failed' }),
          revision('3', {
            validationStatus: 'failed',
            validationDetails: [{ label: 'Oracle validation', status: 'failed' }],
            oraclePassCount: 0,
            oracleTotalCount: 3,
          }),
          revision('4', { validationStatus: 'pending' }),
          row({ id: '5', status: 'draft' }),
        ],
      ),
      NOW,
    );
    expect(items.map((t) => t.id)).toEqual(['2', '3', '4']);
    expect(items[0]).toMatchObject({
      priority: 'urgent',
      slaDueMs: NOW + 10 * DAY,
      subtitle: 'Archive warning · archives in 10d',
      url: 'https://codimango.internalmeta.com/submissions/2',
    });
    expect(items[1]).toMatchObject({ priority: 'high', checkSummary: 'Oracle 0/3', subtitle: undefined });
    expect(items[2]).toMatchObject({ priority: 'normal', subtitle: 'Validation running · sent back 3d ago' });
  });

  it('sorts pending/passing revisions oldest send-back first under sortTasks', () => {
    const items = toTaskItems(
      snap(
        [],
        [
          revision('new', { reviewedAt: iso(NOW - DAY) }),
          revision('old', { reviewedAt: iso(NOW - 20 * DAY) }),
        ],
      ),
      NOW,
    );
    expect(sortTasks(items).map((t) => t.id)).toEqual(['old', 'new']);
  });

  it('lists a task once even if it shows up in both feeds', () => {
    const items = toTaskItems(snap([pendingReview('7', DAY)], [revision('7')]), NOW);
    expect(items.map((t) => t.status)).toEqual(['pending_review']);
  });
});

describe('weeklyCompleted', () => {
  const start = weekStartMs(NOW);

  it('starts the week on Monday 00:00 local time', () => {
    const d = new Date(start);
    expect(d.getDay()).toBe(1);
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([0, 0, 0]);
    expect(start).toBeLessThanOrEqual(NOW);
    expect(NOW - start).toBeLessThan(7 * DAY);
  });

  it('counts reviews delivered and own tasks accepted since the week start', () => {
    const counts = weeklyCompleted(
      snap(
        [
          row({ id: 'a', reviewStatus: 'accepted', reviewedAt: iso(start + HOUR) }),
          row({ id: 'b', reviewStatus: 'needs_revision', reviewedAt: iso(start + 2 * HOUR) }),
          row({ id: 'c', reviewStatus: 'accepted', reviewedAt: iso(start - HOUR) }),
          pendingReview('d', DAY),
        ],
        [
          row({ id: 'e', status: 'accepted', reviewedAt: iso(start + HOUR) }),
          row({ id: 'f', status: 'used_in_training', reviewedAt: iso(start + HOUR) }),
          row({ id: 'g', status: 'needs_revision', reviewedAt: iso(start + HOUR) }),
          row({ id: 'h', status: 'accepted', reviewedAt: iso(start - DAY) }),
        ],
      ),
      NOW,
    );
    expect(counts).toEqual({ reviewsCompleted: 2, submissionsCompleted: 2 });
  });
});

describe('trackLabel', () => {
  it('uses known names and title-cases the rest', () => {
    expect(trackLabel('tbench')).toBe('T-Bench');
    expect(trackLabel('cyber-bench')).toBe('Cyber Bench');
    expect(trackLabel(null)).toBe('Task');
  });
});

describe('parseCachedSnapshot', () => {
  it('round-trips a snapshot and rejects junk', () => {
    const s = snap([pendingReview('1', DAY)], []);
    expect(parseCachedSnapshot(JSON.stringify(s))).toEqual(s);
    expect(parseCachedSnapshot(null)).toBeNull();
    expect(parseCachedSnapshot('{not json')).toBeNull();
    expect(parseCachedSnapshot(JSON.stringify({ reviewing: [] }))).toBeNull();
  });
});
