import { describe, expect, it } from 'vitest';
import {
  harvesterStatuses,
  harvesterStatusesOnNode,
  mapRun,
  parseRemoteOutput,
  remoteScript,
  restartHarvesterTask,
  restartHarvesterTaskOnNode,
  runReason,
  statusesFromRuns,
  stopHarvesterRun,
  stopHarvesterRunOnNode,
} from './harvester.mjs';

const T = 1_794_500_000; // seconds, like Harvester's records

describe('mapRun', () => {
  it('maps Harvester run states to working, stuck, done and stopped', () => {
    expect(mapRun({ state: 'running' }).kind).toBe('working');
    expect(mapRun({ state: 'running', stalled_since: T }).kind).toBe('stuck');
    expect(mapRun({ state: 'running', detail: { timing: { phase: 'platform_blocked' } } }).kind).toBe('stuck');
    expect(mapRun({ state: 'queued' }).kind).toBe('working');
    expect(mapRun({ state: 'remote_waiting' }).kind).toBe('working');
    expect(mapRun({ state: 'infrastructure_blocked', restart_count: 1 }).kind).toBe('working');
    expect(mapRun({ state: 'infrastructure_blocked', restart_count: 3 }).kind).toBe('stuck');
    expect(mapRun({ state: 'done', detail: { outcome: 'green' } }).kind).toBe('done');
    expect(mapRun({ state: 'done', detail: { outcome: 'exhausted' } }).kind).toBe('stopped');
    expect(mapRun({ state: 'failed' }).kind).toBe('stopped');
    expect(mapRun({ state: 'cancelled' }).kind).toBe('stopped');
    expect(mapRun({ state: 'something-new' })).toBeNull();
    expect(mapRun(null)).toBeNull();
  });

  it('explains with the board reason, then a state gloss', () => {
    expect(mapRun({ state: 'remote_waiting' }).reason).toBe('Waiting for validation');
    expect(mapRun({ state: 'running', stalled_since: T }).reason).toBe('No output for over 10 minutes');
    expect(mapRun({ state: 'failed', failure: { cause: 'docker daemon not running' } }).reason).toBe('docker daemon not running');
  });

  it('keeps the intent so Restart revives the same way, and reads seconds or ms times', () => {
    const r = mapRun({ state: 'failed', intent: 'revision', started_at: T, last_progress_at: T + 60 });
    expect(r.intent).toBe('revision');
    expect(r.startedMs).toBe(T * 1000);
    expect(r.sinceMs).toBe((T + 60) * 1000);
    expect(mapRun({ state: 'failed', intent: 'weird' }).intent).toBe('revive');
  });
});

describe('runReason', () => {
  it('prefers detail.detail, then means, then failure.cause, one line and capped', () => {
    expect(runReason({ detail: { detail: 'oracle 1/3 failing\nmore', means: 'x' } })).toBe('oracle 1/3 failing');
    expect(runReason({ detail: { means: 'needs a person' }, failure: { cause: 'c' } })).toBe('needs a person');
    expect(runReason({ failure: { cause: 'c' } })).toBe('c');
    expect(runReason({ detail: { detail: 'a'.repeat(400) } })).toHaveLength(200);
    expect(runReason({})).toBe('');
  });
});

describe('statusesFromRuns', () => {
  it('keeps the latest run per task and skips rows without a task name', () => {
    const out = statusesFromRuns(
      [
        { id: 'old', task_name: 'ember-a', state: 'failed', started_at: T },
        { id: 'new', task_name: 'ember-a', state: 'running', started_at: T + 100 },
        { id: 'x', state: 'running' },
        { id: 'b', task_name: 'ember-b', state: 'done', detail: { outcome: 'green' }, started_at: T },
      ],
      { base: 'http://127.0.0.1:44101', repo: 'ember' },
    );
    expect(Object.keys(out).sort()).toEqual(['ember-a', 'ember-b']);
    expect(out['ember-a']).toMatchObject({ kind: 'working', runId: 'new', repo: 'ember', base: 'http://127.0.0.1:44101' });
    expect(out['ember-b'].kind).toBe('done');
  });
});

function fakeBoard(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    const handler = routes[`${u.port} ${init.method ?? 'GET'} ${u.pathname}`];
    if (!handler) throw new TypeError('fetch failed');
    const [status, body] = handler(u, init);
    return { ok: status < 400, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

describe('harvesterStatuses', () => {
  it('finds the board on its port, reads every project, and says when none answers', async () => {
    const { fetchImpl, calls } = fakeBoard({
      '44101 GET /api/projects': () => [200, [{ name: 'ember' }]],
      '44101 GET /api/taskflow-state': (u) => [200, { runs: u.searchParams.get('repo') === 'ember' && u.searchParams.get('fast') === '1' ? [{ id: 'r1', task_name: 'ember-a', state: 'running' }] : [] }],
    });
    const res = await harvesterStatuses({ fetchImpl, ports: [44101, 44102] });
    expect(res.available).toBe(true);
    expect(res.statuses['ember-a']).toMatchObject({ kind: 'working', base: 'http://127.0.0.1:44101', repo: 'ember' });
    expect(calls.every((c) => !c.url.includes('token='))).toBe(true);
    const none = await harvesterStatuses({ fetchImpl: fakeBoard({}).fetchImpl, ports: [44101] });
    expect(none).toEqual({ available: false, statuses: {} });
  });

  it('passes a board token on every read', async () => {
    const { fetchImpl, calls } = fakeBoard({
      '44101 GET /api/projects': () => [200, [{ name: 'ember' }]],
      '44101 GET /api/taskflow-state': () => [200, { runs: [] }],
    });
    await harvesterStatuses({ fetchImpl, ports: [44101], token: 's3cret' });
    expect(calls.map((c) => new URL(c.url).searchParams.get('token'))).toEqual(['s3cret', 's3cret']);
  });
});

describe('stop and restart', () => {
  it('stops a run as its owner', async () => {
    const { fetchImpl, calls } = fakeBoard({ '44101 POST /api/cancel-run': () => [200, { ok: true }] });
    const r = await stopHarvesterRun({ base: 'http://127.0.0.1:44101', runId: 'r1', owner: 'debrax' }, { fetchImpl });
    expect(r.ok).toBe(true);
    expect(JSON.parse(calls[0].init.body)).toEqual({ id: 'r1', owner: 'debrax' });
  });

  it('restarts with the run intent and reports Harvester refusals', async () => {
    const { fetchImpl, calls } = fakeBoard({ '44101 POST /api/taskflow-bulk': () => [409, { ok: false, error: 'a run is still active' }] });
    const r = await restartHarvesterTask({ base: 'http://127.0.0.1:44101', repo: 'ember', taskName: 'ember-a', intent: 'revision', owner: 'debrax' }, { fetchImpl });
    expect(r).toEqual({ ok: false, error: 'a run is still active' });
    expect(JSON.parse(calls[0].init.body)).toEqual({ repo: 'ember', tasks: ['ember-a'], owner: 'debrax', intent: 'revision' });
  });

  it('only talks to a board on this Mac, and checks names before sending', async () => {
    const { fetchImpl, calls } = fakeBoard({});
    expect((await stopHarvesterRun({ base: 'https://evil.example', runId: 'r1', owner: 'me' }, { fetchImpl })).ok).toBe(false);
    expect((await restartHarvesterTask({ base: 'http://127.0.0.1:44101', repo: 'ember', taskName: '../x', owner: 'me' }, { fetchImpl })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('devserver board (through agentcloudctl)', () => {
  const NODE = 'devvm6833.dkl0.facebook.com';
  const reply = (out) => async () => ({ code: 0, stdout: `note: dialing prod\nMOCHI_HARVESTER_JSON=${JSON.stringify(out)}\n`, stderr: '' });

  it('maps the runs the remote script returns and tags each status with the node', async () => {
    const calls = [];
    const run = async (req) => {
      calls.push(req);
      return reply({ available: true, boards: [{ base: 'https://localhost:44201', repo: 'ember', runs: [{ id: 'r1', task_name: 'ember-a', state: 'remote_waiting' }] }] })();
    };
    const res = await harvesterStatusesOnNode({ node: NODE }, { run });
    expect(res.available).toBe(true);
    expect(res.statuses['ember-a']).toMatchObject({ kind: 'working', reason: 'Waiting for validation', base: 'https://localhost:44201', node: NODE });
    expect(calls[0].node).toBe(NODE);
    expect(calls[0].script).toContain("'status' ''");
  });

  it('is unavailable when the devserver has no board, is unreachable, or answers garbage', async () => {
    expect(await harvesterStatusesOnNode({ node: NODE }, { run: reply({ available: false, boards: [] }) })).toEqual({ available: false, statuses: {} });
    expect(await harvesterStatusesOnNode({ node: NODE }, { run: async () => ({ code: 1, stdout: '', stderr: 'refused' }) })).toEqual({ available: false, statuses: {} });
    expect(await harvesterStatusesOnNode({ node: NODE }, { run: async () => ({ code: 0, stdout: 'nothing here', stderr: '' }) })).toEqual({ available: false, statuses: {} });
  });

  it('drops boards at addresses that are not the devserver loopback', async () => {
    const res = await harvesterStatusesOnNode(
      { node: NODE },
      { run: reply({ available: true, boards: [{ base: 'https://evil.example:44201', repo: 'x', runs: [{ id: 'r', task_name: 't', state: 'running' }] }] }) },
    );
    expect(res.statuses).toEqual({});
  });

  it('stops and restarts through the script, passing Harvester refusals through', async () => {
    const calls = [];
    const run = async (req) => (calls.push(req.script), reply({ ok: false, error: 'a run is still active' })());
    expect(await stopHarvesterRunOnNode({ node: NODE, base: 'https://localhost:44201', runId: 'r1' }, { run })).toEqual({ ok: false, error: 'a run is still active' });
    await restartHarvesterTaskOnNode({ node: NODE, base: 'https://localhost:44201', repo: 'ember', taskName: 'ember-a', intent: 'revision' }, { run });
    expect(calls[0]).toContain("'stop' '' 'https://localhost:44201' 'r1'");
    expect(calls[1]).toContain("'restart' '' 'https://localhost:44201' 'ember' 'ember-a' 'revision'");
    expect((await stopHarvesterRunOnNode({ node: NODE, base: 'http://evil', runId: 'r1' }, { run })).ok).toBe(false);
    expect((await restartHarvesterTaskOnNode({ node: NODE, base: 'https://localhost:44201', repo: 'ember', taskName: '../x' }, { run })).ok).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('quotes script arguments so a token cannot break out of the shell command', () => {
    expect(remoteScript(['status', "it's"])).toContain("'it'\\''s'");
    expect(parseRemoteOutput('MOCHI_HARVESTER_JSON={"ok":true}')).toEqual({ ok: true });
    expect(parseRemoteOutput('MOCHI_HARVESTER_JSON={bad')).toBeNull();
  });
});
