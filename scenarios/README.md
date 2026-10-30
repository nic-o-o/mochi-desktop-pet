# Interaction scenarios

Plain-language descriptions of what Mochi should do, checked on every `npm test`.
Each scenario says what Codimango returns, what the person does, and what they
should see. The runner (`src/test/scenarios/runner.tsx`) renders the real app in
jsdom with a fake desktop bridge, so no Electron, CLI or network is needed.

```sh
npm run scenarios        # just these
npm test                 # everything
```

A failure names the scenario, the step and what was on screen instead.

## A scenario

```yaml
- id: notif-review-assigned                # unique, kebab-case, prefix = area
  title: A new review pops a bubble; clicking it opens the review
  given:
    saved: quiet_day                       # what Mochi saved last time (optional)
    live: new_review_assigned              # what the next fetch returns
  steps:
    - start
    - expect: { bubble: Review Assigned, badge: 1 }
    - click_bubble
    - expect: { opened: [/reviews/r2], badge: none }
```

## Data (`fixtures:` and `given:`)

A snapshot has `reviewing` (reviews assigned to you) and `mine` (your tasks).
Rows are shorthand; times are relative to when the test runs:

| Field | Meaning |
|---|---|
| `id`, `name`, `track` | Task id (used in URLs), name, track |
| `review` | Reviewing feed: `open`, `accepted`, `rejected`, `needs_revision` |
| `status` | Mine feed: `draft`, `being_reviewed`, `needs_revision`, `accepted`… |
| `validation`, `failed_checks`, `oracle` | `passing` / `failed` / `pending`; failed check labels; `"1/3"` |
| `due_in_h`, `claimed_ago_h`, `pooled_ago_h`, `reviewed_ago_h`, `updated_ago_h` | Hours ahead / ago |
| `warned_ago_d`, `failing_since_d`, `escalation` | Stale-archive warning, failing since (days), escalation level |

Snapshot-level `age_min` makes a saved snapshot older (default 0).

`given:`
- `saved`: a fixture name or inline snapshot. Mochi diffs the first fetch against it, which is how "something changed while Mochi was closed" pops a bubble. Leave it out for a first launch.
- `live`: a fixture, an inline snapshot, `{ error: cli_missing | login_required | offline | error }`, or a list (one per fetch; the last repeats).
- `sections`: saved section choices, e.g. `{ revisions: false, reviews: true, drafts: true }`.

## Steps

| Step | Does |
|---|---|
| `start` | Launch Mochi and wait for the first fetch |
| `click_pet` | Click the pet (toggles the panel) |
| `click_bell`, `click_bubble`, `close_bubble` | Bell, bubble body, bubble × |
| `bubble_older`, `bubble_newer` | › and ‹ in the bubble |
| `open_menu`, `toggle_section: Drafts` | ≡ menu; tick or untick a section |
| `refresh_now` | ↻ on the freshness line |
| `click: <text>` | Any button or link showing that text |
| `next_fetch: <live>` | Change what the following fetches return |
| `wake`, `dock_report` | Mac woke up; Dock → Report a Problem |
| `wait: <ms>` | Let time pass |
| `expect: {…}` | Check (retries for up to 1.5 s) |

## Expectations

| Key | Passes when |
|---|---|
| `see`, `not_see` | Mochi's UI contains / doesn't contain each string (the mock backdrop page is ignored) |
| `in_order` | The strings appear in this order (ranking) |
| `panel` | `open` or `closed` |
| `bubble` | The bubble contains this text, or `none` |
| `badge` | Unread count on the bell, or `none` |
| `opened` | A link containing each string was opened (cumulative) |
| `clipboard` | The last clipboard write contains each string |
| `report` | The last problem report matches (partial), e.g. `{ status: offline, counts: { reviews: 1 } }` |
| `disabled` | These ≡ menu checkboxes are disabled |
| `events` | Usage events that should fire (see below) |

## Events

`events:` lists the usage events a step should log, using the names in the
[logging plan](https://docs.google.com/document/d/1bVqcRBZaEfgywid8Q6Y_NgMZvAo47KTFpiCXyHo-4Q8/edit):
`{ event: mochi_click, surface: panel, component: task_row, section: reviews }`.
Until the app logs them, each scenario with events shows one `todo` in the test
output; once logging lands, the runner checks them like any other expectation.

## Adding a scenario

Write the behaviour the way you'd explain it to a tester, run `npm run scenarios`,
and keep it if it passes. If it fails, either the app or the scenario is wrong;
decide which before changing either. `AGENTS.md` has the same loop for an agent.
