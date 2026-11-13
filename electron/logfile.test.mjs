import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installFileLog } from './logfile.mjs';

/** The file stream flushes asynchronously; poll until the text lands. */
async function waitForLog(dir, text) {
  const file = path.join(dir, 'main.log');
  const end = Date.now() + 2000;
  for (;;) {
    try {
      const logged = fs.readFileSync(file, 'utf8');
      if (logged.includes(text)) return logged;
    } catch {
      /* not created yet */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${text} in ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('installFileLog', () => {
  it('writes the file through the real console', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-log-'));
    installFileLog(dir);
    console.log('hello logfile');
    expect(await waitForLog(dir, 'hello logfile')).toContain('hello logfile');
  });

  it('does not throw when the original console throws like a broken pipe, and still writes the file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-log-'));
    const brokenPipe = () => {
      const error = new Error('write EPIPE');
      error.code = 'EPIPE';
      throw error;
    };
    const fakeConsole = { log: brokenPipe, warn: brokenPipe, error: brokenPipe };
    installFileLog(dir, fakeConsole);
    expect(() => fakeConsole.log('hello broken pipe')).not.toThrow();
    expect(() => fakeConsole.warn('warn broken pipe')).not.toThrow();
    expect(() => fakeConsole.error('error broken pipe')).not.toThrow();
    const logged = await waitForLog(dir, 'hello broken pipe');
    expect(logged).toContain('hello broken pipe');
    expect(logged).toContain('warn broken pipe');
    expect(logged).toContain('error broken pipe');
  });
});
