import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { FreshnessState, GlanceFlag, TaskItem, WeeklyGoals, XY } from './logic.ts';
import {
  PRIORITY_RANK,
  dedupeSentences,
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
import { AgentRow } from './AgentRow.tsx';
import type { AgentReviewControls } from './AgentRow.tsx';
import { DelegateRow, TaskHandlerStatus } from './DelegateRow.tsx';
import { delegateAvailable } from './shell.ts';
import { isActive, jobsForTask } from './agentReviews.ts';
import { SetupCard } from './SetupCard.tsx';
import type { SetupKind } from './SetupCard.tsx';
import { SEV_LINES_MAX, sevHeadline } from './sevs.ts';
import type { Sev } from './sevs.ts';
import { SECTIONS } from './sections.ts';
import type { SectionKey, SectionOrder, SectionPrefs } from './sections.ts';
import { NOTIFY_ICONS, NOTIFY_KINDS } from './notifyPrefs.ts';
import type { NotifyPrefs } from './notifyPrefs.ts';
import { SECTION_EVENT_NAME, logClick, logVpv, msSincePanelOpen, useVpv } from './usage.ts';
import { SectionDragHandle } from './SectionDragHandle.tsx';
import { useSectionDrag } from './useSectionDrag.ts';
import { appSettings, canSubmit, setAppSetting, submitDryRun, submitSha, submitTask } from './shell.ts';
import type { AppSettings } from './shell.ts';
import { forgetDelegateNode, loadDelegateNode } from './delegations.ts';

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
  /** Drafts whose validation passes (submittable); filtered by the caller. */
  submittable: TaskItem[];
  /** Which sections show (header filter menu); saved by the caller. */
  sections: SectionPrefs;
  onSectionsChange: (next: SectionPrefs) => void;
  /** Section order, top first (main panel drag handles); saved by the caller. */
  sectionOrder: SectionOrder;
  onSectionOrderChange: (next: SectionOrder) => void;
  /** Which notification kinds may pop the bubble (bell menu); saved by the caller. */
  notify: NotifyPrefs;
  onNotifyChange: (next: NotifyPrefs) => void;
  /** Row to highlight and scroll to (the notification that opened the panel). */
  highlightTaskId?: string | null;
  /** Unread notifications, for the header bell's count. */
  unread?: number;
  /** "Show notifications" at the end of the bell menu: replay the bubbles, latest first. */
  onShowNotifications?: () => void;
  /** Copies the tester's before/after review stats (filter menu footer); desktop shell only. */
  /** Copies diagnostics and opens #mochi-dogfood-feedback in Slack (filter menu footer). */
  onReportProblem?: () => Promise<boolean>;
  /** Opens Customize Mochi (filter menu footer); only when this build can draw pets. */
  onCustomize?: () => void;
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
  /** "Ask agents" on review rows (desktop shell only). */
  agentReview?: AgentReviewControls;
  /** A direct submit landed: caller refreshes tasks (desktop shell only). */
  onSubmitted?: () => void;
  /** Open Codimango SEVs: one line each at the top, most severe first. */
  sevs?: Sev[];
  onOpenSev?: (sev: Sev) => void;
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

/** Friendly one-liner for a failed submit step. */
function describeSubmitError(error?: { kind: string; message?: string }): string {
  if (error?.message) return dedupeSentences(error.message);
  switch (error?.kind) {
    case 'login_required':
      return 'Codimango login expired — run codimango auth setup.';
    case 'offline':
      return 'Offline — will not submit without a connection.';
    case 'cli_missing':
      return 'Codimango CLI missing.';
    default:
      return 'Submission blocked.';
  }
}

type SubmitPhase = 'idle' | 'confirming' | 'working' | 'done' | 'blocked';

/** One row; logs a VPV once per panel opening when half of it is on screen for 250 ms. */
function GlanceRow({
  task: t,
  kind,
  position,
  nowMs,
  onOpen,
  eventSection,
  agentReview,
  onSubmitted,
  highlighted = false,
}: {
  task: TaskItem;
  kind: 'revision' | 'pending' | 'draft';
  position: number;
  /** The task a clicked notification is about: flashed and scrolled into view. */
  highlighted?: boolean;
  nowMs: number;
  onOpen: (id: string) => void;
  /** Logging section override (ready-for-submission rows share the draft look). */
  eventSection?: SectionKey;
  agentReview?: AgentReviewControls;
  onSubmitted?: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [highlighted]);
  const flag =
    kind === 'revision'
      ? revisionRowFlag(t.priority)
      : kind === 'draft'
        ? draftRowFlag(t.draftState)
        : pendingRowFlag(t.slaDueMs, nowMs);
  const section = SECTION_EVENT_NAME[eventSection ?? KIND_SECTION[kind]];
  const fields = { section, task_id: t.id, position, badge: flag.text };
  useVpv(ref, `row:${t.id}`, () => logVpv('glance_panel', 'row', fields));
  /* Ready drafts get Submit in the flag slot (drafts + ready-for-submission sections). */
  const showSubmit = kind === 'draft' && t.draftState === 'ready' && canSubmit();
  /* Revision rows delegate to Green (desktop shell only); the status label
     sits on the meta line and the picker below it share this one guard. */
  const showDelegate = kind === 'revision' && delegateAvailable();
  /* An Ask-agent review on this row is named in the status line; it never blocks a Green repair. */
  const reviewJobRunning = agentReview ? jobsForTask(agentReview.jobs, t.id).some(isActive) : false;
  const [phase, setPhase] = useState<SubmitPhase>('idle');
  const [note, setNote] = useState('');
  const clickFields = { section, task_id: t.id, ms_since_panel_open: msSincePanelOpen() };
  const runSubmit = async () => {
    setPhase('working');
    setNote('Checking…');
    logClick('glance_panel', 'submit_button', { ...clickFields, action: 'confirm' });
    const dry = await submitDryRun(t.id);
    if (!dry) {
      setPhase('blocked');
      setNote('Submit needs the desktop shell.');
      return;
    }
    if (!dry.ok) {
      setPhase('blocked');
      setNote(describeSubmitError(dry.error));
      logClick('glance_panel', 'submit_button', { ...clickFields, action: 'blocked_preflight' });
      return;
    }
    setNote('Submitting…');
    const sh = await submitSha(t.id);
    if (!sh?.ok || !sh.sha) {
      setPhase('blocked');
      setNote(describeSubmitError(sh?.error));
      logClick('glance_panel', 'submit_button', { ...clickFields, action: 'blocked_no_sha' });
      return;
    }
    const done = await submitTask(t.id, sh.sha);
    if (!done?.ok) {
      setPhase('blocked');
      setNote(describeSubmitError(done?.error));
      logClick('glance_panel', 'submit_button', { ...clickFields, action: 'blocked_submit' });
      return;
    }
    setPhase('done');
    setNote('Submitted ✓');
    logClick('glance_panel', 'submit_button', { ...clickFields, action: 'submitted' });
    onSubmitted?.();
  };
  return (
    <li ref={ref} className={highlighted ? 'glance-row is-highlighted' : 'glance-row'}>
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
        <div className="glance-meta-line">
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
          {showSubmit ? (
            phase === 'idle' || phase === 'confirming' ? (
              <button
                type="button"
                className="btn-link agent-link"
                onClick={() => {
                  logClick('glance_panel', 'submit_button', { ...clickFields, action: 'open_confirm' });
                  setPhase('confirming');
                }}
              >
                Submit
              </button>
            ) : (
              <span className="muted small">{phase === 'done' ? 'Submitted ✓' : note}</span>
            )
          ) : (
            <RowFlag flag={flag} />
          )}
        </div>
        {showDelegate && (
          <div className="glance-meta-line">
            <TaskHandlerStatus taskSlug={t.title} reviewJobRunning={reviewJobRunning} />
          </div>
        )}
      </div>
      {kind === 'pending' && agentReview && (
        <AgentRow taskId={t.id} jobs={jobsForTask(agentReview.jobs, t.id)} nowMs={nowMs} controls={agentReview} />
      )}
      {showDelegate && <DelegateRow taskId={t.id} taskSlug={t.title} detail={t.checkSummary} />}
      {showSubmit && phase === 'confirming' && (
        <div className="agent-row">
          <fieldset className="agent-picker">
            <legend>Submit for review</legend>
            <p className="muted small">Submits this exact validated revision. ATR may auto-accept.</p>
            <div className="agent-picker-actions">
              <button type="button" className="btn-secondary" onClick={() => setPhase('idle')}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={() => void runSubmit()}>
                Submit
              </button>
            </div>
          </fieldset>
        </div>
      )}
      {showSubmit && phase === 'blocked' && (
        <div className="agent-row">
          <ul className="agent-status-list">
            <li className="agent-status agent-failed">{note}</li>
          </ul>
          <div className="agent-row-actions">
            <button
              type="button"
              className="btn-link agent-link"
              onClick={() => {
                logClick('glance_panel', 'submit_button', { ...clickFields, action: 'open_codimango' });
                setPhase('idle');
                onOpen(t.id);
              }}
            >
              Submit through Codimango
            </button>
          </div>
        </div>
      )}
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
  eventSection,
  emptyText,
  agentReview,
  onSubmitted,
  highlightTaskId,
  dragHandle,
  dragging,
}: {
  title: string;
  tasks: TaskItem[];
  highlightTaskId?: string | null;
  nowMs: number;
  kind: 'revision' | 'pending' | 'draft';
  onOpen: (id: string) => void;
  /** Logging section + empty copy overrides (ready-for-submission shares the draft look). */
  eventSection?: SectionKey;
  emptyText?: string;
  agentReview?: AgentReviewControls;
  onSubmitted?: () => void;
  /** Grip at the head's left edge that reorders the section (main panel only). */
  dragHandle?: ReactNode;
  dragging?: boolean;
}) {
  /* A highlighted task below the first row opens the section so it can be seen. */
  const [expanded, setExpanded] = useState(() => !!highlightTaskId && tasks.some((t) => t.id === highlightTaskId));
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
    <div className={`glance-section${dragging ? ' is-dragging' : ''}`}>
      {dragHandle}
      <div className="glance-section-head">
        <h3>{title}</h3>
        <span className="count-pill" aria-label={`${tasks.length} tasks`}>
          {tasks.length}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="muted small">
          {emptyText ??
            (kind === 'revision'
              ? 'No revisions requested.'
              : kind === 'draft'
                ? 'No drafts.'
                : 'Nothing awaiting review. Nice.')}
        </p>
      ) : (
        <>
          <ul className="glance-list">
            {shown.map((t, i) => (
              <GlanceRow
                key={t.id}
                task={t}
                kind={kind}
                position={i}
                nowMs={nowMs}
                onOpen={onOpen}
                eventSection={eventSection}
                agentReview={agentReview}
                onSubmitted={onSubmitted}
                highlighted={t.id === highlightTaskId}
              />
            ))}
          </ul>
          {remaining > 0 && (
            <button
              type="button"
              className="glance-more"
              onClick={() => {
                logClick('glance_panel', 'view_more', { section: SECTION_EVENT_NAME[eventSection ?? KIND_SECTION[kind]], hidden_count: remaining });
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

/** Checked items first, unchecked items at the bottom, each side keeping its
 * order. Display only — it never rewrites the saved order or prefs. */
function partitionEnabled<T>(items: readonly T[], enabled: (item: T) => boolean): T[] {
  return [...items.filter(enabled), ...items.filter((item) => !enabled(item))];
}

/** Header menu: which sections the panel lists — in the order set by dragging the
 * section headers in the main panel. At least one section stays on. Reordering
 * lives on the main panel, not here; notification kinds live behind the bell. */
export function SectionFilter({
  prefs,
  counts,
  onChange,
  order,
  open,
  onOpenChange,
}: {
  prefs: SectionPrefs;
  counts: Record<SectionKey, number>;
  onChange: (next: SectionPrefs) => void;
  order: SectionOrder;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const onCount = SECTIONS.filter(({ key }) => prefs[key]).length;
  const shownSections = partitionEnabled(order, (key) => prefs[key]);

  return (
    <div className="section-filter">
      <button
        type="button"
        className="icon-btn"
        aria-label="Choose sections"
        aria-expanded={open}
        title="Show in panel"
        onClick={() => onOpenChange(!open)}
      >
        <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.6}>
          <path d="M2 3.5h12M4.5 8h7M7 12.5h2" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="section-menu" role="group" aria-label="Sections to show">
          <p className="section-menu-title">Show in panel</p>
          {shownSections.map((key) => {
            const label = SECTIONS.find((s) => s.key === key)?.label ?? key;
            const last = prefs[key] && onCount === 1;
            return (
              <div key={key} className={`section-option-row${prefs[key] ? '' : ' is-off'}`}>
                <label className="section-option">
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Header gear menu: Mochi's own settings and help, kept apart from what the
 * panel shows (the filter menu) and from notifications (the bell menu). */
export function SettingsMenu({
  open,
  onOpenChange,
  onReportProblem,
  onCustomize,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReportProblem?: () => Promise<boolean>;
  onCustomize?: () => void;
}) {
  const [reportState, setReportState] = useState<'idle' | 'sent' | 'failed'>('idle');
  useEffect(() => {
    if (reportState === 'idle') return;
    const id = window.setTimeout(() => setReportState('idle'), 4000);
    return () => window.clearTimeout(id);
  }, [reportState]);
  /* Read fresh each time the menu opens: the dock menu can change these too. */
  const [settings, setSettings] = useState<AppSettings | null>(null);
  /* Bumped by Change so the saved devserver is read again. */
  const [nodeVersion, setNodeVersion] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- nodeVersion only forces a fresh read
  const node = useMemo(() => (open ? loadDelegateNode() : null), [open, nodeVersion]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void appSettings().then((next) => live && setSettings(next));
    return () => {
      live = false;
    };
  }, [open]);

  function toggle(key: keyof AppSettings, value: boolean, component: string) {
    logClick('glance_panel', component, { enabled: value });
    void setAppSetting(key, value).then((next) => next && setSettings(next));
  }

  return (
    <div className="settings-menu-wrap">
      <button
        type="button"
        className="icon-btn"
        aria-label="Settings"
        aria-expanded={open}
        title="Settings"
        onClick={() => {
          if (!open) logClick('glance_panel', 'settings');
          onOpenChange(!open);
        }}
      >
        {/* cog outline (Feather "settings", MIT) */}
        <svg
          viewBox="0 0 24 24"
          width={14}
          height={14}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && (
        <div className="section-menu settings-menu" role="group" aria-label="Mochi settings">
          <p className="section-menu-title">Settings</p>
          {onCustomize && (
            <button
              type="button"
              className="section-menu-action"
              onClick={() => {
                logClick('glance_panel', 'customize');
                onOpenChange(false);
                onCustomize();
              }}
            >
              Customize Mochi…
            </button>
          )}
          {typeof settings?.openAtLogin === 'boolean' && (
            <label className="section-option">
              <input
                type="checkbox"
                checked={settings.openAtLogin}
                onChange={(e) => toggle('openAtLogin', e.target.checked, 'open_at_login')}
              />
              <span>Open at login</span>
            </label>
          )}
          {settings && (
            <label className="section-option">
              <input type="checkbox" checked={settings.sharing} onChange={(e) => toggle('sharing', e.target.checked, 'share_usage')} />
              <span>Share usage data</span>
            </label>
          )}
          {node && (
            <div className="settings-row">
              <span className="settings-row-label" title={node}>
                Delegation devserver: {node.split('.')[0]}
              </span>
              <button
                type="button"
                className="btn-link"
                onClick={() => {
                  logClick('glance_panel', 'delegate_node_forget');
                  forgetDelegateNode();
                  setNodeVersion((v) => v + 1);
                }}
                title="Forget it; the next delegation asks again"
              >
                Change
              </button>
            </div>
          )}
          {onReportProblem && <p className="section-menu-title settings-menu-group">Help</p>}
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

/** Header bell menu: which notification kinds may pop the bubble. It opens like
 * the filter menu, anchored to the bell. Past notices still replay from the
 * pet's bell and the shortcut, whatever is switched off here, and from the
 * "Show notifications" line at the end of this menu. */
export function NotifyMenu({
  notify,
  onNotifyChange,
  open,
  onOpenChange,
  unread,
  onShowNotifications,
}: {
  notify: NotifyPrefs;
  onNotifyChange: (next: NotifyPrefs) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unread?: number;
  onShowNotifications?: () => void;
}) {
  const shownNotify = partitionEnabled(NOTIFY_KINDS, ({ key }) => notify[key]);
  return (
    <div className="notify-filter">
      <button
        type="button"
        className="icon-btn panel-bell"
        aria-label="Notification settings"
        aria-expanded={open}
        title="Notification settings"
        onClick={() => {
          logClick('glance_panel', 'notify_menu', { unread_count: unread ?? 0 });
          onOpenChange(!open);
        }}
      >
        <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden="true" focusable="false">
          <path
            d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5c0 3-1.2 4.2-1.9 4.9-.3.3 0 .6.4.6h11.9c.5 0 .8-.3.5-.6-.7-.7-1.9-1.9-1.9-4.9A4.5 4.5 0 0 0 8 1.5ZM6.6 13.5a1.5 1.5 0 0 0 2.8 0H6.6Z"
            fill="currentColor"
          />
        </svg>
        {unread ? <span className="panel-bell-count">{unread > 9 ? '9+' : unread}</span> : null}
      </button>
      {open && (
        <div className="section-menu" role="group" aria-label="Notify me about">
          <p className="section-menu-title">Notify me about</p>
          {shownNotify.map(({ key, label }) => (
            <label key={key} className={`section-option${notify[key] ? '' : ' is-off'}`}>
              <input
                type="checkbox"
                checked={notify[key]}
                onChange={(e) => {
                  logClick('glance_panel', 'notify_filter', { notif_kind: key, enabled: e.target.checked });
                  onNotifyChange({ ...notify, [key]: e.target.checked });
                }}
              />
              <span aria-hidden="true">{NOTIFY_ICONS[key]}</span>
              <span>{label}</span>
            </label>
          ))}
          <p className="muted small section-menu-note">Switched-off kinds don&apos;t pop up; the pet bell replays past ones.</p>
          {onShowNotifications && (
            <button
              type="button"
              className="btn-link section-menu-link"
              onClick={() => {
                logClick('glance_panel', 'notifications', { unread_count: unread ?? 0 });
                onOpenChange(false);
                onShowNotifications();
              }}
            >
              {unread ? `Show notifications (${unread > 9 ? '9+' : unread} new)` : 'Show notifications'}
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
  const lists: Record<
    SectionKey,
    { tasks: TaskItem[]; kind: 'revision' | 'pending' | 'draft'; eventSection?: SectionKey; emptyText?: string }
  > = {
    revisions: { tasks: props.revisions, kind: 'revision' },
    reviews: { tasks: props.pending, kind: 'pending' },
    drafts: { tasks: props.drafts, kind: 'draft' },
    submittable: {
      tasks: props.submittable,
      kind: 'draft',
      eventSection: 'submittable',
      emptyText: 'No drafts ready to submit.',
    },
  };
  /* Sections with no tasks are hidden entirely — each only appears when at least one task exists.
     Order is the person's (main panel drag handles); the default pins Ready for submission first. */
  const shownSections = props.sectionOrder
    .map((key) => SECTIONS.find((s) => s.key === key))
    .filter((s): s is (typeof SECTIONS)[number] => !!s && props.sections[s.key] && lists[s.key].tasks.length > 0);
  /* One header menu open at a time: the bell's notify menu, the filter menu or Settings. */
  const [openMenu, setOpenMenu] = useState<'sections' | 'notify' | 'settings' | null>(null);
  /* Dragging a section header reorders the shown sections; the filter menu
     follows this order. Hidden sections keep their places. */
  const sectionsRef = useRef<HTMLDivElement | null>(null);
  const sectionDrag = useSectionDrag({
    listRef: sectionsRef,
    order: props.sectionOrder,
    shown: shownSections.map(({ key }) => key),
    onOrderChange: props.onSectionOrderChange,
  });
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
            <NotifyMenu
              notify={props.notify}
              onNotifyChange={props.onNotifyChange}
              open={openMenu === 'notify'}
              onOpenChange={(next) => setOpenMenu(next ? 'notify' : null)}
              unread={props.unread}
              onShowNotifications={props.onShowNotifications}
            />
          )}
          {!props.setup && (
            <SectionFilter
              prefs={props.sections}
              counts={{
                revisions: props.revisions.length,
                reviews: props.pending.length,
                drafts: props.drafts.length,
                submittable: props.submittable.length,
              }}
              onChange={props.onSectionsChange}
              order={props.sectionOrder}
              open={openMenu === 'sections'}
              onOpenChange={(next) => setOpenMenu(next ? 'sections' : null)}
            />
          )}
          {!props.setup && (
            <SettingsMenu
              open={openMenu === 'settings'}
              onOpenChange={(next) => setOpenMenu(next ? 'settings' : null)}
              onCustomize={props.onCustomize}
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

      {props.sevs && props.sevs.length > 0 && (
        <ul className="sev-lines" aria-label="Codimango SEVs">
          {props.sevs.slice(0, SEV_LINES_MAX).map((sev) => (
            <li key={sev.id}>
              <button
                type="button"
                className="sev-line"
                title={`SEV${sev.level} open: ${sev.title}`}
                onClick={() => {
                  logClick('glance_panel', 'sev', { notif_kind: 'sev_open' });
                  props.onOpenSev?.(sev);
                }}
              >
                <span aria-hidden="true">⚠️</span> SEV{sev.level} · {sevHeadline(sev.title)}
              </button>
            </li>
          ))}
          {props.sevs.length > SEV_LINES_MAX && <li className="sev-more">+{props.sevs.length - SEV_LINES_MAX} more open</li>}
        </ul>
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
          ) : shownSections.length === 0 ? (
            <p className="muted small">You&apos;re all caught up. Nice.</p>
          ) : (
            <div ref={sectionsRef}>
              {shownSections.map(({ key, label }, i) => (
                <div key={key}>
                  {i > 0 && <hr className="glance-divider" />}
                  <TaskSection
                    title={label}
                    tasks={lists[key].tasks}
                    nowMs={props.nowMs}
                    kind={lists[key].kind}
                    onOpen={props.onOpenTask}
                    eventSection={lists[key].eventSection}
                    emptyText={lists[key].emptyText}
                    agentReview={props.agentReview}
                    onSubmitted={props.onSubmitted}
                    highlightTaskId={props.highlightTaskId}
                    dragging={sectionDrag.draggingKey === key}
                    dragHandle={
                      <SectionDragHandle
                        label={label}
                        dragging={sectionDrag.draggingKey === key}
                        onPointerDown={(e) => sectionDrag.startDrag(e, key, i)}
                        onKeyDown={(e) => sectionDrag.moveWithKeys(e, key, i)}
                      />
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
