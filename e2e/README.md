# End-to-end tests

The same `scenarios/*.yaml` that `npm test` runs in jsdom, run against the real
Electron app with Playwright. Mac only (needs a screen).

```sh
npm run e2e                     # builds dist/, then runs every scenario against the dev app
npm run e2e -- -g panel-rows    # one scenario (Playwright's --grep)
npm run package && MOCHI_E2E_APP=out/Mochi-darwin-arm64/Mochi.app npm run e2e:app   # the packaged app testers install
```

Failures attach a screenshot of the window and the scenario's `events.jsonl`;
open `out/e2e-report/index.html` to see them.

## What's real

| | `npm test` (jsdom) | `npm run e2e` |
|---|---|---|
| React app | real | real |
| Main process, preload bridge, IPC | fake bridge | **real** |
| Codimango CLI | fake results | **fake `codimango` program**, run by the real `electron/codimango.mjs` (exit codes, JSON parsing, parallel reads) |
| Clicks | synthetic events | **real mouse input** in the real window |
| Links | recorded by the fake bridge | **recorded in the main process** after `isAllowedLink` (no browser opens) |
| Clipboard | stub | **the system clipboard** |
| Report a Problem | bridge call | **real diagnostics** on the clipboard, Slack URL opened |
| Usage events | recorded by the fake bridge | **read back from `events.jsonl`**, after the main process sanitizes them |
| Visibility (VPV) | everything visible | **real `IntersectionObserver`** in the real window |
| Speed | ~3 s for all | ~1–2 min for all |

Not covered: the Dock menu itself (`dock_report` sends the menu item's message
directly), the system Open at Login setting, and the real Codimango service.

## How it works

- **One app per run.** Before each scenario, the runner clears Mochi's storage,
  presets what Mochi "saved last time", points the fake CLI at the scenario's
  data, then loads the page (`start`).
- **Isolated.** `MOCHI_USER_DATA_DIR` gives the test app its own profile and log
  folder, so it never reads your data or clashes with the Mochi you have open.
  `MOCHI_LOAD_DIST=1` loads the built `dist/` instead of the Vite server.
- **Fake CLI.** `MOCHI_CODIMANGO_BIN` points at `e2e/fake-codimango.mjs`, which
  answers `task list --filter reviewing|mine` from a queue the runner writes,
  with the real CLI's exit codes for sign-in (9) and network (5) failures. "CLI
  missing" removes the program from that path.
- **Clipboard.** The run overwrites your clipboard.

Set `MOCHI_E2E_KEEP=1` to keep the temp folder (profile, logs, fake CLI queue)
after a run.
