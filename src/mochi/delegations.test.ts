// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DELEGATE_AGENT_OPTIONS,
  DELEGATE_NODE_STORAGE_KEY,
  DELEGATE_STATUS_LABELS,
  isDelegateAgent,
  isDockerMissingFailure,
  loadDelegateNode,
  removeDelegation,
  loadDelegations,
  normalizeDelegateNode,
  parseDelegations,
  recordDelegation,
  saveDelegateNode,
  saveDelegations,
} from './delegations.ts';
import type { DelegationRecord } from './delegations.ts';

const record = (over: Partial<DelegationRecord> = {}): DelegationRecord => ({
  taskSlug: 'ember-task',
  agent: 'codex',
  status: 'started',
  pid: 424242,
  logPath: '/home/zixuanchen/logs/green-1.log',
  repo: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember',
  startedAtMs: 1000,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
});

describe('parseDelegations', () => {
  it('returns nothing for missing or broken storage', () => {
    expect(parseDelegations(null)).toEqual([]);
    expect(parseDelegations('not json')).toEqual([]);
    expect(parseDelegations('{"a":1}')).toEqual([]);
    expect(parseDelegations(JSON.stringify([{ taskSlug: 1 }, record()]))).toEqual([record()]);
  });

  it('rounds trips through save and load', () => {
    saveDelegations([record()]);
    expect(loadDelegations()).toEqual([record()]);
    expect(loadDelegations()).toEqual(loadDelegations());
  });
});

describe('delegate node', () => {
  it('normalizes a node id and rejects shell-shaped input', () => {
    expect(normalizeDelegateNode(' devvm7438.hil0.facebook.com ')).toBe('devvm7438.hil0.facebook.com');
    expect(normalizeDelegateNode('HTTPS://DevVM7438.Hil0.Facebook.Com/')).toBe('devvm7438.hil0.facebook.com');
    expect(normalizeDelegateNode('zixuanchen-mac')).toBe('zixuanchen-mac');
    expect(normalizeDelegateNode('')).toBeNull();
    expect(normalizeDelegateNode(null)).toBeNull();
    expect(normalizeDelegateNode('not a node!!')).toBeNull();
    expect(normalizeDelegateNode('a..b')).toBeNull();
    expect(normalizeDelegateNode('bad; rm -rf /')).toBeNull();
  });

  it('remembers the devserver once asked, and treats junk storage as unset', () => {
    expect(loadDelegateNode()).toBeNull();
    saveDelegateNode('devvm7438.hil0.facebook.com');
    expect(loadDelegateNode()).toBe('devvm7438.hil0.facebook.com');
    saveDelegateNode(' DevVM7438.Hil0.Facebook.Com/ ');
    expect(loadDelegateNode()).toBe('devvm7438.hil0.facebook.com');
    localStorage.setItem(DELEGATE_NODE_STORAGE_KEY, '!!!');
    expect(loadDelegateNode()).toBeNull();
  });

  it('remembers which devserver a delegation ran on', () => {
    saveDelegations([record({ node: 'devvm7438.hil0.facebook.com' })]);
    expect(loadDelegations()[0].node).toBe('devvm7438.hil0.facebook.com');
  });
});

describe('live status display', () => {
  it('labels every status concisely', () => {
    expect(DELEGATE_STATUS_LABELS).toEqual({
      starting: 'Green starting',
      working: 'Green working',
      blocked: 'Green blocked',
      done: 'Green done',
      stopped: 'Green not running',
      unknown: 'Green status unknown',
    });
  });

});

describe('recordDelegation', () => {
  it('replaces the record for a task and moves it first', () => {
    const first = record({ pid: 1, startedAtMs: 1000 });
    const other = record({ taskSlug: 'other-task', pid: 2, startedAtMs: 2000 });
    const next = recordDelegation([first, other], record({ pid: 3, startedAtMs: 3000 }));
    expect(next.map((r) => r.pid)).toEqual([3, 2]);
    expect(next[0].taskSlug).toBe('ember-task');
  });

  it('keeps at most twenty records, newest first', () => {
    // Input in the stored newest-first order: task-19 newest, task-0 oldest.
    const many = Array.from({ length: 20 }, (_, i) => record({ taskSlug: `task-${19 - i}`, pid: 19 - i, startedAtMs: 19 - i }));
    const next = recordDelegation(many, record({ taskSlug: 'task-new', pid: 99, startedAtMs: 100 }));
    expect(next).toHaveLength(20);
    expect(next[0].taskSlug).toBe('task-new');
    expect(next.some((r) => r.taskSlug === 'task-0')).toBe(false);
  });

  it('saves a failed delegation so the panel can show what went wrong', () => {
    const next = recordDelegation([], record({ status: 'failed', pid: null, logPath: null, errorMessage: 'repo not found' }));
    expect(next[0].status).toBe('failed');
    expect(next[0].errorMessage).toBe('repo not found');
  });
});

describe('delegate agent options', () => {
  it('offers Muse and Codex, with MetaCode and Claude Code unavailable', () => {
    expect(DELEGATE_AGENT_OPTIONS).toEqual([
      { id: 'muse', label: 'Muse', available: true },
      { id: 'codex', label: 'Codex', available: true },
      { id: 'metacode', label: 'MetaCode', available: false },
      { id: 'claude', label: 'Claude Code', available: false },
    ]);
  });

  it('accepts only Muse and Codex as Green repair agents', () => {
    expect(isDelegateAgent('muse')).toBe(true);
    expect(isDelegateAgent('codex')).toBe(true);
    expect(isDelegateAgent('metacode')).toBe(false);
    expect(isDelegateAgent('claude')).toBe(false);
    expect(isDelegateAgent('')).toBe(false);
    expect(isDelegateAgent(null)).toBe(false);
  });
});

describe('docker-missing failures', () => {
  it('recognizes the docker check, and falls back to the old message text for records saved before it', () => {
    expect(isDockerMissingFailure(record({ status: 'failed', errorKind: 'doctor_failed', errorCheck: 'docker' }))).toBe(true);
    expect(
      isDockerMissingFailure(
        record({
          status: 'failed',
          errorKind: 'doctor_failed',
          errorMessage: 'Green doctor failed in /home/debrax/AAI/x. docker          MISSING -- local task proof',
        }),
      ),
    ).toBe(true);
    expect(isDockerMissingFailure(record({ status: 'failed', errorKind: 'doctor_failed', errorMessage: 'Green doctor failed.' }))).toBe(false);
    expect(isDockerMissingFailure(record())).toBe(false);
    expect(isDockerMissingFailure(null)).toBe(false);
  });

  it('removes one task record without mutating the list', () => {
    const other = record({ taskSlug: 'other-task' });
    const before = [record(), other];
    const next = removeDelegation(before, 'ember-task');
    expect(next).toEqual([other]);
    expect(before).toHaveLength(2);
  });
});
