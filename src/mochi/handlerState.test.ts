// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { deriveRowState } from './handlerState.ts';
import type { HandlerProbe } from './delegations.ts';
import type { DelegationRecord } from './delegations.ts';

const probe = (over: Partial<HandlerProbe> = {}): HandlerProbe => ({
  handler: 'green',
  pid: 99,
  logPath: '/tmp/old.log',
  agent: 'codex',
  kind: 'working',
  lastDecision: 'DECIDE FIX: x',
  lastActivityAgeSecs: 60,
  waitingMins: null,
  waitingReason: null,
  blockedReason: null,
  hasBlocked: false,
  hasTimingZero: false,
  leaseAgeSecs: null,
  checkedAtMs: 1000,
  ...over,
});

const record = (over: Partial<DelegationRecord> = {}): DelegationRecord => ({
  taskSlug: 'ember-task',
  agent: 'codex',
  status: 'started',
  pid: 99,
  logPath: '/tmp/old.log',
  repo: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember',
  startedAtMs: 1000,
  ...over,
});

describe('deriveRowState', () => {
  it('shows a live working worker with no Delegate button', () => {
    const state = deriveRowState({ probe: probe(), probeState: 'ok', record: record(), reviewJobRunning: false });
    expect(state.phase).toBe('running');
    expect(state.statusText).toBe('Green working');
    expect(state.statusClass).toBe('agent-done');
    expect(state.showDelegate).toBe(false);
    expect(state.interruptible).toBe(false);
  });

  it('shows a live starting worker with no Delegate button', () => {
    const state = deriveRowState({ probe: probe({ kind: 'starting', lastDecision: null }), probeState: 'ok', record: record(), reviewJobRunning: false });
    expect(state.statusText).toBe('Green starting');
    expect(state.showDelegate).toBe(false);
  });

  it('shows waiting with the waited-on reason and elapsed minutes, and hides Delegate for a short wait', () => {
    const state = deriveRowState({
      probe: probe({ waitingMins: 10, waitingReason: 'Agentic trial-output review, Codex run' }),
      probeState: 'ok',
      record: record(),
      reviewJobRunning: false,
    });
    expect(state.phase).toBe('waiting');
    expect(state.statusText).toBe('Green waiting · Agentic trial-output review, Codex run (10m)');
    expect(state.showDelegate).toBe(false);
    expect(state.interruptible).toBe(false);
    expect(state.stopPid).toBeNull();
  });

  it('offers stop and delegate for a long wait, at the 30-minute boundary and above', () => {
    for (const mins of [30, 56, 72]) {
      const state = deriveRowState({
        probe: probe({ waitingMins: mins, waitingReason: 'Agentic trial-output review' }),
        probeState: 'ok',
        record: record(),
        reviewJobRunning: false,
      });
      expect(state.phase).toBe('waiting');
      expect(state.showDelegate).toBe(true);
      expect(state.interruptible).toBe(true);
      expect(state.stopPid).toBe(99);
    }
    const short = deriveRowState({
      probe: probe({ waitingMins: 29, waitingReason: 'Agentic trial-output review' }),
      probeState: 'ok',
      record: record(),
      reviewJobRunning: false,
    });
    expect(short.showDelegate).toBe(false);
    expect(short.interruptible).toBe(false);
  });

  it('shows the full waiting reason without truncating it', () => {
    const reason = 'Agentic trial-output review, Codex run, Programming language detection, Oracle validation, and several more lanes besides';
    const state = deriveRowState({
      probe: probe({ waitingMins: 72, waitingReason: reason }),
      probeState: 'ok',
      record: record(),
      reviewJobRunning: false,
    });
    expect(state.statusText).toBe(`Green waiting · ${reason} (72m)`);
  });

  it('treats a live but long-silent worker as stuck and interruptible', () => {
    const state = deriveRowState({ probe: probe({ lastActivityAgeSecs: 3600 }), probeState: 'ok', record: record(), reviewJobRunning: false });
    expect(state.phase).toBe('stuck');
    expect(state.statusText).toBe('Green stuck · no activity for 60m');
    expect(state.showDelegate).toBe(true);
    expect(state.interruptible).toBe(true);
    expect(state.stuckPid).toBe(99);
    expect(state.stopPid).toBe(99);
  });

  it('does not call a live worker stuck when its log age is unknown', () => {
    const state = deriveRowState({ probe: probe({ lastActivityAgeSecs: null }), probeState: 'ok', record: record(), reviewJobRunning: false });
    expect(state.phase).toBe('running');
    expect(state.interruptible).toBe(false);
  });

  it('shows a dead worker as done, blocked, or not running from its log evidence', () => {
    const dead = (over: Partial<HandlerProbe> = {}) => probe({ handler: 'none', pid: null, kind: 'stopped', ...over });
    expect(deriveRowState({ probe: dead({ kind: 'done', hasTimingZero: true }), probeState: 'ok', record: record(), reviewJobRunning: false }).statusText).toBe('Green done');
    const blocked = deriveRowState({
      probe: dead({ kind: 'blocked', hasBlocked: true, blockedReason: 'F2: the contract cannot work' }),
      probeState: 'ok',
      record: record(),
      reviewJobRunning: false,
    });
    expect(blocked.phase).toBe('blocked');
    expect(blocked.statusText).toBe('Green blocked · F2: the contract cannot work');
    expect(blocked.showDelegate).toBe(true);
    expect(deriveRowState({ probe: dead(), probeState: 'ok', record: record(), reviewJobRunning: false }).statusText).toBe('Green not running');
  });

  it('labels a blocked worker as needing input when its reason asks for a decision', () => {
    const state = deriveRowState({
      probe: probe({ handler: 'none', pid: null, kind: 'blocked', hasBlocked: true, blockedReason: 'F2: needs an approver decision on the new API surface' }),
      probeState: 'ok',
      record: record(),
      reviewJobRunning: false,
    });
    expect(state.needsInput).toBe(true);
    expect(state.statusText).toContain('needs your input');
  });

  it('shows the started placeholder while the first probe is still pending', () => {
    const state = deriveRowState({ probe: null, probeState: 'pending', record: record(), reviewJobRunning: false });
    expect(state.phase).toBe('starting');
    expect(state.statusText).toBe('Green started');
    expect(state.showDelegate).toBe(false);
  });

  it('shows unknown when the probe fails for a started record, and nothing without one', () => {
    const withRecord = deriveRowState({ probe: null, probeState: 'failed', record: record(), reviewJobRunning: false });
    expect(withRecord.statusText).toBe('Green status unknown');
    expect(withRecord.showDelegate).toBe(true);
    const withoutRecord = deriveRowState({ probe: null, probeState: 'failed', record: null, reviewJobRunning: false });
    expect(withoutRecord.statusText).toBeNull();
    expect(withoutRecord.showDelegate).toBe(true);
  });

  it('lets a live probe beat a stale failed record', () => {
    const failed = record({ status: 'failed', pid: null, logPath: null, errorKind: 'doctor_failed', errorCheck: 'docker', errorMessage: 'Green doctor failed.' });
    const state = deriveRowState({ probe: probe(), probeState: 'ok', record: failed, reviewJobRunning: false });
    expect(state.phase).toBe('running');
    expect(state.showDelegate).toBe(false);
    expect(state.showInstallDocker).toBe(false);
  });

  it('renders a Docker-missing setup failure as a status line with Install Docker, no Delegate button', () => {
    const state = deriveRowState({
      probe: probe({ handler: 'none', pid: null, kind: null }),
      probeState: 'ok',
      record: record({ status: 'failed', pid: null, logPath: null, errorKind: 'doctor_failed', errorCheck: 'docker', errorMessage: 'Green doctor failed.' }),
      reviewJobRunning: false,
    });
    expect(state.phase).toBe('setup-blocked');
    expect(state.statusText).toBe('Docker is missing on your devserver');
    expect(state.showDelegate).toBe(false);
    expect(state.showInstallDocker).toBe(true);
  });

  it('renders other setup failures with the Delegate button kept as the retry', () => {
    for (const [errorKind, statusText] of [
      ['doctor_failed', 'Green doctor failed on your devserver'],
      ['green_missing', 'Green is not installed on your devserver'],
      ['repo_not_found', 'Task checkout not found on your devserver'],
      ['checkout_stale', 'Task checkout is out of date on your devserver'],
      ['agentcloud_missing', 'agentcloudctl is not installed on this Mac'],
      ['node_error', 'Could not reach your devserver'],
    ] as const) {
      const state = deriveRowState({
        probe: probe({ handler: 'none', pid: null, kind: null }),
        probeState: 'ok',
        record: record({ status: 'failed', pid: null, logPath: null, errorKind, errorMessage: 'x' }),
        reviewJobRunning: false,
      });
      expect(state.phase).toBe('setup-blocked');
      expect(state.statusText).toBe(statusText);
      expect(state.showDelegate).toBe(true);
      expect(state.showInstallDocker).toBe(false);
    }
  });

  it('renders a plain launch failure as not running, and a missing devserver as idle', () => {
    const launched = deriveRowState({
      probe: probe({ handler: 'none', pid: null, kind: null }),
      probeState: 'ok',
      record: record({ status: 'failed', pid: null, logPath: null, errorKind: 'launch_failed', errorMessage: 'x' }),
      reviewJobRunning: false,
    });
    expect(launched.statusText).toBe('Green not running');
    expect(launched.showDelegate).toBe(true);
    const noNode = deriveRowState({
      probe: probe({ handler: 'none', pid: null, kind: null }),
      probeState: 'ok',
      record: record({ status: 'failed', pid: null, logPath: null, errorKind: 'node_missing', errorMessage: 'x' }),
      reviewJobRunning: false,
    });
    expect(noNode.statusText).toBeNull();
    expect(noNode.showDelegate).toBe(true);
  });

  it('names a running agent review without blocking delegation', () => {
    const state = deriveRowState({ probe: probe({ handler: 'none', pid: null, kind: null }), probeState: 'ok', record: null, reviewJobRunning: true });
    expect(state.statusText).toBe('Agent review running');
    expect(state.handler).toBe('agent-review');
    expect(state.showDelegate).toBe(true);
  });

  it('shows nothing for an idle row', () => {
    const state = deriveRowState({ probe: probe({ handler: 'none', pid: null, kind: null }), probeState: 'ok', record: null, reviewJobRunning: false });
    expect(state.statusText).toBeNull();
    expect(state.showDelegate).toBe(true);
    expect(state.phase).toBe('idle');
  });
});
