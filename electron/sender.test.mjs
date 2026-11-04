import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectNewLines, flushSender, loadSharing, setSharing } from './sender.mjs';

function writeLog(dir, rows) {
  fs.writeFileSync(path.join(dir, 'events.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path.join(dir, 'events.jsonl');
}

const row = (id, time) => ({ event_name: 'mochi_click', surface: 'pet', component: 'pet', action: 'open_panel', task_id: id, time });

describe('sharing toggle', () => {
  it('defaults to sharing on and round-trips the opt-out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-sharing-'));
    expect(loadSharing(dir)).toEqual({ sharing: true, sent: null });
    setSharing(dir, false);
    expect(loadSharing(dir).sharing).toBe(false);
    setSharing(dir, true);
    expect(loadSharing(dir).sharing).toBe(true);
  });
});

describe('flushSender', () => {
  it('ships new rows and sends nothing twice', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-sender-'));
    const logFile = writeLog(dir, [row('a', '2026-11-04T12:00:00.000Z'), row('b', '2026-11-04T12:00:01.000Z')]);
    const calls = [];
    const run = async (args, stdin) => {
      calls.push([args, stdin]);
      return true;
    };
    const first = await flushSender({ logFile, userDataDir: dir, logger: 'TestConfig', run });
    expect(first).toEqual({ shipped: 2, dropped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain('TestConfig');
    const second = await flushSender({ logFile, userDataDir: dir, logger: 'TestConfig', run });
    expect(second).toEqual({ shipped: 0, dropped: 0, reason: 'empty' });
    expect(calls).toHaveLength(1);
  });

  it('does nothing without a logger config and never spawns', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-sender-'));
    const logFile = writeLog(dir, [row('a', '2026-11-04T12:00:00.000Z')]);
    let spawned = false;
    const out = await flushSender({ logFile, userDataDir: dir, logger: null, run: async () => ((spawned = true), true) });
    expect(spawned).toBe(false);
    expect(out.reason).toBe('no-config');
  });

  it('does nothing while opted out', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-sender-'));
    const logFile = writeLog(dir, [row('a', '2026-11-04T12:00:00.000Z')]);
    setSharing(dir, false);
    let spawned = false;
    const out = await flushSender({ logFile, userDataDir: dir, logger: 'TestConfig', run: async () => ((spawned = true), true) });
    expect(spawned).toBe(false);
    expect(out.reason).toBe('opted-out');
  });

  it('drops the batch on failure instead of retrying it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-sender-'));
    const logFile = writeLog(dir, [row('a', '2026-11-04T12:00:00.000Z')]);
    const calls = [];
    const out = await flushSender({
      logFile,
      userDataDir: dir,
      logger: 'TestConfig',
      run: async (...a) => {
        calls.push(a);
        return false;
      },
    });
    expect(out).toEqual({ shipped: 0, dropped: 1 });
    const again = await flushSender({
      logFile,
      userDataDir: dir,
      logger: 'TestConfig',
      run: async (...a) => {
        calls.push(a);
        return true;
      },
    });
    expect(again).toEqual({ shipped: 0, dropped: 0, reason: 'empty' });
    expect(calls).toHaveLength(1);
  });

  it('tolerates a missing log file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-sender-'));
    const out = await flushSender({ logFile: path.join(dir, 'missing.jsonl'), userDataDir: dir, logger: 'TestConfig', run: async () => true });
    expect(out).toEqual({ shipped: 0, dropped: 0, reason: 'empty' });
  });
});

describe('collectNewLines', () => {
  it('resends only rows newer than a rotated file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-sender-'));
    const logFile = writeLog(dir, [row('a', '2026-11-04T12:00:00.000Z'), row('b', '2026-11-04T12:00:01.000Z')]);
    const first = collectNewLines(logFile, null);
    expect(first.lines).toHaveLength(2);
    /* Rotation: same path, new inode, old rows plus one fresh row. */
    fs.renameSync(logFile, `${logFile}.1`);
    writeLog(dir, [row('a', '2026-11-04T12:00:00.000Z'), row('c', '2026-11-04T12:00:02.000Z')]);
    const second = collectNewLines(logFile, first.sent);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]).toContain('"c"');
  });
});
