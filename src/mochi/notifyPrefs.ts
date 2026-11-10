/* Which notifications may pop the bubble, saved locally (filter menu).
 * Everything is on by default. A kind that's off never pops or raises the
 * unread badge, but still goes to history, so the bell can replay it.
 */
import type { NoticeKind } from './notifications.ts';

export type NotifyKind = NoticeKind | 'sev' | 'agent_review';
export type NotifyPrefs = Record<NotifyKind, boolean>;

export const NOTIFY_STORAGE_KEY = 'mochi.notify.v1';

/** Menu order and wording. */
export const NOTIFY_KINDS: { key: NotifyKind; label: string }[] = [
  { key: 'validation_failed', label: 'Validation failed' },
  { key: 'validation_passed', label: 'Validation passed' },
  { key: 'needs_revision', label: 'Sent back for revision' },
  { key: 'accepted', label: 'Task accepted' },
  { key: 'rejected', label: 'Task rejected' },
  { key: 'review_assigned', label: 'Review assigned to you' },
  { key: 'review_started', label: 'Review started on your task' },
  { key: 'sev', label: 'Codimango SEVs' },
  { key: 'agent_review', label: 'Agent review finished' },
];

export const DEFAULT_NOTIFY: NotifyPrefs = Object.fromEntries(NOTIFY_KINDS.map(({ key }) => [key, true])) as NotifyPrefs;

export function parseNotifyPrefs(raw: string | null): NotifyPrefs {
  if (!raw) return DEFAULT_NOTIFY;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<NotifyKind, unknown>>;
    const prefs = { ...DEFAULT_NOTIFY };
    for (const { key } of NOTIFY_KINDS) {
      if (typeof parsed[key] === 'boolean') prefs[key] = parsed[key];
    }
    return prefs;
  } catch {
    return DEFAULT_NOTIFY;
  }
}

export function loadNotifyPrefs(): NotifyPrefs {
  try {
    return parseNotifyPrefs(localStorage.getItem(NOTIFY_STORAGE_KEY));
  } catch {
    return DEFAULT_NOTIFY;
  }
}

export function saveNotifyPrefs(prefs: NotifyPrefs): void {
  try {
    localStorage.setItem(NOTIFY_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable — prefs still apply for the session */
  }
}

/** SEV bubbles come as sev_open / sev_mitigated; both follow the one "Codimango SEVs" switch. */
export function notifyKindOf(kind: string | undefined): NotifyKind | null {
  if (!kind) return null;
  if (kind.startsWith('sev_')) return 'sev';
  return NOTIFY_KINDS.some((k) => k.key === kind) ? (kind as NotifyKind) : null;
}

/** Whether a bubble of this kind may pop. Unknown kinds (the placeholder) always may. */
export function notifyAllowed(prefs: NotifyPrefs, kind: string | undefined): boolean {
  const key = notifyKindOf(kind);
  return key === null || prefs[key];
}
