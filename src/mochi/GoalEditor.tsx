import { useId, useState } from 'react';
import type { WeeklyGoals } from './logic.ts';
import { validateGoalInput, parseGoalInput } from './logic.ts';

interface GoalEditorProps {
  initial: WeeklyGoals;
  onSave: (goals: WeeklyGoals) => void;
  onCancel: () => void;
}

/** Edit weekly targets. Accepts positive integers only, with per-field errors. */
export function GoalEditor({ initial, onSave, onCancel }: GoalEditorProps) {
  const uid = useId();
  const [reviewRaw, setReviewRaw] = useState(String(initial.reviewGoal));
  const [submissionRaw, setSubmissionRaw] = useState(String(initial.submissionGoal));

  const reviewError = validateGoalInput(reviewRaw);
  const submissionError = validateGoalInput(submissionRaw);
  const canSave = reviewError === null && submissionError === null;

  function handleSave() {
    const reviewGoal = parseGoalInput(reviewRaw);
    const submissionGoal = parseGoalInput(submissionRaw);
    if (reviewGoal === null || submissionGoal === null) return;
    onSave({ reviewGoal, submissionGoal });
  }

  return (
    <div className="goal-editor">
      <h3 className="panel-subtitle">Edit weekly goals</h3>
      <div className="goal-field">
        <label htmlFor={`${uid}-review`}>Reviews per week</label>
        <input
          id={`${uid}-review`}
          value={reviewRaw}
          inputMode="numeric"
          autoComplete="off"
          onChange={(e) => setReviewRaw(e.target.value)}
          aria-invalid={reviewError !== null}
          aria-describedby={reviewError ? `${uid}-review-err` : undefined}
        />
        {reviewError !== null && (
          <p className="field-error" id={`${uid}-review-err`} role="alert">
            {reviewError}
          </p>
        )}
      </div>
      <div className="goal-field">
        <label htmlFor={`${uid}-sub`}>Submissions per week</label>
        <input
          id={`${uid}-sub`}
          value={submissionRaw}
          inputMode="numeric"
          autoComplete="off"
          onChange={(e) => setSubmissionRaw(e.target.value)}
          aria-invalid={submissionError !== null}
          aria-describedby={submissionError ? `${uid}-sub-err` : undefined}
        />
        {submissionError !== null && (
          <p className="field-error" id={`${uid}-sub-err`} role="alert">
            {submissionError}
          </p>
        )}
      </div>
      <div className="panel-actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={handleSave} disabled={!canSave}>
          Save
        </button>
      </div>
    </div>
  );
}
