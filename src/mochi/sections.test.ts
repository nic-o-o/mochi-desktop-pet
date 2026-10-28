import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, parseSectionPrefs, visibleStatuses } from './sections.ts';

describe('section prefs', () => {
  it('defaults to revisions and reviews, drafts off', () => {
    expect(parseSectionPrefs(null)).toEqual({ revisions: true, reviews: true, drafts: false });
    expect(parseSectionPrefs('{not json')).toEqual(DEFAULT_SECTIONS);
  });

  it('keeps saved booleans and ignores junk', () => {
    expect(parseSectionPrefs(JSON.stringify({ drafts: true, reviews: false, extra: 1 }))).toEqual({
      revisions: true,
      reviews: false,
      drafts: true,
    });
    expect(parseSectionPrefs(JSON.stringify({ drafts: 'yes' }))).toEqual(DEFAULT_SECTIONS);
  });

  it('never leaves every section off', () => {
    const allOff = JSON.stringify({ revisions: false, reviews: false, drafts: false });
    expect(parseSectionPrefs(allOff)).toEqual(DEFAULT_SECTIONS);
  });

  it('maps switched-on sections to task statuses', () => {
    expect([...visibleStatuses({ revisions: false, reviews: true, drafts: true })].sort()).toEqual([
      'draft',
      'pending_review',
    ]);
  });
});
