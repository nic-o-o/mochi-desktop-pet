# Mochi · Desktop Pet UI (prototype)

A floating desktop-pet companion that tracks pending tasks, items awaiting
review, and weekly goals. Built with React + TypeScript + Vite, using local
mock data only.

## Run it

```bash
npm install
npm run dev      # prototype UI in the browser
npm test         # vitest suite (24 tests)
npm run build    # production build
```

## Desktop app (Tauri, macOS)

Mochi can run as a real desktop pet: a frameless, transparent,
always-on-top window that hugs the visible UI, so the rest of your screen
stays clickable. The browser version above is unchanged.

One-time setup on your Mac:

```bash
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Then, from this folder:

```bash
npm install
npm run tauri dev    # live desktop pet
npm run tauri build  # produces Mochi.app / .dmg under src-tauri/target
```

Notes:

- v1 covers the primary display only.
- If `tauri dev`/`build` complains about a missing window permission, it
  names the exact permission — add it to
  `src-tauri/capabilities/default.json` and retry.
- The app icon is generated from `src/assets/hero.png` (placeholder art);
  swap the source and re-run `npx tauri icon <file>` to change it.

## Verified interactions

- Drag the pet: it follows the pointer, stays inside the viewport, and
  releasing after a drag does **not** open the panel (6px click/drag threshold).
- Click the pet: toggles the task overview panel.
- 🔔 Simulate notification → bubble appears near the pet (Mochi turns
  Nervous) → clicking the bubble opens the panel and dismisses it.
- Edit weekly goals: invalid inputs (0, negatives, decimals, letters, empty,
  >999) show inline errors; Save updates the panel bars, the pet rings, and
  `localStorage` immediately. Cancel discards drafts.
- View all tasks: list is sorted urgent → high → medium → low, then nearest
  SLA; titles open a local mock detail view; footer actions stay visible while
  the list scrolls.
- Hide (−) and restore (🐾 pill, bottom-right).
- Idle 10s → Sleepy; hover/drag → Happy; bubble → Nervous; open panel →
  Focused. Priority is deterministic: Focused > Nervous > Happy > Sleepy >
  Chilling (see `src/logic/petState.ts` + tests).
- Refresh the page: goals and pet position persist via `localStorage`.

## Approximations / incomplete

- Pet art is a placeholder SVG/CSS blob (no reference assets were provided).
- "Always-on-top across applications" is out of scope: Mochi floats above the
  page content within the browser tab.
- Task detail links open a local mock view, not any internal site.
- Weekly completed counts are fixed mock values (`src/data/mockTasks.ts`).
- No chat, accounts, or backend — by design for this phase.
