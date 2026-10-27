/* `npm run baseline` — your review turnaround before/after Mochi.
 *
 * Time to verdict = reviewedAt − enteredPoolAt for each review you delivered
 * (both fields stay on the task after delivery; claimedAt and the SLA deadline
 * are cleared, so they can't be measured after the fact). Prints median, p90
 * and worst over the last N days, plus reviews open right now.
 * Reads only your own reviewing feed through your codimango CLI login.
 *
 *   npm run baseline            # last 30 days
 *   npm run baseline -- 14      # last 14 days
 *   npm run baseline -- 30 --json
 */
import { listTasks } from '../electron/codimango.mjs';

const HOUR_MS = 60 * 60 * 1000;
const args = process.argv.slice(2);
const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 30);
const asJson = args.includes('--json');

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);

const res = await listTasks('reviewing');
if (!res.ok) {
  console.error(`codimango ${res.error.kind}: ${res.error.message}${res.error.fix ? ` (fix: ${res.error.fix})` : ''}`);
  process.exit(1);
}

const now = Date.now();
const since = now - days * 24 * HOUR_MS;
const hours = res.rows
  .filter((r) => r.reviewStatus !== 'being_reviewed' && r.reviewedAt && r.enteredPoolAt)
  .map((r) => ({ reviewed: Date.parse(r.reviewedAt), pooled: Date.parse(r.enteredPoolAt) }))
  .filter((r) => r.reviewed >= since && r.reviewed >= r.pooled)
  .map((r) => (r.reviewed - r.pooled) / HOUR_MS)
  .sort((a, b) => a - b);
const open = res.rows.filter((r) => r.reviewStatus === 'being_reviewed');
const overdue = open.filter((r) => r.reviewSlaDeadline && Date.parse(r.reviewSlaDeadline) < now);

const summary = {
  windowDays: days,
  delivered: hours.length,
  medianHours: round1(percentile(hours, 50)),
  p90Hours: round1(percentile(hours, 90)),
  worstHours: round1(hours.at(-1) ?? null),
  within72h: hours.filter((h) => h <= 72).length,
  openNow: open.length,
  overdueNow: overdue.length,
  measuredAt: new Date(now).toISOString(),
};

if (asJson) {
  console.log(JSON.stringify(summary));
} else {
  console.log(`Time to verdict, last ${days} days: ${summary.delivered} reviews delivered`);
  console.log(`  median ${summary.medianHours ?? '–'} h · p90 ${summary.p90Hours ?? '–'} h · worst ${summary.worstHours ?? '–'} h`);
  console.log(`  within 72 h: ${summary.within72h} of ${summary.delivered}`);
  console.log(`Open now: ${summary.openNow} (${summary.overdueNow} past SLA)`);
  if (res.rows.length >= 100) console.log('Note: first 100 reviews only.');
}
