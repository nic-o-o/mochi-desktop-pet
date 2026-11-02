/* Shared by the pool section and its tests. */
import type { PoolTask } from './shell.ts';

export const CODIMANGO_TASK_URL = 'https://codimango.internalmeta.com/submissions/';

/** Who's on it: free to pick up, claimed, handed back, or the owner is still at it. */
export function poolState(t: PoolTask): string {
  if (t.outcome) return `${t.outcome === 'no-lever' ? 'no trap found' : 'brief sent'} by ${t.claimedBy}`;
  if (t.claimedBy) return `${t.claimedBy} is on it`;
  if (t.active) return 'owner is working on it';
  return 'open';
}
