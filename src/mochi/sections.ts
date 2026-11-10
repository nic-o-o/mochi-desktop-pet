/* Which glance-panel sections the user wants to see, and in what order, saved locally.
 * Revisions, reviews, and ready-for-submission are on by default; drafts are opt-in.
 * Default order pins Ready for submission first, then the SECTIONS order.
 */
import type { TaskStatus } from './logic.ts';

export type SectionKey = 'revisions' | 'reviews' | 'drafts' | 'submittable';
export type SectionPrefs = Record<SectionKey, boolean>;

export const SECTIONS_STORAGE_KEY = 'mochi.sections.v1';
export const DEFAULT_SECTIONS: SectionPrefs = { revisions: true, reviews: true, drafts: false, submittable: true };

/** Panel order, labels, and the task status each section lists. */
export const SECTIONS: { key: SectionKey; label: string; status: TaskStatus }[] = [
  { key: 'revisions', label: 'Needs revision', status: 'revision_required' },
  { key: 'reviews', label: 'Waiting for your review', status: 'pending_review' },
  { key: 'drafts', label: 'Drafts', status: 'draft' },
  { key: 'submittable', label: 'Ready for submission', status: 'draft' },
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

export type SectionOrder = SectionKey[];

export const SECTION_ORDER_STORAGE_KEY = 'mochi.sections.order.v1';
export const DEFAULT_SECTION_ORDER: SectionOrder = ['submittable', 'revisions', 'reviews', 'drafts'];

/** A saved order, repaired: unknown keys and repeats dropped, missing sections appended in default order. */
export function parseSectionOrder(raw: string | null): SectionOrder {
  if (!raw) return DEFAULT_SECTION_ORDER;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SECTION_ORDER;
    const known = new Set<string>(DEFAULT_SECTION_ORDER);
    const order: SectionOrder = [];
    for (const key of parsed) {
      if (typeof key === 'string' && known.has(key) && !order.includes(key as SectionKey)) order.push(key as SectionKey);
    }
    for (const key of DEFAULT_SECTION_ORDER) if (!order.includes(key)) order.push(key);
    return order;
  } catch {
    return DEFAULT_SECTION_ORDER;
  }
}

export function loadSectionOrder(): SectionOrder {
  try {
    return parseSectionOrder(localStorage.getItem(SECTION_ORDER_STORAGE_KEY));
  } catch {
    return DEFAULT_SECTION_ORDER;
  }
}

export function saveSectionOrder(order: SectionOrder): void {
  try {
    localStorage.setItem(SECTION_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    /* storage unavailable — the order still applies for the session */
  }
}

/** Move one section up (-1) or down (+1); a move past either end changes nothing. Never mutates. */
export function moveSection(order: SectionOrder, key: SectionKey, delta: -1 | 1): SectionOrder {
  const from = order.indexOf(key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
