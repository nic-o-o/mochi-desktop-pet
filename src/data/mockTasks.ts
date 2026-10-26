import type { Goals, Task, WeeklyProgress } from '../types';

export const DEFAULT_GOALS: Goals = {
  reviewGoal: 10,
  submissionGoal: 12,
};

/** Mock completed counts for the current week (local data only). */
export const WEEKLY_PROGRESS: WeeklyProgress = {
  reviewsCompleted: 7,
  submissionsCompleted: 13, // intentionally above the default goal: ring caps, text shows 13
};

/**
 * Fixed mock task set covering: pending review, revision required,
 * urgent items, and approaching-SLA deadlines.
 */
export const MOCK_TASKS: Task[] = [
  {
    id: 't-finance-review',
    title: 'Review Q3 expense report batch',
    kind: 'review',
    priority: 'urgent',
    dueInMinutes: 25,
    author: 'Priya N.',
    detail:
      'Twelve expense reports are waiting for a final check. Verify receipts against the travel policy, then approve or send back with a note.',
  },
  {
    id: 't-deploy-checklist',
    title: 'Pre-deploy checklist sign-off',
    kind: 'submission',
    priority: 'urgent',
    dueInMinutes: 45,
    author: 'Ops rotation',
    detail:
      'Friday deploy window closes soon. Confirm migrations, feature flags, and the rollback plan, then submit the sign-off.',
  },
  {
    id: 't-onboarding-copy',
    title: 'Revise onboarding checklist copy',
    kind: 'revision',
    priority: 'high',
    dueInMinutes: 50,
    author: 'Dana K.',
    detail:
      'Reviewer asked for shorter steps and a friendlier tone. Two paragraphs are flagged inline; address them and re-submit.',
  },
  {
    id: 't-rate-limit',
    title: 'API rate-limit proposal',
    kind: 'review',
    priority: 'high',
    dueInMinutes: 120,
    author: 'Miguel A.',
    detail:
      'Proposal to raise the partner rate limit. Check the load-test numbers in section 3 before approving.',
  },
  {
    id: 't-splash-art',
    title: 'Revise mobile splash illustration',
    kind: 'revision',
    priority: 'medium',
    dueInMinutes: 180,
    author: 'June P.',
    detail:
      'Contrast on the splash headline fails AA. Adjust the gradient stops and re-export at 2x and 3x.',
  },
  {
    id: 't-notif-queue',
    title: 'Refactor notification queue worker',
    kind: 'review',
    priority: 'medium',
    dueInMinutes: 300,
    author: 'Sam R.',
    detail:
      'This change refactors the retry backoff. Focus review on the DLQ path and the new jitter math.',
  },
  {
    id: 't-status-summary',
    title: 'Weekly status summary draft',
    kind: 'submission',
    priority: 'low',
    dueInMinutes: 1440,
    author: 'You',
    detail:
      'Draft is 80% done. Fill in the risks section and submit before Monday standup.',
  },
  {
    id: 't-a11y-audit',
    title: 'Accessibility audit: settings page',
    kind: 'review',
    priority: 'low',
    dueInMinutes: 2880,
    author: 'A11y guild',
    detail:
      'Routine audit sweep. Eleven findings, mostly label associations. No rush, but keep the streak alive.',
  },
];
