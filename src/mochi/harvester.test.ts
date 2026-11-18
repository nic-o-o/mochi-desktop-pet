import { describe, expect, it } from 'vitest';
import { harvesterLine, plainReason, shortReason } from './harvester.ts';
import type { HarvesterTaskStatus } from './shell.ts';

describe('plainReason', () => {
  it('puts known Harvester reasons in plain words, including after "stopped before finishing"', () => {
    expect(plainReason('the durable owner is repairing or checking the task')).toBe('Working on the fix and running tests');
    expect(plainReason('calibration guard refused the candidate: a shallow task may deepen only its contract')).toMatch(/^Its own check rejected the last attempt/);
    expect(plainReason('Harvester stopped before finishing. Last: the exact revision is still being validated by Nest')).toBe(
      'Harvester stopped before finishing. Last: Pushed a fix; waiting for Codimango to validate it',
    );
  });

  it('reads the Codimango-side messages seen on real runs', () => {
    expect(plainReason('Revalidation was not started: the server could not resolve rerun policy. Retry later.')).toBe(
      "Codimango couldn't start revalidation; Harvester will retry",
    );
    expect(
      plainReason('every check that RAN passed, but the qualitative half could not run (the qualitative validation request exceeds 4194304 bytes). Publishing on a partial review'),
    ).toMatch(/over its 4 MB size limit/);
  });

  it('cuts long reasons to about one line at a word boundary', () => {
    const long = 'models:oracle was requested recently; exact-head platform failures: Oracle validation, Metacode or Opus pass/fail balance, Deep Review';
    const short = shortReason(long);
    expect(short.length).toBeLessThanOrEqual(110);
    expect(short.endsWith('…')).toBe(true);
    expect(long.startsWith(short.slice(0, -1))).toBe(true);
    expect(shortReason('Queued')).toBe('Queued');
  });

  it('reads the waits seen on Needs revision rows', () => {
    expect(plainReason('published a7c6803fb6a3 is awaiting its exact-revision verdict')).toBe('Pushed a fix; waiting for Codimango to validate it');
    expect(plainReason('quality was requested recently; exact-head platform failures: Deep Review')).toBe(
      "Codimango's own checks errored (Deep Review); asked Codimango to re-run them",
    );
    expect(plainReason('models:oracle was requested recently; next allowed after 12:00')).toBe('Asked Codimango to re-run its checks; waiting');
  });

  it('shows anything it does not know as Harvester wrote it', () => {
    expect(plainReason('Queued')).toBe('Queued');
    expect(plainReason('the errored remote component could not be identified')).toBe('the errored remote component could not be identified');
  });
});

describe('harvesterLine', () => {
  const H = 3_600_000;
  const pushedAt = Date.parse('2026-11-18T10:14:00Z');
  const status = (s: Partial<HarvesterTaskStatus>): HarvesterTaskStatus => ({
    kind: 'working',
    state: 'remote_waiting',
    reason: 'published 869775b28e1f is still being validated by Nest',
    runId: 'run-1',
    intent: 'revive',
    restartCount: 0,
    sinceMs: pushedAt,
    reasonMs: pushedAt,
    startedMs: pushedAt - H,
    taskName: 'ember-x',
    base: 'disk',
    repo: 'ember',
    ...s,
  });

  it("says when Codimango has already given the verdict Harvester is still waiting for", () => {
    const finished = pushedAt + 3 * H;
    expect(harvesterLine(status({}), { verdict: 'failed', atMs: finished }, finished + H)).toEqual({
      label: 'Harvester fixing validation',
      reason: "Codimango already finished validating the latest push (failed); Harvester hasn't picked that up yet",
      sinceMs: finished,
      attention: true,
    });
    expect(harvesterLine(status({ kind: 'stuck', reason: 'Nest has not created a validation commit or live job' }), { verdict: 'passing', atMs: finished }, finished).reason).toMatch(
      /^Codimango already finished validating the latest push \(passes\)/,
    );
  });

  it("keeps Harvester's wait while Codimango is validating, or for an hour after it pushed", () => {
    const wait = 'Pushed a fix; waiting for Codimango to validate it';
    expect(harvesterLine(status({}), { verdict: 'validating', atMs: pushedAt + H }, pushedAt + 5 * H).reason).toBe(wait);
    expect(harvesterLine(status({}), { verdict: 'unvalidated', atMs: pushedAt }, pushedAt + 5 * H).reason).toBe(wait);
    // The row's verdict is from before the push: Codimango may not have seen the push yet.
    expect(harvesterLine(status({}), { verdict: 'failed', atMs: pushedAt - H }, pushedAt + 30 * 60_000).reason).toBe(wait);
    expect(harvesterLine(status({}), undefined, pushedAt + 5 * H).attention).toBe(false);
    // Working on the fix, not waiting: Codimango's old verdict is no news.
    expect(
      harvesterLine(status({ state: 'running', reason: 'durable owner is repairing or running local checks' }), { verdict: 'failed', atMs: pushedAt + H }, pushedAt + 5 * H).reason,
    ).toBe('Working on the fix and running tests');
  });

  it('says when Harvester waits on a push Codimango never got (freeze-terminal on 11-18)', () => {
    const nov14 = Date.parse('2026-11-14T16:44:00Z');
    expect(harvesterLine(status({}), { verdict: 'failed', atMs: nov14 }, pushedAt + 2 * H)).toMatchObject({
      reason: 'Harvester is waiting, but Codimango has nothing new to validate (latest push: failed)',
      attention: true,
    });
  });

  it('says how a stopped run ended and where Codimango stands, not its last progress line', () => {
    const stopped = (reason: string) => status({ kind: 'stopped', state: 'remote_waiting', reason });
    expect(harvesterLine(stopped('Harvester stopped before finishing. Last: published a7c6803fb6a3 is awaiting its exact-revision verdict'), { verdict: 'unvalidated', atMs: pushedAt }, pushedAt)).toMatchObject({
      label: 'Harvester stopped after pushing a fix',
      reason: "Codimango hasn't validated the latest push",
      attention: true,
    });
    expect(harvesterLine(stopped('Harvester stopped before finishing. Last: the exact revision is still being validated by Nest'), { verdict: 'failed', atMs: pushedAt }, pushedAt)).toMatchObject({
      label: 'Harvester stopped after pushing a fix',
      reason: 'Codimango: the latest push failed validation',
    });
    expect(harvesterLine(stopped('Nest has not created a validation commit or live job'), { verdict: 'passing', atMs: pushedAt }, pushedAt)).toMatchObject({
      label: 'Harvester stopped while waiting for Codimango',
      reason: 'Codimango: the latest push passes validation',
    });
    // Waiting on a re-run of Codimango's checks is not a push of its own.
    expect(harvesterLine(stopped('Harvester stopped before finishing. Last: quality was requested recently; exact-head platform failures: Deep Review'), undefined, pushedAt)).toMatchObject({
      label: 'Harvester stopped while waiting for Codimango',
      reason: '',
    });
    expect(harvesterLine(stopped('Harvester stopped before finishing. Last: no lever left, and no pivot either'), { verdict: 'failed', atMs: pushedAt }, pushedAt)).toMatchObject({
      label: 'Harvester stopped before finishing',
      reason: 'Last: Out of ideas; needs you to decide',
    });
    expect(harvesterLine(stopped('Harvester stopped before finishing.'), undefined, pushedAt)).toMatchObject({ label: 'Harvester stopped before finishing', reason: '' });
    expect(harvesterLine(stopped('Exhausted the repair budget'), undefined, pushedAt)).toMatchObject({ label: 'Harvester stopped', reason: 'Exhausted the repair budget' });
  });
});
