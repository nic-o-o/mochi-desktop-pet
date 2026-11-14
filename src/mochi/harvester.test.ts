import { describe, expect, it } from 'vitest';
import { plainReason } from './harvester.ts';

describe('plainReason', () => {
  it('puts known Harvester reasons in plain words, including after "stopped before finishing"', () => {
    expect(plainReason('the durable owner is repairing or checking the task')).toBe('Working on the fix and running tests');
    expect(plainReason('calibration guard refused the candidate: a shallow task may deepen only its contract')).toMatch(/^Its own check rejected the last attempt/);
    expect(plainReason('Harvester stopped before finishing. Last: the exact revision is still being validated by Nest')).toBe(
      'Harvester stopped before finishing. Last: Pushed a fix; waiting for Codimango to validate it',
    );
  });

  it('shows anything it does not know as Harvester wrote it', () => {
    expect(plainReason('Queued')).toBe('Queued');
    expect(plainReason('models:oracle was requested recently; exact-head platform failures: Oracle validation')).toBe(
      'models:oracle was requested recently; exact-head platform failures: Oracle validation',
    );
  });
});
