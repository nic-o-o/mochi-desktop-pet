#!/usr/bin/env node
/* Stand-in for the codimango CLI in end-to-end tests. Mochi runs it exactly as
 * it runs the real one (`task list --filter reviewing|mine --limit 500 --json`).
 *
 * $MOCHI_FAKE_CODIMANGO_DIR/current names the folder for the current data;
 * its queue.json holds what each refresh returns, in order (the last one
 * repeats): { reviewing: [...], mine: [...] } or { error: kind }. Each filter
 * keeps its own counter there because Mochi reads both feeds in parallel; a
 * new folder per change means a call still running can't shift the next queue.
 * started.log / finished.log let the runner wait until no call is running.
 * "CLI missing" is the test removing this program from the path Mochi runs.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.MOCHI_FAKE_CODIMANGO_DIR;
const filterAt = process.argv.indexOf('--filter');
const filter = filterAt === -1 ? '' : process.argv[filterAt + 1];
if (!dir || process.argv[2] !== 'task' || process.argv[3] !== 'list' || !['reviewing', 'mine'].includes(filter)) {
  console.error(`fake codimango: unsupported call: ${process.argv.slice(2).join(' ')}`);
  process.exit(2);
}

fs.appendFileSync(path.join(dir, 'started.log'), `${filter}\n`);
process.on('exit', () => fs.appendFileSync(path.join(dir, 'finished.log'), `${filter}\n`));

const data = fs.readFileSync(path.join(dir, 'current'), 'utf8').trim();
const queue = JSON.parse(fs.readFileSync(path.join(data, 'queue.json'), 'utf8'));
const counterFile = path.join(data, `count-${filter}`);
const n = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0;
fs.writeFileSync(counterFile, String(n + 1));
const spec = queue[Math.min(n, queue.length - 1)];

/* Exit codes and error bodies match the real CLI (electron/codimango.mjs classifyFailure). */
if (spec.error === 'login_required') {
  console.log(JSON.stringify({ error: { kind: 'authentication', message: 'Not signed in', fix: 'codimango auth setup' } }));
  process.exit(9);
}
if (spec.error === 'offline') {
  console.error('network error');
  process.exit(5);
}
if (spec.error) {
  console.error(`fake codimango: ${spec.error}`);
  process.exit(2);
}
console.log(JSON.stringify({ tasks: spec[filter] ?? [], hasMore: false }));
