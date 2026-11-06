/* Mochi desktop shell — preload bridge (context-isolated, CommonJS).
 * In a plain browser (npm run dev) `window.mochiShell` is undefined and the
 * renderer in src/mochi/shell.ts no-ops, so browser behavior is unchanged.
 */
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = () => callback();
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('mochiShell', {
  getDisplayBounds: () => ipcRenderer.invoke('mochi:get-display-bounds'),
  onDisplayChanged: (callback) => subscribe('mochi:display-changed', callback),
  onSimulateNotification: (callback) => subscribe('mochi:simulate-notification', callback),
  onSystemResumed: (callback) => subscribe('mochi:system-resumed', callback),
  onReportRequest: (callback) => subscribe('mochi:report-request', callback),
  reportProblem: (state) => ipcRenderer.invoke('mochi:report-problem', state),
  syncBounds: (rect) => ipcRenderer.send('mochi:sync-bounds', rect),
  fetchCodimango: () => ipcRenderer.invoke('mochi:fetch-codimango'),
  openLink: (url) => ipcRenderer.invoke('mochi:open-link', url),
  logEvent: (event) => ipcRenderer.send('mochi:log-event', event),
  usageSummary: () => ipcRenderer.invoke('mochi:usage-summary'),
  raise: () => ipcRenderer.send('mochi:raise'),
  listAgentReviews: () => ipcRenderer.invoke('mochi:agent-reviews-list'),
  startAgentReview: (req) => ipcRenderer.invoke('mochi:agent-review-start', req),
  cancelAgentReview: (id) => ipcRenderer.invoke('mochi:agent-review-cancel', id),
  onAgentReviewsChanged: (callback) => {
    const listener = (_event, jobs) => callback(jobs);
    ipcRenderer.on('mochi:agent-reviews', listener);
    return () => ipcRenderer.removeListener('mochi:agent-reviews', listener);
  },
  listSevs: () => ipcRenderer.invoke('mochi:sevs-list'),
  onSevsChanged: (callback) => {
    const listener = (_event, sevs) => callback(sevs);
    ipcRenderer.on('mochi:sevs', listener);
    return () => ipcRenderer.removeListener('mochi:sevs', listener);
  },
  onScreenLock: (callback) => {
    const listener = (_event, locked) => callback(locked);
    ipcRenderer.on('mochi:screen-lock', listener);
    return () => ipcRenderer.removeListener('mochi:screen-lock', listener);
  },
});

// Boot log: the only proof the bridge loaded (forwarded to the terminal).
console.log('[mochi] preload bridge installed');
