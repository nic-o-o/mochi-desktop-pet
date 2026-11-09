import { describe, expect, it } from 'vitest';
import { classifyFailure, isAllowedLink, pickRow, pickSubmitSha } from './codimango.mjs';

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
