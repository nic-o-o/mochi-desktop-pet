import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFY, NOTIFY_KINDS, notifyAllowed, notifyKindOf, parseNotifyPrefs } from './notifyPrefs.ts';

describe('notification switches', () => {
  it('has every kind on by default', () => {
    expect(NOTIFY_KINDS.every(({ key }) => DEFAULT_NOTIFY[key])).toBe(true);
    expect(parseNotifyPrefs(null)).toEqual(DEFAULT_NOTIFY);
    expect(parseNotifyPrefs('nope')).toEqual(DEFAULT_NOTIFY);
  });

  it('keeps saved booleans and ignores anything else', () => {
    const prefs = parseNotifyPrefs('{"validation_failed":false,"sev":"no","made_up":false}');
    expect(prefs.validation_failed).toBe(false);
    expect(prefs.sev).toBe(true);
    expect('made_up' in prefs).toBe(false);
  });

  it('maps bubble kinds to switches; SEV opened and mitigated share one', () => {
    expect(notifyKindOf('sev_open')).toBe('sev');
    expect(notifyKindOf('sev_mitigated')).toBe('sev');
    expect(notifyKindOf('validation_failed')).toBe('validation_failed');
    expect(notifyKindOf(undefined)).toBeNull();
    expect(notifyKindOf('something_new')).toBeNull();
  });

  it('blocks only switched-off kinds; unknown kinds (the placeholder) still pop', () => {
    const prefs = { ...DEFAULT_NOTIFY, validation_failed: false, sev: false };
    expect(notifyAllowed(prefs, 'validation_failed')).toBe(false);
    expect(notifyAllowed(prefs, 'sev_mitigated')).toBe(false);
    expect(notifyAllowed(prefs, 'validation_passed')).toBe(true);
    expect(notifyAllowed(prefs, undefined)).toBe(true);
  });
});
