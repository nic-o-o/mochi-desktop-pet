import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, SECTIONS, parseSectionPrefs, visibleStatuses } from './sections.ts';

describe('section prefs', () => {
  it('defaults to revisions, reviews, and ready-for-submission; drafts off', () => {
    expect(parseSectionPrefs(null)).toEqual({ revisions: true, reviews: true, drafts: false, submittable: true });
    expect(parseSectionPrefs('{not json')).toEqual(DEFAULT_SECTIONS);
  });

  it('keeps saved booleans and ignores junk', () => {
    expect(parseSectionPrefs(JSON.stringify({ drafts: true, reviews: false, extra: 1 }))).toEqual({
      revisions: true,
      reviews: false,
      drafts: true,
      submittable: true,
    });
    expect(parseSectionPrefs(JSON.stringify({ drafts: 'yes' }))).toEqual(DEFAULT_SECTIONS);
  });

  it('never leaves every section off', () => {
    const allOff = JSON.stringify({ revisions: false, reviews: false, drafts: false, submittable: false });
    expect(parseSectionPrefs(allOff)).toEqual(DEFAULT_SECTIONS);
  });

  it('maps switched-on sections to task statuses', () => {
    expect([...visibleStatuses({ revisions: false, reviews: true, drafts: true, submittable: true })].sort()).toEqual([
      'draft',
      'pending_review',
    ]);
  });

  it('keeps the draft status for the ready-for-submission section', () => {
    expect(SECTIONS.find(({ key }) => key === 'submittable')).toMatchObject({
      label: 'Ready for submission',
      status: 'draft',
    });
  });
});
