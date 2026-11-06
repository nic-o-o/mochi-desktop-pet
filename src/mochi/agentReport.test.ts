import { describe, expect, it } from 'vitest';
import { formGaps, parseReport, plainText, reportsDisagree } from './agentReport.ts';

/* Shaped like the codimango-review-assistant output contract. */
const REPORT = `I reviewed the task at the exact revision.

## Review summary

Revision: 3f2a9c1 · Coverage: full; Seam not run.
Findings: 1 blocker, 2 minor. Human verdict: Request changes.
Blocking: Yes

## Structured form

### 1. Quality Review Agent
**Reviewer Agrees?** Yes
**Notes**
The quality agent's verdict matches the trajectories.
Both failing runs hit the same missing fixture.

### 2. TBR Review Agreement
- Disagree criteria: None
- **Notes:** No disagreement.

### 3. Decision
**Decision:** Request changes
**If you did not accept the task, what kind of changes did you request?** Substantive changes
**Reason**
tests/test_timer.py asserts on wall-clock time, so the oracle passes only on fast machines.

### 4. Reviewer Confidence
High
`;

describe('parseReport', () => {
  it('splits the summary and every form section with its labelled fields', () => {
    const r = parseReport(REPORT)!;
    expect(r.summary).toContain('Findings: 1 blocker, 2 minor.');
    expect(r.summary).not.toContain('Structured form');
    expect(r.sections.map((s) => s.title)).toEqual(['Quality Review Agent', 'TBR Review Agreement', 'Decision', 'Reviewer Confidence']);
    expect(r.sections[0].fields).toEqual([
      { label: 'Reviewer Agrees?', value: 'Yes' },
      { label: 'Notes', value: "The quality agent's verdict matches the trajectories.\nBoth failing runs hit the same missing fixture." },
    ]);
    expect(r.sections[1].fields).toEqual([
      { label: 'Disagree criteria', value: 'None' },
      { label: 'Notes', value: 'No disagreement.' },
    ]);
    expect(r.sections[3]).toEqual({ title: 'Reviewer Confidence', fields: [], body: 'High' });
  });

  it('reads the decision from the Decision section and the blocking answer', () => {
    const r = parseReport(REPORT)!;
    expect(r.decision).toBe('Request changes');
    expect(r.blocking).toBe('Yes');
    expect(r.draft).toBe(false);
  });

  it('accepts bold-numbered section headings and DRAFT answers', () => {
    const r = parseReport(
      '## Review summary\nDRAFT: form controls not verified.\nBlocking: needs evidence\n\n## Structured form\n**1. Decision**\nAccept\n\n1. **Other Notes**\nNone.',
    )!;
    expect(r.sections.map((s) => s.title)).toEqual(['Decision', 'Other Notes']);
    expect(r.decision).toBe('Accept');
    expect(r.blocking).toBe('Needs evidence');
    expect(r.draft).toBe(true);
  });

  it('returns null without a Structured form, so the caller shows the raw text', () => {
    expect(parseReport('I could not reach Codimango, so there is no review.')).toBeNull();
    expect(parseReport('## Structured form\n\n')).toBeNull();
  });
});

/* Shaped like a real Claude Code run: autoloaded lines, bulleted findings inside text boxes, a not-yet decision. */
const NEEDS_EVIDENCE = `## Review summary
Status: DRAFT.

## Structured form

### 1. Quality Review Agent
Autoloaded: verdict Accept (GOOD), with Critical 0, High 0.

**Reviewer Agrees? — select:** Partially

**Notes**

The headline holds. Two problems:
- **Environment hygiene:** /app keeps 789 ancestor commits.
- **Difficulty:** "EASY" understates the results.

### 2. Taxonomy
- **Sub-domain — select:** web_backend
- **Use case — select:** extend_behavior
- **Action:** Save verification

### 3. Decision
**Decision — select:** Do not select yet — Needs evidence

*(If F1 is ruled against the task, choose Request changes and then Substantive changes.)*

**Reason**

No confirmed blockers remain.

**F1.**
- **Finding:** the base bundle ships full git history.
- **Blocking:** Needs evidence.

**F2.**
- **Finding:** authoring files are agent-visible.
- **Blocking:** No.
`;

describe('parseReport on text-box answers', () => {
  it('keeps bulleted findings inside the Notes and Reason they belong to', () => {
    const r = parseReport(NEEDS_EVIDENCE)!;
    expect(r.sections[0].fields.map((f) => f.label)).toEqual(['Reviewer Agrees? — select', 'Notes']);
    expect(r.sections[0].fields[1].value).toContain('Difficulty: "EASY" understates');
    const reason = r.sections[2].fields.find((f) => f.label === 'Reason')!;
    expect(reason.value).toContain('F1.\n- Finding: the base bundle ships full git history.');
    expect(reason.value).toContain('F2.\n- Finding: authoring files are agent-visible.\n- Blocking: No.');
  });

  it('still splits bulleted one-line fields such as Taxonomy axes', () => {
    expect(parseReport(NEEDS_EVIDENCE)!.sections[1].fields.map((f) => f.label)).toEqual([
      'Sub-domain — select',
      'Use case — select',
      'Action',
    ]);
  });

  it('keeps the autoloaded line and takes the decision only from the selected choice', () => {
    const r = parseReport(NEEDS_EVIDENCE)!;
    expect(r.sections[0].intro).toBe('Autoloaded: verdict Accept (GOOD), with Critical 0, High 0.');
    expect(r.decision).toBeUndefined();
    expect(r.blocking).toBe('Needs evidence');
  });
});

describe('formGaps', () => {
  it('names the always-present parts a report leaves out', () => {
    expect(formGaps(parseReport(REPORT)!)).toEqual(['Taxonomy']);
    const merged = parseReport(
      '## Structured form\n### 1. Human Checks\n**Realistic — select:** 3\n**Original — select:** 2\n**Additional Notes**\nOne paragraph for both.',
    )!;
    expect(formGaps(merged)).toEqual(['Taxonomy', 'Decision', 'a reason for each Human Checks score']);
  });

  it('is empty for a report with Taxonomy, Decision and a reason per score', () => {
    const full = parseReport(
      '## Structured form\n### 1. Taxonomy\n**Sub-domain:** Web APIs\n### 2. Human Checks\n**Realistic — select:** 3\n**Why this score?**\nA real API change.\n### 3. Decision\n**Decision:** Accept',
    )!;
    expect(formGaps(full)).toEqual([]);
  });
});

describe('plainText', () => {
  it('drops markdown emphasis for pasting into Codimango', () => {
    expect(plainText('**Reason**: the __oracle__ fails\n\n\n\nagain')).toBe('Reason: the oracle fails\n\nagain');
  });
});

describe('reportsDisagree', () => {
  it('flags different decisions or blocking answers, not one report alone', () => {
    const a = parseReport(REPORT)!;
    const b = parseReport(REPORT.replace('**Decision:** Request changes', '**Decision:** Accept').replace('Blocking: Yes', 'Blocking: No'))!;
    expect(reportsDisagree([a])).toBe(false);
    expect(reportsDisagree([a, a])).toBe(false);
    expect(reportsDisagree([a, b])).toBe(true);
  });
});
