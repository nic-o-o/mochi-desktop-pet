import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentId, AgentJob } from './agentReviews.ts';
import { AGENT_LABELS, isActive, isStale, minutesLabel } from './agentReviews.ts';
import type { ParsedReport } from './agentReport.ts';
import { formGaps, parseReport, plainText, reportsDisagree } from './agentReport.ts';
import type { TaskItem, XY } from './logic.ts';
import { logClick, logVpv } from './usage.ts';

interface AgentReportViewProps {
  /** Shell mode: pin the card near the pet instead of centering on screen. */
  anchor?: XY | null;
  taskId: string;
  /** The review row, while it is still waiting for you (gone once delivered). */
  task?: TaskItem;
  jobs: AgentJob[];
  nowMs: number;
  onRunAgain: (agent: AgentId) => void;
  onCancel: (jobId: string) => void;
  onOpenCodimango?: () => void;
  onClose: () => void;
  onBack: () => void;
}

/** "a", "a and b", "a, b and c". */
function listText(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A Copy button that says "Copied" for two seconds. */
function CopyButton({ text, label, onCopied }: { text: string; label: string; onCopied: () => void }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const id = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(id);
  }, [state]);
  return (
    <button
      type="button"
      className="btn-link agent-copy"
      aria-label={label}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setState('copied');
            onCopied();
          },
          () => setState('failed'),
        );
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : 'Copy'}
    </button>
  );
}

function ReportBody({ job, report, stale, onCopied }: { job: AgentJob; report: ParsedReport | null; stale: boolean; onCopied: (position: number | 'all') => void }) {
  const raw = job.report ?? '';
  const gaps = report ? formGaps(report) : [];
  let position = 0;
  return (
    <div className="agent-report">
      {stale && (
        <p className="agent-banner" role="status">
          Task changed since this report. Run it again to review the latest revision.
        </p>
      )}
      {report === null ? (
        <>
          <p className="muted small">Mochi couldn't split this report into form fields, so here it is as written.</p>
          <div className="agent-field-head">
            <span />
            <CopyButton text={plainText(raw)} label="Copy whole report" onCopied={() => onCopied('all')} />
          </div>
          <p className="agent-text">{plainText(raw)}</p>
        </>
      ) : (
        <>
          {gaps.length > 0 && (
            <p className="agent-banner" role="status">
              This report leaves out {listText(gaps)}. Fill {gaps.length > 1 ? 'those' : 'that'} in on Codimango yourself, and check for sections
              only some tasks show, like Validation Override.
            </p>
          )}
          <div className="agent-verdict">
            {report.decision && <span className="agent-chip">Decision: {report.decision}</span>}
            {report.blocking && <span className={`agent-chip${report.blocking === 'Yes' ? ' is-blocking' : ''}`}>Blocking: {report.blocking}</span>}
            {report.draft && <span className="agent-chip is-draft">Draft: check before submitting</span>}
            <CopyButton text={plainText(raw)} label="Copy whole report" onCopied={() => onCopied('all')} />
          </div>
          {report.summary && <p className="agent-text agent-summary">{report.summary}</p>}
          {report.sections.map((section, i) => (
            <section key={`${i}-${section.title}`} className="agent-section">
              <h4>{section.title}</h4>
              {section.intro && <p className="agent-text muted">{section.intro}</p>}
              {section.fields.length > 0 ? (
                section.fields.map((f) => {
                  const at = position++;
                  return (
                    <div key={`${f.label}-${at}`} className="agent-field">
                      <div className="agent-field-head">
                        <span className="agent-field-label">{f.label}</span>
                        <CopyButton text={f.value} label={`Copy ${section.title}: ${f.label}`} onCopied={() => onCopied(at)} />
                      </div>
                      <p className="agent-text">{f.value}</p>
                    </div>
                  );
                })
              ) : (
                (() => {
                  const at = position++;
                  return (
                    <div className="agent-field">
                      <div className="agent-field-head">
                        <span />
                        <CopyButton text={section.body} label={`Copy ${section.title}`} onCopied={() => onCopied(at)} />
                      </div>
                      <p className="agent-text">{section.body}</p>
                    </div>
                  );
                })()
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

/** Agent reports for one review: a tab per agent, every form field with Copy. Never submits. */
export function AgentReportView(props: AgentReportViewProps) {
  const { jobs, task, nowMs } = props;
  const taskName = task?.title ?? jobs[0]?.taskName ?? 'this review';
  const [tab, setTab] = useState<AgentId | null>(() => (jobs.find((j) => j.status === 'done') ?? jobs[0])?.agent ?? null);
  const active = jobs.find((j) => j.agent === tab) ?? jobs[0];
  const parsed = useMemo(() => new Map(jobs.map((j) => [j.id, j.report ? parseReport(j.report) : null])), [jobs]);
  const disagree = reportsDisagree(jobs.flatMap((j) => (j.status === 'done' && parsed.get(j.id) ? [parsed.get(j.id)!] : [])));

  const seen = useRef('');
  useEffect(() => {
    if (!active) return;
    const key = `${active.id}:${active.status}`;
    if (seen.current === key) return;
    seen.current = key;
    logVpv('agent_review', 'report', { task_id: props.taskId, kind: active.agent, status: active.status });
  }, [active, props.taskId]);

  const fields = (extra: Record<string, string | number> = {}) => ({ task_id: props.taskId, kind: active?.agent, ...extra });

  return (
    <div className="mochi-scrim" onClick={props.onClose}>
      <section
        className="float-panel expanded-view agent-report-view"
        style={props.anchor ? { left: props.anchor.x, top: props.anchor.y } : undefined}
        role="dialog"
        aria-label={`Agent review: ${taskName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="panel-header panel-header-sticky">
          <h2>Agent review</h2>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close agent review">
            ×
          </button>
        </header>

        <div className="expanded-body">
          <h3 className="detail-title">{taskName}</h3>
          {jobs.length > 1 && (
            <div className="agent-tabs" role="tablist" aria-label="Agents">
              {jobs.map((j) => (
                <button
                  key={j.agent}
                  type="button"
                  role="tab"
                  aria-selected={j.agent === active?.agent}
                  className={`agent-tab${j.agent === active?.agent ? ' is-active' : ''}`}
                  onClick={() => {
                    logClick('agent_review', 'tab', { task_id: props.taskId, kind: j.agent });
                    setTab(j.agent);
                  }}
                >
                  {AGENT_LABELS[j.agent]}
                </button>
              ))}
            </div>
          )}
          {active?.model && (
            <p className="muted small agent-model">
              {AGENT_LABELS[active.agent]} · {active.model}
            </p>
          )}
          {disagree && (
            <p className="agent-banner" role="status">
              The agents disagree on the decision. Compare both reports before you decide.
            </p>
          )}

          {!active ? (
            <p className="muted">No agent has reviewed this task yet.</p>
          ) : active.status === 'queued' ? (
            <p className="agent-progress">{AGENT_LABELS[active.agent]} is waiting for another review to finish.</p>
          ) : active.status === 'running' ? (
            <p className="agent-progress" aria-live="polite">
              {AGENT_LABELS[active.agent]} is reviewing · {minutesLabel(active.startedAtMs ?? active.createdAtMs, nowMs)}
              {active.steps > 0 ? ` · ${active.steps} steps` : ''}. Mochi will tell you when the report is ready.
            </p>
          ) : active.status === 'failed' ? (
            <div className="agent-failure" role="alert">
              <p>{active.failure?.message ?? 'The review stopped.'}</p>
              {active.failure?.fix && (
                <p className="small">
                  To fix it, run <code>{active.failure.fix}</code> in Terminal, then run the review again.
                </p>
              )}
            </div>
          ) : (
            <ReportBody
              job={active}
              report={parsed.get(active.id) ?? null}
              stale={isStale(active, task)}
              onCopied={(position) =>
                logClick('agent_review', position === 'all' ? 'copy_all' : 'copy', fields(position === 'all' ? {} : { position }))
              }
            />
          )}
        </div>

        <footer className="panel-actions panel-footer-sticky">
          {active && isActive(active) && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                logClick('agent_review', 'cancel', fields());
                props.onCancel(active.id);
              }}
            >
              Stop review
            </button>
          )}
          {active && !isActive(active) && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                logClick('agent_review', 'run_again', fields());
                props.onRunAgain(active.agent);
              }}
            >
              Run again
            </button>
          )}
          {props.onOpenCodimango && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                logClick('agent_review', 'open_codimango', fields());
                props.onOpenCodimango?.();
              }}
            >
              Open in Codimango
            </button>
          )}
          <button type="button" className="btn-primary" onClick={props.onBack}>
            Back to overview
          </button>
        </footer>
      </section>
    </div>
  );
}
