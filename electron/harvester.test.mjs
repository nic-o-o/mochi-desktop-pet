import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

describe('a restarted task (Harvester re-queues the same record)', () => {
  it('ignores taskflow state from the previous cycle and times the status from the restart', () => {
    const run = {
      state: 'queued',
      started_at: '2026-10-23T22:26:18Z',
      lifecycle_started_at: '2026-11-13T23:50:16Z',
      moved_at: '2026-11-13T23:50:16Z',
      detail: { outcome: 'infrastructure_blocked', detail: 'Nest has not created a validation commit', at: Date.parse('2026-11-01T20:28:00Z') / 1000, timing: { phase: 'platform_blocked' } },
    };
    expect(mapRun(run)).toMatchObject({ kind: 'working', reason: 'Queued', sinceMs: Date.parse('2026-11-13T23:50:16Z') });
  });

  it('keeps taskflow state written during the current cycle', () => {
    const at = Date.parse('2026-11-13T23:55:00Z') / 1000;
    const run = { state: 'running', lifecycle_started_at: '2026-11-13T23:50:16Z', detail: { detail: 'Repairing, round 1', at, timing: { phase: 'platform_blocked' } } };
    expect(mapRun(run)).toMatchObject({ kind: 'stuck', reason: 'Repairing, round 1', sinceMs: at * 1000 });
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

  it('maps runs read from disk: a run whose process ended is stopped, with Harvester\'s last word', async () => {
    const runs = [
      { id: 'r1', task_name: 'ember-a', state: 'running', process_ended: true, detail: { detail: 'published abc is still being validated by Nest' } },
      { id: 'r2', task_name: 'ember-b', state: 'running' },
    ];
    const res = await harvesterStatusesOnNode({ node: NODE }, { run: reply({ available: true, boards: [{ base: 'disk', repo: '/home/me/.config/harvester/projects/ember', runs }] }) });
    expect(res.statuses['ember-a']).toMatchObject({
      kind: 'stopped',
      reason: 'Harvester stopped before finishing. Last: published abc is still being validated by Nest',
      base: 'disk',
    });
    expect(res.statuses['ember-b'].kind).toBe('working');
    expect(mapRun({ state: 'remote_waiting', process_ended: true }).reason).toBe('Harvester stopped before finishing.');
  });

  it('stops and restarts a board-less run through the script', async () => {
    const calls = [];
    const run = async (req) => (calls.push(req.script), reply({ ok: true })());
    expect(await stopHarvesterRunOnNode({ node: NODE, base: 'disk', runId: 'r1' }, { run })).toEqual({ ok: true });
    await restartHarvesterTaskOnNode({ node: NODE, base: 'disk', repo: '/p/ember', taskName: 'ember-a', intent: 'revive' }, { run });
    expect(calls[0]).toContain("'stop' '' 'disk' 'r1'");
    expect(calls[1]).toContain("'restart' '' 'disk' '/p/ember' 'ember-a' 'revive'");
  });

  it('quotes script arguments so a token cannot break out of the shell command', () => {
    expect(remoteScript(['status', "it's"])).toContain("'it'\\''s'");
    expect(parseRemoteOutput('MOCHI_HARVESTER_JSON={"ok":true}')).toEqual({ ok: true });
    expect(parseRemoteOutput('MOCHI_HARVESTER_JSON={bad')).toBeNull();
  });
});

// The devserver script itself, run here against a fake Harvester: run records in
// CARD_BOARD_RUNS and an engine checkout whose runner answers liveness, taskflow
// state and cancel, and whose revive launcher records how it was called.
describe('devserver script without a board', () => {
  const NOW = Date.now() / 1000;
  function fakeHarvester() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-hv-'));
    const runs = path.join(root, 'runs');
    const engine = path.join(root, 'engine');
    const project = path.join(root, 'project');
    const log = path.join(root, 'calls.jsonl');
    for (const d of [runs, path.join(engine, 'ui'), path.join(engine, 'skills/revive/scripts'), project]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(engine, 'ui/runner.py'),
      [
        'import json, os',
        'def _log(v):',
        '    with open(os.environ["FAKE_LOG"], "a") as f: f.write(json.dumps(v) + "\\n")',
        'def taskflow_detail(rec):',
        `    return {"outcome": "remote_waiting", "detail": "last word for " + rec["id"], "at": ${Math.round(NOW)}}`,
        'def _run_alive(rec):',
        '    return rec.get("pid") == 4242',
        'def cancel(run_id, actor=""):',
        '    _log({"cancel": run_id, "actor": actor})',
        '    return {"id": run_id}, None',
        'def queue_revives(*, repo_root, repo, tasks, actor="", worker_mode="", publish=True, local_docker=True, intent="revive"):',
        '    _log({"queue": tasks, "repo": repo, "actor": actor, "publish": publish, "intent": intent})',
        '    return [], tasks, []',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(engine, 'skills/revive/scripts/launch.py'),
      [
        'import os, pathlib, sys',
        'sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3] / "ui"))',
        'import runner',
        'print("noise on stdout")',
        'def resolve(target, explicit_project=""):',
        '    if target.startswith("missing"): raise ValueError("no task named " + target)',
        '    root = pathlib.Path(explicit_project)',
        '    return root, root / target',
        'def _ensure_promoter(config_root):',
        '    runner._log({"promoter": str(config_root)})',
        '    return 1, config_root / "log"',
      ].join('\n'),
    );
    const rec = (id, fields) => fs.writeFileSync(path.join(runs, `${id}.json`), JSON.stringify({ id, kind: 'taskflow', engine_checkout: engine, repo_root: project, ...fields }));
    rec('a-old', { task_name: 'ember-a', state: 'done', started_at: '2026-11-01T00:00:00Z' });
    rec('a-new', { task_name: 'ember-a', state: 'running', pid: 1, started_at: '2026-11-09T00:00:00Z' });
    rec('b', { task_name: 'ember-b', state: 'running', pid: 4242, started_at: '2026-11-09T00:00:00Z' });
    rec('c', { task_name: 'ember-c', state: 'queued', started_at: '2026-11-09T00:00:00Z' });
    rec('card', { task_name: 'ember-d', kind: 'card', state: 'running' });
    fs.writeFileSync(path.join(runs, 'mismatch.json'), JSON.stringify({ id: 'other', kind: 'taskflow', task_name: 'ember-e', state: 'running' }));
    return { root, runs, project, log };
  }
  const runScript = (h, argv) =>
    parseRemoteOutput(execFileSync('/bin/sh', ['-c', remoteScript(argv)], { env: { ...process.env, HOME: h.root, CARD_BOARD_RUNS: h.runs, FAKE_LOG: h.log }, encoding: 'utf8' }));
  const calls = (h) => fs.readFileSync(h.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('reads the latest record per task and marks runs whose process is gone', (ctx) => {
    const h = fakeHarvester();
    const out = runScript(h, ['status', '']);
    if (out.boards.some((b) => b.base !== 'disk')) ctx.skip(); // a real board is running on this Mac
    expect(out.available).toBe(true);
    const runs = Object.fromEntries(out.boards.flatMap((b) => b.runs).map((r) => [r.task_name, r]));
    expect(Object.keys(runs).sort()).toEqual(['ember-a', 'ember-b', 'ember-c']);
    expect(runs['ember-a']).toMatchObject({ id: 'a-new', process_ended: true, detail: { detail: 'last word for a-new' } });
    expect(runs['ember-b'].process_ended).toBeFalsy();
    expect(runs['ember-c'].process_ended).toBe(true); // queued, and no queue drainer running
    expect(out.boards[0]).toMatchObject({ base: 'disk', repo: h.project });
  });

  it('stops with Harvester\'s cancel as this user and restarts like its revive launcher, keeping the intent', () => {
    const h = fakeHarvester();
    const me = os.userInfo().username;
    const repo = path.basename(h.project);
    expect(runScript(h, ['stop', '', 'disk', 'b'])).toEqual({ ok: true, error: null });
    expect(runScript(h, ['restart', '', 'disk', h.project, 'ember-a', 'revision'])).toEqual({ ok: true, error: null });
    expect(runScript(h, ['restart', '', 'disk', h.project, 'ember-b', 'revive'])).toEqual({ ok: true, error: null });
    expect(runScript(h, ['stop', '', 'disk', 'nope']).ok).toBe(false);
    expect(calls(h)).toEqual([
      { cancel: 'b', actor: me },
      { queue: ['ember-a'], repo, actor: me, publish: true, intent: 'revision' },
      { promoter: h.project },
      { queue: ['ember-b'], repo, actor: me, publish: true, intent: 'revive' },
      { promoter: h.project },
    ]);
  });
});
