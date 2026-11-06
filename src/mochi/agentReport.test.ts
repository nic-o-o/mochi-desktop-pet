import { describe, expect, it } from 'vitest';
import { parseReport, plainText, reportsDisagree } from './agentReport.ts';

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
