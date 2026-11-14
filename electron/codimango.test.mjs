import { describe, expect, it } from 'vitest';
import { addSubmitBlockers, classifyFailure, isAllowedLink, pickCanaryScan, pickRow, pickSubmitBlockers, pickSubmitSha } from './codimango.mjs';

describe('classifyFailure', () => {
  it('reports a missing CLI', () => {
    expect(classifyFailure({ code: 'ENOENT' }, '', '').kind).toBe('cli_missing');
  });

  it('reports an expired login with the CLI-provided fix', () => {
    const stdout = JSON.stringify({
      error: { kind: 'authentication', fix: 'codimango auth setup', message: 'No Nest OIDC token found.' },
    });
    expect(classifyFailure({ code: 9 }, stdout, '')).toEqual({
      kind: 'login_required',
      message: 'Codimango login missing or expired.',
      fix: 'codimango auth setup',
    });
    expect(classifyFailure({ code: 9 }, '', '').fix).toBe('codimango auth setup');
  });

  it('reports network failures and timeouts as offline', () => {
    expect(classifyFailure({ code: 5 }, '', '').kind).toBe('offline');
    expect(classifyFailure({ killed: true, code: null }, '', '').kind).toBe('offline');
  });

  it('surfaces other errors without the feedback banner', () => {
    const stderr = 'Something broke\nNeed help with a bug or blocked workflow? Run `codimango feedback`.\n';
    expect(classifyFailure({ code: 2 }, '', stderr)).toEqual({ kind: 'error', message: 'Something broke' });
  });
});

describe('pickRow', () => {
  it("keeps only the rollup's state, so the panel can tell running from waiting to start", () => {
    expect(pickRow({ id: 1, validationRollupState: { state: 'pending', failingGates: 0, totalGates: 6 } }).validationRollupState).toEqual({ state: 'pending' });
    expect(pickRow({ id: 1 }).validationRollupState).toBeNull();
  });

  it('keeps only mapped fields and stringifies the id', () => {
    const row = pickRow({
      id: 42,
      name: 'x',
      status: 'needs_revision',
      metadataJson: '{"big":true}',
      validationDetails: [
        { label: 'AI assessment', status: 'failed', detail: 'long text' },
        { label: 'VALIDATION_ENGINE::deep_review', status: 'failed', detail: 'long text', advisory: true },
      ],
    });
    expect(row.id).toBe('42');
    expect(row.metadataJson).toBeUndefined();
    expect(row.reviewSlaDeadline).toBeNull();
    expect(row.validationDetails).toEqual([
      { label: 'AI assessment', status: 'failed', advisory: false },
      { label: 'VALIDATION_ENGINE::deep_review', status: 'failed', advisory: true },
    ]);
  });
});

describe('isAllowedLink', () => {
  it('allows only https Codimango pages, the Alacarte page and SEV pages', () => {
    expect(isAllowedLink('https://www.internalfb.com/sevmanager/view/728082')).toBe(true);
    expect(isAllowedLink('https://www.internalfb.com/sevmanager/view/728082/edit')).toBe(false);
    expect(isAllowedLink('https://www.internalfb.com/alacarte')).toBe(true);
    expect(
      isAllowedLink(
        'https://www.internalfb.com/alacarte?device_key=JRRQJ7M9NL%3A%3Aprod&q=%5B%7B%22field%22%3A%22keyword%22%7D%5D',
      ),
    ).toBe(true);
    expect(isAllowedLink('https://www.internalfb.com/intern/anything')).toBe(false);
    expect(isAllowedLink('https://codimango.internalmeta.com/reviews/1')).toBe(true);
    expect(isAllowedLink('http://codimango.internalmeta.com/reviews/1')).toBe(false);
    expect(isAllowedLink('https://evil.example/codimango.internalmeta.com')).toBe(false);
    expect(isAllowedLink('file:///etc/passwd')).toBe(false);
  });
});

describe('pickSubmitSha', () => {
  const sha = '688c80f7de79753f8c6f250be04d65c1b1f79bc6';
  it('prefers the validation generation revision', () => {
    expect(pickSubmitSha({ validationGeneration: { sourceRevision: sha }, commitSha: '0'.repeat(40) })).toBe(sha);
  });
  it('falls back to the task commit', () => {
    expect(pickSubmitSha({ commitSha: sha })).toBe(sha);
  });
  it('rejects non-SHA values', () => {
    expect(pickSubmitSha({ validationGeneration: { sourceRevision: 'abc' }, commitSha: null })).toBeNull();
    expect(pickSubmitSha({})).toBeNull();
    expect(pickSubmitSha(null)).toBeNull();
  });
});

describe('pickSubmitBlockers', () => {
  it('is empty when submit-status clears the task', () => {
    expect(pickSubmitBlockers({ blocked: false, blockers: [], tbrInfraError: false, validationPending: false })).toEqual([]);
  });
  it('lists blocker labels, TBR infra errors and pending validation', () => {
    expect(
      pickSubmitBlockers({
        blocked: true,
        blockers: [{ label: 'Provenance SUSPECT', status: 'warn' }],
        tbrInfraError: true,
        validationPending: true,
      }),
    ).toEqual(['Provenance SUSPECT', 'TBR infra error', 'Validation still running']);
  });
  it('still blocks when blocked comes without labels', () => {
    expect(pickSubmitBlockers({ blocked: true, blockers: [] })).toEqual(['Blocked']);
  });
  it('returns null for unexpected output', () => {
    expect(pickSubmitBlockers(null)).toBeNull();
  });
});

describe('addSubmitBlockers', () => {
  it('checks only your drafts whose validation passes', async () => {
    const rows = [
      { id: '1', status: 'draft', validationStatus: 'passing' },
      { id: '2', status: 'draft', validationStatus: 'failed' },
      { id: '3', status: 'submitted', validationStatus: 'passing' },
      { id: '4', status: 'draft', validationStatus: 'passing' },
    ];
    const asked = [];
    await addSubmitBlockers(
      rows,
      async (id) => {
        asked.push(id);
        return id === '4' ? null : ['Provenance SUSPECT'];
      },
      async () => null,
    );
    expect(asked).toEqual(['1', '4']);
    expect(rows.map((r) => r.submitBlockers)).toEqual([['Provenance SUSPECT'], undefined, undefined, null]);
  });

  it('reads the canary scan from task show for passing drafts the list row left without one', async () => {
    const listed = { outcome: 'clean', commitSha: 'a', scannerVersion: 'canary-scan-v1', retryable: false };
    const shown = { outcome: 'incomplete', commitSha: 'b', scannerVersion: 'canary-scan-v1', retryable: false };
    const rows = [
      { id: '1', status: 'draft', validationStatus: 'passing', canaryScan: listed },
      { id: '2', status: 'draft', validationStatus: 'passing', canaryScan: null },
      { id: '3', status: 'draft', validationStatus: 'failed', canaryScan: null },
    ];
    const shownFor = [];
    await addSubmitBlockers(
      rows,
      async () => [],
      async (id) => {
        shownFor.push(id);
        return shown;
      },
    );
    expect(shownFor).toEqual(['2']);
    expect(rows.map((r) => r.canaryScan)).toEqual([listed, shown, null]);
  });
});

describe('pickCanaryScan', () => {
  it('reads the scan from a task show body (173718: read budget exhausted)', () => {
    expect(
      pickCanaryScan({
        qualitativeResult: {
          benchmarkCanaryScanResult: {
            commitSha: 'efa7c1f7fa1e17fbcbc6cf427ade52f3e6772ac9',
            outcome: 'incomplete',
            reason: 'read_budget_exhausted',
            retryable: false,
            scannerVersion: 'canary-scan-v1',
          },
        },
      }),
    ).toEqual({ outcome: 'incomplete', commitSha: 'efa7c1f7fa1e17fbcbc6cf427ade52f3e6772ac9', scannerVersion: 'canary-scan-v1', retryable: false });
    expect(pickCanaryScan({})).toBeNull();
  });
});

describe('pickRow canary scan', () => {
  it('keeps only the canary scan fields from qualitativeResult', () => {
    const row = pickRow({
      id: 1,
      commitSha: 'abc',
      qualitativeResult: {
        contaminationV2: { checks: [] },
        benchmarkCanaryScanResult: {
          commitSha: 'abc',
          outcome: 'incomplete',
          reason: 'read_budget_exhausted',
          retryable: false,
          scannerVersion: 'canary-scan-v1',
        },
      },
    });
    expect(row.commitSha).toBe('abc');
    expect(row.canaryScan).toEqual({
      outcome: 'incomplete',
      commitSha: 'abc',
      scannerVersion: 'canary-scan-v1',
      retryable: false,
    });
    expect(pickRow({ id: 2 }).canaryScan).toBeNull();
  });
});
