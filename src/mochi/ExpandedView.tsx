import type { TaskItem, WeeklyGoals, XY } from './logic.ts';
import { filterTasks, formatSla } from './logic.ts';
import { GoalEditor } from './GoalEditor.tsx';

interface ExpandedViewProps {
  /** Shell mode: pin the card near the pet instead of centering on screen. */
  anchor?: XY | null;
  tasks: TaskItem[];
  nowMs: number;
  search: string;
  onSearchChange: (q: string) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  editing: boolean;
  goals: WeeklyGoals;
  onSaveGoals: (goals: WeeklyGoals) => void;
  onCancelEdit: () => void;
  onEditGoals: () => void;
  onClose: () => void;
  onBackToOverview: () => void;
}

const STATUS_LABEL: Record<TaskItem['status'], string> = {
  pending_review: 'Pending review',
  revision_required: 'Revision needed',
  draft: 'Draft',
};

/** Drafts have no deadline, so show the validation state instead of an SLA. */
function slaLabel(task: TaskItem, nowMs: number): string {
  return task.status === 'draft' ? (task.subtitle ?? 'Draft') : formatSla(task.slaDueMs, nowMs);
}

function isHot(task: TaskItem, nowMs: number): boolean {
  return task.status !== 'draft' && task.slaDueMs - nowMs < 60 * 60 * 1000;
}

/** Full task list, sorted by priority then nearest SLA. Footer actions stay visible. */
export function ExpandedView(props: ExpandedViewProps) {
  const visible = filterTasks(props.tasks, props.search);
  const selected = props.selectedId ? props.tasks.find((t) => t.id === props.selectedId) ?? null : null;

  return (
    <div className="mochi-scrim" onClick={props.onClose}>
      <section
        className="float-panel expanded-view"
        style={props.anchor ? { left: props.anchor.x, top: props.anchor.y } : undefined}
        role="dialog"
        aria-label={selected ? `Task detail: ${selected.title}` : 'All tasks'}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="panel-header panel-header-sticky">
          <h2>{selected ? 'Task detail' : `All tasks (${props.tasks.length})`}</h2>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close task list">
            ×
          </button>
        </header>

        <div className="expanded-body">
          {props.editing ? (
            <GoalEditor initial={props.goals} onSave={props.onSaveGoals} onCancel={props.onCancelEdit} />
          ) : selected ? (
            <div className="task-detail">
              <button type="button" className="btn-link" onClick={() => props.onSelect(null)}>
                ← Back to all tasks
              </button>
              <h3 className="detail-title">{selected.title}</h3>
              <dl className="detail-grid">
                <dt>Type</dt>
                <dd>{selected.type}</dd>
                <dt>Priority</dt>
                <dd>
                  <span className={`badge badge-${selected.priority}`}>{selected.priority}</span>
                </dd>
                <dt>Status</dt>
                <dd>{STATUS_LABEL[selected.status]}</dd>
                <dt>SLA</dt>
                <dd className={isHot(selected, props.nowMs) ? 'sla-hot' : undefined}>
                  {slaLabel(selected, props.nowMs)}
                </dd>
                <dt>Requester</dt>
                <dd>{selected.requester}</dd>
              </dl>
              <p className="detail-desc">{selected.description}</p>
              <p className="muted small">
                Mock detail view — it stays inside this prototype instead of navigating anywhere.
              </p>
            </div>
          ) : (
            <>
              <div className="search-row">
                <label htmlFor="mochi-task-search" className="visually-hidden">
                  Search tasks
                </label>
                <input
                  id="mochi-task-search"
                  type="search"
                  placeholder="Search title or type…"
                  value={props.search}
                  onChange={(e) => props.onSearchChange(e.target.value)}
                />
              </div>
              {visible.length === 0 ? (
                <div className="empty-state">
                  <p className="empty-title">No tasks found</p>
                  <p className="muted">
                    {props.search.trim()
                      ? `Nothing matches “${props.search.trim()}”.`
                      : 'Your queue is clear. Enjoy the calm.'}
                  </p>
                  {props.search.trim() && (
                    <button type="button" className="btn-secondary" onClick={() => props.onSearchChange('')}>
                      Clear search
                    </button>
                  )}
                </div>
              ) : (
                <ul className="task-list">
                  {visible.map((t) => (
                    <li key={t.id} className="task-row">
                      <button type="button" className="task-title" onClick={() => props.onSelect(t.id)}>
                        {t.title}
                      </button>
                      <div className="task-meta">
                        <span className="muted">{t.type}</span>
                        <span className={`badge badge-${t.priority}`}>{t.priority}</span>
                        <span className={`badge badge-status-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                        <span className={isHot(t, props.nowMs) ? 'sla-hot' : 'muted'}>
                          {slaLabel(t, props.nowMs)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <footer className="panel-actions panel-footer-sticky">
          <button type="button" className="btn-secondary" onClick={props.onEditGoals}>
            Edit weekly goals
          </button>
          <button type="button" className="btn-primary" onClick={props.onBackToOverview}>
            Back to overview
          </button>
        </footer>
      </section>
    </div>
  );
}
