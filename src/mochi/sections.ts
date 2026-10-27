/* Which glance-panel sections the user wants to see, saved locally.
 * Revisions and reviews are on by default; drafts are opt-in.
 */
import type { TaskStatus } from './logic.ts';

export type SectionKey = 'revisions' | 'reviews' | 'drafts';
export type SectionPrefs = Record<SectionKey, boolean>;

export const SECTIONS_STORAGE_KEY = 'mochi.sections.v1';
export const DEFAULT_SECTIONS: SectionPrefs = { revisions: true, reviews: true, drafts: false };

/** Panel order, labels, and the task status each section lists. */
export const SECTIONS: { key: SectionKey; label: string; status: TaskStatus }[] = [
  { key: 'revisions', label: 'Needs revision', status: 'revision_required' },
  { key: 'reviews', label: 'Waiting for your review', status: 'pending_review' },
  { key: 'drafts', label: 'Drafts', status: 'draft' },
];

export function parseSectionPrefs(raw: string | null): SectionPrefs {
  if (!raw) return DEFAULT_SECTIONS;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<SectionKey, unknown>>;
    const prefs = { ...DEFAULT_SECTIONS };
    for (const { key } of SECTIONS) {
      if (typeof parsed[key] === 'boolean') prefs[key] = parsed[key];
    }
    // Never leave the panel with nothing in it.
    return SECTIONS.some(({ key }) => prefs[key]) ? prefs : DEFAULT_SECTIONS;
  } catch {
    return DEFAULT_SECTIONS;
  }
}

export function loadSectionPrefs(): SectionPrefs {
  try {
    return parseSectionPrefs(localStorage.getItem(SECTIONS_STORAGE_KEY));
  } catch {
    return DEFAULT_SECTIONS;
  }
}

export function saveSectionPrefs(prefs: SectionPrefs): void {
  try {
    localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable — prefs still apply for the session */
  }
}

/** Statuses of the sections that are switched on (filters the full task list too). */
export function visibleStatuses(prefs: SectionPrefs): Set<TaskStatus> {
  return new Set(SECTIONS.filter(({ key }) => prefs[key]).map(({ status }) => status));
}
