import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/* "abc1234 · 2026-10-28": which commit and day a build came from (problem reports). */
function buildLabel(): string {
  let sha = 'unknown'
  try {
    sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    /* not a git checkout */
  }
  return `${sha} · ${new Date().toISOString().slice(0, 10)}`
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset URLs so the packaged app can load dist/ over file://.
  base: './',
  define: {
    __MOCHI_BUILD__: JSON.stringify(buildLabel()),
  },
})
