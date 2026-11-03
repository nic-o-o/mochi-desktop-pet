import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AUTHORIZE_URL, PERSONA_VERSION, askMochi, checkImages, classifyFailure, contextLine, persona } from './metamate.mjs';

/* A fake CLI: answers each call from a queue keyed by its action (`create`, `send`, `result`). */
function fakeCli(script, actionIndex) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const next = script[args[actionIndex]]?.shift();
    if (!next) throw new Error(`unexpected call: ${args.join(' ')}`);
    return { err: next.err ?? null, stdout: next.stdout ? JSON.stringify(next.stdout) : next.raw ?? '', stderr: next.stderr ?? '' };
  };
  return { run, calls };
}
const fakeMeta = (script) => fakeCli(script, 1); // meta agentcloud.session <action>
const fakeCtl = (script) => fakeCli(script, 0); // agentcloudctl <action>
const noSleep = async () => {};
const context = { reviews: 2, revisions: 1, drafts: 0 };
const PNG = { type: 'image/png', bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) };

let stateFile;
let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-mm-'));
  stateFile = path.join(tmpDir, 'metamate.json');
});
const message = (call) => call.find((a) => a.startsWith('--message=')).slice('--message='.length);

describe('askMochi', () => {
  it('starts an empty hidden chat, sends the persona with the first message, then reads that run', async () => {
    const meta = fakeMeta({
      create: [{ stdout: { session_id: 's1' } }],
      send: [{ stdout: { input_id: 3 } }],
      result: [
        { err: { code: 1 }, raw: '{"error":{"kind":"conflict","message":"CONFLICT: run_open"}}' },
        { stdout: { outcome: 'COMPLETED', final_answer: ' Hi! *wiggles* ' } },
      ],
    });
    const out = await askMochi('hi Mochi', { stateFile, context, meta: meta.run, sleep: noSleep });
    expect(out).toEqual({ kind: 'answer', text: 'Hi! *wiggles*' });
    expect(meta.calls[0]).toEqual(expect.arrayContaining(['create', '--hidden', '--no-message']));
    const sent = message(meta.calls[1]);
    expect(sent).toContain('You are Mochi');
    expect(sent).toContain('Never use tools');
    expect(sent).toContain('2 review(s) waiting');
    expect(sent).toContain('They say: hi Mochi');
    expect(meta.calls[2]).toContain('--input-id=3');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ sessionId: 's1', personaVersion: PERSONA_VERSION });
  });

  it('sends follow-ups to the same chat with fresh counts and no persona', async () => {
    fs.writeFileSync(stateFile, JSON.stringify({ sessionId: 's1', personaVersion: PERSONA_VERSION }));
    const meta = fakeMeta({
      send: [{ stdout: { input_id: 5 } }],
      result: [{ stdout: { outcome: 'COMPLETED', final_answer: 'Two reviews!' } }],
    });
    const out = await askMochi('how many reviews?', { stateFile, context, meta: meta.run, sleep: noSleep });
    expect(out.text).toBe('Two reviews!');
    const sent = message(meta.calls[0]);
    expect(meta.calls[0]).toContain('--session-id=s1');
    expect(sent).not.toContain('You are Mochi');
    expect(sent).toContain('2 review(s) waiting');
    expect(sent).toContain('They say: how many reviews?');
  });

  it('starts a fresh chat when the persona changed since the saved one', async () => {
    fs.writeFileSync(stateFile, JSON.stringify({ sessionId: 'old' })); // no personaVersion: the first persona
    const meta = fakeMeta({
      create: [{ stdout: { session_id: 's2' } }],
      send: [{ stdout: { input_id: 3 } }],
      result: [{ stdout: { outcome: 'COMPLETED', final_answer: 'Fresh start!' } }],
    });
    expect((await askMochi('hey', { stateFile, meta: meta.run, sleep: noSleep })).text).toBe('Fresh start!');
    expect(meta.calls[1]).toContain('--session-id=s2');
  });

  it('starts over once when the saved chat is gone', async () => {
    fs.writeFileSync(stateFile, JSON.stringify({ sessionId: 'old', personaVersion: PERSONA_VERSION }));
    const meta = fakeMeta({
      send: [{ err: { code: 4 }, raw: '{"error":{"kind":"not_found","message":"session NOT_FOUND"}}' }, { stdout: { input_id: 3 } }],
      create: [{ stdout: { session_id: 's2' } }],
      result: [{ stdout: { outcome: 'COMPLETED', final_answer: 'Hello again!' } }],
    });
    expect((await askMochi('hey', { stateFile, meta: meta.run, sleep: noSleep })).text).toBe('Hello again!');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessionId).toBe('s2');
  });

  it('sends pictures through agentcloudctl, with the text from a file, and cleans up', async () => {
    fs.writeFileSync(stateFile, JSON.stringify({ sessionId: 's1', personaVersion: PERSONA_VERSION }));
    let seen;
    const ctl = fakeCtl({ send: [{ raw: 'delivered: input durable at seq 62\n' }] });
    const run = async (args) => {
      const textFile = args[args.indexOf('--text-file') + 1];
      const image = args[args.indexOf('--image') + 1];
      seen = { text: fs.readFileSync(textFile, 'utf8'), image: [...fs.readFileSync(image)], imageName: image };
      return ctl.run(args);
    };
    const meta = fakeMeta({ result: [{ stdout: { outcome: 'COMPLETED', final_answer: 'Orange!' } }] });
    const out = await askMochi('what color?', { stateFile, images: [PNG], meta: meta.run, ctl: run, sleep: noSleep, tmpDir });
    expect(out.text).toBe('Orange!');
    expect(ctl.calls[0].slice(0, 3)).toEqual(['send', '-s', 's1']);
    expect(seen.text).toContain('They say: what color?');
    expect(seen.image).toEqual([...PNG.bytes]);
    expect(seen.imageName).toMatch(/\.png$/);
    expect(meta.calls[0]).toContain('--input-id=62');
    expect(fs.existsSync(path.dirname(seen.imageName))).toBe(false);
  });

  it('accepts a picture with no text', async () => {
    fs.writeFileSync(stateFile, JSON.stringify({ sessionId: 's1', personaVersion: PERSONA_VERSION }));
    const ctl = fakeCtl({ send: [{ raw: 'delivered: input durable at seq 9' }] });
    const meta = fakeMeta({ result: [{ stdout: { outcome: 'COMPLETED', final_answer: 'Cute!' } }] });
    expect((await askMochi('', { stateFile, images: [PNG], meta: meta.run, ctl: ctl.run, sleep: noSleep, tmpDir })).text).toBe('Cute!');
  });

  it("explains when Agentcloud access hasn't been granted (the message a new user gets)", async () => {
    const meta = fakeMeta({
      create: [{ stdout: { session_id: 's1' } }],
      send: [{ stdout: { input_id: 3 } }],
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
    const out = await askMochi('hi', { stateFile, meta: meta.run, sleep: noSleep });
    expect(out).toEqual({ kind: 'access_needed', message: 'Mochi needs your OK to use Metamate 3 first.', fix: AUTHORIZE_URL });
  });

  it('keeps polling through a transient Agentcloud 503', async () => {
    fs.writeFileSync(stateFile, JSON.stringify({ sessionId: 's1', personaVersion: PERSONA_VERSION }));
    const meta = fakeMeta({
      send: [{ stdout: { input_id: 5 } }],
      result: [
        {
          err: { code: 1 },
          raw: '{"status":"error","message":"genGetAgentSessionRunResult failed (BACKEND_ERROR): AgentCloud genGetRunResult returned HTTP 503: authentication is temporarily unavailable.","fault_domain":"infra"}',
        },
        { stdout: { outcome: 'COMPLETED', final_answer: 'Orange!' } },
      ],
    });
    expect((await askMochi('color?', { stateFile, meta: meta.run, sleep: noSleep })).text).toBe('Orange!');
  });

  it('gives up politely when the answer takes too long', async () => {
    let t = 0;
    const meta = fakeMeta({
      create: [{ stdout: { session_id: 's1' } }],
      send: [{ stdout: { input_id: 3 } }],
      result: Array.from({ length: 200 }, () => ({ err: { code: 1 }, raw: 'CONFLICT' })),
    });
    const out = await askMochi('hi', { stateFile, meta: meta.run, sleep: async (ms) => (t += ms), now: () => t });
    expect(out.kind).toBe('timeout');
  });

  it('refuses an empty message without calling anything', async () => {
    const meta = fakeMeta({});
    expect((await askMochi('   ', { stateFile, meta: meta.run })).kind).toBe('error');
    expect(meta.calls).toHaveLength(0);
  });
});

describe('checkImages', () => {
  it('takes PNG/JPEG/GIF/WebP up to 7 MB and 5 at a time', () => {
    expect(checkImages([PNG]).images).toHaveLength(1);
    expect(checkImages([{ type: 'image/svg+xml', bytes: new Uint8Array([1]) }]).problem).toMatch(/PNG, JPEG, GIF or WebP/);
    expect(checkImages([{ type: 'image/png', bytes: new Uint8Array(7 * 1024 * 1024 + 1) }]).problem).toMatch(/too big/);
    expect(checkImages(Array(6).fill(PNG)).problem).toMatch(/up to 5/);
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

describe('persona and counts', () => {
  it('tells Mochi not to use tools, and passes counts, never task names', () => {
    expect(persona()).toMatch(/Never use tools/);
    expect(contextLine({ reviews: 3, revisions: 0, drafts: 4 })).toMatch(/3 review\(s\) waiting.*4 draft\(s\)/);
    expect(contextLine(undefined)).toBe('');
  });
});
