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
5. `npm test` still passes (82 tests, incl. bridge + union geometry + glance flags + goal steppers + notifications + setup card).

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
  (clicking the pet clears it instead). Cmd+Shift+M replays past notifications
  newest first.
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
