/* Codimango → panel rows. Pure mapping from `codimango task list --json` rows
 * (picked down by electron/codimango.mjs) to TaskItem, plus the weekly counts.
 * No React/DOM/Electron imports so it stays unit-testable in Node.
 *
 * Two ranking rules, one per panel section:
 *   Waiting for your review — time left to reviewSlaDeadline:
 *     past due → urgent, < 24h → high, 24–48h → normal, > 48h → low.
 *     An escalated review (escalationLevel > 0) moves up one level.
 *   Needs revision — distance from Codimango's stale auto-archive (a failing or
 *     pending task with no push for 14 days is warned, then archived 14 days later):
 *     archive warning sent → urgent; validation failing 10+ days → urgent;
 *     failing → high; pending or passing → normal (oldest send-back first).
 */
import type { TaskItem, TaskPriority } from './logic.ts';

export const CODIMANGO_WEB = 'https://codimango.internalmeta.com';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Days from the stale-archive warning to the archive itself. */
export const ARCHIVE_AFTER_WARNING_DAYS = 14;
/** Failing validation this long counts as urgent even before the warning. */
export const LONG_FAILING_DAYS = 10;

export interface CodimangoValidationDetail {
  label: string;
  status: string;
}

/** The subset of a `task list --json` row Mochi reads. */
export interface CodimangoRow {
  id: string;
  name: string;
  status: string;
  reviewStatus: string | null;
  track: string | null;
  reviewSlaDeadline: string | null;
  enteredPoolAt: string | null;
  reviewedAt: string | null;
  escalationLevel: number | null;
  validationStatus: string | null;
  validationFailedSince: string | null;
  staleArchiveWarnedAt: string | null;
  validationDetails: CodimangoValidationDetail[] | null;
  oraclePassCount: number | null;
  oracleTotalCount: number | null;
}

/** What one refresh returns: your reviews feed and your own tasks. */
export interface CodimangoSnapshot {
  fetchedAtMs: number;
  reviewing: CodimangoRow[];
  mine: CodimangoRow[];
}

export type CodimangoFailureKind = 'cli_missing' | 'login_required' | 'offline' | 'error';

export interface CodimangoFailure {
  kind: CodimangoFailureKind;
  message: string;
  /** Command the user can run to fix it, e.g. `codimango auth setup`. */
  fix?: string;
}

export type CodimangoFetchResult =
  | { ok: true; snapshot: CodimangoSnapshot }
  | { ok: false; error: CodimangoFailure };

export interface WeeklyCompleted {
  reviewsCompleted: number;
  submissionsCompleted: number;
}

/** Codimango task rows carry an extra "open in Codimango" link and a subtitle override. */
export type CodimangoTaskItem = TaskItem & { url: string };

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : 'unknown';
}

function ago(fromMs: number, nowMs: number): string {
  const days = Math.floor((nowMs - fromMs) / DAY_MS);
  return days < 1 ? 'today' : `${days}d ago`;
}

const TRACK_LABELS: Record<string, string> = {
  'swe-bench-pro': 'SWE-Bench Pro',
  'swe-bench-licensed': 'SWE-Bench Licensed',
  tbench: 'T-Bench',
  'long-horizon': 'Long Horizon',
};

export function trackLabel(track: string | null): string {
  if (!track) return 'Task';
  return (
    TRACK_LABELS[track] ??
    track
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ')
  );
}

const PRIORITY_UP: Record<TaskPriority, TaskPriority> = {
  urgent: 'urgent',
  high: 'urgent',
  normal: 'high',
  low: 'normal',
};

export function reviewPriority(slaDueMs: number, escalationLevel: number, nowMs: number): TaskPriority {
  const left = slaDueMs - nowMs;
  const base: TaskPriority =
    left < 0 ? 'urgent' : left < DAY_MS ? 'high' : left < 2 * DAY_MS ? 'normal' : 'low';
  return escalationLevel > 0 ? PRIORITY_UP[base] : base;
}

export function revisionPriority(row: CodimangoRow, nowMs: number): TaskPriority {
  if (row.staleArchiveWarnedAt) return 'urgent';
  if (row.validationStatus === 'failed') {
    const since = ms(row.validationFailedSince);
    return since !== null && nowMs - since >= LONG_FAILING_DAYS * DAY_MS ? 'urgent' : 'high';
  }
  return 'normal';
}

/* Short names for validation checks; the Codimango UI shows the balance check
   as "Solvability & difficulty". Unknown labels pass through unchanged. */
const CHECK_LABELS: Record<string, string> = {
  'Structural checks': 'Structural',
  'Metacode or Opus pass/fail balance': 'Solvability & difficulty',
  'Agentic trial-output review': 'Trial review',
  'Contamination check': 'Contamination',
  'VALIDATION_ENGINE::unified_provenance': 'Provenance',
};

/** "Oracle 1/3", "Solvability & difficulty", "Oracle 1/3 +2" — the failed checks, shortest first. */
export function failedCheckSummary(row: CodimangoRow): string | undefined {
  const failed = (row.validationDetails ?? []).filter((d) => d.status === 'failed');
  const names = failed.map((d) =>
    d.label === 'Oracle validation' && row.oracleTotalCount
      ? `Oracle ${row.oraclePassCount ?? 0}/${row.oracleTotalCount}`
      : (CHECK_LABELS[d.label] ?? d.label),
  );
  if (names.length === 0) return undefined;
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}

export function reviewUrl(id: string): string {
  return `${CODIMANGO_WEB}/reviews/${encodeURIComponent(id)}`;
}

export function submissionUrl(id: string): string {
  return `${CODIMANGO_WEB}/submissions/${encodeURIComponent(id)}`;
}

/** Reviews still waiting on your verdict. The reviewing feed also lists delivered ones. */
function pendingReviewItem(row: CodimangoRow, nowMs: number): CodimangoTaskItem | null {
  if (row.reviewStatus !== 'being_reviewed') return null;
  const slaDueMs = ms(row.reviewSlaDeadline);
  if (slaDueMs === null) return null;
  const escalation = row.escalationLevel ?? 0;
  return {
    id: row.id,
    title: row.name,
    type: trackLabel(row.track),
    priority: reviewPriority(slaDueMs, escalation, nowMs),
    status: 'pending_review',
    slaDueMs,
    description:
      `${trackLabel(row.track)} review. In the pool since ${day(row.enteredPoolAt)}, ` +
      `due ${day(row.reviewSlaDeadline)}.` +
      (escalation > 0 ? ` Escalated (level ${escalation}).` : ''),
    // Codimango only exposes the importer's numeric ID, so no name here.
    requester: 'Codimango',
    subtitle: escalation > 0 ? 'Assigned to you · escalated' : 'Assigned to you',
    url: reviewUrl(row.id),
  };
}

/** Your tasks a reviewer sent back. */
function revisionItem(row: CodimangoRow, nowMs: number): CodimangoTaskItem | null {
  if (row.status !== 'needs_revision') return null;
  const warnedMs = ms(row.staleArchiveWarnedAt);
  const sentBackMs = ms(row.reviewedAt) ?? nowMs;
  const checkSummary = row.validationStatus === 'failed' ? failedCheckSummary(row) : undefined;
  // Warned rows sort by the real archive date; the rest oldest send-back first.
  const slaDueMs = warnedMs !== null ? warnedMs + ARCHIVE_AFTER_WARNING_DAYS * DAY_MS : sentBackMs;
  let subtitle: string | undefined;
  if (warnedMs !== null) {
    const daysLeft = Math.max(0, Math.ceil((slaDueMs - nowMs) / DAY_MS));
    subtitle = `Archive warning · archives in ${daysLeft}d`;
  } else if (row.validationStatus === 'failed') {
    subtitle = checkSummary ? undefined : `Validation failed · sent back ${ago(sentBackMs, nowMs)}`;
  } else if (row.validationStatus === 'pending') {
    subtitle = `Validation running · sent back ${ago(sentBackMs, nowMs)}`;
  } else {
    subtitle = `Reviewer feedback · sent back ${ago(sentBackMs, nowMs)}`;
  }
  return {
    id: row.id,
    title: row.name,
    type: trackLabel(row.track),
    priority: revisionPriority(row, nowMs),
    status: 'revision_required',
    slaDueMs,
    description:
      `Sent back for revision on ${day(row.reviewedAt)}. Validation: ${row.validationStatus ?? 'unknown'}` +
      (checkSummary ? ` (${checkSummary})` : '') +
      '.' +
      (warnedMs !== null
        ? ` Stale-archive warning sent ${day(row.staleArchiveWarnedAt)}; a push, comment or send-back resets it.`
        : ''),
    requester: 'Reviewer',
    checkSummary,
    subtitle,
    url: submissionUrl(row.id),
  };
}

export function toTaskItems(snapshot: CodimangoSnapshot, nowMs: number): CodimangoTaskItem[] {
  const out: CodimangoTaskItem[] = [];
  const seen = new Set<string>();
  for (const row of snapshot.reviewing) {
    const item = pendingReviewItem(row, nowMs);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  for (const row of snapshot.mine) {
    const item = revisionItem(row, nowMs);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/** Validate a cached snapshot from localStorage; null if missing or malformed. */
export function parseCachedSnapshot(raw: string | null): CodimangoSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CodimangoSnapshot>;
    if (
      typeof parsed.fetchedAtMs !== 'number' ||
      !Array.isArray(parsed.reviewing) ||
      !Array.isArray(parsed.mine)
    ) {
      return null;
    }
    return { fetchedAtMs: parsed.fetchedAtMs, reviewing: parsed.reviewing, mine: parsed.mine };
  } catch {
    return null;
  }
}

/** Monday 00:00 local time of the week containing nowMs. */
export function weekStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  const sinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - sinceMonday);
  return d.getTime();
}

const ACCEPTED_STATUSES = new Set(['accepted', 'used_in_training']);

/**
 * Reviews you delivered this week, and your tasks accepted this week.
 * Codimango has no acceptedAt; reviewedAt (the verdict time) stands in for it.
 */
export function weeklyCompleted(snapshot: CodimangoSnapshot, nowMs: number): WeeklyCompleted {
  const start = weekStartMs(nowMs);
  const thisWeek = (iso: string | null) => {
    const t = ms(iso);
    return t !== null && t >= start && t <= nowMs;
  };
  return {
    reviewsCompleted: snapshot.reviewing.filter(
      (r) => r.reviewStatus !== 'being_reviewed' && thisWeek(r.reviewedAt),
    ).length,
    submissionsCompleted: snapshot.mine.filter(
      (r) => ACCEPTED_STATUSES.has(r.status) && thisWeek(r.reviewedAt),
    ).length,
  };
}
