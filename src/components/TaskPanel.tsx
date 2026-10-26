import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Goals, PanelMode, Task, WeeklyProgress } from '../types';
import { formatDue, progressFraction } from '../logic/format';
import { PRIORITY_LABEL } from '../logic/sorting';
import { validateGoalInput } from '../logic/goals';

interface TaskPanelProps {
  style: CSSProperties;
  tasks: Task[];
  goals: Goals;
  progress: WeeklyProgress;
  mode: PanelMode;
  selectedTask: Task | null;
  onModeChange: (mode: PanelMode) => void;
  onSelectTask: (task: Task) => void;
  onSaveGoals: (goals: Goals) => void;
  onClose: () => void;
  onInteract: () => void;
}

const KIND_LABEL: Record<Task['kind'], string> = {
  review: 'Review',
  revision: 'Revision',
  submission: 'Submission',
};

function ProgressRow({
  label,
  done,
  goal,
  barClass,
}: {
  label: string;
  done: number;
  goal: number;
  barClass: string;
}) {
  const pct = Math.round(progressFraction(done, goal) * 100);
  return (
    <div className="mochi-progress-row">
      <div className="mochi-progress-head">
        <span>{label}</span>
        <span className="mochi-progress-count" data-testid={`progress-${label}`}>
          {done}/{goal}
        </span>
      </div>
      <div
        className="mochi-progress-track"
        role="progressbar"
        aria-label={`${label} progress`}
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={goal}
      >
        <div className={`mochi-progress-fill ${barClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function TaskRow({
  task,
  onSelect,
}: {
  task: Task;
  onSelect: (task: Task) => void;
}) {
  return (
    <li className={`mochi-task priority-${task.priority}`}>
      <span className={`mochi-prio mochi-prio--${task.priority}`}>
        {PRIORITY_LABEL[task.priority]}
      </span>
      <div className="mochi-task-main">
        <button
          type="button"
          className="mochi-task-title"
          onClick={() => onSelect(task)}
        >
          {task.title}
        </button>
        <div className="mochi-task-meta">
          <span className="mochi-kind">{KIND_LABEL[task.kind]}</span>
          <span aria-hidden="true">·</span>
          <span className={task.dueInMinutes <= 60 ? 'mochi-due-soon' : ''}>
            {formatDue(task.dueInMinutes)}
          </span>
        </div>
      </div>
    </li>
  );
}

function GoalsForm({
  goals,
  onSave,
  onCancel,
}: {
  goals: Goals;
  onSave: (goals: Goals) => void;
  onCancel: () => void;
}) {
  const [reviewDraft, setReviewDraft] = useState(String(goals.reviewGoal));
  const [submissionDraft, setSubmissionDraft] = useState(
    String(goals.submissionGoal),
  );
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // Reset drafts whenever the editor is opened with fresh goals.
  useEffect(() => {
    setReviewDraft(String(goals.reviewGoal));
    setSubmissionDraft(String(goals.submissionGoal));
    setReviewError(null);
    setSubmissionError(null);
    setSavedFlash(false);
  }, [goals.reviewGoal, goals.submissionGoal]);

  const handleSave = () => {
    const r = validateGoalInput(reviewDraft);
    const s = validateGoalInput(submissionDraft);
    setReviewError(r.ok ? null : r.error);
    setSubmissionError(s.ok ? null : s.error);
    if (r.ok && s.ok) {
      onSave({ reviewGoal: r.value, submissionGoal: s.value });
      setSavedFlash(true);
    } else {
      setSavedFlash(false);
    }
  };

  return (
    <div className="mochi-goals-form">
      <h3>Edit weekly goals</h3>
      <p className="mochi-hint">Positive whole numbers, 1–999.</p>
      <label className="mochi-field">
        <span>Reviews per week</span>
        <input
          type="text"
          inputMode="numeric"
          value={reviewDraft}
          onChange={(e) => setReviewDraft(e.target.value)}
          aria-invalid={reviewError !== null}
          aria-describedby={reviewError ? 'goal-review-error' : undefined}
          data-testid="goal-review-input"
        />
      </label>
      {reviewError && (
        <p className="mochi-error" id="goal-review-error" role="alert">
          {reviewError}
        </p>
      )}
      <label className="mochi-field">
        <span>Submissions per week</span>
        <input
          type="text"
          inputMode="numeric"
          value={submissionDraft}
          onChange={(e) => setSubmissionDraft(e.target.value)}
          aria-invalid={submissionError !== null}
          aria-describedby={submissionError ? 'goal-submission-error' : undefined}
          data-testid="goal-submission-input"
        />
      </label>
      {submissionError && (
        <p className="mochi-error" id="goal-submission-error" role="alert">
          {submissionError}
        </p>
      )}
      {savedFlash && (
        <p className="mochi-saved" role="status">
          Saved ✓
        </p>
      )}
      <div className="mochi-actions">
        <button type="button" className="mochi-btn mochi-btn--primary" onClick={handleSave} data-testid="goal-save">
          Save
        </button>
        <button type="button" className="mochi-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function TaskPanel(props: TaskPanelProps) {
  const {
    style,
    tasks,
    goals,
    progress,
    mode,
    selectedTask,
    onModeChange,
    onSelectTask,
    onSaveGoals,
    onClose,
    onInteract,
  } = props;

  const pendingReviews = tasks.filter((t) => t.kind === 'review');
  const revisions = tasks.filter((t) => t.kind === 'revision');

  return (
    <section
      className={`mochi-panel mochi-panel--${mode}`}
      style={style}
      role="dialog"
      aria-label={
        mode === 'all'
          ? 'All pending tasks'
          : mode === 'detail'
            ? 'Task details'
            : mode === 'goals'
              ? 'Edit weekly goals'
              : 'Task overview'
      }
      onPointerEnter={onInteract}
      data-testid="mochi-panel"
    >
      <header className="mochi-panel-head">
        <div>
          <strong>Mochi · Tasks</strong>
          <span className="mochi-panel-sub">
            {mode === 'all' && `${tasks.length} pending`}
            {mode === 'overview' &&
              `${pendingReviews.length} to review · ${revisions.length} to revise`}
            {mode === 'goals' && 'weekly targets'}
            {mode === 'detail' && 'mock detail view'}
          </span>
        </div>
        <button
          type="button"
          className="mochi-panel-x"
          aria-label="Close task panel"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      {mode === 'overview' && (
        <div className="mochi-panel-body">
          <div className="mochi-section">
            <h3>Pending reviews ({pendingReviews.length})</h3>
            {pendingReviews.length === 0 ? (
              <p className="mochi-empty">Nothing awaiting review. 🎉</p>
            ) : (
              <ul className="mochi-list">
                {pendingReviews.slice(0, 3).map((t) => (
                  <TaskRow key={t.id} task={t} onSelect={onSelectTask} />
                ))}
              </ul>
            )}
          </div>

          <div className="mochi-section">
            <h3>Needs revision ({revisions.length})</h3>
            {revisions.length === 0 ? (
              <p className="mochi-empty">No revisions requested. 🎉</p>
            ) : (
              <ul className="mochi-list">
                {revisions.slice(0, 3).map((t) => (
                  <TaskRow key={t.id} task={t} onSelect={onSelectTask} />
                ))}
              </ul>
            )}
          </div>

          <div className="mochi-section">
            <h3>Weekly progress</h3>
            <ProgressRow
              label="reviews"
              done={progress.reviewsCompleted}
              goal={goals.reviewGoal}
              barClass="mochi-progress-fill--green"
            />
            <ProgressRow
              label="submissions"
              done={progress.submissionsCompleted}
              goal={goals.submissionGoal}
              barClass="mochi-progress-fill--orange"
            />
          </div>

          <div className="mochi-actions mochi-actions--sticky">
            <button
              type="button"
              className="mochi-btn mochi-btn--primary"
              onClick={() => onModeChange('all')}
            >
              View all tasks
            </button>
            <button type="button" className="mochi-btn" onClick={() => onModeChange('goals')}>
              Edit weekly goals
            </button>
          </div>
        </div>
      )}

      {mode === 'goals' && (
        <div className="mochi-panel-body">
          <GoalsForm
            goals={goals}
            onSave={onSaveGoals}
            onCancel={() => onModeChange('overview')}
          />
          <div className="mochi-actions mochi-actions--sticky">
            <button type="button" className="mochi-btn" onClick={() => onModeChange('overview')}>
              ← Back to overview
            </button>
          </div>
        </div>
      )}

      {mode === 'all' && (
        <>
          <div className="mochi-panel-scroll">
            {tasks.length === 0 ? (
              <div className="mochi-empty-state">
                <div className="mochi-empty-face" aria-hidden="true">
                  (＾-＾)
                </div>
                <p>
                  <strong>All clear!</strong>
                </p>
                <p>No pending tasks. Mochi is proud of you.</p>
              </div>
            ) : (
              <ul className="mochi-list mochi-list--full">
                {tasks.map((t) => (
                  <TaskRow key={t.id} task={t} onSelect={onSelectTask} />
                ))}
              </ul>
            )}
          </div>
          <div className="mochi-actions mochi-actions--sticky mochi-actions--footer">
            <button type="button" className="mochi-btn" onClick={() => onModeChange('overview')}>
              ← Overview
            </button>
            <button type="button" className="mochi-btn" onClick={() => onModeChange('goals')}>
              Edit weekly goals
            </button>
          </div>
        </>
      )}

      {mode === 'detail' && selectedTask && (
        <>
          <div className="mochi-panel-scroll">
            <span className={`mochi-prio mochi-prio--${selectedTask.priority}`}>
              {PRIORITY_LABEL[selectedTask.priority]}
            </span>{' '}
            <span className="mochi-kind">{KIND_LABEL[selectedTask.kind]}</span>
            <h3 className="mochi-detail-title">{selectedTask.title}</h3>
            <dl className="mochi-detail-meta">
              <div>
                <dt>Time left</dt>
                <dd>{formatDue(selectedTask.dueInMinutes)}</dd>
              </div>
              <div>
                <dt>From</dt>
                <dd>{selectedTask.author}</dd>
              </div>
            </dl>
            <p className="mochi-detail-body">{selectedTask.detail}</p>
            <p className="mochi-hint">
              Prototype note: titles open this local mock view instead of
              navigating anywhere.
            </p>
          </div>
          <div className="mochi-actions mochi-actions--sticky mochi-actions--footer">
            <button type="button" className="mochi-btn" onClick={() => onModeChange('all')}>
              ← All tasks
            </button>
          </div>
        </>
      )}
    </section>
  );
}
