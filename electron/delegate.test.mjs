import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  cloneSshUrl,
  delegateToGreen,
  isTaskSlug,
  normalizeDelegateNode,
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
