import { describe, expect, it } from 'vitest';
import {
  delegateToGreen,
  isTaskSlug,
  parseGreenStarted,
  parseTaskShow,
  repoCandidatePath,
  repoDirName,
} from './delegate.mjs';

const TASK_SHOW = JSON.stringify({
  name: 'ember-review-turnaround-study-install-time-bef-da119-zixuanchen',
  sourceRepo: 'https://github.com/codimango/swe-bench-aai-labs-ember',
  status: 'draft',
});

/* A fake node runner: each script it is asked to run resolves from a canned
   answer keyed by what the script contains. */
function fakeRun(answers) {
  const calls = [];
  const run = async ({ cwd, script }) => {
    calls.push({ cwd, script });
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
    [
      'rev-parse',
      { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg-272075201@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' },
    ],
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

describe('delegateToGreen', () => {
  it('checks Green, resolves and verifies the repo, runs doctor, then launches detached with Codex', async () => {
    const fake = happyRun();
    const result = await delegateToGreen({ taskSlug: 'ember-review-turnaround-study-install-time-bef-da119-zixuanchen' }, { run: fake.run });
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
  });

  it('rejects an invalid slug without running anything', async () => {
    const fake = happyRun();
    const result = await delegateToGreen({ taskSlug: 'not a slug' }, { run: fake.run });
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
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
      ['doctor', OK],
      ['--detach', { code: 0, stdout: 'worker pid: 7\nlog: /tmp/g.log\n', stderr: '' }],
    ]);
    const result = await delegateToGreen({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(true);
    expect(fake.calls.some((c) => c.script.includes('agent-market skill install green --agent codex --scope user --force'))).toBe(true);
  });

  it('fails closed when Green stays missing after install', async () => {
    const fake = fakeRun([
      ['SKILL.md', { code: 1, stdout: '', stderr: '' }],
      ['agent-market skill install green', { code: 1, stdout: '', stderr: 'agent-market: command not found' }],
    ]);
    const result = await delegateToGreen({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('green_missing');
    expect(result.error?.fix).toContain('agent-market skill install green');
    expect(fake.calls.some((c) => c.script.includes('--detach'))).toBe(false);
  });

  it('fails closed when the derived checkout is absent, without launching', async () => {
    const fake = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['rev-parse', { code: 3, stdout: '', stderr: 'fatal: not a git repository' }],
    ]);
    const result = await delegateToGreen({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('repo_not_found');
    expect(result.error?.message).toContain('~/AAI/swe-bench-aai-labs-ember');
    expect(fake.calls.some((c) => c.script.includes('--detach'))).toBe(false);
  });

  it('fails closed when the checkout remote does not match the task repo', async () => {
    const fake = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\nhttps://github.com/someone-else/other.git\n', stderr: '' }],
    ]);
    const result = await delegateToGreen({ taskSlug: 'ember-task' }, { run: fake.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('repo_not_found');
    expect(fake.calls.some((c) => c.script.includes('--detach'))).toBe(false);
  });

  it('fails closed when doctor fails, without launching', async () => {
    const fake = fakeRun([
      ['SKILL.md', OK],
      ['task show', { code: 0, stdout: TASK_SHOW, stderr: '' }],
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
      ['doctor', { code: 1, stdout: '', stderr: 'muse: command not found' }],
    ]);
    const result = await delegateToGreen({ taskSlug: 'ember-task' }, { run: fake.run });
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
      ['rev-parse', { code: 0, stdout: '/home/zixuanchen/AAI/swe-bench-aai-labs-ember\norg@github.com:codimango/swe-bench-aai-labs-ember.git\n', stderr: '' }],
      ['doctor', OK],
      ['--detach', { code: 1, stdout: '', stderr: 'converge-locks: task already has a worker' }],
    ]);
    const result = await delegateToGreen({ taskSlug: 'ember-task' }, { run: failing.run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('launch_failed');
    expect(result.error?.message).toContain('already has a worker');
  });

  it('reports agentcloudctl missing when the runner cannot spawn it', async () => {
    const run = async () => {
      const error = new Error('spawn agentcloudctl ENOENT');
      error.code = 'ENOENT';
      throw error;
    };
    const result = await delegateToGreen({ taskSlug: 'ember-task' }, { run });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('agentcloud_missing');
  });
});
