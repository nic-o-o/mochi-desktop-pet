import { describe, expect, it } from 'vitest';
import { classifyFailure, isCodimangoUrl, pickRow } from './codimango.mjs';

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
  it('keeps only mapped fields and stringifies the id', () => {
    const row = pickRow({
      id: 42,
      name: 'x',
      status: 'needs_revision',
      metadataJson: '{"big":true}',
      validationDetails: [{ label: 'AI assessment', status: 'failed', detail: 'long text' }],
    });
    expect(row.id).toBe('42');
    expect(row.metadataJson).toBeUndefined();
    expect(row.reviewSlaDeadline).toBeNull();
    expect(row.validationDetails).toEqual([{ label: 'AI assessment', status: 'failed' }]);
  });
});

describe('isCodimangoUrl', () => {
  it('allows only https Codimango pages', () => {
    expect(isCodimangoUrl('https://codimango.internalmeta.com/reviews/1')).toBe(true);
    expect(isCodimangoUrl('http://codimango.internalmeta.com/reviews/1')).toBe(false);
    expect(isCodimangoUrl('https://evil.example/codimango.internalmeta.com')).toBe(false);
    expect(isCodimangoUrl('file:///etc/passwd')).toBe(false);
  });
});
