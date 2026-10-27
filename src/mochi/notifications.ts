/* Real notifications for the pet bubble, derived from Codimango snapshots.
 *
 * There is no notification pull API (server pushes to Slack/GChat only), so
 * arrivals are detected by diffing consecutive snapshots: review verdicts and
 * validation pass/fail. The first snapshot is always a silent baseline.
 * History persists newest-first in localStorage, capped, and Cmd+Shift+M
 * walks it instead of showing canned templates.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodimangoRow, CodimangoSnapshot } from './codimango.ts';
import { failedCheckSummary, reviewUrl, submissionUrl } from './codimango.ts';

/* v2: entries carry kind+icon; v1 entries are dropped and reseeded. */
export const NOTIFICATIONS_STORAGE_KEY = 'mochi.notifications.v2';
export const NOTIFICATION_HISTORY_LIMIT = 50;

export interface Notice {
  id: string;
  /** Absent only on the unsaved empty-history placeholder. */
  kind?: NoticeKind;
  title: string;
  /** Task name, rendered in the panel-link style; detail is the plain rest. */
  taskName: string;
  detail: string;
  url: string;
  taskId: string;
  raisedAtMs: number;
}

export type NoticeKind =
  | 'accepted'
  | 'rejected'
  | 'needs_revision'
  | 'validation_passed'
  | 'validation_failed'
  | 'review_assigned'
  | 'task_submitted';

/** Canonical per-type icon, matching the Codimango notifier taxonomy. */
export const NOTICE_ICONS: Record<NoticeKind, string> = {
  accepted: '✅',
  rejected: '❌',
  needs_revision: '🔄',
  validation_passed: '✅',
  validation_failed: '❌',
  review_assigned: '👤',
  task_submitted: '📥',
};

type NoticeVoice = 'owner' | 'reviewer';

/** Review verdicts only — other reviewStatus values (draft, being_reviewed) never notify. */
const VERDICTS = ['accepted', 'rejected', 'needs_revision'] as const;
type Verdict = (typeof VERDICTS)[number];

function isVerdict(status: string | null): status is Verdict {
  return (VERDICTS as readonly string[]).includes(status ?? '');
}

/* Canonical copy: owner voice for my tasks, reviewer voice for reviews I was on. */
const VERDICT_COPY: Record<Verdict, { title: string; owner: string; reviewer: string }> = {
  accepted: {
    title: 'Task Accepted',
    owner: 'Your task was accepted into the benchmark.',
    reviewer: 'A task assigned to you was accepted.',
  },
  rejected: {
    title: 'Task Rejected',
    owner: 'Your task was rejected and will not be included in the benchmark.',
    reviewer: 'A task assigned to you was rejected and will not be included in the benchmark.',
  },
  needs_revision: {
    title: 'Changes Requested',
    owner: 'Your task needs further changes before it can be accepted.',
    reviewer: 'A task assigned to you needs further changes before it can be accepted.',
  },
};

function verdictNotice(row: CodimangoRow, status: Verdict, voice: NoticeVoice, raisedAtMs: number): Notice {
  const copy = VERDICT_COPY[status];
  return {
    id: `verdict:${voice}:${row.id}:${status}:${raisedAtMs}`,
    kind: status,
    title: copy.title,
    taskName: row.name,
    detail: voice === 'owner' ? copy.owner : copy.reviewer,
    url: reviewUrl(row.id),
    taskId: row.id,
    raisedAtMs,
  };
}

function assignedNotice(row: CodimangoRow, raisedAtMs: number): Notice {
  return {
    id: `assigned:${row.id}:${raisedAtMs}`,
    kind: 'review_assigned',
    title: 'Review Assigned',
    taskName: row.name,
    detail: "You've been assigned as the reviewer.",
    url: reviewUrl(row.id),
    taskId: row.id,
    raisedAtMs,
  };
}

function submittedNotice(row: CodimangoRow, raisedAtMs: number): Notice {
  return {
    id: `submitted:${row.id}:${raisedAtMs}`,
    kind: 'task_submitted',
    title: 'Task Submitted for Review',
    taskName: row.name,
    detail: 'Your task was submitted and is now waiting for review.',
    url: submissionUrl(row.id),
    taskId: row.id,
    raisedAtMs,
  };
}

function toMs(iso: string | null, fallback: number): number {
  if (!iso) return fallback;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? fallback : t;
}

/** Compact relative age for the bubble timestamp ("5m ago", "3h ago"). */
export function noticeAge(raisedAtMs: number, nowMs: number): string {
  const mins = Math.floor(Math.max(0, nowMs - raisedAtMs) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function validationNotice(row: CodimangoRow, raisedAtMs: number): Notice {
  const v = row.validationStatus ?? '';
  const passed = v === 'passing';
  const summary = !passed ? failedCheckSummary(row) : undefined;
  return {
    id: `validation:${row.id}:${v}:${raisedAtMs}`,
    kind: passed ? 'validation_passed' : 'validation_failed',
    title: passed ? 'Validation passed' : 'Validation failed',
    taskName: row.name,
    detail: passed ? 'All validation checks passed.' : `Validation failed${summary ? ` (${summary})` : ''}.`,
    url: submissionUrl(row.id),
    taskId: row.id,
    raisedAtMs,
  };
}

/**
 * Arrivals between two snapshots: review verdicts (left being_reviewed, or a
 * newly-seen verdict) and validation transitions into passed/failed.
 * A null previous snapshot is the silent baseline.
 */
export function diffNotifications(
  prev: CodimangoSnapshot | null,
  next: CodimangoSnapshot,
  nowMs: number,
): Notice[] {
  if (!prev) return [];
  const out: Notice[] = [];
  /* Same id+verdict seen in both feeds is one event; owner voice wins. */
  const seen = new Set<string>();
  const prevMine = new Map(prev.mine.map((r) => [r.id, r]));
  const prevReviewing = new Map(prev.reviewing.map((r) => [r.id, r]));

  /* Owner voice: my tasks' verdicts, submissions, and validation. */
  for (const row of next.mine) {
    const p = prevMine.get(row.id);
    const rs = row.reviewStatus;
    if (isVerdict(rs) && p?.reviewStatus !== rs) {
      out.push(verdictNotice(row, rs, 'owner', nowMs));
      seen.add(`${row.id}|${rs}`);
    } else if (rs === 'being_reviewed' && p?.reviewStatus !== 'being_reviewed') {
      out.push(submittedNotice(row, nowMs));
    }
    const v = row.validationStatus;
    if ((v === 'passing' || v === 'failed') && p?.validationStatus !== v) {
      out.push(validationNotice(row, nowMs));
    }
  }
  /* Reviewer voice: verdicts I was on, and new assignments to me. */
  for (const row of next.reviewing) {
    const p = prevReviewing.get(row.id);
    const rs = row.reviewStatus;
    if (isVerdict(rs) && p?.reviewStatus !== rs && !seen.has(`${row.id}|${rs}`)) {
      out.push(verdictNotice(row, rs, 'reviewer', nowMs));
    } else if (rs === 'being_reviewed' && p?.reviewStatus !== 'being_reviewed') {
      out.push(assignedNotice(row, nowMs));
    }
  }
  return out;
}

/**
 * The first snapshot becomes browsable history: every decided review and
 * finished validation, newest first by verdict time, capped. Silent — nothing
 * pops for the past.
 */
export function seedNotifications(snapshot: CodimangoSnapshot, nowMs: number): Notice[] {
  const out: Notice[] = [];
  const seen = new Set<string>();
  for (const row of snapshot.mine) {
    const rs = row.reviewStatus;
    if (isVerdict(rs)) {
      out.push(verdictNotice(row, rs, 'owner', toMs(row.reviewedAt, nowMs)));
      seen.add(`${row.id}|${rs}`);
    } else if (rs === 'being_reviewed') {
      out.push(submittedNotice(row, toMs(row.enteredPoolAt, nowMs)));
    }
    const v = row.validationStatus;
    if (v === 'passing' || v === 'failed') {
      out.push(validationNotice(row, toMs(row.reviewedAt ?? row.validationFailedSince, nowMs)));
    }
  }
  for (const row of snapshot.reviewing) {
    const rs = row.reviewStatus;
    if (isVerdict(rs)) {
      if (!seen.has(`${row.id}|${rs}`)) {
        out.push(verdictNotice(row, rs, 'reviewer', toMs(row.reviewedAt, nowMs)));
      }
    } else if (rs === 'being_reviewed') {
      out.push(assignedNotice(row, toMs(row.enteredPoolAt, nowMs)));
    }
  }
  out.sort((a, b) => b.raisedAtMs - a.raisedAtMs);
  return out.slice(0, NOTIFICATION_HISTORY_LIMIT);
}

export function loadNotificationHistory(): Notice[] {
  try {
    const raw = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<Notice>[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (n) =>
          typeof n?.title === 'string' &&
          typeof n?.taskName === 'string' &&
          typeof n?.detail === 'string' &&
          typeof n?.kind === 'string',
      )
      .slice(0, NOTIFICATION_HISTORY_LIMIT) as Notice[];
  } catch {
    return [];
  }
}

export function saveNotificationHistory(history: Notice[]): Notice[] {
  const trimmed = history.slice(0, NOTIFICATION_HISTORY_LIMIT);
  try {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* storage unavailable — history still applies for the session */
  }
  return trimmed;
}

const EMPTY_NOTICE: Notice = {
  id: 'empty',
  title: 'No notifications yet',
  taskName: '',
  detail: 'New review verdicts and validation results will appear here.',
  url: '',
  taskId: '',
  raisedAtMs: 0,
};

/* Merge seeded past events under existing history, newest first, capped. */
function mergeSeeded(history: Notice[], seeded: Notice[]): Notice[] {
  const seen = new Set(history.map((n) => `${n.taskId}|${n.title}`));
  const fresh = seeded.filter((n) => !seen.has(`${n.taskId}|${n.title}`));
  if (fresh.length === 0) return history;
  return saveNotificationHistory(
    [...history, ...fresh].sort((a, b) => b.raisedAtMs - a.raisedAtMs),
  );
}

/**
 * Persisted newest-first history plus shortcut cycling. History derives from
 * the snapshot during render; only the bubble pop itself is an effect.
 * The shortcut replays past notices newest first, wrapping around. Empty
 * history replays a placeholder, never saved.
 */
export function useNotificationHistory(
  snapshot: CodimangoSnapshot | null,
  nowMs: number,
  onArrive: (notice: Notice) => void,
) {
  const [history, setHistory] = useState<Notice[]>(loadNotificationHistory);
  const [prevSnapshot, setPrevSnapshot] = useState<CodimangoSnapshot | null>(null);
  const [pendingArrival, setPendingArrival] = useState<Notice | null>(null);
  const historyRef = useRef<Notice[]>(history);
  const cursorRef = useRef(0);
  const onArriveRef = useRef(onArrive);
  const arrivedRef = useRef<Notice | null>(null);

  useEffect(() => {
    onArriveRef.current = onArrive;
    historyRef.current = history;
  });

  if (snapshot !== prevSnapshot) {
    setPrevSnapshot(snapshot);
    if (snapshot) {
      if (!prevSnapshot) {
        /* First snapshot seeds browsable history without popping anything. */
        const seeded = seedNotifications(snapshot, nowMs);
        if (seeded.length > 0) setHistory((h) => mergeSeeded(h, seeded));
      } else {
        const fresh = diffNotifications(prevSnapshot, snapshot, nowMs);
        if (fresh.length > 0) {
          setHistory((h) => saveNotificationHistory([...fresh.slice().reverse(), ...h]));
          setPendingArrival(fresh[fresh.length - 1]);
        }
      }
    }
  }

  useEffect(() => {
    if (pendingArrival && arrivedRef.current !== pendingArrival) {
      arrivedRef.current = pendingArrival;
      cursorRef.current = 0;
      onArriveRef.current(pendingArrival);
    }
  }, [pendingArrival]);

  const showNext = useCallback(() => {
    const h = historyRef.current;
    if (h.length === 0) {
      onArriveRef.current({ ...EMPTY_NOTICE, raisedAtMs: Date.now() });
      return;
    }
    const notice = h[cursorRef.current % h.length];
    cursorRef.current += 1;
    onArriveRef.current(notice);
  }, []);

  /* Closing the bubble restarts the next walk at the latest notice. */
  const resetCycle = useCallback(() => {
    cursorRef.current = 0;
  }, []);

  return { history, showNext, resetCycle };
}
