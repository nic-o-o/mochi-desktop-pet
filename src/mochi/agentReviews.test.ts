import { describe, expect, it } from 'vitest';
import type { AgentJob } from './agentReviews.ts';
import { isStale, jobLine, jobsForTask, newlyFinished, rememberSkill, rememberedSkill } from './agentReviews.ts';
import type { ReviewSkill } from './agentReviews.ts';
import type { TaskItem } from './logic.ts';

const NOW = 1_800_000_000_000;
const job = (over: Partial<AgentJob>): AgentJob => ({
  id: 'j1',
  taskId: 'r1',
  taskName: 'ember-turn-timer',
  taskUpdatedAtMs: NOW - 60_000,
  agent: 'claude',
  status: 'running',
  steps: 0,
  createdAtMs: NOW - 13 * 60_000,
  startedAtMs: NOW - 12 * 60_000,
  ...over,
});

describe('jobLine', () => {
  it('says what each agent is doing in the row', () => {
    expect(jobLine(job({}), NOW)).toBe('Claude Code reviewing · 12 min');
    expect(jobLine(job({ startedAtMs: NOW - 5_000 }), NOW)).toBe('Claude Code reviewing · under a minute');
    expect(jobLine(job({ status: 'queued', agent: 'codex' }), NOW)).toBe('Codex waiting to start');
    expect(jobLine(job({ status: 'done' }), NOW)).toBe('Claude Code · report ready');
    expect(jobLine(job({ status: 'failed', failure: { kind: 'timeout', message: '' } }), NOW)).toBe('Claude Code · failed');
    expect(jobLine(job({ status: 'failed', failure: { kind: 'cancelled', message: '' } }), NOW)).toBe('Claude Code · stopped');
  });
});

describe('skills', () => {
  it('names a chosen skill in the row', () => {
    expect(jobLine(job({ status: 'done', skill: { id: 'personal:mine', label: 'mine' } }), NOW)).toBe('Claude Code · mine · report ready');
  });

  it('remembers the last skill only while it is still offered', () => {
    const skills: ReviewSkill[] = [
      { id: 'default', source: 'default', label: 'Codimango review assistant (default)' },
      { id: 'personal:mine', source: 'personal', label: 'mine' },
    ];
    const store = new Map<string, string>();
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    try {
      expect(rememberedSkill(skills)).toBe('default');
      rememberSkill('personal:mine');
      expect(rememberedSkill(skills)).toBe('personal:mine');
      expect(rememberedSkill(skills.slice(0, 1))).toBe('default');
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
  });
});

describe('jobsForTask', () => {
  it('keeps the latest run per agent, Claude first', () => {
    const jobs = [job({ id: 'a', agent: 'codex' }), job({ id: 'b' }), job({ id: 'c', taskId: 'r2' }), job({ id: 'd' })];
    expect(jobsForTask(jobs, 'r1').map((j) => j.id)).toEqual(['d', 'a']);
  });
});

describe('newlyFinished', () => {
  it('reports runs that just finished, not ones loaded finished or stopped by the person', () => {
    const prev = [job({ id: 'a' }), job({ id: 'b', agent: 'codex' }), job({ id: 'c', status: 'done' })];
    const next = [
      job({ id: 'a', status: 'done' }),
      job({ id: 'b', agent: 'codex', status: 'failed', failure: { kind: 'cancelled', message: '' } }),
      job({ id: 'c', status: 'done' }),
    ];
    expect(newlyFinished(prev, next).map((j) => j.id)).toEqual(['a']);
    expect(newlyFinished([], next)).toEqual([]);
  });
});

describe('isStale', () => {
  it('is stale once the task changed after the run started', () => {
    const task = { updatedAtMs: NOW } as TaskItem;
    expect(isStale(job({ taskUpdatedAtMs: NOW - 1 }), task)).toBe(true);
    expect(isStale(job({ taskUpdatedAtMs: NOW }), task)).toBe(false);
    expect(isStale(job({ taskUpdatedAtMs: null }), task)).toBe(false);
    expect(isStale(job({}), undefined)).toBe(false);
  });
});
