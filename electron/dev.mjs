/* `npm run desktop` — one-command Mochi desktop shell (Mac-first).
 * Spawns Vite, waits for it to answer, then opens the Electron overlay.
 * Ctrl+C (or quitting Electron) stops both. No extra dependencies.
 *
 * Refuses to start when :5173 is already taken (usually a Mochi that is still
 * running): otherwise the new Electron window would attach to the old Vite
 * server and you'd get two pets running mixed code.
 */
import { spawn } from 'node:child_process';

const PORT = 5173;
const READY_TIMEOUT_MS = 60_000;

function startVite() {
  const vite = spawn('npx', ['vite', '--strictPort', '--port', String(PORT)], {
    stdio: 'inherit',
  });
  return vite;
}

/** True when something already answers on the dev port. */
async function portInUse() {
  try {
    await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function waitForVite(vite) {
  const started = Date.now();
  let exited = false;
  vite.once('exit', () => {
    exited = true;
  });
  for (;;) {
    if (exited) throw new Error(`Vite exited before answering on :${PORT}`);
    try {
      const res = await fetch(`http://localhost:${PORT}/`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > READY_TIMEOUT_MS) {
      throw new Error(`Vite did not answer on :${PORT} within 60s`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  if (await portInUse()) {
    throw new Error(
      `Port ${PORT} is already in use. Is Mochi already running? Quit the other pet ` +
        '(click it, then Cmd+Q) or stop the other `npm run desktop`, then try again.',
    );
  }
  const vite = startVite();
  const killVite = () => {
    if (!vite.killed) vite.kill();
  };
  process.on('SIGINT', () => {
    killVite();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    killVite();
    process.exit(143);
  });

  try {
    await waitForVite(vite);
  } catch (err) {
    killVite();
    throw err;
  }

  const electron = spawn('npx', ['electron', '.'], {
    stdio: 'inherit',
    env: { ...process.env, MOCHI_DEV_URL: `http://localhost:${PORT}/` },
  });
  const code = await new Promise((resolve) => electron.on('close', resolve));
  killVite();
  process.exit(code ?? 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
