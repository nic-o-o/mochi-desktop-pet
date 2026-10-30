/* Shorthand task rows for scenarios → full Codimango rows, with times relative
 * to "now" so scenarios stay valid whenever they run. Example:
 *   reviewing: [{ id: r1, name: ember-x, review: open, due_in_h: 10 }]
 *   mine:      [{ id: d1, name: ember-y, status: draft, validation: failed,
 *                 failed_checks: [AI assessment], updated_ago_h: 2 }]
 */
import type { CodimangoRow, CodimangoSnapshot } from '../../mochi/codimango.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface ShorthandRow {
  id: string;
  name?: string;
  track?: string;
  /** Reviewing feed: where your review stands. */
  review?: 'open' | 'accepted' | 'rejected' | 'needs_revision';
  /** Mine feed: the task's status. */
  status?: string;
  validation?: 'passing' | 'failed' | 'pending' | null;
  failed_checks?: string[];
  /** "passed/total", e.g. "1/3". */
  oracle?: string;
  due_in_h?: number;
  claimed_ago_h?: number;
  pooled_ago_h?: number;
  reviewed_ago_h?: number;
  updated_ago_h?: number;
  warned_ago_d?: number;
  failing_since_d?: number;
  escalation?: number;
}

export interface ShorthandSnapshot {
  reviewing?: ShorthandRow[];
  mine?: ShorthandRow[];
  /** How old the snapshot is (saved snapshots), in minutes. */
  age_min?: number;
}

const ago = (now: number, h: number | undefined, unit = HOUR) =>
  h === undefined ? null : new Date(now - h * unit).toISOString();
const ahead = (now: number, h: number | undefined) => (h === undefined ? null : new Date(now + h * HOUR).toISOString());

export function toRow(s: ShorthandRow, now: number, feed: 'reviewing' | 'mine'): CodimangoRow {
  const status = s.status ?? (feed === 'reviewing' ? (s.review === 'open' || !s.review ? 'being_reviewed' : s.review) : 'draft');
  const reviewStatus = feed === 'reviewing' ? (s.review === 'open' || !s.review ? 'being_reviewed' : s.review) : status === 'used_in_training' ? 'accepted' : status;
  const open = reviewStatus === 'being_reviewed';
  const [oPass, oTotal] = s.oracle ? s.oracle.split('/').map(Number) : [null, null];
  return {
    id: s.id,
    name: s.name ?? `task-${s.id}`,
    status,
    reviewStatus,
    track: s.track ?? 'swe-bench-pro',
    reviewSlaDeadline: open ? ahead(now, s.due_in_h ?? 48) : null,
    enteredPoolAt: ago(now, s.pooled_ago_h ?? (open ? (s.claimed_ago_h ?? 24) + 0.01 : undefined)),
    claimedAt: open ? ago(now, s.claimed_ago_h ?? 24) : null,
    updatedAt: ago(now, s.updated_ago_h),
    reviewedAt: open ? null : ago(now, s.reviewed_ago_h),
    escalationLevel: s.escalation ?? 0,
    validationStatus: s.validation ?? null,
    validationFailedSince: ago(now, s.failing_since_d, DAY),
    staleArchiveWarnedAt: ago(now, s.warned_ago_d, DAY),
    validationDetails: s.failed_checks ? s.failed_checks.map((label) => ({ label, status: 'failed' })) : null,
    oraclePassCount: oPass,
    oracleTotalCount: oTotal,
  };
}

export function toSnapshot(s: ShorthandSnapshot, now: number): CodimangoSnapshot {
  return {
    fetchedAtMs: now - (s.age_min ?? 0) * 60_000,
    reviewing: (s.reviewing ?? []).map((r) => toRow(r, now, 'reviewing')),
    mine: (s.mine ?? []).map((r) => toRow(r, now, 'mine')),
  };
}
