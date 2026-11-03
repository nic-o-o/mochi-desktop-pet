import { useEffect, useMemo, useRef, useState } from 'react';
import type { FreshnessState, GlanceFlag, TaskItem, WeeklyGoals, XY } from './logic.ts';
import {
  PRIORITY_RANK,
  draftRowFlag,
  formatSla,
  freshnessLabel,
  pendingRank,
  pendingRowFlag,
  revisionRank,
  revisionRowFlag,
  ringFraction,
  stepGoal,
} from './logic.ts';
import { SetupCard } from './SetupCard.tsx';
import type { SetupKind } from './SetupCard.tsx';
import { SECTIONS } from './sections.ts';
import type { SectionKey, SectionPrefs } from './sections.ts';
import { SECTION_EVENT_NAME, logClick, logVpv, msSincePanelOpen, useVpv } from './usage.ts';

const KIND_SECTION: Record<'revision' | 'pending' | 'draft', SectionKey> = {
  revision: 'revisions',
  pending: 'reviews',
  draft: 'drafts',
};

interface OverviewPanelProps {
  position: XY;
  pending: TaskItem[];
  revisions: TaskItem[];
  drafts: TaskItem[];
  /** Which sections show (header filter menu); saved by the caller. */
  sections: SectionPrefs;
  onSectionsChange: (next: SectionPrefs) => void;
  /** Copies the tester's before/after review stats (filter menu footer); desktop shell only. */
  onCopyStats?: () => Promise<boolean>;
  /** Copies diagnostics and opens #mochi-dogfood-feedback in Slack (filter menu footer). */
  onReportProblem?: () => Promise<boolean>;
  reviewsCompleted: number;
  submissionsCompleted: number;
  goals: WeeklyGoals;
  nowMs: number;
  onSaveGoals: (goals: WeeklyGoals) => void;
  onClose: () => void;
  onOpenTask: (id: string) => void;
  /** Codimango CLI missing or signed out: show setup steps instead of the week. */
  setup?: { kind: SetupKind; checking: boolean; hint: boolean; onCheck: () => void; onOpenAlacarte: () => void };
  /** First Codimango read still running (nothing cached yet). */
  connecting?: boolean;
  /** Data age line under the header with a refresh button (desktop shell only). */
  freshness?: { fetchedAtMs: number | null; state: FreshnessState; onRefresh: () => void };
}

/** Small full-circle progress ring with a centered "done / goal" label. */
function MiniRing({
  frac,
  tone,
  done,
  goal,
}: {
  frac: number;
  tone: 'green' | 'orange';
  done: number;
  goal: number;
}) {
  return (
    <svg
      className="mini-ring"
      viewBox="0 0 72 72"
      width={72}
      height={72}
      role="img"
      aria-label={`${done} of ${goal}`}
    >
      <circle cx={36} cy={36} r={30} className="ring-track" strokeWidth={7} fill="none" />
      {frac > 0 && (
        <circle
          cx={36}
          cy={36}
          r={30}
          className={`ring-progress ring-${tone}`}
          strokeWidth={7}
          fill="none"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${frac * 100} 100`}
          transform="rotate(-90 36 36)"
        />
      )}
      <text
        x={36}
        y={37}
        textAnchor="middle"
        dominantBaseline="central"
        className={`mini-ring-label ring-${tone}-text`}
      >
        <tspan>{done} / </tspan>
        <tspan className="goal-num">{goal}</tspan>
      </text>
    </svg>
  );
}

/**
 * One stat card. Hovering (or tabbing into) the card underlines the goal
 * number and reveals ^/v steppers that nudge the goal, never below 1.
 */
function GlanceCard({
  title,
  caption,
  done,
  goal,
  tone,
  onStep,
}: {
  title: string;
  caption: string;
  done: number;
  goal: number;
  tone: 'green' | 'orange';
  onStep: (delta: 1 | -1) => void;
}) {
  return (
    <div className="glance-card">
      <h3>{title}</h3>
      <div className="glance-ring-row">
        <MiniRing frac={ringFraction(done, goal)} tone={tone} done={done} goal={goal} />
        <div className="goal-steppers" role="group" aria-label={`${title} goal controls`}>
          <button
            type="button"
            className="goal-stepper"
            onClick={() => onStep(1)}
            aria-label={`Increase ${title.toLowerCase()} goal`}
          >
            ˄
          </button>
          <button
            type="button"
            className="goal-stepper"
            onClick={() => onStep(-1)}
            disabled={goal <= 1}
            aria-label={`Decrease ${title.toLowerCase()} goal`}
          >
            ˅
          </button>
        </div>
      </div>
      <p>{caption}</p>
    </div>
  );
}

function RowFlag({ flag }: { flag: GlanceFlag }) {
  return <span className={`glance-flag tone-${flag.tone}`}>{flag.text}</span>;
}

/** One row; logs a VPV once per panel opening when half of it is on screen for 250 ms. */
function GlanceRow({
  task: t,
  kind,
  position,
  nowMs,
  onOpen,
}: {
  task: TaskItem;
  kind: 'revision' | 'pending' | 'draft';
  position: number;
  nowMs: number;
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const flag =
    kind === 'revision'
      ? revisionRowFlag(t.priority)
      : kind === 'draft'
        ? draftRowFlag(t.draftState)
        : pendingRowFlag(t.slaDueMs, nowMs);
  const fields = { section: SECTION_EVENT_NAME[KIND_SECTION[kind]], task_id: t.id, position, badge: flag.text };
  useVpv(ref, `row:${t.id}`, () => logVpv('glance_panel', 'row', fields));
  return (
    <li ref={ref} className="glance-row">
      <button
        type="button"
        className="glance-title"
        onClick={() => {
          logClick('glance_panel', 'row', { ...fields, ms_since_panel_open: msSincePanelOpen() });
          onOpen(t.id);
        }}
        title={t.title}
      >
        {t.title}
      </button>
      <div className="glance-meta">
        <span className="muted">
          {t.subtitle
            ? t.subtitle
            : kind === 'revision'
              ? t.checkSummary
                ? `Validation failed · ${t.checkSummary}`
                : `${t.type} · ${formatSla(t.slaDueMs, nowMs)}`
              : t.submittedBy
                ? `Submitted by ${t.submittedBy}`
                : `Assigned by ${t.requester}`}
        </span>
        <RowFlag flag={flag} />
      </div>
    </li>
  );
}

/** One glance section: the first task shows, the rest hide behind "View N more". */
function TaskSection({
  title,
  tasks,
  nowMs,
  kind,
  onOpen,
}: {
  title: string;
  tasks: TaskItem[];
  nowMs: number;
  kind: 'revision' | 'pending' | 'draft';
  onOpen: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  /* Flag-rank order: HI PRI above LOW PRI; Past due above 0d/1d/2d left.
     Stable, so priority-then-SLA order survives inside each bucket. */
  const ordered = useMemo(() => {
    const rank =
      kind === 'revision'
        ? (t: TaskItem) => revisionRank(t.priority)
        : kind === 'draft'
          ? (t: TaskItem) => PRIORITY_RANK[t.priority]
          : (t: TaskItem) => pendingRank(t.slaDueMs, nowMs);
    return tasks
      .map((t, i) => ({ t, i }))
      .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
      .map(({ t }) => t);
  }, [tasks, kind, nowMs]);
  const shown = expanded ? ordered : ordered.slice(0, 1);
  const remaining = ordered.length - shown.length;
  return (
    <div className="glance-section">
      <div className="glance-section-head">
        <h3>{title}</h3>
        <span className="count-pill" aria-label={`${tasks.length} tasks`}>
          {tasks.length}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="muted small">
          {kind === 'revision'
            ? 'No revisions requested.'
            : kind === 'draft'
              ? 'No drafts.'
              : 'Nothing awaiting review. Nice.'}
        </p>
      ) : (
        <>
          <ul className="glance-list">
            {shown.map((t, i) => (
              <GlanceRow key={t.id} task={t} kind={kind} position={i} nowMs={nowMs} onOpen={onOpen} />
            ))}
          </ul>
          {remaining > 0 && (
            <button
              type="button"
              className="glance-more"
              onClick={() => {
                logClick('glance_panel', 'view_more', { section: SECTION_EVENT_NAME[KIND_SECTION[kind]], hidden_count: remaining });
                setExpanded(true);
              }}
            >
              View {remaining} more ▾
            </button>
          )}
          {expanded && tasks.length > 1 && (
            <button type="button" className="glance-more" onClick={() => setExpanded(false)}>
              Show less ▴
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Header menu: checkboxes for which sections the panel lists (at least one stays on). */
function SectionFilter({
  prefs,
  counts,
  onChange,
  onCopyStats,
  onReportProblem,
}: {
  prefs: SectionPrefs;
  counts: Record<SectionKey, number>;
  onChange: (next: SectionPrefs) => void;
  onCopyStats?: () => Promise<boolean>;
  onReportProblem?: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [reportState, setReportState] = useState<'idle' | 'sent' | 'failed'>('idle');
  useEffect(() => {
    if (reportState === 'idle') return;
    const id = window.setTimeout(() => setReportState('idle'), 4000);
    return () => window.clearTimeout(id);
  }, [reportState]);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copyState === 'idle') return;
    const id = window.setTimeout(() => setCopyState('idle'), 2000);
    return () => window.clearTimeout(id);
  }, [copyState]);
  const onCount = SECTIONS.filter(({ key }) => prefs[key]).length;
  return (
    <div className="section-filter">
      <button
        type="button"
        className="icon-btn"
        aria-label="Choose sections"
        aria-expanded={open}
        title="Choose sections"
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.6}>
          <path d="M2 3.5h12M4.5 8h7M7 12.5h2" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="section-menu" role="group" aria-label="Sections to show">
          <p className="section-menu-title">Show in panel</p>
          {SECTIONS.map(({ key, label }) => {
            const last = prefs[key] && onCount === 1;
            return (
              <label key={key} className="section-option">
                <input
                  type="checkbox"
                  checked={prefs[key]}
                  disabled={last}
                  onChange={(e) => {
                    logClick('glance_panel', 'section_filter', { section: SECTION_EVENT_NAME[key], enabled: e.target.checked });
                    onChange({ ...prefs, [key]: e.target.checked });
                  }}
                />
                <span>{label}</span>
                <span className="section-count">{counts[key]}</span>
              </label>
            );
          })}
          {onCopyStats && (
            <button
              type="button"
              className="section-menu-action"
              onClick={() => {
                logClick('glance_panel', 'copy_stats');
                void onCopyStats().then((ok) => setCopyState(ok ? 'copied' : 'failed'));
              }}
              title="Copies your review speed before and since installing Mochi, to send to the Mochi team"
            >
              {copyState === 'copied' ? 'Copied ✓' : copyState === 'failed' ? "Couldn't copy" : 'Copy my review stats'}
            </button>
          )}
          {onReportProblem && (
            <button
              type="button"
              className="section-menu-action"
              onClick={() => {
                logClick('glance_panel', 'report_problem');
                void onReportProblem().then((ok) => setReportState(ok ? 'sent' : 'failed'));
              }}
              title="Copies diagnostics and opens #mochi-dogfood-feedback in Slack"
            >
              {reportState === 'sent'
                ? 'Diagnostics copied: paste them in Slack'
                : reportState === 'failed'
                  ? "Couldn't open the report"
                  : 'Report a problem…'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** "Your week at a glance" — compact floating overview next to the pet. */
export function OverviewPanel(props: OverviewPanelProps) {
  const { goals, reviewsCompleted, submissionsCompleted } = props;
  const lists: Record<SectionKey, { tasks: TaskItem[]; kind: 'revision' | 'pending' | 'draft' }> = {
    revisions: { tasks: props.revisions, kind: 'revision' },
    reviews: { tasks: props.pending, kind: 'pending' },
    drafts: { tasks: props.drafts, kind: 'draft' },
  };
  const shownSections = SECTIONS.filter(({ key }) => props.sections[key]);
  return (
    <section
      className="float-panel overview-panel"
      style={{ left: props.position.x, top: props.position.y }}
      role="dialog"
      aria-label="Your week at a glance"
    >
      <header className="panel-header glance-header">
        <h2>Your week at a glance</h2>
        <div className="glance-header-actions">
          {!props.setup && (
            <SectionFilter
              prefs={props.sections}
              counts={{
                revisions: props.revisions.length,
                reviews: props.pending.length,
                drafts: props.drafts.length,
              }}
              onChange={props.onSectionsChange}
              onCopyStats={props.onCopyStats}
              onReportProblem={props.onReportProblem}
            />
          )}
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close task panel">
            ×
          </button>
        </div>
      </header>
      {props.freshness && !props.setup && !props.connecting && (
        <p className={`glance-freshness${props.freshness.state === 'offline' || props.freshness.state === 'error' ? ' is-stale' : ''}`}>
          <span aria-live="polite">{freshnessLabel(props.freshness.fetchedAtMs, props.nowMs, props.freshness.state)}</span>
          <button
            type="button"
            className={`freshness-refresh${props.freshness.state === 'refreshing' ? ' is-spinning' : ''}`}
            onClick={props.freshness.onRefresh}
            disabled={props.freshness.state === 'refreshing'}
            aria-label="Refresh now"
            title="Refresh now"
          >
            ↻
          </button>
        </p>
      )}

      {props.setup ? (
        <SetupCard {...props.setup} />
      ) : (
        <>
          <div className="glance-cards">
            <GlanceCard
              title="Reviewed"
              caption="tasks this week"
              done={reviewsCompleted}
              goal={goals.reviewGoal}
              tone="green"
              onStep={(d) => {
                const next = stepGoal(goals.reviewGoal, d);
                logClick('glance_panel', 'goal_stepper', { goal: 'reviews', old_value: goals.reviewGoal, new_value: next });
                props.onSaveGoals({ ...goals, reviewGoal: next });
              }}
            />
            <GlanceCard
              title="Accepted"
              caption="goals this week"
              done={submissionsCompleted}
              goal={goals.submissionGoal}
              tone="orange"
              onStep={(d) => {
                const next = stepGoal(goals.submissionGoal, d);
                logClick('glance_panel', 'goal_stepper', { goal: 'accepted', old_value: goals.submissionGoal, new_value: next });
                props.onSaveGoals({ ...goals, submissionGoal: next });
              }}
            />
          </div>

          {props.connecting ? (
            <p className="muted small glance-connecting">Connecting to Codimango…</p>
          ) : (
            shownSections.map(({ key, label }, i) => (
              <div key={key}>
                {i > 0 && <hr className="glance-divider" />}
                <TaskSection
                  title={label}
                  tasks={lists[key].tasks}
                  nowMs={props.nowMs}
                  kind={lists[key].kind}
                  onOpen={props.onOpenTask}
                />
              </div>
            ))
          )}
        </>
      )}
    </section>
  );
}
