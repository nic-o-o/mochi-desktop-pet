import { describe, expect, it } from 'vitest';
import { NOTICE_ICONS, diffNotifications, noticeAge, seedNotifications } from './notifications.ts';
import type { CodimangoRow, CodimangoSnapshot } from './codimango.ts';

const NOW = 2_000_000_000;
const iso = (t: number) => new Date(t).toISOString();

function row(overrides: Partial<CodimangoRow> & { id: string; name: string }): CodimangoRow {
  return {
    status: 'being_reviewed',
    reviewStatus: 'being_reviewed',
    track: 'swe-bench-pro',
    reviewSlaDeadline: null,
    enteredPoolAt: null,
    claimedAt: null,
    reviewedAt: null,
    escalationLevel: null,
    validationStatus: null,
    validationFailedSince: null,
    staleArchiveWarnedAt: null,
    validationDetails: null,
    oraclePassCount: null,
    oracleTotalCount: null,
    ...overrides,
  };
}

function snap(reviewing: CodimangoRow[], mine: CodimangoRow[]): CodimangoSnapshot {
  return { fetchedAtMs: NOW, reviewing, mine };
}

describe('diffNotifications — arrivals from snapshot diffs', () => {
  it('stays silent without a previous snapshot (the hook seeds history instead)', () => {
    const next = snap(
      [row({ id: 'r1', name: 'a', reviewStatus: 'accepted' })],
      [row({ id: 'm1', name: 'b', validationStatus: 'failed' })],
    );
    expect(diffNotifications(null, next, NOW)).toEqual([]);
  });

  it('stays silent when nothing changed', () => {
    const s = snap(
      [row({ id: 'r1', name: 'a' })],
      [row({ id: 'm1', name: 'b', validationStatus: 'passing' })],
    );
    expect(diffNotifications(s, s, NOW)).toEqual([]);
  });

  it('fires reviewer-voice verdicts with a task link', () => {
    const prev = snap([row({ id: 'r1', name: 'ember-one' })], []);
    const next = snap([row({ id: 'r1', name: 'ember-one', reviewStatus: 'accepted' })], []);
    const [n] = diffNotifications(prev, next, NOW);
    expect(n.kind).toBe('accepted');
    expect(n.title).toBe('Task Accepted');
    expect(n.taskName).toBe('ember-one');
    expect(n.detail).toBe('A task assigned to you was accepted.');
    expect(n.url).toBe('https://codimango.internalmeta.com/reviews/r1');
    // Usually your own verdict: kept in history, never pops the bubble.
    expect(n.quiet).toBe(true);
  });

  it('fires owner-voice verdicts for my tasks', () => {
    const prev = snap([], [row({ id: 'm1', name: 'ember-mine', reviewStatus: 'being_reviewed' })]);
    const next = snap([], [row({ id: 'm1', name: 'ember-mine', reviewStatus: 'needs_revision' })]);
    const [n] = diffNotifications(prev, next, NOW);
    expect(n.kind).toBe('needs_revision');
    expect(n.title).toBe('Changes Requested');
    expect(n.detail).toBe('Your task needs further changes before it can be accepted.');
    expect(n.quiet).toBeUndefined();
  });

  it('never fires on draft or in-review statuses', () => {
    const prev = snap(
      [row({ id: 'r1', name: 'a', reviewStatus: 'being_reviewed' })],
      [row({ id: 'm1', name: 'b', reviewStatus: 'being_reviewed' })],
    );
    const next = snap(
      [row({ id: 'r1', name: 'a', reviewStatus: 'draft' })],
      [row({ id: 'm1', name: 'b', reviewStatus: 'draft' })],
    );
    expect(diffNotifications(prev, next, NOW)).toEqual([]);
  });

  it('dedupes the same verdict seen in both feeds, owner voice wins', () => {
    const prev = snap(
      [row({ id: 'x', name: 'ember-x', reviewStatus: 'being_reviewed' })],
      [row({ id: 'x', name: 'ember-x', reviewStatus: 'being_reviewed' })],
    );
    const next = snap(
      [row({ id: 'x', name: 'ember-x', reviewStatus: 'accepted' })],
      [row({ id: 'x', name: 'ember-x', reviewStatus: 'accepted' })],
    );
    const found = diffNotifications(prev, next, NOW);
    expect(found).toHaveLength(1);
    expect(found[0].detail).toBe('Your task was accepted into the benchmark.');
  });

  it('fires on validation passing and failing, naming failed checks', () => {
    const prev = snap(
      [],
      [
        row({ id: 'm1', name: 'ember-a', validationStatus: 'pending' }),
        row({ id: 'm2', name: 'ember-b', validationStatus: 'passing' }),
      ],
    );
    const next = snap(
      [],
      [
        row({ id: 'm1', name: 'ember-a', validationStatus: 'passing' }),
        row({
          id: 'm2',
          name: 'ember-b',
          validationStatus: 'failed',
          validationDetails: [{ label: 'Oracle validation', status: 'failed' }],
          oraclePassCount: 1,
          oracleTotalCount: 3,
        }),
      ],
    );
    const [pass, fail] = diffNotifications(prev, next, NOW);
    expect(pass.kind).toBe('validation_passed');
    expect(pass.title).toBe('Validation passed');
    expect(fail.kind).toBe('validation_failed');
    expect(fail.taskName).toBe('ember-b');
    expect(fail.detail).toContain('Oracle 1/3');
  });

  it('fires assigned and review-started when a reviewer claims a task', () => {
    const prev = snap([], []);
    const next = snap(
      [row({ id: 'r1', name: 'ember-rev', enteredPoolAt: iso(NOW - 900), claimedAt: iso(NOW - 500) })],
      [row({ id: 'm1', name: 'ember-mine', enteredPoolAt: iso(NOW - 900), claimedAt: iso(NOW - 500) })],
    );
    const [started, assigned] = diffNotifications(prev, next, NOW);
    expect(started.kind).toBe('review_started');
    expect(started.title).toBe('Review Started');
    expect(started.detail).toBe('A reviewer picked up your task.');
    expect(started.url).toBe('https://codimango.internalmeta.com/submissions/m1');
    expect(assigned.kind).toBe('review_assigned');
    expect(assigned.title).toBe('Review Assigned');
  });

  it('ignores old events on rows that are new to the snapshot (e.g. paged in past 100 rows)', () => {
    const DAY = 86_400_000;
    const prev = snap([], []);
    const next = snap(
      [
        row({ id: 'r1', name: 'old-verdict', reviewStatus: 'accepted', reviewedAt: iso(NOW - 3 * DAY) }),
        row({ id: 'r2', name: 'old-claim', claimedAt: iso(NOW - 2 * DAY) }),
      ],
      [
        row({ id: 'm1', name: 'old-mine', reviewStatus: 'needs_revision', reviewedAt: iso(NOW - 5 * DAY) }),
        row({ id: 'm2', name: 'old-validation', reviewStatus: 'draft', validationStatus: 'failed' }),
      ],
    );
    expect(diffNotifications(prev, next, NOW)).toEqual([]);
  });

  it('still notifies a new row whose event happened since the last fetch', () => {
    const prev = snap([], []);
    const next = snap(
      [],
      [row({ id: 'm1', name: 'fresh', reviewStatus: 'accepted', reviewedAt: iso(NOW + 60_000) })],
    );
    expect(diffNotifications(prev, next, NOW).map((n) => n.kind)).toEqual(['accepted']);
  });
});

describe('seedNotifications — first snapshot becomes browsable history', () => {
  it('seeds verdicts and validations newest first, skipping undecided rows', () => {
    const s = snap(
      [
        row({ id: 'r1', name: 'ember-one', reviewStatus: 'accepted', reviewedAt: iso(NOW - 1000) }),
        row({ id: 'r2', name: 'ember-two' }),
      ],
      [
        row({
          id: 'm1',
          name: 'ember-m',
          validationStatus: 'failed',
          validationFailedSince: iso(NOW - 2000),
          validationDetails: [{ label: 'Oracle validation', status: 'failed' }],
          oraclePassCount: 1,
          oracleTotalCount: 3,
        }),
      ],
    );
    const seeded = seedNotifications(s, NOW);
    expect(seeded.map((n) => n.taskId)).toEqual(['m1', 'r2', 'r1', 'm1']);
    expect(seeded.map((n) => n.kind)).toEqual([
      'review_started',
      'review_assigned',
      'accepted',
      'validation_failed',
    ]);
    expect(seeded[2].title).toBe('Task Accepted');
    expect(seeded[2].raisedAtMs).toBe(NOW - 1000);
    expect(seeded[3].title).toBe('Validation failed');
  });

  it('seeds standing review rows as assigned/review-started', () => {
    const s = snap(
      [row({ id: 'r1', name: 'ember-rev', enteredPoolAt: iso(NOW - 3000) })],
      [row({ id: 'm1', name: 'ember-mine', enteredPoolAt: iso(NOW - 4000) })],
    );
    const kinds = seedNotifications(s, NOW).map((n) => n.kind);
    expect(kinds).toEqual(['review_assigned', 'review_started']);
  });

  it('returns empty for a snapshot with nothing decided', () => {
    expect(seedNotifications(snap([], []), NOW)).toEqual([]);
  });

  it('caps history at the limit, newest first', () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({ id: `r${i}`, name: `ember-${i}`, reviewStatus: 'accepted', reviewedAt: iso(NOW - i * 1000) }),
    );
    const seeded = seedNotifications(snap(rows, []), NOW);
    expect(seeded).toHaveLength(50);
    expect(seeded[0].taskId).toBe('r0');
  });
});

describe('noticeAge — bubble timestamp', () => {
  it('renders compact relative ages', () => {
    expect(noticeAge(NOW, NOW)).toBe('just now');
    expect(noticeAge(NOW - 30_000, NOW)).toBe('just now');
    expect(noticeAge(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(noticeAge(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(noticeAge(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
    expect(noticeAge(NOW + 60_000, NOW)).toBe('just now');
  });
});

describe('NOTICE_ICONS — canonical per-type icon', () => {
  it('covers every kind the pet can raise', () => {
    expect(NOTICE_ICONS).toEqual({
      accepted: '✅',
      rejected: '❌',
      needs_revision: '🔄',
      validation_passed: '✅',
      validation_failed: '❌',
      review_assigned: '👤',
      review_started: '👀',
    });
  });
});
