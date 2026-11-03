/* `npm run release` — build a tester release and get it into the shared folder.
 *
 *   npm run release              # build the current version
 *   npm run release -- patch     # bump 0.1.0 → 0.1.1 first (or minor / major)
 *
 * Builds out/Mochi.dmg, installs it over your own copy (restarting Mochi), then
 * opens the testers' Google Drive folder and shows the DMG in Finder: drag it
 * into the folder and choose "Replace existing file" so the link stays the same.
 * (The upload is by hand: the DMG is too big for the meta CLI from a laptop.)
 * Prints a note to post for testers. Commit and push the version bump afterwards.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRIVE_FOLDER = 'https://drive.google.com/drive/folders/1xB_TQejb_nVMgT4ywwF6iWSz78V1ETPs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bump = process.argv.slice(2).find((a) => ['patch', 'minor', 'major'].includes(a));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
}

const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).stdout.trim();
if (dirty) console.warn('Note: you have uncommitted changes; they will be in this build.\n');

if (bump) run('npm', ['version', bump, '--no-git-tag-version']);
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
console.log(`Building Mochi ${version}…`);
run(process.execPath, ['scripts/package.mjs', '--install'], { env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });

const dmg = path.join(root, 'out', 'Mochi.dmg');
if (!fs.existsSync(dmg)) throw new Error('out/Mochi.dmg was not built');
spawnSync('open', [DRIVE_FOLDER]);
spawnSync('open', ['-R', dmg]);

console.log(`
Mochi ${version} is installed here and ready to share.
1. Drag out/Mochi.dmg (shown in Finder) into the Drive folder (opened in your browser)
   and choose "Replace existing file".
2. ${bump ? `Commit the version bump: git commit -m "Release ${version}" -- package.json package-lock.json && git push` : 'Nothing to commit (no version bump).'}
3. Post for testers:

   Mochi ${version} is out: ${DRIVE_FOLDER}
   To update: quit Mochi (right-click its Dock icon → Quit), open the new Mochi.dmg,
   drag Mochi to Applications and choose Replace. If macOS says it can't verify the app,
   click Done, then System Settings → Privacy & Security → Open Anyway.
`);
