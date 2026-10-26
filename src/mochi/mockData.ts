import type { TaskItem, WeeklyGoals } from './logic.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Fixed mock offsets from load time so SLA scenarios are always demonstrable. */
function dueIn(ms: number): number {
  return Date.now() + ms;
}

export const DEFAULT_GOALS: WeeklyGoals = { reviewGoal: 5, submissionGoal: 4 };

/** Completed counts this week. Reviews intentionally exceed the goal to show ring capping. */
export const WEEKLY_COMPLETED = { reviewsCompleted: 7, submissionsCompleted: 3 };

export const GOALS_STORAGE_KEY = 'mochi.goals.v1';
export const PET_POS_STORAGE_KEY = 'mochi.petPos.v1';

export function loadGoals(): WeeklyGoals {
  try {
    const raw = localStorage.getItem(GOALS_STORAGE_KEY);
    if (!raw) return DEFAULT_GOALS;
    const parsed = JSON.parse(raw) as Partial<WeeklyGoals>;
    const reviewGoal =
      typeof parsed.reviewGoal === 'number' &&
      Number.isInteger(parsed.reviewGoal) &&
      parsed.reviewGoal >= 1
        ? parsed.reviewGoal
        : DEFAULT_GOALS.reviewGoal;
    const submissionGoal =
      typeof parsed.submissionGoal === 'number' &&
      Number.isInteger(parsed.submissionGoal) &&
      parsed.submissionGoal >= 1
        ? parsed.submissionGoal
        : DEFAULT_GOALS.submissionGoal;
    return { reviewGoal, submissionGoal };
  } catch {
    return DEFAULT_GOALS;
  }
}

export function saveGoals(goals: WeeklyGoals): void {
  try {
    localStorage.setItem(GOALS_STORAGE_KEY, JSON.stringify(goals));
  } catch {
    /* storage unavailable (private mode, tests) — goals still apply for the session */
  }
}

export const MOCK_TASKS: TaskItem[] = [
  {
    id: 'T-1042',
    title: 'Checkout flow refactor',
    type: 'Code review',
    priority: 'urgent',
    status: 'pending_review',
    slaDueMs: dueIn(35 * MIN),
    description:
      'Refactors the checkout state machine into smaller reducers. Please check the payment retry path and the new error boundary before sign-off.',
    requester: 'Priya N.',
  },
  {
    id: 'T-1043',
    title: 'Payments SLA copy pass',
    type: 'Doc review',
    priority: 'urgent',
    status: 'revision_required',
    slaDueMs: dueIn(50 * MIN),
    description:
      'Second pass on the payments SLA wording. Legal flagged two paragraphs; the author has addressed one and needs a decision on the refund window phrasing.',
    requester: 'Marcus L.',
  },
  {
    id: 'T-1044',
    title: 'OAuth token rotation',
    type: 'Security review',
    priority: 'urgent',
    status: 'pending_review',
    slaDueMs: dueIn(3 * HOUR),
    description:
      'Rotates OAuth refresh tokens on each use. Review the migration plan for existing sessions and the fallback when the token endpoint is slow.',
    requester: 'Aisha K.',
  },
  {
    id: 'T-1045',
    title: 'Onboarding empty states',
    type: 'Design review',
    priority: 'high',
    status: 'pending_review',
    slaDueMs: dueIn(2 * HOUR),
    description:
      'Empty-state illustrations and copy for the new onboarding checklist. Three variants to compare; accessibility notes are attached to the mock.',
    requester: 'Diego R.',
  },
  {
    id: 'T-1046',
    title: 'Push notification payload',
    type: 'Code review',
    priority: 'high',
    status: 'revision_required',
    slaDueMs: dueIn(5 * HOUR),
    description:
      'Shrinks the push payload and adds a version flag. Revision requested: add a fallback for older clients that ignore the new flag.',
    requester: 'Sofia M.',
  },
  {
    id: 'T-1047',
    title: 'Avatar upload edge cases',
    type: 'QA sign-off',
    priority: 'normal',
    status: 'pending_review',
    slaDueMs: dueIn(15 * MIN),
    description:
      'Sign-off on avatar upload retries after network drops. The SLA clock is almost out — a quick pass over the two failing device logs is enough.',
    requester: 'Tom H.',
  },
  {
    id: 'T-1048',
    title: 'Weekly analytics export',
    type: 'QA sign-off',
    priority: 'normal',
    status: 'pending_review',
    slaDueMs: dueIn(26 * HOUR),
    description:
      'Routine sign-off that the weekly export matches the dashboard totals. Spot-check the top three rows and confirm the CSV encoding.',
    requester: 'Lena W.',
  },
  {
    id: 'T-1049',
    title: 'Dark mode contrast fixes',
    type: 'Design review',
    priority: 'low',
    status: 'revision_required',
    slaDueMs: dueIn(-20 * MIN),
    description:
      'Contrast fixes for dark mode missed the AA threshold on two surfaces. The SLA has lapsed; still worth a quick look so it can ship with the next train.',
    requester: 'Diego R.',
  },
  {
    id: 'T-1050',
    title: 'Help center IA draft',
    type: 'Doc review',
    priority: 'low',
    status: 'pending_review',
    slaDueMs: dueIn(3 * 24 * HOUR),
    description:
      'Early draft of the help-center information architecture. No rush — comments on section grouping are welcome whenever there is time.',
    requester: 'Priya N.',
  },
];

export interface NotificationTemplate {
  title: string;
  body: string;
}

export const NOTIFICATION_TEMPLATES: NotificationTemplate[] = [
  {
    title: 'Review requested',
    body: 'Priya N. requested your review on “Checkout flow refactor”.',
  },
  {
    title: 'SLA approaching',
    body: '“Avatar upload edge cases” needs QA sign-off in about 15 minutes.',
  },
  {
    title: 'Revision submitted',
    body: 'Marcus L. resubmitted “Payments SLA copy pass” for another look.',
  },
  {
    title: 'Urgent review',
    body: 'Aisha K. flagged “OAuth token rotation” as urgent security review.',
  },
];
