import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AUTHORIZE_URL, askMochi, classifyFailure, persona } from './metamate.mjs';

/* A fake `meta`: answers each call from a queue, keyed by the agentcloud action. */
function fakeMeta(script) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const action = args[1];
    const next = script[action]?.shift();
    if (!next) throw new Error(`unexpected meta call: ${args.join(' ')}`);
    return { err: next.err ?? null, stdout: next.stdout ? JSON.stringify(next.stdout) : next.raw ?? '', stderr: next.stderr ?? '' };
  };
  return { run, calls };
}
const noSleep = async () => {};

let stateFile;
beforeEach(() => {
  stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-mm-')), 'metamate.json');
});

describe('askMochi', () => {
  it('starts a hidden session with the persona on the first message, then reads that run', async () => {
    const meta = fakeMeta({
      create: [{ stdout: { session_id: 's1', input_id: 2 } }],
      result: [
        { err: { code: 1 }, raw: '{"error":{"kind":"conflict","message":"CONFLICT: run_open"}}' },
        { stdout: { outcome: 'COMPLETED', final_answer: ' Hi! *wiggles* ' } },
      ],
    });
    const out = await askMochi('hi Mochi', { stateFile, context: { reviews: 2, revisions: 1, drafts: 0 }, run: meta.run, sleep: noSleep });
    expect(out).toEqual({ kind: 'answer', text: 'Hi! *wiggles*' });
    const create = meta.calls[0];
    expect(create).toContain('--hidden');
    const msg = create.find((a) => a.startsWith('--message='));
    expect(msg).toContain('You are Mochi');
    expect(msg).toContain('2 review(s) waiting');
    expect(msg).toContain('They say: hi Mochi');
    expect(meta.calls[1]).toContain('--input-id=2');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessionId).toBe('s1');
  });

  it('sends follow-ups to the same session, without the persona', async () => {
    fs.writeFileSync(stateFile, JSON.stringify({ sessionId: 's1' }));
    const meta = fakeMeta({
      send: [{ stdout: { input_id: 5 } }],
      result: [{ stdout: { outcome: 'COMPLETED', final_answer: 'Two reviews!' } }],
    });
    const out = await askMochi('how many reviews?', { stateFile, run: meta.run, sleep: noSleep });
    expect(out.text).toBe('Two reviews!');
    expect(meta.calls[0]).toEqual(expect.arrayContaining(['send', '--session-id=s1', '--message=how many reviews?']));
    expect(meta.calls[1]).toContain('--input-id=5');
  });

  it('starts over when the saved session is gone', async () => {
    fs.writeFileSync(stateFile, JSON.stringify({ sessionId: 'old' }));
    const meta = fakeMeta({
      send: [{ err: { code: 4 }, raw: '{"error":{"kind":"not_found","message":"session NOT_FOUND"}}' }],
      create: [{ stdout: { session_id: 's2', input_id: 2 } }],
      result: [{ stdout: { outcome: 'COMPLETED', final_answer: 'Hello again!' } }],
    });
    expect((await askMochi('hey', { stateFile, run: meta.run, sleep: noSleep })).text).toBe('Hello again!');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessionId).toBe('s2');
  });

  it("explains when Agentcloud access hasn't been granted (the message a new user gets)", async () => {
    const meta = fakeMeta({
      create: [{ stdout: { session_id: 's1', input_id: 2 } }],
      result: [
        {
          stdout: {
            outcome: 'FAILED',
            final_answer: null,
            detail:
              'agentcloud could not send this request to the model: your agentcloud access registration has not completed, so no credential could be presented for you. ... grant permissions at https://agentcloud.internalmeta.com/authorize or run `agentcloud-auth setup` on your devserver',
          },
        },
      ],
    });
    const out = await askMochi('hi', { stateFile, run: meta.run, sleep: noSleep });
    expect(out).toEqual({ kind: 'access_needed', message: 'Mochi needs your OK to use Metamate 3 first.', fix: AUTHORIZE_URL });
  });

  it('gives up politely when the answer takes too long', async () => {
    let t = 0;
    const meta = fakeMeta({
      create: [{ stdout: { session_id: 's1', input_id: 2 } }],
      result: Array.from({ length: 200 }, () => ({ err: { code: 1 }, raw: 'CONFLICT' })),
    });
    const out = await askMochi('hi', { stateFile, run: meta.run, sleep: async (ms) => (t += ms), now: () => t });
    expect(out.kind).toBe('timeout');
  });

  it('refuses an empty message without calling meta', async () => {
    const meta = fakeMeta({});
    expect((await askMochi('   ', { stateFile, run: meta.run })).kind).toBe('error');
    expect(meta.calls).toHaveLength(0);
  });
});

describe('classifyFailure', () => {
  it('reports a missing CLI', () => {
    expect(classifyFailure({ err: { code: 'ENOENT' } }).kind).toBe('cli_missing');
  });
  it('reports timeouts as offline', () => {
    expect(classifyFailure({ err: { killed: true } }).kind).toBe('offline');
  });
});

describe('persona', () => {
  it('passes counts, never task names', () => {
    expect(persona({ reviews: 3, revisions: 0, drafts: 4 })).toMatch(/3 review\(s\) waiting.*4 draft\(s\)/);
    expect(persona(undefined)).not.toMatch(/waiting/);
  });
});
