import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, SECTIONS, parseSectionPrefs, visibleStatuses, DEFAULT_SECTION_ORDER, moveSection, parseSectionOrder, reorderSection, reorderInVisibleOrder } from './sections.ts';

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

  it('reorders a section to any index and clamps past either end', () => {
    const order = DEFAULT_SECTION_ORDER;
    expect(reorderSection(order, 'reviews', 0)).toEqual(['reviews', 'submittable', 'revisions', 'drafts']);
    expect(reorderSection(order, 'reviews', 3)).toEqual(['submittable', 'revisions', 'drafts', 'reviews']);
    expect(reorderSection(order, 'submittable', 2)).toEqual(['revisions', 'reviews', 'submittable', 'drafts']);
    expect(reorderSection(order, 'reviews', -5)).toEqual(['reviews', 'submittable', 'revisions', 'drafts']);
    expect(reorderSection(order, 'reviews', 99)).toEqual(['submittable', 'revisions', 'drafts', 'reviews']);
    expect(order).toEqual(['submittable', 'revisions', 'reviews', 'drafts']);
  });

  it('reordering to the same spot, or an unknown section, returns the same order', () => {
    const order = DEFAULT_SECTION_ORDER;
    expect(reorderSection(order, 'reviews', 2)).toBe(order);
    expect(reorderSection(order, 'bogus' as never, 0)).toBe(order);
  });

  it('reorders within the shown sections and leaves hidden ones where they sit', () => {
    const order = DEFAULT_SECTION_ORDER;
    const shown = ['submittable', 'revisions', 'reviews'] as const;
    // Reviews above revisions; the hidden drafts section stays last.
    expect(reorderInVisibleOrder(order, 'reviews', [...shown], 1)).toEqual(['submittable', 'reviews', 'revisions', 'drafts']);
    // Ready for submission to the bottom of the shown list, still above hidden drafts.
    expect(reorderInVisibleOrder(order, 'submittable', [...shown], 2)).toEqual(['revisions', 'reviews', 'submittable', 'drafts']);
    // A hidden section interleaved in the full order stays put when a shown one passes it.
    const interleaved = ['drafts', 'submittable', 'revisions', 'reviews'] as const;
    expect(reorderInVisibleOrder([...interleaved], 'reviews', [...shown], 0)).toEqual(['drafts', 'reviews', 'submittable', 'revisions']);
    expect(order).toEqual(['submittable', 'revisions', 'reviews', 'drafts']);
  });

  it('reordering in the shown list clamps, ignores unknown sections, and is a no-op for one shown section', () => {
    const order = DEFAULT_SECTION_ORDER;
    const shown = ['submittable', 'revisions', 'reviews'] as const;
    expect(reorderInVisibleOrder(order, 'submittable', [...shown], 99)).toEqual(['revisions', 'reviews', 'submittable', 'drafts']);
    expect(reorderInVisibleOrder(order, 'submittable', [...shown], -5)).toBe(order);
    expect(reorderInVisibleOrder(order, 'bogus' as never, [...shown], 0)).toBe(order);
    expect(reorderInVisibleOrder(order, 'reviews', ['reviews'], 0)).toBe(order);
  });
});
