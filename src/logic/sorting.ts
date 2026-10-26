import type { Priority, Task } from '../types';

export const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/**
 * Sort first by priority (urgent first), then by nearest SLA deadline.
 * Ties fall back to id so the order is fully deterministic.
 */
export function compareTasks(a: Task, b: Task): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  if (a.dueInMinutes !== b.dueInMinutes) {
    return a.dueInMinutes - b.dueInMinutes;
  }
  return a.id.localeCompare(b.id);
}

/** Non-mutating sort; the input array is never modified. */
export function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(compareTasks);
}
