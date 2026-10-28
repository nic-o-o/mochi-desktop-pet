/* Review-turnaround study: did testers deliver reviews faster after installing Mochi?
 *
 * On first launch Mochi records the install time, and once data arrives the
 * tester's "before": time to verdict (reviewedAt − enteredPoolAt) for reviews
 * delivered in the 30 days before install. "After" is the same measure for
 * reviews delivered since install, computed when the tester copies their stats.
 * Everything stays on the Mac; nothing is shown in the panel (showing people
 * their own speed could push them to rush reviews).
 */
import type { CodimangoRow, CodimangoSnapshot } from './codimango.ts';

export const STUDY_STORAGE_KEY = 'mochi.study.v1';
export const BEFORE_WINDOW_DAYS = 30;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface TurnaroundStats {
  count: number;
  medianHours: number | null;
  p90Hours: number | null;
}

export interface StudyRecord {
  installedAtMs: number;
  /** Null until the first Codimango snapshot after install. */
  before: TurnaroundStats | null;
}

/** Nearest-rank percentile, same method as `npm run baseline`. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

/** Time to verdict for reviews delivered in [fromMs, toMs). */
export function turnaroundStats(reviewing: CodimangoRow[], fromMs: number, toMs: number): TurnaroundStats {
  const hours = reviewing
    .filter((r) => r.reviewStatus !== 'being_reviewed' && r.reviewedAt && r.enteredPoolAt)
    .map((r) => ({ reviewed: Date.parse(r.reviewedAt as string), pooled: Date.parse(r.enteredPoolAt as string) }))
    .filter((r) => r.reviewed >= fromMs && r.reviewed < toMs && r.reviewed >= r.pooled)
    .map((r) => (r.reviewed - r.pooled) / HOUR_MS)
    .sort((a, b) => a - b);
  return {
    count: hours.length,
    medianHours: round1(percentile(hours, 50)),
    p90Hours: round1(percentile(hours, 90)),
  };
}

export function parseStudy(raw: string | null): StudyRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StudyRecord>;
    if (typeof parsed.installedAtMs !== 'number') return null;
    const b = parsed.before;
    const before =
      b && typeof b.count === 'number'
        ? { count: b.count, medianHours: b.medianHours ?? null, p90Hours: b.p90Hours ?? null }
        : null;
    return { installedAtMs: parsed.installedAtMs, before };
  } catch {
    return null;
  }
}

/**
 * Next study record: start it on first launch (even before any data), and
 * fill in "before" from the first snapshot. Returns the same object when
 * nothing changed, so callers can skip saving.
 */
export function advanceStudy(
  study: StudyRecord | null,
  snapshot: CodimangoSnapshot | null,
  nowMs: number,
): StudyRecord {
  const current = study ?? { installedAtMs: nowMs, before: null };
  if (current.before || !snapshot) return current;
  const from = current.installedAtMs - BEFORE_WINDOW_DAYS * DAY_MS;
  return { ...current, before: turnaroundStats(snapshot.reviewing, from, current.installedAtMs) };
}

function statsLine(s: TurnaroundStats | null): string {
  if (!s) return 'not measured yet';
  if (s.count === 0) return 'no reviews delivered';
  return `${s.count} reviews · median ${s.medianHours} h · p90 ${s.p90Hours} h`;
}

/** What "Copy my review stats" puts on the clipboard: a readable summary plus one JSON line. */
export function studyReport(study: StudyRecord, snapshot: CodimangoSnapshot | null, nowMs: number): string {
  const after = snapshot ? turnaroundStats(snapshot.reviewing, study.installedAtMs, nowMs + 1) : null;
  const days = Math.floor((nowMs - study.installedAtMs) / DAY_MS);
  const installed = new Date(study.installedAtMs).toISOString().slice(0, 10);
  const json = {
    v: 1,
    installedAt: new Date(study.installedAtMs).toISOString(),
    copiedAt: new Date(nowMs).toISOString(),
    before: study.before,
    after,
  };
  return [
    `Mochi review stats (copied ${new Date(nowMs).toISOString().slice(0, 10)})`,
    `Installed: ${installed} (${days === 0 ? 'today' : `${days}d ago`})`,
    `Before Mochi (${BEFORE_WINDOW_DAYS} days before install): ${statsLine(study.before)}`,
    `Since install: ${statsLine(after)}`,
    JSON.stringify(json),
  ].join('\n');
}

export function loadStudy(): StudyRecord | null {
  try {
    return parseStudy(localStorage.getItem(STUDY_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveStudy(study: StudyRecord): void {
  try {
    localStorage.setItem(STUDY_STORAGE_KEY, JSON.stringify(study));
  } catch {
    /* storage unavailable — the study restarts next launch */
  }
}
