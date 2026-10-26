import type { TaskItem, WeeklyGoals } from './logic.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Fixed mock offsets from load time so SLA scenarios are always demonstrable. */
function dueIn(ms: number): number {
  return Date.now() + ms;
}

export const DEFAULT_GOALS: WeeklyGoals = { reviewGoal: 5, submissionGoal: 2 };

/** Completed counts this week: 1/5 reviewed, 2/2 accepted. */
export const WEEKLY_COMPLETED = { reviewsCompleted: 1, submissionsCompleted: 2 };

/* v3: accepted-goal default is now 2, so stored v2 goals don't linger. */
export const GOALS_STORAGE_KEY = 'mochi.goals.v3';
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
    id: 'T-2001',
    title: 'ember-campfire-create-uniqueness',
    type: 'Validation',
    priority: 'urgent',
    status: 'revision_required',
    slaDueMs: dueIn(2 * HOUR),
    description:
      'Uniqueness check on campfire creation failed Oracle sampling 1 of 3. Rework the dedupe key, then request another validation pass.',
    requester: 'Arnav Narula',
    checkSummary: 'Oracle 1/3',
  },
  {
    id: 'T-2002',
    title: 'ember-campfire-retention-age-trim',
    type: 'Validation',
    priority: 'low',
    status: 'revision_required',
    slaDueMs: dueIn(30 * HOUR),
    description:
      'Retention age trim failed 5 validation checks. Address the failing checks and request another validation pass.',
    requester: 'Debra Xu',
    checkSummary: '5 checks failed',
  },
  {
    id: 'T-2003',
    title: 'ember-llm-egress-failover-complete',
    type: 'Code review',
    priority: 'high',
    status: 'pending_review',
    slaDueMs: dueIn(-45 * MIN),
    description:
      'Failover-complete signal for LLM egress is past due. Arnav is waiting on sign-off to close the rollout.',
    requester: 'Arnav Narula',
  },
  {
    id: 'T-2004',
    title: 'automend-add-aggregate-persistence-schema',
    type: 'Code review',
    priority: 'normal',
    status: 'pending_review',
    slaDueMs: dueIn(5 * HOUR),
    description:
      'Aggregate persistence schema for automend, submitted this morning. Review the migration before end of day.',
    requester: 'Sai Sriram Morthi',
    submittedBy: 'Sai Sriram Morthi',
  },
  {
    id: 'T-2005',
    title: 'ember-creature-reply-no-bump',
    type: 'Code review',
    priority: 'low',
    status: 'pending_review',
    slaDueMs: dueIn(26 * HOUR),
    description:
      'Reply-no-bump behavior for creature notifications, assigned yesterday and due tomorrow.',
    requester: 'Debra Xu',
  },
];

export interface NotificationTemplate {
  title: string;
  body: string;
}

export const NOTIFICATION_TEMPLATES: NotificationTemplate[] = [
  {
    title: 'Review requested',
    body: 'Arnav Narula requested your review on “ember-llm-egress-failover-complete”.',
  },
  {
    title: 'SLA approaching',
    body: '“automend-add-aggregate-persistence-schema” is due later today.',
  },
  {
    title: 'Revision submitted',
    body: '“ember-campfire-create-uniqueness” failed validation — Oracle 1/3.',
  },
  {
    title: 'Assigned to you',
    body: 'Debra Xu assigned “ember-creature-reply-no-bump” to you.',
  },
];
