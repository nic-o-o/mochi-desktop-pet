# Mochi — Desktop Pet UI Prototype

A floating desktop-pet companion that tracks pending reviews, revision requests,
and weekly goals. Built with React, TypeScript, and Vite. In the desktop shell the panel shows
your real Codimango reviews and revisions (read through your `codimango` CLI
login); in a plain browser it shows mock data.

## Run it

```sh
npm install
npm run dev
```

Then open the printed local URL (default `http://localhost:5173/`).

Other commands:

```sh
npm test    # Vitest suite: state priority, task sorting, goal validation, geometry, shell bridge
npm run build
npm run lint
```

## Codimango data (desktop shell)

Sign-in is your existing Codimango CLI login; Mochi never reads or stores the
token. Install the CLI from Alacarte (`devfeature_codimango`), then run
`codimango auth setup` once.

- **Fetch:** `electron/codimango.mjs` runs `codimango task list --filter
  reviewing` and `--filter mine` (about 7 s total today) and passes only the
  fields the panel needs to the renderer (about 50 KB instead of about 4 MB).
- **Rows and ranking:** `src/mochi/codimango.ts`. Waiting for your review =
  reviews still `being_reviewed`, ranked by time left to the SLA (past due,
  under 24 h, 24–48 h, over 48 h; escalated reviews move up one level). Needs
  revision = your `needs_revision` tasks, ranked by distance from the stale
  auto-archive (archive warning, failing 10+ days, failing, then pending or
  passing oldest first).
- **Refresh:** `src/mochi/useTasks.ts` shows the cached snapshot immediately,
  then refreshes on launch, on panel open and every 10 minutes (at most once a
  minute).
- **Setup card:** when the CLI is missing (`cli_missing`) or signed out
  (`login_required`), the glance panel shows setup steps instead of the week:
  Open Alacarte, a copyable `codimango auth setup`, and Check connection.
  `offline` / `error` keep the cached rows and log `[mochi] codimango …` to
  the terminal. Try it with `MOCHI_CODIMANGO_BIN=/nonexistent npm run desktop`.
- **Opening a task:** clicking a title (panel or full list) opens the task's
  Codimango page (`/reviews/<id>` or `/submissions/<id>`) in your browser via
  `openLink` in `src/mochi/shell.ts`; the main process only opens
  Codimango URLs. Mock rows (no `url`) keep the local detail view.
- **Baseline:** `npm run baseline [days] [--json]` prints your time to verdict
  (pool entry to verdict: median, p90, worst) for before/after comparisons.

## Ask agents to review (desktop shell)

Each row in Waiting for your review has **Ask agents**: pick Claude Code
and/or Codex and they review the task on this Mac, under your own logins.
Mochi bubbles when a report is ready; the report shows the decision, blocking
answer and every review-form field with Copy. Mochi never submits a review:
you read the report, decide, and submit in Codimango (Open in Codimango).

- **Reviewer:** the team-aai `codimango-review-assistant` skill, so its rubric
  updates reach Mochi without a release. Claude Code loads it from your plugins
  (`claude plugin install team-aai@agent-market` if missing); Codex is pointed
  at the skill's `SKILL.md`.
- **Runs:** `electron/agentReview.mjs` starts `claude -p` / `codex exec` by full
  path in a fresh temp folder, at most two at once, and stops a run after 45
  minutes. Runs and reports are saved under `userData/agent-reviews/` (kept 14
  days); a run still going when Mochi quits comes back as interrupted.
- **Reports:** `src/mochi/agentReport.ts` splits the skill's "Review summary"
  and "Structured form" into fields; a report it can't split is shown as
  written. A report from before the task's latest change says so.
- **Try it without agents:** `MOCHI_CLAUDE_BIN=/nonexistent npm run desktop`
  shows the "can't find Claude Code" failure.

## Delegate to agent (desktop shell)

Each row in Needs revision has **Delegate to agent**: pick Codex and confirm,
and Mochi launches the `$green` skill on your devserver (asked the first
time you delegate, then saved, via `agentcloudctl`) to repair that task — Green reads the validation findings,
hands the repair to Codex, proves it locally, pushes, and waits for
validation, detached for up to 10 hours. Mochi reports the worker pid and
log path when the first decision lands; it does not write the repair prompt
itself (Green authors it from the findings). Before launching, Mochi checks
Green is installed on the devserver (installing it with Agent Market if
needed), resolves the task checkout from the task's `sourceRepo` under
`~/AAI/` and verifies it, clones it over SSH if it is missing, fast-forwards
it to `origin/main` if the task directory is missing from a stale checkout
(only a fast-forward, never a rebase), checks the task directory exists,
stopping before launching and naming the task's commit if it is still missing,
and runs Green `doctor --install-hooks` there. The
launch is `green <task-slug> --live --hardening --detach --agent codex`, so
confirming edits and pushes the real task. Delegations are remembered locally
(`mochi.delegations.v1`) so the pid and log survive the panel closing; while
the panel is open, each row shows only the worker's live status, fetched every
30 seconds (starting, working, and done in green; blocked and not running in
red; unknown in grey when the check fails).

## Codimango SEVs (desktop shell)

When a Codimango SEV opens, Mochi bubbles (⚠️ "Codimango SEV3 open") because
it can block submission, validation or reviews; clicking opens the SEV. While
it's open the panel has one line for it, and Mochi bubbles again (✅) when it's
mitigated. Each SEV bubbles once.

Mochi reads SEVs every ten minutes through `/opt/facebook/bin/meta` with your
login (`electron/sevs.mjs`). It keeps public SEV1–3s with Codimango in the
title, opened in the last week; only SEVs opened in the last day bubble. Titles
about security holes or personal data are left out, so they never pop up on a
shared screen. If `meta` is missing or the read fails, Mochi stays quiet.

## Install as a Mac app (one-click download)

Download **`Mochi.dmg`** from the latest release
(`github.com/nic-o-o/mochi-desktop-pet/releases/latest`), open it and drag
**Mochi** to **Applications**, then open Mochi from Spotlight or Launchpad.

> First launch: macOS can't verify the app (ad-hoc signed, not notarized),
> so it warns it may be malware. Click **Done**, then System Settings →
> Privacy & Security → **Open Anyway**, and open Mochi again. (Right-click →
> Open on the app skips the Settings trip.)

To update, quit Mochi first (right-click its Dock icon → Quit), then drag the
new DMG's Mochi to Applications and choose Replace. Only one Mochi runs at a
time, so a new copy opened while the old one runs just quits. The packaged app loads its built files,
so no terminal or Vite server is needed; right-click its Dock icon for
**Open at Login**.
Logs go to `~/Library/Logs/Mochi/main.log`.

**Releasing to testers:** cut a version per "Release cadence & version cuts"
below and push the `vx.y.z` tag — CI builds the DMG and publishes the
release automatically. (The old Drive-folder flow via `npm run release` is
retired; the script remains for local rebuilds: `npm run release` alone
rebuilds the current version.)

### Build it yourself (developers)

```sh
npm install
npm run package
```

This builds `out/Mochi.dmg` — the same file CI attaches to each
version-tagged release. Or run `npm run package -- --install`: it replaces
the installed copy (`/Applications`, else `~/Applications`) and restarts a
running Mochi on the new build.

## Release cadence & version cuts

Every user-facing change ships to testers inside a **versioned cut** — no
unversioned DMGs. `package.json` is the single source of truth for the
version; the download link and any future updater all key off it.

- **Cadence:** cut **weekly (Friday)** with everything merged that week, plus
  **on-demand cuts** for urgent dogfood fixes. If Friday has nothing merged,
  skip the week — say so in chat so nobody waits on it.
- **How to cut** (releaser only, one at a time — `main` is protected, so the
  bump itself goes through a PR):
  ```sh
  git checkout main && git pull
  git checkout -b mochi/release-x.y.z
  npm version patch   # or minor for a feature batch
  git push -u origin mochi/release-x.y.z
  ```
  open a PR titled `Release x.y.z`, merge it, then tag the merge:
  ```sh
  git checkout main && git pull
  git tag vx.y.z && git push origin vx.y.z
  ```
  The tag is what release CI (and the `releases/latest` download link) listens to.
- **Rule for PR authors (Debra and everyone):** every PR must declare in its
  description whether it **rides the next scheduled cut** or **needs its own
  cut** (urgent tester-facing fix). The PR template has the checkbox — check
  it, or the PR doesn't merge. The releaser batches "rides along" PRs into
  the Friday cut.

The app is ad-hoc signed only (no Apple Developer ID, not notarized). On the
Mac that built it, it opens normally; a copy downloaded on another Mac needs
System Settings → Privacy & Security → **Open Anyway** on first launch. If
the package step can't download Electron behind the proxy, run it as
`NODE_USE_ENV_PROXY=1 npm run package`.

## Desktop pet (Electron shell, Mac-first dev prototype)

The same React app runs as a real floating desktop pet: a single SMALL
transparent window (`electron/main.mjs`) shrink-wrapped around the visible UI
— pet-sized normally, growing to cover the panel/bubble/task card while open,
paw-sized when hidden. The renderer computes the union of visible rects in
screen coordinates (`unionBounds` in `src/mochi/logic.ts`) and pushes it to
the shell, which resizes/moves the window to match. Technically everything on
a desktop is a window — but this one never exists beyond Mochi's own pixels.

Clicks need no hover toggling: mouse events stay enabled permanently and
unpainted (fully transparent) pixels pass through to the apps below natively,
so small buttons can't fall through a toggling race. Dragging moves the pet by
moving the window (pet position state → bounds sync). There is no on-screen
notification button in shell mode — press **Cmd+Shift+M** anywhere to replay
past notifications instead.

Run it on your Mac (it cannot open a window on a headless devserver):

```sh
rsync -avz --exclude node_modules --exclude dist zixuanchen@devvm7438.hil0:/home/zixuanchen/bin/Oct23Nwr/model1/ ~/mochi-prototype/
cd ~/mochi-prototype
npm install     # downloads the Mac Electron binary (~100MB) on first install
npm run desktop # starts Vite + the pet; quit with Cmd+Q or the dock icon
```

The terminal prints `[mochi] preload bridge installed`, `[mochi] shell
renderer ready`, and the shortcut registration — if the pet never appears,
those lines say which half failed (plus a warning after 5s with no sync).

Manual checklist on the Mac (not yet run — no display server here):

1. Only Mochi floats over your desktop — no backdrop page, no big window
   (Mission Control shows a small window titled “Mochi”).
2. Drag moves the pet (window follows); click (no drag) opens the panel.
3. Minus hides to the paw; paw restores. Panel/bubble/expanded open, edit
   goals, Cmd+Shift+M replays the latest past notification.
4. Clicks on transparent gaps beside the pet reach the app below (nothing
   hides unexpectedly); idle 10s → sleepy; swipe Spaces — the pet follows.
5. `npm test` still passes (84 tests, incl. bridge + union geometry + glance flags + goal steppers + notifications + setup card).

Limits: primary display only (re-clamped on display change); overlay level is
`floating` (switch to `screen-saver` in `electron/main.mjs` to float over
fullscreen video too); dock icon kept so the prototype is easy to quit (no
tray menu, no autostart, no `.dmg` packaging yet); dev-only (backed by the
Vite dev server, no rebuild per change). If dragging feels laggy, say so —
the fix is a direct move-window IPC bypassing React state per frame.

## What was verified (headless Chromium, 45 checks + Vitest, 30 tests)

- Drag moves the pet without opening the panel (6px click/drag threshold); a
  plain click toggles the task panel.
- Real arrivals (review verdicts, validation pass/fail) → nervous bubble near
  the pet, which stays until clicked → clicking the bubble opens its task page
  (clicking the pet clears it instead). Verdicts on reviews you were assigned
  (usually your own) go to history without popping. Cmd+Shift+M replays past
  notifications newest first.
- Goal editor accepts positive integers only (`0`, `abc`, `2.5` rejected with
  messages, Save disabled); saving updates the panel cards, the pet rings, and
  `localStorage` immediately.
- Expanded view lists 5 mock tasks sorted by priority then nearest SLA;
  titles open a local mock detail; search drives an empty state; the footer
  stays visible while the list scrolls; “Back to overview” returns to the panel.
- Hide (−) closes pet + panel and leaves a paw restore button; restore works.
- States follow Focused > Nervous > Happy > Sleepy > Chilling (hover can't
  override an open panel; bubble beats hover); sleepy triggers after 10s idle;
  `prefers-reduced-motion` disables animations (asserted via computed style).
- Bubble and panel flip to stay inside the viewport near screen edges
  (asserted with the pet parked at the right edge); goals and pet position
  survive a page reload via `localStorage` (`mochi.goals.v1`, `mochi.petPos.v1`).

## Approximations and limits

- No design assets were provided: Mochi is an original placeholder SVG/CSS pet
  (see `MochiPet.tsx`); silhouette and expressions are stand-ins, noted in the
  page footer.
- True always-on-top system-window behavior is out of scope: Mochi floats above
  the page content via fixed positioning.
- The expanded view replaces (rather than stacks on) the overview panel to
  avoid double cards; the expanded task view counts as “panel open” for the
  Focused state.
- Hidden state is session-only (not persisted); completed counts are fixed mock
  data (1 review of 5, 2 submissions of 2, with true counts in text).
- Task detail actions (approve/request changes) are not included — detail is
  read-only by design for this phase.
