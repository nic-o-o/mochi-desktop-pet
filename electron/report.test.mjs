import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnostics, logTail } from './report.mjs';

describe('logTail', () => {
  it('returns the last lines, or a note when there is no log', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-log-')), 'main.log');
    fs.writeFileSync(file, Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const tail = logTail(file, 3);
    expect(tail).toBe('line 58\nline 59\nline 60');
    expect(logTail(path.join(os.tmpdir(), 'does-not-exist.log'))).toMatch(/no log file/);
  });
});

describe('diagnostics', () => {
  it('lists build, macOS, data status, counts and the log, with no task names', () => {
    const now = Date.parse('2026-10-28T10:00:00Z');
    const text = diagnostics({
      state: {
        build: 'abc1234 · 2026-10-28',
        status: 'offline',
        failureKind: 'offline',
        fetchedAtMs: now - 2 * 3_600_000,
        counts: { reviews: 1, revisions: 2, drafts: 16 },
      },
      appVersion: '0.0.0',
      osVersion: '27.0',
      arch: 'arm64',
      log: '[mochi] codimango offline: Could not reach Codimango',
      nowMs: now,
    });
    expect(text.split('\n')).toEqual([
      '--- Mochi diagnostics (paste under your description) ---',
      'Mochi: build abc1234 · 2026-10-28, app 0.0.0',
      'macOS: 27.0 (arm64)',
      'Data: offline (last error: offline), last refresh 2026-10-28 08:00 UTC (2h ago)',
      'Panel: 1 to review, 2 revisions, 16 drafts',
      'Recent log:',
      '[mochi] codimango offline: Could not reach Codimango',
      '--- end ---',
    ]);
  });

  it('copes with a missing state', () => {
    expect(diagnostics({ state: null, appVersion: '0.0.0', osVersion: '27.0', arch: 'arm64', log: '' })).toContain(
      'last refresh never',
    );
  });
});
