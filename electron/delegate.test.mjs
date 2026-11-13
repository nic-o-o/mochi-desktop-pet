import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  checkDelegateStatus,
  checkTaskHandler,
  cloneSshUrl,
  delegateToGreen,
  installDocker,
  isDelegateAgent,
  parseDoctorOutput,
  parseDockerProbeOutput,
  parseExistingWorkerOutput,
  parseLogDetailOutput,
  stopGreenWorker,
  deriveDelegateStatus,
  isTaskSlug,
  normalizeDelegateNode,
  parseDelegateStatusOutput,
  parseGreenStarted,
  parseTaskShow,
  repoCandidatePath,
  repoDirName,
  runNodeExec,
  taskCommitSha,
} from './delegate.mjs';

const TASK_SHOW = JSON.stringify({
  name: 'ember-review-turnaround-study-install-time-bef-da119-zixuanchen',
  sourceRepo: 'https://github.com/codimango/swe-bench-aai-labs-ember',
  commitSha: '4e305117d2917b0aaaffeeb029539555685a74f6',
  status: 'draft',
});

/* A fake node runner: each script it is asked to run resolves from a canned
   answer keyed by what the script contains. */
const NODE = 'devvm7438.hil0.facebook.com';

async function delegateWithNode(req, deps) {
  return delegateToGreen({ node: NODE, ...req }, deps);
}

function fakeRun(answers) {
  const calls = [];
  const run = async ({ node, cwd, script }) => {
    calls.push({ node, cwd, script });
    for (const [needle, result] of answers) {
      if (script.includes(needle)) return typeof result === 'function' ? result({ cwd, script }) : result;
    }
    throw new Error(`unexpected script: ${script}`);
  };
  return { run, calls };
}

const OK = { code: 0, stdout: '', stderr: '' };

function happyRun() {
  return fakeRun([
    ['SKILL.md', OK],
    [
      'task show',
      { code: 0, stdout: TASK_SHOW, stderr: '' },
    ],
    ['test -e', OK],
    [
      'rev-parse',
      { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg-272075201@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' },
    ],
    ['test -d', OK],
    ['doctor', OK],
    [
      '--detach',
      {
        code: 0,
        stdout: 'DECIDE repair: validation failures\nworker pid: 424242\nlog: /home/zixuanchen/logs/green-1.log\n',
        stderr: '',
      },
    ],
  ]);
}

describe('isTaskSlug', () => {
  it('accepts Codimango slugs and rejects anything else', () => {
    expect(isTaskSlug('ember-review-turnaround-study-install-time-bef-da119-zixuanchen')).toBe(true);
    expect(isTaskSlug('')).toBe(false);
    expect(isTaskSlug('task name with spaces')).toBe(false);
    expect(isTaskSlug('a/b')).toBe(false);
    expect(isTaskSlug('task; rm -rf /')).toBe(false);
    expect(isTaskSlug(null)).toBe(false);
  });
});

describe('repoDirName / repoCandidatePath', () => {
  it('takes the repo name off https and ssh sourceRepo URLs', () => {
    expect(repoDirName('https://github.com/codimango/swe-bench-aai-labs-ember')).toBe('swe-bench-aai-labs-ember');
    expect(repoDirName('org-272075201@github.com:codimango/swe-bench-aai-labs-ember.git')).toBe('swe-bench-aai-labs-ember');
    expect(repoDirName('https://github.com/codimango/swe-bench-aai-labs-ember/')).toBe('swe-bench-aai-labs-ember');
    expect(repoCandidatePath('/home/zixuanchen', 'https://github.com/codimango/swe-bench-aai-labs-ember')).toBe(
      '/home/zixuanchen/AAI/swe-bench-aai-labs-ember',
    );
  });

  it('returns null when there is no usable repo name', () => {
    expect(repoDirName('')).toBeNull();
    expect(repoDirName(null)).toBeNull();
    expect(repoDirName('https://github.com/codimango/')).toBeNull();
    expect(repoDirName('not a url at all')).toBeNull();
    expect(repoCandidatePath('/home/zixuanchen', '')).toBeNull();
  });
});

describe('parseTaskShow', () => {
  it('reads sourceRepo out of task show JSON, even with a banner line first', () => {
    expect(parseTaskShow(TASK_SHOW)).toBe('https://github.com/codimango/swe-bench-aai-labs-ember');
    expect(parseTaskShow(`Need help? Run \`codimango feedback\`.\n${TASK_SHOW}`)).toBe('https://github.com/codimango/swe-bench-aai-labs-ember');
    expect(parseTaskShow('not json')).toBeNull();
    expect(parseTaskShow('{"name":"x"}')).toBeNull();
  });
});

describe('cloneSshUrl', () => {
  it('builds the git@ clone URL off https and ssh sourceRepo URLs', () => {
    expect(cloneSshUrl('https://github.com/codimango/swe-bench-aai-labs-ember')).toBe('git@github.com:codimango/swe-bench-aai-labs-ember.git');
    expect(cloneSshUrl('org-272075201@github.com:codimango/swe-bench-aai-labs-ember.git')).toBe('git@github.com:codimango/swe-bench-aai-labs-ember.git');
    expect(cloneSshUrl('git@github.com:codimango/swe-bench-aai-labs-ember.git')).toBe('git@github.com:codimango/swe-bench-aai-labs-ember.git');
    expect(cloneSshUrl('codimango/swe-bench-aai-labs-ember')).toBe('git@github.com:codimango/swe-bench-aai-labs-ember.git');
  });

  it('returns null when there is no org and repo to clone', () => {
    expect(cloneSshUrl('')).toBeNull();
    expect(cloneSshUrl(null)).toBeNull();
    expect(cloneSshUrl('https://github.com/codimango/')).toBeNull();
    expect(cloneSshUrl('swe-bench-aai-labs-ember')).toBeNull();
  });
});

describe('taskCommitSha', () => {
  it('reads the task commit out of task show JSON', () => {
    expect(taskCommitSha(TASK_SHOW)).toBe('4e305117d2917b0aaaffeeb029539555685a74f6');
    expect(taskCommitSha('{"name":"x"}')).toBeNull();
    expect(taskCommitSha('{"commitSha":"short"}')).toBeNull();
    expect(taskCommitSha('not json')).toBeNull();
  });
});

describe('parseGreenStarted', () => {
  it('reads the worker pid, log path, and first decision', () => {
    expect(parseGreenStarted('DECIDE repair: validation failures\nworker pid: 424242\nlog: /home/zixuanchen/logs/green-1.log\n')).toEqual({
      pid: 424242,
      logPath: '/home/zixuanchen/logs/green-1.log',
      decision: 'DECIDE repair: validation failures',
    });
  });

  it('tolerates a launch that reports only a log path', () => {
    expect(parseGreenStarted('log: /tmp/green.log\n')).toEqual({ pid: null, logPath: '/tmp/green.log', decision: null });
    expect(parseGreenStarted('nothing useful\n')).toEqual({ pid: null, logPath: null, decision: null });
  });
});

describe('normalizeDelegateNode', () => {
  it('trims, lowercases, and strips a scheme and path', () => {
    expect(normalizeDelegateNode(' devvm7438.hil0.facebook.com ')).toBe('devvm7438.hil0.facebook.com');
    expect(normalizeDelegateNode('HTTPS://DevVM7438.Hil0.Facebook.Com/')).toBe('devvm7438.hil0.facebook.com');
    expect(normalizeDelegateNode('https://devvm7438.hil0.facebook.com/some/path')).toBe('devvm7438.hil0.facebook.com');
    expect(normalizeDelegateNode('zixuanchen-mac')).toBe('zixuanchen-mac');
  });

  it('rejects empty, spaced, and shell-shaped input', () => {
    expect(normalizeDelegateNode('')).toBeNull();
    expect(normalizeDelegateNode(null)).toBeNull();
    expect(normalizeDelegateNode('not a node!!')).toBeNull();
    expect(normalizeDelegateNode('a..b')).toBeNull();
    expect(normalizeDelegateNode('-bad')).toBeNull();
    expect(normalizeDelegateNode('bad-')).toBeNull();
    expect(normalizeDelegateNode('bad; rm -rf /')).toBeNull();
    expect(normalizeDelegateNode('a_b')).toBeNull();
  });
});

describe('deriveDelegateStatus', () => {
  it('calls a live worker working once it has decided, starting before that', () => {
    expect(deriveDelegateStatus({ pidAlive: true, logExists: true, logAgeSecs: 120, hasDecide: true, hasBlocked: false, hasTimingZero: false }).kind).toBe('working');
    expect(deriveDelegateStatus({ pidAlive: true, logExists: true, logAgeSecs: 5, hasDecide: false, hasBlocked: false, hasTimingZero: false }).kind).toBe('starting');
  });

  it('calls a dead worker blocked, done, or stopped from its log markers', () => {
    expect(
      deriveDelegateStatus({ pidAlive: false, logExists: true, logAgeSecs: 900, hasDecide: true, hasBlocked: true, hasTimingZero: false }).kind,
    ).toBe('blocked');
    expect(
      deriveDelegateStatus({ pidAlive: false, logExists: true, logAgeSecs: 900, hasDecide: true, hasBlocked: false, hasTimingZero: true }).kind,
    ).toBe('done');
    expect(
      deriveDelegateStatus({ pidAlive: false, logExists: true, logAgeSecs: 900, hasDecide: true, hasBlocked: false, hasTimingZero: false }).kind,
    ).toBe('stopped');
    expect(deriveDelegateStatus({ pidAlive: false, logExists: false, logAgeSecs: null, hasDecide: false, hasBlocked: false, hasTimingZero: false }).kind).toBe(
      'stopped',
    );
  });

  it('keeps an alive worker working even when a blocked closure is in its log', () => {
    expect(
      deriveDelegateStatus({ pidAlive: true, logExists: true, logAgeSecs: 60, hasDecide: true, hasBlocked: true, hasTimingZero: false, lastDecision: 'DECIDE FIX: x' }).kind,
    ).toBe('working');
  });
});

describe('parseDelegateStatusOutput', () => {
  it('reads the probe lines and the last decision', () => {
    const parsed = parseDelegateStatusOutput(
      'PID_ALIVE=1\nLOG_EXISTS=1\nLOG_AGE_SECS=120\nDECIDE_LINE=13:54:28  DECIDE FIX: 2 finding(s) from codimango\nHAS_BLOCKED=0\nHAS_TIMING_ZERO=0\n',
    );
    expect(parsed).toEqual({
      pidAlive: true,
      logExists: true,
      logAgeSecs: 120,
      hasDecide: true,
      lastDecision: 'DECIDE FIX: 2 finding(s) from codimango',
      hasBlocked: false,
      hasTimingZero: false,
    });
  });

  it('defaults missing and malformed values instead of throwing', () => {
    expect(parseDelegateStatusOutput('PID_ALIVE=yes\nLOG_AGE_SECS=soon\n')).toEqual({
      pidAlive: false,
      logExists: false,
      logAgeSecs: null,
      hasDecide: false,
      lastDecision: null,
      hasBlocked: false,
      hasTimingZero: false,
    });
    expect(parseDelegateStatusOutput('')).toEqual({
      pidAlive: false,
      logExists: false,
      logAgeSecs: null,
      hasDecide: false,
      lastDecision: null,
      hasBlocked: false,
      hasTimingZero: false,
    });
  });
});

describe('checkDelegateStatus', () => {
  const STATUS_OUTPUT = 'PID_ALIVE=1\nLOG_EXISTS=1\nLOG_AGE_SECS=120\nDECIDE_LINE=DECIDE FIX: 2 finding(s)\nHAS_BLOCKED=0\nHAS_TIMING_ZERO=0\n';

  it('runs one probe on the named node and returns the live status', async () => {
    const calls = [];
    const run = async (job) => {
      calls.push(job);
      return { code: 0, stdout: STATUS_OUTPUT, stderr: '' };
    };
    const result = await checkDelegateStatus(
      { taskSlug: 'ember-task', node: 'devvm7438.hil0.facebook.com', pid: 424242, logPath: '/tmp/green.log' },
      { run },
    );
    expect(result.ok).toBe(true);
    expect(result.status).toMatchObject({ kind: 'working', pid: 424242, logPath: '/tmp/green.log', lastDecision: 'DECIDE FIX: 2 finding(s)', lastActivityAgeSecs: 120 });
    expect(calls).toHaveLength(1);
    expect(calls[0].node).toBe('devvm7438.hil0.facebook.com');
    expect(calls[0].script).toContain('424242');
    expect(calls[0].script).toContain('/tmp/green.log');
    expect(calls[0].script).toContain('tail -n 200');
    expect(calls[0].script).toContain('loop.py');
    // The decision is searched in the whole log, not just the last 200
    // lines: a worker waiting hours past its DECIDE is still working.
    expect(calls[0].script).toContain('grep -F " DECIDE " "$log"');
  });

  it('reports a dead worker as done when its log ends with a zero timing', async () => {
    const run = async () => ({
      code: 0,
      stdout: 'PID_ALIVE=0\nLOG_EXISTS=1\nLOG_AGE_SECS=900\nDECIDE_LINE=\nHAS_BLOCKED=0\nHAS_TIMING_ZERO=1\n',
      stderr: '',
    });
    const result = await checkDelegateStatus({ taskSlug: 'ember-task', node: 'devvm7438.hil0.facebook.com', pid: 424242, logPath: '/tmp/green.log' }, { run });
    expect(result.status?.kind).toBe('done');
  });

  it('refuses without a node or a valid slug, and never probes a relative log path', async () => {
    const calls = [];
    const run = async (job) => {
      calls.push(job);
      return { code: 0, stdout: STATUS_OUTPUT, stderr: '' };
    };
    expect((await checkDelegateStatus({ taskSlug: 'ember-task', pid: 424242, logPath: '/tmp/green.log' }, { run })).error?.kind).toBe('node_missing');
    expect((await checkDelegateStatus({ taskSlug: 'not a slug', node: 'devvm7438.hil0.facebook.com', pid: 424242, logPath: '/tmp/green.log' }, { run })).error?.kind).toBe('invalid_task');
    expect(calls).toHaveLength(0);
    const result = await checkDelegateStatus(
      { taskSlug: 'ember-task', node: 'devvm7438.hil0.facebook.com', pid: 424242, logPath: 'relative/green.log' },
      { run },
    );
    expect(result.ok).toBe(true);
    expect(calls[0].script).not.toContain('relative/green.log');
  });

  it('reports a failed probe as a node error, not a status', async () => {
    const run = async () => ({ code: 1, stdout: '', stderr: 'dial error' });
    const result = await checkDelegateStatus({ taskSlug: 'ember-task', node: 'devvm7438.hil0.facebook.com', pid: 424242, logPath: '/tmp/green.log' }, { run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('node_error');
    expect(result.status).toBeUndefined();
  });
});

describe('delegate node', () => {
  it('refuses to run without a node', async () => {
    const fake = happyRun();
    const result = await delegateToGreen({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('node_missing');
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses an invalid node without running anything', async () => {
    const fake = happyRun();
    const result = await delegateToGreen({ taskSlug: 'ember-task', node: 'not a node!!' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('node_missing');
    expect(fake.calls).toHaveLength(0);
  });

  it('runs on the node it was given, normalized, not on any hardcoded node', async () => {
    const fake = happyRun();
    const result = await delegateToGreen(
      { taskSlug: 'ember-task', node: '  HTTPS://Other-Devvm.Hil0.Facebook.Com/ ' },
      { run: fake.run },
    );
    expect(result.ok).toBe(true);
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls.every((c) => c.node === 'other-devvm.hil0.facebook.com')).toBe(true);
  });

  it('passes the requested node to agentcloudctl instead of a hardcoded one', async () => {
    const captured = [];
    const spawnImpl = (bin, args) => {
      captured.push({ bin, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit('data', 'out');
        child.stderr.emit('data', 'err');
        child.emit('close', 0);
      });
      return child;
    };
    const result = await runNodeExec({ node: 'other-devvm.hil0.facebook.com', script: 'true' }, spawnImpl);
    expect(result).toEqual({ code: 0, stdout: 'out', stderr: 'err', timedOut: false });
    const args = captured[0].args;
    expect(args[args.indexOf('--node') + 1]).toBe('other-devvm.hil0.facebook.com');
  });
});

describe('parseExistingWorkerOutput', () => {
  it('reads the holder pid, log path, and agent off the probe output', () => {
    expect(parseExistingWorkerOutput('WORKER_PID=2353662\nWORKER_LOG=/tmp/green.ember-task.log\nWORKER_AGENT=muse\n')).toEqual({
      pid: 2353662,
      logPath: '/tmp/green.ember-task.log',
      agent: 'muse',
    });
  });

  it('rejects a missing, dead, or unusable worker', () => {
    expect(parseExistingWorkerOutput('')).toBeNull();
    expect(parseExistingWorkerOutput('WORKER_PID=0\nWORKER_LOG=/tmp/g.log\n')).toBeNull();
    expect(parseExistingWorkerOutput('WORKER_PID=12\nWORKER_LOG=relative/g.log\n')).toBeNull();
    expect(parseExistingWorkerOutput('WORKER_PID=12\n')).toBeNull();
    expect(parseExistingWorkerOutput('WORKER_PID=abc\nWORKER_LOG=/tmp/g.log\n')).toBeNull();
  });

  it('leaves an unrecognized agent unset for the caller to default', () => {
    expect(parseExistingWorkerOutput('WORKER_PID=12\nWORKER_LOG=/tmp/g.log\nWORKER_AGENT=claude\n')).toEqual({ pid: 12, logPath: '/tmp/g.log', agent: null });
  });
});

describe('parseDoctorOutput', () => {
  const READY = `repository      /home/debrax/AAI/swe-bench-aai-labs-ember
codimango       /usr/local/bin/codimango
codex           /usr/local/bin/codex
muse            /usr/local/bin/muse
git             /usr/local/bin/git
docker          /usr/bin/docker
codimango CLI   current command surface ready
repair model    avocado-code-flex: ready
push guard      already active in /home/debrax/AAI/swe-bench-aai-labs-ember/.git/green-hooks
ok`;

  it('spots a missing Docker binary in an otherwise passing doctor run', () => {
    const output = READY.replace('docker          /usr/bin/docker', 'docker          MISSING -- local task proof').replace('\nok', '\nnot ready');
    expect(parseDoctorOutput(output)).toEqual({ dockerMissing: true, ready: false, missingBinaries: ['docker'] });
  });

  it('reports ready when every check passes', () => {
    expect(parseDoctorOutput(READY)).toEqual({ dockerMissing: false, ready: true, missingBinaries: [] });
  });

  it('defaults safely on empty or unfamiliar output', () => {
    expect(parseDoctorOutput('')).toEqual({ dockerMissing: false, ready: false, missingBinaries: [] });
    expect(parseDoctorOutput('push guard      already active in /tmp/x\nok')).toEqual({ dockerMissing: false, ready: true, missingBinaries: [] });
  });
});

describe('parseDockerProbeOutput', () => {
  it('reads the install environment off the probe lines', () => {
    expect(
      parseDockerProbeOutput('DOCKER_BIN=/usr/bin/docker\nDOCKER_DAEMON=1\nOS_ID=centos\nHAS_DNF=1\nHAS_YUM=0\nHAS_APT=0\nHAS_SYSTEMCTL=1\nSUDO_OK=1\n'),
    ).toEqual({ dockerBin: '/usr/bin/docker', daemonReachable: true, osId: 'centos', hasDnf: true, hasYum: false, hasApt: false, hasSystemctl: true, sudoOk: true });
  });

  it('defaults a missing or hostile probe to install nothing', () => {
    expect(parseDockerProbeOutput('')).toEqual({ dockerBin: null, daemonReachable: false, osId: null, hasDnf: false, hasYum: false, hasApt: false, hasSystemctl: false, sudoOk: false });
    expect(parseDockerProbeOutput('DOCKER_BIN=relative/docker\nDOCKER_DAEMON=1\nSUDO_OK=1\n')).toEqual({ dockerBin: null, daemonReachable: false, osId: null, hasDnf: false, hasYum: false, hasApt: false, hasSystemctl: false, sudoOk: true });
  });
});

describe('parseLogDetailOutput', () => {
  it('reads the active wait and the blocked closure reason off the last lines', () => {
    const parsed = parseLogDetailOutput(
      'WAITING_LINE=15:31:36    waiting 80m for Agentic trial-output review, Codex run\nLAST_LINE=15:31:36    waiting 80m for Agentic trial-output review, Codex run\nCLOSURE_LINE=\n',
    );
    expect(parsed).toEqual({ waitingActive: true, waitingMins: 80, waitingReason: 'Agentic trial-output review, Codex run', blockedReason: null, hasBlocked: false });
  });

  it('does not treat a stale wait as active once the worker moves on', () => {
    const parsed = parseLogDetailOutput(
      'WAITING_LINE=15:00:00    waiting 5m for Agentic trial-output review\nLAST_LINE=15:31:36  DECIDE FIX: 1 finding(s)\nCLOSURE_LINE=GREEN_REPAIR_CLOSURE: BLOCKED — F2: the contract cannot work\n',
    );
    expect(parsed.waitingActive).toBe(false);
    expect(parsed.waitingMins).toBeNull();
    expect(parsed.blockedReason).toBe('F2: the contract cannot work');
    expect(parsed.hasBlocked).toBe(true);
  });

  it('defaults empty output without throwing', () => {
    expect(parseLogDetailOutput('')).toEqual({ waitingActive: false, waitingMins: null, waitingReason: null, blockedReason: null, hasBlocked: false });
  });
});

describe('delegateToGreen', () => {
  it('checks Green, resolves and verifies the repo, runs doctor, then launches detached with Codex', async () => {
    const fake = happyRun();
    const result = await delegateWithNode({ taskSlug: 'ember-review-turnaround-study-install-time-bef-da119-zixuanchen' }, { run: fake.run });
    expect(result).toMatchObject({
      ok: true,
      taskSlug: 'ember-review-turnaround-study-install-time-bef-da119-zixuanchen',
      agent: 'codex',
      repo: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember',
      pid: 424242,
      logPath: '/home/zixuanchen/logs/green-1.log',
    });
    const launch = fake.calls.at(-1);
    expect(launch.script).toContain('--live');
    expect(launch.script).toContain('--hardening');
    expect(launch.script).toContain('--detach');
    expect(launch.script).toContain('--agent codex');
    expect(launch.script).toContain('ember-review-turnaround-study-install-time-bef-da119-zixuanchen');
    expect(launch.cwd).toBe('/home/zixuanchen/AAI/swe-bench-aai-labs-ember');
    expect(fake.calls.some((c) => c.script.includes('doctor --install-hooks'))).toBe(true);
    expect(fake.calls.findIndex((c) => c.script.includes('test -d'))).toBeLessThan(
      fake.calls.findIndex((c) => c.script.includes('doctor --install-hooks')),
    );
  });

  it('launches with Muse when Muse is chosen, and installs Green for Muse', async () => {
    let checked = 0;
    const fake = fakeRun([
      [
        'SKILL.md',
        () => {
          checked += 1;
          return checked === 1 ? { code: 1, stdout: '', stderr: '' } : OK;
        },
      ],
      ['agent-market skill install green', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['test -e', OK],
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
      ['test -d', OK],
      ['doctor', OK],
      ['--detach', { code: 0, stdout: 'worker pid: 7\nlog: /tmp/g.log\n', stderr: '' }],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-task', agent: 'muse' }, { run: fake.run });
    expect(result).toMatchObject({ ok: true, agent: 'muse' });
    const launch = fake.calls.at(-1);
    expect(launch.script).toContain('--agent muse');
    expect(fake.calls.some((c) => c.script.includes('agent-market skill install green --agent muse --scope user --force'))).toBe(true);
  });

  it('rejects MetaCode and Claude Code without running anything', async () => {
    expect(isDelegateAgent('muse')).toBe(true);
    expect(isDelegateAgent('codex')).toBe(true);
    expect(isDelegateAgent('metacode')).toBe(false);
    expect(isDelegateAgent('claude')).toBe(false);
    for (const agent of ['metacode', 'claude']) {
      const fake = happyRun();
      const result = await delegateWithNode({ taskSlug: 'ember-task', agent }, { run: fake.run });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe('invalid_agent');
      expect(result.agent).toBe('codex');
      expect(fake.calls).toHaveLength(0);
    }
  });

  it('returns the worker holding the remote lease instead of failing when the launch is refused', async () => {
    const fake = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['test -e', OK],
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
      ['test -d', OK],
      ['doctor', OK],
      [
        '--detach',
        {
          code: 64,
          stdout: 'worker pid: 3591932\nlog: /tmp/green.ember-task.20261112-151816.0ihmu90p.log\nrefusing: another unattended worker holds the remote lease for ember-task\n',
          stderr: '',
        },
      ],
      [
        'mochi-discover-worker',
        {
          code: 0,
          stdout: 'WORKER_PID=2353662\nWORKER_LOG=/tmp/green.ember-task.20261112-135356.q_oey57t.log\nWORKER_AGENT=codex\n',
          stderr: '',
        },
      ],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result).toMatchObject({
      ok: true,
      agent: 'codex',
      pid: 2353662,
      logPath: '/tmp/green.ember-task.20261112-135356.q_oey57t.log',
      repo: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember',
      alreadyRunning: true,
    });
  });

  it('still fails the launch when refused by the lease but no worker is found', async () => {
    const fake = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['test -e', OK],
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
      ['test -d', OK],
      ['doctor', OK],
      [
        '--detach',
        {
          code: 64,
          stdout: 'refusing: another unattended worker holds the remote lease for ember-task\n',
          stderr: '',
        },
      ],
      ['mochi-discover-worker', OK],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('launch_failed');
    expect(result.error?.message).toContain('holds the remote lease');
  });

  it('fails closed when the task directory is missing from the checkout, before doctor or launch', async () => {
    const fake = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['test -e', OK],
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
      ['test -d', { code: 1, stdout: '', stderr: '' }],
      ['pull --ff-only', OK],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-review-turnaround-study-install-time-bef-da119-zixuanchen' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('task_dir_missing');
    expect(result.error?.message).toContain('/home/zixuanchen/AAI/swe-bench-aai-labs-ember/ember-review-turnaround-study-install-time-bef-da119-zixuanchen');
    expect(result.error?.message).toContain('4e305117d2917b0aaaffeeb029539555685a74f6');
    expect(fake.calls.some((c) => c.script.includes('pull --ff-only'))).toBe(true);
    expect(fake.calls.some((c) => c.script.includes('doctor'))).toBe(false);
    expect(fake.calls.some((c) => c.script.includes('--detach'))).toBe(false);
  });

  it('rejects an invalid slug without running anything', async () => {
    const fake = happyRun();
    const result = await delegateWithNode({ taskSlug: 'not a slug' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('invalid_task');
    expect(fake.calls).toHaveLength(0);
  });

  it('installs Green when the check finds it missing, then proceeds', async () => {
    let checked = 0;
    const fake = fakeRun([
      [
        'SKILL.md',
        () => {
          checked += 1;
          return checked === 1 ? { code: 1, stdout: '', stderr: '' } : OK;
        },
      ],
      ['agent-market skill install green', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['test -e', OK],
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
      ['test -d', OK],
      ['doctor', OK],
      ['--detach', { code: 0, stdout: 'worker pid: 7\nlog: /tmp/g.log\n', stderr: '' }],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(true);
    expect(fake.calls.some((c) => c.script.includes('agent-market skill install green --agent codex --scope user --force'))).toBe(true);
  });

  it('fails closed when Green stays missing after install', async () => {
    const fake = fakeRun([
      ['SKILL.md', { code: 1, stdout: '', stderr: '' }],
      ['agent-market skill install green', { code: 1, stdout: '', stderr: 'agent-market: command not found' }],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('green_missing');
    expect(result.error?.fix).toContain('agent-market skill install green');
    expect(fake.calls.some((c) => c.script.includes('--detach'))).toBe(false);
  });

  it('fails closed when the derived checkout is absent, without launching', async () => {
    const fake = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['test -e', OK],
      ['rev-parse', { code: 3, stdout: '', stderr: 'fatal: not a git repository' }],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('repo_not_found');
    expect(result.error?.message).toContain('~/AAI/swe-bench-aai-labs-ember');
    expect(fake.calls.some((c) => c.script.includes('--detach'))).toBe(false);
  });

  it('fails closed when the checkout remote does not match the task repo', async () => {
    const fake = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['test -e', OK],
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\nhttps://github.com/someone-else/other.git\n', stderr: '' }],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('repo_not_found');
    expect(fake.calls.some((c) => c.script.includes('--detach'))).toBe(false);
  });

  it('fails closed when doctor fails, without launching', async () => {
    const fake = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['test -e', OK],
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
      ['test -d', OK],
      ['doctor', { code: 1, stdout: '', stderr: 'muse: command not found' }],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('doctor_failed');
    expect(result.error?.message).toContain('muse');
    expect(fake.calls.some((c) => c.script.includes('--detach'))).toBe(false);
  });

  it('names Docker as the failing doctor check instead of dumping the doctor table', async () => {
    const fake = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['test -e', OK],
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
      ['test -d', OK],
      [
        'doctor',
        {
          code: 1,
          stdout:
            'repository      /home/debrax/AAI/swe-bench-aai-labs-ember\ncodimango       /usr/local/bin/codimango\ncodex           /usr/local/bin/codex\nmuse            /usr/local/bin/muse\ngit             /usr/local/bin/git\ndocker          MISSING -- local task proof\ncodimango CLI   current command surface ready\nrepair model    avocado-code-flex: ready\npush guard      already active in /home/debrax/AAI/swe-bench-aai-labs-ember/.git/green-hooks\nnot ready',
          stderr: '',
        },
      ],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('doctor_failed');
    expect(result.error?.check).toBe('docker');
    expect(result.error?.message).toContain('Docker is missing');
    expect(result.error?.message).not.toContain('MISSING --');
    expect(fake.calls.some((c) => c.script.includes('--detach'))).toBe(false);
  });

  it('reports a launch failure with the output tail', async () => {
    const fake = happyRun();
    fake.calls.length = 0;
    const failing = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['test -e', OK],
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
      ['test -d', OK],
      ['doctor', OK],
      ['--detach', { code: 1, stdout: '', stderr: 'converge-locks: task already has a worker' }],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-task' }, { run: failing.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('launch_failed');
    expect(result.error?.message).toContain('already has a worker');
  });

  it('fast-forwards a stale checkout so a missing task directory appears, then launches', async () => {
    let dirChecks = 0;
    const fake = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['test -e', OK],
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
      [
        'test -d',
        () => {
          dirChecks += 1;
          return dirChecks === 1 ? { code: 1, stdout: '', stderr: '' } : OK;
        },
      ],
      ['pull --ff-only', OK],
      ['doctor', OK],
      ['--detach', { code: 0, stdout: 'worker pid: 8\nlog: /tmp/g2.log\n', stderr: '' }],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(true);
    expect(result.pid).toBe(8);
    const pull = fake.calls.find((c) => c.script.includes('pull --ff-only'));
    expect(pull?.cwd).toBe('/home/zixuanchen/AAI/swe-bench-aai-labs-ember');
    expect(pull?.script).toContain('git pull --ff-only origin main');
  });

  it('fails closed when the checkout cannot fast-forward, without launching', async () => {
    const fake = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['test -e', OK],
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
      ['test -d', { code: 1, stdout: '', stderr: '' }],
      ['pull --ff-only', { code: 1, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.' }],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('checkout_stale');
    expect(result.error?.message).toContain('Not possible to fast-forward');
    expect(fake.calls.some((c) => c.script.includes('doctor'))).toBe(false);
    expect(fake.calls.some((c) => c.script.includes('--detach'))).toBe(false);
  });

  it('clones a missing task checkout over ssh, then verifies and launches', async () => {
    const fake = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['test -e', { code: 1, stdout: '', stderr: '' }],
      ['git clone', OK],
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
      ['test -d', OK],
      ['doctor', OK],
      ['--detach', { code: 0, stdout: 'worker pid: 9\nlog: /tmp/g3.log\n', stderr: '' }],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(true);
    expect(result.pid).toBe(9);
    const clone = fake.calls.find((c) => c.script.includes('git clone'));
    expect(clone?.script).toContain("git clone 'git@github.com:codimango/swe-bench-aai-labs-ember.git'");
    expect(clone?.script).toContain('"$HOME/AAI/swe-bench-aai-labs-ember"');
    expect(fake.calls.findIndex((c) => c.script.includes('git clone'))).toBeLessThan(
      fake.calls.findIndex((c) => c.script.includes('rev-parse')),
    );
  });

  it('fails closed when cloning fails, without launching', async () => {
    const fake = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['test -e', { code: 1, stdout: '', stderr: '' }],
      ['git clone', { code: 128, stdout: '', stderr: 'fatal: Could not read from remote repository.' }],
    ]);
    const result = await delegateWithNode({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('repo_not_found');
    expect(result.error?.message).toContain('Could not read from remote repository');
    expect(fake.calls.some((c) => c.script.includes('--detach'))).toBe(false);
  });

  it('reports agentcloudctl missing when the runner cannot spawn it', async () => {
    const run = async () => {
      const error = new Error('spawn agentcloudctl ENOENT');
      error.code = 'ENOENT';
      throw error;
    };
    const result = await delegateWithNode({ taskSlug: 'ember-task' }, { run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('agentcloud_missing');
  });
});

const HANDLER_STATUS_OUTPUT =
  'PID_ALIVE=1\nLOG_EXISTS=1\nLOG_AGE_SECS=45\nDECIDE_LINE=13:54:27  DECIDE FIX: 1 finding(s) from codimango\nHAS_BLOCKED=0\nHAS_TIMING_ZERO=0\n';
const HANDLER_DETAIL_WAITING =
  'WAITING_LINE=15:31:36    waiting 80m for Agentic trial-output review, Codex run\nLAST_LINE=15:31:36    waiting 80m for Agentic trial-output review, Codex run\nCLOSURE_LINE=\n';

function handlerRun(overrides = {}) {
  return fakeRun([
    ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
    ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
    [
      'mochi-discover-worker',
      overrides.discover ?? { code: 0, stdout: 'WORKER_PID=2353662\nWORKER_LOG=/tmp/green.ember-task.log\nWORKER_AGENT=codex\n', stderr: '' },
    ],
    ['PID_ALIVE=', overrides.status ?? { code: 0, stdout: HANDLER_STATUS_OUTPUT, stderr: '' }],
    ['mochi-log-detail', overrides.detail ?? { code: 0, stdout: HANDLER_DETAIL_WAITING, stderr: '' }],
    ['mochi-lease-age', overrides.lease ?? { code: 0, stdout: `LEASE_TS=${Math.floor(Date.now() / 1000) - 3600}\n`, stderr: '' }],
  ]);
}

describe('checkTaskHandler', () => {
  it('finds a live worker by discovery and reports its wait, without a saved record', async () => {
    const fake = handlerRun();
    const result = await checkTaskHandler({ taskSlug: 'ember-task', node: NODE }, { run: fake.run });
    expect(result.ok).toBe(true);
    expect(result.probe).toMatchObject({
      handler: 'green',
      pid: 2353662,
      logPath: '/tmp/green.ember-task.log',
      agent: 'codex',
      kind: 'working',
      waitingMins: 80,
      waitingReason: 'Agentic trial-output review, Codex run',
      lastActivityAgeSecs: 45,
    });
    expect(typeof result.probe.leaseAgeSecs).toBe('number');
    expect(result.probe.leaseAgeSecs).toBeGreaterThan(3500);
    expect(fake.calls.find((c) => c.script.includes('mochi-lease-age'))?.cwd).toBe('/home/zixuanchen/AAI/swe-bench-aai-labs-ember');
  });

  it('reports no handler when discovery finds nothing and no record is given', async () => {
    const fake = handlerRun({ discover: OK });
    const result = await checkTaskHandler({ taskSlug: 'ember-task', node: NODE }, { run: fake.run });
    expect(result.ok).toBe(true);
    expect(result.probe).toMatchObject({ handler: 'none', pid: null, logPath: null, kind: null });
    expect(fake.calls.some((c) => c.script.includes('PID_ALIVE='))).toBe(false);
    expect(fake.calls.some((c) => c.script.includes('mochi-log-detail'))).toBe(false);
    expect(fake.calls.some((c) => c.script.includes('mochi-lease-age'))).toBe(false);
  });

  it('reads dead-worker evidence from the saved log when discovery finds nothing', async () => {
    const fake = handlerRun({
      discover: OK,
      status: { code: 0, stdout: 'PID_ALIVE=0\nLOG_EXISTS=1\nLOG_AGE_SECS=900\nDECIDE_LINE=\nHAS_BLOCKED=1\nHAS_TIMING_ZERO=0\n', stderr: '' },
      detail: { code: 0, stdout: 'WAITING_LINE=\nLAST_LINE=GREEN_REPAIR_CLOSURE: BLOCKED — F2: the contract cannot work\nCLOSURE_LINE=GREEN_REPAIR_CLOSURE: BLOCKED — F2: the contract cannot work\n', stderr: '' },
    });
    const result = await checkTaskHandler({ taskSlug: 'ember-task', node: NODE, pid: 99, logPath: '/tmp/old.log' }, { run: fake.run });
    expect(result.ok).toBe(true);
    expect(result.probe).toMatchObject({ handler: 'none', pid: 99, logPath: '/tmp/old.log', kind: 'blocked', blockedReason: 'F2: the contract cannot work' });
  });

  it('reports a probe failure instead of inventing a handler', async () => {
    const fake = handlerRun({ status: { code: 1, stdout: '', stderr: 'boom' } });
    const result = await checkTaskHandler({ taskSlug: 'ember-task', node: NODE }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('node_error');
  });

  it('rejects an invalid slug or node without running anything', async () => {
    const fake = handlerRun();
    expect((await checkTaskHandler({ taskSlug: 'not a slug', node: NODE }, { run: fake.run })).ok).toBe(false);
    expect((await checkTaskHandler({ taskSlug: 'ember-task', node: 'not a node!!' }, { run: fake.run })).ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('stopGreenWorker', () => {
  it('stops only a verified worker, then confirms it is gone', async () => {
    let verifies = 0;
    const fake = fakeRun([
      [
        'mochi-verify-worker',
        () => {
          verifies += 1;
          return { code: 0, stdout: verifies === 1 ? 'WORKER_ALIVE=1\n' : 'WORKER_ALIVE=0\n', stderr: '' };
        },
      ],
      ['mochi-stop-worker', OK],
      ['mochi-discover-worker', OK],
    ]);
    const result = await stopGreenWorker({ taskSlug: 'ember-task', node: NODE, pid: 99, logPath: '/tmp/old.log' }, { run: fake.run, pollIntervalMs: 5, maxPolls: 3 });
    expect(result).toMatchObject({ ok: true, stopped: true, pid: 99 });
    expect(fake.calls.some((c) => c.script.includes('kill 99'))).toBe(true);
  });

  it('never kills a pid that is not this task\u2019s Green worker', async () => {
    const fake = fakeRun([['mochi-verify-worker', { code: 0, stdout: 'WORKER_ALIVE=0\n', stderr: '' }]]);
    const result = await stopGreenWorker({ taskSlug: 'ember-task', node: NODE, pid: 99, logPath: '/tmp/old.log' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('not_a_worker');
    expect(fake.calls.some((c) => c.script.includes('kill'))).toBe(false);
  });

  it('reports failure when the worker survives SIGTERM instead of escalating', async () => {
    const fake = fakeRun([
      ['mochi-verify-worker', { code: 0, stdout: 'WORKER_ALIVE=1\n', stderr: '' }],
      ['mochi-stop-worker', OK],
      ['mochi-discover-worker', { code: 0, stdout: 'WORKER_PID=99\nWORKER_LOG=/tmp/old.log\nWORKER_AGENT=codex\n', stderr: '' }],
    ]);
    const result = await stopGreenWorker({ taskSlug: 'ember-task', node: NODE, pid: 99, logPath: '/tmp/old.log' }, { run: fake.run, pollIntervalMs: 5, maxPolls: 2 });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('stop_failed');
    expect(fake.calls.filter((c) => c.script.includes('kill')).length).toBe(1);
    expect(fake.calls.some((c) => c.script.includes('kill -9') || c.script.includes('kill -KILL'))).toBe(false);
  });
});

const DOCKER_PRESENT = 'DOCKER_BIN=/usr/bin/docker\nDOCKER_DAEMON=1\nOS_ID=centos\nHAS_DNF=1\nHAS_YUM=0\nHAS_APT=0\nHAS_SYSTEMCTL=1\nSUDO_OK=1\n';
const DOCKER_MISSING_DNF = 'DOCKER_BIN=\nDOCKER_DAEMON=0\nOS_ID=centos\nHAS_DNF=1\nHAS_YUM=0\nHAS_APT=0\nHAS_SYSTEMCTL=1\nSUDO_OK=1\n';

describe('installDocker', () => {
  it('does nothing privileged when Docker is already present and reachable', async () => {
    const fake = fakeRun([['mochi-docker-probe', { code: 0, stdout: DOCKER_PRESENT, stderr: '' }]]);
    const result = await installDocker({ taskSlug: 'ember-task', node: NODE }, { run: fake.run });
    expect(result).toMatchObject({ ok: true, alreadyInstalled: true, daemonReachable: true });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls.some((c) => c.script.includes('mochi-docker-install'))).toBe(false);
  });

  it('installs with dnf, starts the daemon, adds the group, and verifies', async () => {
    let probes = 0;
    const fake = fakeRun([
      [
        'mochi-docker-probe',
        () => {
          probes += 1;
          return { code: 0, stdout: probes === 1 ? DOCKER_MISSING_DNF : DOCKER_PRESENT, stderr: '' };
        },
      ],
      ['mochi-docker-install', OK],
      ['mochi-docker-daemon', OK],
      ['mochi-docker-group', OK],
    ]);
    const result = await installDocker({ taskSlug: 'ember-task', node: NODE }, { run: fake.run });
    expect(result).toMatchObject({ ok: true, daemonReachable: true });
    expect(fake.calls.find((c) => c.script.includes('mochi-docker-install'))?.script).toContain('dnf install -y docker-ce');
    expect(probes).toBe(2);
  });

  it('installs with apt on Debian-family devservers', async () => {
    let probes = 0;
    const fake = fakeRun([
      [
        'mochi-docker-probe',
        () => {
          probes += 1;
          return {
            code: 0,
            stdout: probes === 1 ? 'DOCKER_BIN=\nDOCKER_DAEMON=0\nOS_ID=ubuntu\nHAS_DNF=0\nHAS_YUM=0\nHAS_APT=1\nHAS_SYSTEMCTL=1\nSUDO_OK=1\n' : DOCKER_PRESENT.replace('centos', 'ubuntu'),
            stderr: '',
          };
        },
      ],
      ['mochi-docker-install', OK],
      ['mochi-docker-daemon', OK],
      ['mochi-docker-group', OK],
    ]);
    const result = await installDocker({ taskSlug: 'ember-task', node: NODE }, { run: fake.run });
    expect(result.ok).toBe(true);
    expect(fake.calls.find((c) => c.script.includes('mochi-docker-install'))?.script).toContain('apt-get install -y docker.io');
  });

  it('refuses to guess on an unsupported system and never runs sudo', async () => {
    const fake = fakeRun([['mochi-docker-probe', { code: 0, stdout: 'DOCKER_BIN=\nDOCKER_DAEMON=0\nOS_ID=\nHAS_DNF=0\nHAS_YUM=0\nHAS_APT=0\nHAS_SYSTEMCTL=0\nSUDO_OK=1\n', stderr: '' }]]);
    const result = await installDocker({ taskSlug: 'ember-task', node: NODE }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('unsupported_os');
    expect(fake.calls.some((c) => c.script.includes('mochi-docker-install'))).toBe(false);
  });

  it('fails closed when sudo needs a password instead of hanging on a prompt', async () => {
    const fake = fakeRun([['mochi-docker-probe', { code: 0, stdout: DOCKER_MISSING_DNF.replace('SUDO_OK=1', 'SUDO_OK=0'), stderr: '' }]]);
    const result = await installDocker({ taskSlug: 'ember-task', node: NODE }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('sudo_required');
    expect(fake.calls.some((c) => c.script.includes('mochi-docker-install'))).toBe(false);
  });

  it('fails closed when the daemon will not start, before touching the group', async () => {
    const fake = fakeRun([
      ['mochi-docker-probe', { code: 0, stdout: DOCKER_MISSING_DNF, stderr: '' }],
      ['mochi-docker-install', OK],
      ['mochi-docker-daemon', { code: 1, stdout: '', stderr: 'Failed to start docker.service' }],
    ]);
    const result = await installDocker({ taskSlug: 'ember-task', node: NODE }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('daemon_failed');
    expect(fake.calls.some((c) => c.script.includes('mochi-docker-group'))).toBe(false);
  });

  it('reports a permission problem when only sudo can reach the daemon after install', async () => {
    let probes = 0;
    const fake = fakeRun([
      [
        'mochi-docker-probe',
        () => {
          probes += 1;
          return {
            code: 0,
            stdout: probes === 1 ? DOCKER_MISSING_DNF : 'DOCKER_BIN=/usr/bin/docker\nDOCKER_DAEMON=0\nOS_ID=centos\nHAS_DNF=1\nHAS_YUM=0\nHAS_APT=0\nHAS_SYSTEMCTL=1\nSUDO_OK=1\n',
            stderr: '',
          };
        },
      ],
      ['mochi-docker-install', OK],
      ['mochi-docker-daemon', OK],
      ['mochi-docker-group', OK],
      ['mochi-docker-sudo-info', OK],
    ]);
    const result = await installDocker({ taskSlug: 'ember-task', node: NODE }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('docker_permission');
  });
});
