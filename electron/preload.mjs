/* Mochi desktop shell — preload bridge (context-isolated).
 * Exposes a single capability: let mouse events through except over Mochi UI.
 * In a plain browser (npm run dev) `window.mochiShell` is undefined and the
 * renderer in src/mochi/shell.ts no-ops, so browser behavior is unchanged.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('mochiShell', {
  setIgnoreMouseEvents: (ignore) =>
    ipcRenderer.send('mochi:set-ignore-mouse', ignore === true),
});

// TEMP-DEBUG: proves the bridge loaded; remove after click diagnosis.
console.log('[mochi] preload bridge installed');
