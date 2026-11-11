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

/** Move one section to an index, clamped to either end. A move to its own spot, or of
 * an unknown section, returns the same array. Never mutates. */
export function reorderSection(order: SectionOrder, key: SectionKey, to: number): SectionOrder {
  const from = order.indexOf(key);
  const clamped = Math.max(0, Math.min(to, order.length - 1));
  if (from < 0 || clamped === from) return order;
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(clamped, 0, moved);
  return next;
}

/** Move one section up (-1) or down (+1); a move past either end changes nothing. Never mutates. */
export function moveSection(order: SectionOrder, key: SectionKey, delta: -1 | 1): SectionOrder {
  return reorderSection(order, key, order.indexOf(key) + delta);
}

/** Move one section to an index within the sections currently shown (`shown`, in
 * shown order). Sections not shown keep their places: the moved section lands
 * before the shown section now at that index, or just past the last shown one.
 * A move to its own spot, of an unknown section, or with one shown section
 * returns the same array. Never mutates. */
export function reorderInVisibleOrder(order: SectionOrder, key: SectionKey, shown: SectionKey[], toShown: number): SectionOrder {
  const fromShown = shown.indexOf(key);
  if (fromShown < 0 || shown.length <= 1) return order;
  const clamped = Math.max(0, Math.min(toShown, shown.length - 1));
  if (clamped === fromShown) return order;
  const remaining = order.filter((k) => k !== key);
  const visibleRemaining = remaining.filter((k) => shown.includes(k));
  const insertAt =
    clamped >= visibleRemaining.length
      ? visibleRemaining.length > 0
        ? remaining.indexOf(visibleRemaining[visibleRemaining.length - 1]) + 1
        : remaining.length
      : remaining.indexOf(visibleRemaining[clamped]);
  const next = [...remaining];
  next.splice(insertAt, 0, key);
  return next;
}
