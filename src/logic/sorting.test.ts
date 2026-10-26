import { describe, expect, it } from 'vitest';
import type { Task } from '../types';
import { sortTasks } from './sorting';

function task(
  id: string,
  priority: Task['priority'],
  dueInMinutes: number,
): Task {
  return {
    id,
    title: id,
    kind: 'review',
    priority,
    dueInMinutes,
    author: 'test',
    detail: 'test',
  };
}

describe('sortTasks', () => {
  it('sorts by priority first: urgent, high, medium, low', () => {
    const input = [
      task('low', 'low', 1),
      task('medium', 'medium', 1),
      task('urgent', 'urgent', 9999),
      task('high', 'high', 1),
    ];
    expect(sortTasks(input).map((t) => t.id)).toEqual([
      'urgent',
      'high',
      'medium',
      'low',
    ]);
  });

  it('breaks priority ties by nearest SLA deadline', () => {
    const input = [
      task('c', 'high', 300),
      task('a', 'high', 25),
      task('b', 'high', 120),
    ];
    expect(sortTasks(input).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('prefers higher priority over a nearer deadline', () => {
    const input = [
      task('soon-but-low', 'low', 5),
      task('later-but-urgent', 'urgent', 5000),
    ];
    expect(sortTasks(input).map((t) => t.id)).toEqual([
      'later-but-urgent',
      'soon-but-low',
    ]);
  });

  it('is deterministic for full ties (falls back to id)', () => {
    const input = [task('b', 'medium', 60), task('a', 'medium', 60)];
    expect(sortTasks(input).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const input = [
      task('b', 'low', 1),
      task('a', 'urgent', 9999),
    ];
    const snapshot = [...input];
    sortTasks(input);
    expect(input).toEqual(snapshot);
  });

  it('handles an empty list', () => {
    expect(sortTasks([])).toEqual([]);
  });
});
