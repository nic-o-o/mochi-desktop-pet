import { describe, expect, it } from 'vitest';
import { plainReason, shortReason } from './harvester.ts';

describe('plainReason', () => {
  it('puts known Harvester reasons in plain words, including after "stopped before finishing"', () => {
    expect(plainReason('the durable owner is repairing or checking the task')).toBe('Working on the fix and running tests');
    expect(plainReason('calibration guard refused the candidate: a shallow task may deepen only its contract')).toMatch(/^Its own check rejected the last attempt/);
    expect(plainReason('Harvester stopped before finishing. Last: the exact revision is still being validated by Nest')).toBe(
      'Harvester stopped before finishing. Last: Pushed a fix; waiting for Codimango to validate it',
    );
  });

  it('reads the Codimango-side messages seen on real runs', () => {
    expect(plainReason('Revalidation was not started: the server could not resolve rerun policy. Retry later.')).toBe(
      "Codimango couldn't start revalidation; Harvester will retry",
    );
    expect(
      plainReason('every check that RAN passed, but the qualitative half could not run (the qualitative validation request exceeds 4194304 bytes). Publishing on a partial review'),
    ).toMatch(/over its 4 MB size limit/);
  });

  it('cuts long reasons to about one line at a word boundary', () => {
    const long = 'models:oracle was requested recently; exact-head platform failures: Oracle validation, Metacode or Opus pass/fail balance, Deep Review';
    const short = shortReason(long);
    expect(short.length).toBeLessThanOrEqual(110);
    expect(short.endsWith('…')).toBe(true);
    expect(long.startsWith(short.slice(0, -1))).toBe(true);
    expect(shortReason('Queued')).toBe('Queued');
  });

  it('shows anything it does not know as Harvester wrote it', () => {
    expect(plainReason('Queued')).toBe('Queued');
    expect(plainReason('models:oracle was requested recently; exact-head platform failures: Oracle validation')).toBe(
      'models:oracle was requested recently; exact-head platform failures: Oracle validation',
    );
  });
});
