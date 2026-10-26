export const MIN_GOAL = 1;
export const MAX_GOAL = 999;

export type GoalValidation =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Accepts positive integers only (leading/trailing whitespace allowed).
 * Everything else yields a human-readable error for the form.
 */
export function validateGoalInput(raw: string): GoalValidation {
  const text = raw.trim();
  if (text === '') {
    return { ok: false, error: 'Enter a number.' };
  }
  if (!/^\d+$/.test(text)) {
    return {
      ok: false,
      error: 'Use whole numbers only — no decimals, signs, or letters.',
    };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < MIN_GOAL) {
    return { ok: false, error: `Goal must be at least ${MIN_GOAL}.` };
  }
  if (value > MAX_GOAL) {
    return { ok: false, error: `Goal must be ${MAX_GOAL} or less.` };
  }
  return { ok: true, value };
}
