/* `npm run package` — build Mochi.app so the pet launches like any Mac app
 * (Spotlight, Launchpad, Dock, or at login) with no terminal or Vite server.
 *
 *   npm run package              # → out/Mochi-darwin-<arch>/Mochi.app + out/Mochi.dmg
 *   npm run package -- --install # also copies the app to ~/Applications
 *
 * Mochi.dmg is the drag-to-Applications installer to share. The app is only
 * ad-hoc signed (no Apple Developer ID, not notarized), so on another Mac the
 * first launch needs System Settings → Privacy & Security → Open Anyway.
 * Quit Mochi before installing over a running copy.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const install = process.argv.includes('--install');

/* The app needs only the main process, preload and the built renderer. */
const KEEP = [/^\/package\.json$/, /^\/dist(\/|$)/, /^\/electron(\/|$)/];
const DROP = [/\.test\.m?js$/, /^\/electron\/dev\.mjs$/];

function ignore(file) {
  if (file === '') return false;
  if (DROP.some((re) => re.test(file))) return true;
  // Keep parent folders so packager can descend into them.
  if (file === '/dist' || file === '/electron') return false;
  return !KEEP.some((re) => re.test(file));
}

const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const electronVersion = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version;

const [appDir] = await packager({
  dir: root,
  name: 'Mochi',
  platform: 'darwin',
  arch: process.arch,
  electronVersion,
  out: path.join(root, 'out'),
  overwrite: true,
  asar: true,
  prune: false,
  ignore,
  appBundleId: 'dev.mochi.desktop-pet',
  // build/icon.svg is the source; `swift scripts/make-icon.swift` regenerates this.
  icon: path.join(root, 'build', 'icon.icns'),
  appCategoryType: 'public.app-category.productivity',
});

const appPath = path.join(appDir, 'Mochi.app');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed (${r.status})`);
}

/* Packager edits the bundle after Electron's signature, which macOS then
   reports as "damaged". Re-sign the whole bundle ad hoc. */
run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
run('codesign', ['--verify', '--deep', '--strict', appPath]);
console.log(`Built ${path.relative(root, appPath)}`);

/* Drag-to-Applications disk image: the app plus an Applications shortcut.
   Not fatal: the app above is already usable without it. */
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-dmg-'));
const dmgPath = path.join(root, 'out', 'Mochi.dmg');
try {
  fs.cpSync(appPath, path.join(stage, 'Mochi.app'), { recursive: true, verbatimSymlinks: true });
  fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
  run('hdiutil', ['create', '-volname', 'Mochi', '-srcfolder', stage, '-ov', '-format', 'UDZO', '-quiet', dmgPath]);
  console.log(`Built ${path.relative(root, dmgPath)} (open it and drag Mochi to Applications)`);
} catch (err) {
  console.warn(`Skipped Mochi.dmg: ${err instanceof Error ? err.message : err}`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

if (install) {
  const dest = path.join(os.homedir(), 'Applications', 'Mochi.app');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(appPath, dest, { recursive: true, verbatimSymlinks: true });
  console.log(`Installed ${dest}. Open it from Spotlight ("Mochi") or Launchpad.`);
} else {
  console.log('Run `npm run package -- --install` to copy it to ~/Applications.');
}
