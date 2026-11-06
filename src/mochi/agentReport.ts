/* Agent review report → summary + review-form fields, for the report view.
 * The codimango-review-assistant skill answers in two parts: "## Review
 * summary" and "## Structured form", the form numbered in UI order with bold
 * field labels. Parsing is lenient (the skill's wording changes without a Mochi
 * release); when there is no Structured form heading, the caller shows the raw
 * text with one Copy button instead. Pure, so it is unit-tested in Node.
 */

export interface ReportField {
  label: string;
  value: string;
}

export interface ReportSection {
  title: string;
  /** Bold-labelled fields in the section, in order; empty when it is plain text. */
  fields: ReportField[];
  /** Text before the first field, such as the autoloaded agent verdict (read-only on the form). */
  intro?: string;
  /** The whole section as plain text (Copy for sections without fields). */
  body: string;
}

export type Blocking = 'Yes' | 'No' | 'Needs evidence';

export interface ParsedReport {
  summary: string;
  decision?: 'Accept' | 'Request changes' | 'Reject';
  blocking?: Blocking;
  /** The skill marks answers it couldn't verify as DRAFT. */
  draft: boolean;
  sections: ReportSection[];
}

const SUMMARY_HEADING = /^#{1,3}\s*Review summary\s*#*\s*$/im;
const FORM_HEADING = /^#{1,3}\s*Structured form\s*#*\s*$/im;
const SECTION_PATTERNS = [
  /^#{3,4}\s+(?:\d+[.)]\s*)?(.+?)\s*#*\s*$/,
  /^\*\*\s*\d+[.)]\s*(.+?)\s*\*\*\s*$/,
  /^\d+[.)]\s+\*\*(.+?)\*\*\s*$/,
];
const BOLD_FIELD = /^\s*(?:[-*]\s+)?\*\*(.+?)\*\*\s*:?\s*(.*)$/;
const BULLET_FIELD = /^\s*[-*]\s+([^:*.]{1,60}):\s+(.+)$/;
const DECISIONS = /\b(Accept|Request changes|Reject)\b/;
/** "**F1.**", "**2)**": numbered findings inside a Reason, not new fields. */
const ENUMERATOR = /^[A-Z]?\d+[.)]?$/;

/** Markdown emphasis off, for display and for pasting into Codimango's text boxes. */
export function plainText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sectionTitle(line: string): string | null {
  for (const re of SECTION_PATTERNS) {
    const m = re.exec(line);
    if (m) return plainText(m[1]).replace(/:$/, '').trim();
  }
  return null;
}

/**
 * A text box's label ("**Reason**", "**Notes**") sits on its own line with the
 * answer below. Inside such an answer, bulleted bold labels and numbered
 * finding headings belong to the answer, so Copy takes all of it.
 */
function parseFields(lines: string[]): { intro: string; fields: ReportField[] } {
  const fields: ReportField[] = [];
  const intro: string[] = [];
  let current: { label: string; lines: string[]; textBox: boolean } | null = null;
  const close = () => {
    if (!current) return;
    const value = plainText(current.lines.join('\n'));
    if (value) fields.push({ label: current.label, value });
    current = null;
  };
  for (const line of lines) {
    const m = BOLD_FIELD.exec(line) ?? BULLET_FIELD.exec(line);
    const label = m ? plainText(m[1]).replace(/:$/, '').trim() : '';
    const insideAnswer = current?.textBox && (/^\s*[-*]\s/.test(line) || ENUMERATOR.test(label));
    if (m && !insideAnswer) {
      close();
      current = { label, lines: m[2] ? [m[2]] : [], textBox: !m[2] };
    } else if (current) {
      current.lines.push(line);
    } else {
      intro.push(line);
    }
  }
  close();
  return { intro: plainText(intro.join('\n')), fields };
}

function between(text: string, from: RegExp, to?: RegExp): string {
  const start = from.exec(text);
  if (!start) return '';
  const rest = text.slice(start.index + start[0].length);
  const end = to ? to.exec(rest) : null;
  return end ? rest.slice(0, end.index) : rest;
}

export function parseReport(text: string): ParsedReport | null {
  const src = text.replace(/\r\n/g, '\n');
  if (!FORM_HEADING.test(src)) return null;
  const summary = plainText(between(src, SUMMARY_HEADING, FORM_HEADING));
  const form = between(src, FORM_HEADING);

  const sections: ReportSection[] = [];
  let current: { title: string; lines: string[] } | null = null;
  const close = () => {
    if (!current) return;
    const body = plainText(current.lines.join('\n'));
    if (!body && current.title === 'Form') return;
    const { intro, fields } = parseFields(current.lines);
    sections.push({ title: current.title, fields, body, ...(intro && fields.length > 0 ? { intro } : {}) });
  };
  for (const line of form.split('\n')) {
    const title = sectionTitle(line);
    if (title) {
      close();
      current = { title, lines: [] };
    } else {
      current ??= { title: 'Form', lines: [] };
      current.lines.push(line);
    }
  }
  close();
  if (sections.length === 0) return null;

  const decisionSection = sections.find((s) => /^decision\b/i.test(s.title));
  // In the form, only the selected choice counts: an answer like "Do not select
  // yet — Needs evidence (…choose Request changes if…)" has no decision.
  const decisionField = decisionSection?.fields.find((f) => /^decision\b/i.test(f.label));
  const decision = (
    decisionSection
      ? /^(Accept|Request changes|Reject)\b/.exec((decisionField?.value ?? decisionSection.body).trim())
      : DECISIONS.exec(/^.*(verdict|decision).*$/im.exec(summary)?.[0] ?? '')
  )?.[1] as ParsedReport['decision'];
  const blockingMatch = /Blocking:\s*\**\s*(Yes|No|Needs evidence)/i.exec(src);
  const blocking = blockingMatch
    ? ((blockingMatch[1][0].toUpperCase() + blockingMatch[1].slice(1).toLowerCase()) as Blocking)
    : undefined;

  return { summary, decision, blocking, draft: /\bDRAFT\b/.test(src), sections };
}

/**
 * Parts of the review form the report leaves out, for a "fill these in
 * yourself" banner. Only parts every form has are checked: Mochi doesn't know
 * which conditional sections (Validation Override, Agentic Full-Task Review)
 * a task shows.
 */
export function formGaps(report: ParsedReport): string[] {
  const gaps: string[] = [];
  const find = (re: RegExp) => report.sections.find((s) => re.test(s.title));
  if (!find(/taxonomy/i)) gaps.push('Taxonomy');
  if (!find(/^decision\b/i)) gaps.push('Decision');
  const checks = find(/human checks/i);
  if (checks && !checks.fields.some((f) => /\bwhy\b/i.test(f.label))) gaps.push('a reason for each Human Checks score');
  return gaps;
}

/** Two finished reports disagree when their decision or blocking answer differs. */
export function reportsDisagree(reports: ParsedReport[]): boolean {
  const decided = reports.filter((r) => r.decision || r.blocking);
  if (decided.length < 2) return false;
  const key = (r: ParsedReport) => `${r.decision ?? ''}|${r.blocking ?? ''}`;
  return decided.some((r) => key(r) !== key(decided[0]));
}
