import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectNewLines, FIELD_IDS, flushSender, loadSharing, setSharing, toLoggerRow } from './sender.mjs';

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
    expect(calls[0][0]).toEqual(['--logger', 'TestConfig', '--fail-on-error']);
    const sent = calls[0][1].trim().split('\n').map((l) => JSON.parse(l));
    const b64 = (v) => Buffer.from(v).toString('base64');
    expect(sent.map((r) => r[42].str)).toEqual([b64('a'), b64('b')]);
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

describe('toLoggerRow', () => {
  it('keys columns by the measured input IDs with base64 strings', () => {
    const line = JSON.stringify({
      event_name: 'mochi_resource',
      unixname: 'debrax',
      surface: 'pet',
      memory_mb: 212.6,
      launched_at_login: true,
      cpu_percent: 3.5,
      title: 'not a column',
      time: '2026-11-04T12:00:00.000Z',
    });
    const b64 = (v) => Buffer.from(v).toString('base64');
    expect(JSON.parse(toLoggerRow(line))).toEqual({
      4: { str: b64('mochi_resource') },
      27: { i64: Date.parse('2026-11-04T12:00:00.000Z') },
      29: { str: b64('debrax') },
      35: { str: b64('pet') },
      21: { i64: 1 },
      22: { i64: 213 },
      23: { double: 3.5 },
    });
  });

  it('maps every event column to a distinct ID', () => {
    const ids = Object.values(FIELD_IDS).map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(FIELD_IDS)).toHaveLength(41);
  });

  it('rejects lines without an event name or a valid time', () => {
    expect(toLoggerRow('not json')).toBeNull();
    expect(toLoggerRow(JSON.stringify({ time: '2026-11-04T12:00:00.000Z' }))).toBeNull();
    expect(toLoggerRow(JSON.stringify({ event_name: 'mochi_click', time: 'soon' }))).toBeNull();
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
