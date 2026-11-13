/* Packaged app only: there is no terminal, so main-process console output is
 * also appended to ~/Library/Logs/Mochi/main.log (rotated at startup past 1 MB).
 */
import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';

const MAX_BYTES = 1_000_000;
/* Per-drag bounds syncs (TEMP-DEBUG in main.mjs) would flood the file. */
const SKIP = /^\[mochi\] sync (request|actual)/;

export function installFileLog(dir, logConsole = console) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'main.log');
  try {
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    /* no log yet */
  }
  const stream = fs.createWriteStream(file, { flags: 'a' });
  /* A failed log sink must never crash the app: stdout can be a closed
     pipe (e.g. launched piped to `head`), and the file can go away. */
  stream.on('error', () => {});
  for (const level of ['log', 'warn', 'error']) {
    const original = logConsole[level].bind(logConsole);
    logConsole[level] = (...args) => {
      try {
        original(...args);
      } catch {
        /* stdout closed — the file log below still runs */
      }
      try {
        const line = args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
        if (!SKIP.test(line)) stream.write(`${new Date().toISOString()} ${level} ${line}\n`);
      } catch {
        /* file sink failed — never throw out of logging */
      }
    };
  }
  return file;
}
