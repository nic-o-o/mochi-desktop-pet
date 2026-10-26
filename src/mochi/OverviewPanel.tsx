import type { TaskItem, WeeklyGoals, XY } from './logic.ts';
import { formatSla, ringFraction } from './logic.ts';
import { GoalEditor } from './GoalEditor.tsx';

interface OverviewPanelProps {
  position: XY;
  pending: TaskItem[];
  revisions: TaskItem[];
  reviewsCompleted: number;
  submissionsCompleted: number;
  goals: WeeklyGoals;
  nowMs: number;
  editing: boolean;
  onSaveGoals: (goals: WeeklyGoals) => void;
  onCancelEdit: () => void;
  onClose: () => void;
  onEditGoals: () => void;
  onViewAll: () => void;
  onOpenTask: (id: string) => void;
}

function MiniRow({ task, nowMs, onOpen }: { task: TaskItem; nowMs: number; onOpen: (id: string) => void }) {
  return (
    <li className="mini-row">
      <button type="button" className="mini-title" onClick={() => onOpen(task.id)} title={task.title}>
        {task.title}
      </button>
      <span className={`prio-dot prio-${task.priority}`} aria-label={`${task.priority} priority`} />
      <span className="mini-sla">{formatSla(task.slaDueMs, nowMs)}</span>
    </li>
  );
}

/** Compact floating overview next to the pet — not a full dashboard. */
export function OverviewPanel(props: OverviewPanelProps) {
  const { goals, reviewsCompleted, submissionsCompleted } = props;
  const shown = props.editing;
  return (
    <section
      className="float-panel overview-panel"
      style={{ left: props.position.x, top: props.position.y }}
      role="dialog"
      aria-label="Mochi task overview"
    >
      <header className="panel-header">
        <h2>Task overview</h2>
        <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close task panel">
          ×
        </button>
      </header>

      {shown ? (
        <GoalEditor initial={goals} onSave={props.onSaveGoals} onCancel={props.onCancelEdit} />
      ) : (
        <>
          <div className="panel-section">
            <h3 className="panel-subtitle">Pending reviews ({props.pending.length})</h3>
            {props.pending.length === 0 ? (
              <p className="muted">Nothing awaiting review. Nice.</p>
            ) : (
              <ul className="mini-list">
                {props.pending.slice(0, 3).map((t) => (
                  <MiniRow key={t.id} task={t} nowMs={props.nowMs} onOpen={props.onOpenTask} />
                ))}
              </ul>
            )}
            {props.pending.length > 3 && (
              <p className="muted more-link">+{props.pending.length - 3} more in “View all tasks”.</p>
            )}
          </div>

          <div className="panel-section">
            <h3 className="panel-subtitle">Needs revision ({props.revisions.length})</h3>
            {props.revisions.length === 0 ? (
              <p className="muted">No revisions requested.</p>
            ) : (
              <ul className="mini-list">
                {props.revisions.slice(0, 2).map((t) => (
                  <MiniRow key={t.id} task={t} nowMs={props.nowMs} onOpen={props.onOpenTask} />
                ))}
              </ul>
            )}
          </div>

          <div className="panel-section">
            <h3 className="panel-subtitle">Weekly progress</h3>
            <div className="progress-row">
              <span className="dot dot-green" aria-hidden="true" />
              <span className="progress-label">Reviews</span>
              <span className="progress-count">
                {reviewsCompleted} / {goals.reviewGoal}
              </span>
            </div>
            <div className="meter" aria-hidden="true">
              <div
                className="meter-fill meter-green"
                style={{ width: `${Math.round(ringFraction(reviewsCompleted, goals.reviewGoal) * 100)}%` }}
              />
            </div>
            <div className="progress-row">
              <span className="dot dot-orange" aria-hidden="true" />
              <span className="progress-label">Submissions</span>
              <span className="progress-count">
                {submissionsCompleted} / {goals.submissionGoal}
              </span>
            </div>
            <div className="meter" aria-hidden="true">
              <div
                className="meter-fill meter-orange"
                style={{ width: `${Math.round(ringFraction(submissionsCompleted, goals.submissionGoal) * 100)}%` }}
              />
            </div>
          </div>

          <div className="panel-actions">
            <button type="button" className="btn-secondary" onClick={props.onEditGoals}>
              Edit weekly goals
            </button>
            <button type="button" className="btn-primary" onClick={props.onViewAll}>
              View all tasks
            </button>
          </div>
        </>
      )}
    </section>
  );
}
