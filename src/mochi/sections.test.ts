import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, SECTIONS, parseSectionPrefs, visibleStatuses, DEFAULT_SECTION_ORDER, moveSection, parseSectionOrder } from './sections.ts';

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

describe('section order', () => {
  it('defaults to Ready for submission first, then the panel order', () => {
    expect(parseSectionOrder(null)).toEqual(['submittable', 'revisions', 'reviews', 'drafts']);
    expect(parseSectionOrder('not json')).toEqual(DEFAULT_SECTION_ORDER);
    expect(parseSectionOrder('{"a":1}')).toEqual(DEFAULT_SECTION_ORDER);
  });

  it('repairs a saved order: drops unknown keys and repeats, appends missing sections', () => {
    expect(parseSectionOrder('["reviews","bogus","reviews","drafts"]')).toEqual(['reviews', 'drafts', 'submittable', 'revisions']);
  });

  it('moves a section one step and stops at either end', () => {
    const order = DEFAULT_SECTION_ORDER;
    expect(moveSection(order, 'reviews', -1)).toEqual(['submittable', 'reviews', 'revisions', 'drafts']);
    expect(moveSection(order, 'submittable', -1)).toBe(order);
    expect(moveSection(order, 'drafts', 1)).toBe(order);
    expect(order).toEqual(['submittable', 'revisions', 'reviews', 'drafts']);
  });
});
