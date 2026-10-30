# Scenarios: instructions for coding agents

You keep `scenarios/*.yaml` in step with how Mochi behaves. Format: `README.md`.

## When a PR changes behaviour

1. Read the PR description and diff. List each interaction it adds or changes, in
   the form "when <data / action>, the person sees <result>".
2. For each, find the scenario that covers it (`grep -n` the ids and titles). Update
   it, or add one to the file for that area (`ls scenarios/*.yaml`), or a new file
   for a new surface.
3. Use the copy the person actually sees (titles, button text, badges). Don't
   assert on class names, colours or layout; those belong in unit tests.
4. Add `events:` for each interaction the logging plan says should be logged.
5. Run `npm run scenarios`. A new scenario must fail if you break the behaviour it
   describes: change one expected string and confirm it fails, then change it back.

## When a scenario fails

Decide which side is wrong before editing anything:

- **The app regressed**: the scenario matches the intended behaviour (PR, README,
  install doc). Report the scenario id, the step, and expected vs. on screen. Don't
  edit the scenario to make it pass.
- **The behaviour changed on purpose**: the PR says so. Update the scenario and say
  which PR changed it in your summary.
- **The scenario was wrong**: e.g. it missed the "View N more" link, or the fixture
  times don't trigger the rule (a new row only pops if its timestamp is after the
  saved snapshot's). Fix the scenario and explain why it was wrong.

If you can't tell, say so and ask; don't guess.

## Exploring

To look for gaps, read `src/mochi/notifications.ts`, `codimango.ts` and
`OverviewPanel.tsx`, list behaviours with no scenario, and propose new ones as a
list before writing them.
