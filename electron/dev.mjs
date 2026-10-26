/* `npm run desktop` — one-command Mochi desktop shell (Mac-first).
 * Spawns Vite, waits for it to answer, then opens the Electron overlay.
 * Ctrl+C (or quitting Electron) stops both. No extra dependencies.
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

async function waitForVite() {
  const started = Date.now();
  for (;;) {
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
    await waitForVite();
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
