import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEventLog, readEvents, sanitizeEvent, usageSummary } from './events.mjs';

describe('sanitizeEvent', () => {
  it('keeps listed fields with ID, enum, number and boolean values', () => {
    expect(
      sanitizeEvent({ event_name: 'mochi_click', surface: 'glance_panel', component: 'row', task_id: 'abc-123', position: 2, enabled: true }),
    ).toEqual({ event_name: 'mochi_click', surface: 'glance_panel', component: 'row', task_id: 'abc-123', position: 2, enabled: true });
  });

  it('rejects unknown event names', () => {
    expect(sanitizeEvent({ event_name: 'something_else', surface: 'pet' })).toBeNull();
    expect(sanitizeEvent(null)).toBeNull();
  });

  it('drops unlisted fields and free text', () => {
    const e = sanitizeEvent({
      event_name: 'mochi_click',
      surface: 'bubble',
      task_name: 'ember-lobby-seat',
      detail: 'Your task was accepted into the benchmark.',
      badge: 'Past due',
      reason: 'x'.repeat(65),
      position: Number.NaN,
    });
    expect(e).toEqual({ event_name: 'mochi_click', surface: 'bubble', badge: 'Past due' });
  });
});

describe('createEventLog', () => {
  it('appends sanitized events with the common columns and reads them back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-events-'));
    const now = Date.parse('2026-10-30T12:00:00Z');
    const log = createEventLog(dir, { app_session_id: 's1', unixname: 'tester' }, () => now);
    expect(log.log({ event_name: 'mochi_click', surface: 'pet', component: 'pet', action: 'open_panel' })).toBe(true);
    expect(log.log({ event_name: 'nope' })).toBe(false);
    await log.close();
    const events = readEvents(log.file, now);
    expect(events).toEqual([
      {
        event_name: 'mochi_click',
        surface: 'pet',
        component: 'pet',
        action: 'open_panel',
        app_session_id: 's1',
        unixname: 'tester',
        time: '2026-10-30T12:00:00.000Z',
      },
    ]);
    expect(readEvents(log.file, now + 8 * 86_400_000)).toEqual([]);
  });
});

describe('usageSummary', () => {
  it('counts panel opens, row and bubble CTR, refreshes and active days', () => {
    const t = (d) => `2026-10-${d}T10:00:00.000Z`;
    const events = [
      { event_name: 'mochi_daily_active', time: t(28) },
      { event_name: 'mochi_daily_active', time: t(29) },
      { event_name: 'mochi_vpv', surface: 'glance_panel', component: 'panel', trigger: 'pet_click', time: t(29) },
      { event_name: 'mochi_vpv', surface: 'glance_panel', component: 'panel', trigger: 'pet_click', time: t(29) },
      { event_name: 'mochi_vpv', surface: 'glance_panel', component: 'panel', trigger: 'keyboard', time: t(29) },
      { event_name: 'mochi_vpv', surface: 'glance_panel', component: 'row', time: t(29) },
      { event_name: 'mochi_vpv', surface: 'glance_panel', component: 'row', time: t(29) },
      { event_name: 'mochi_click', surface: 'glance_panel', component: 'row', time: t(29) },
      { event_name: 'mochi_vpv', surface: 'bubble', component: 'bubble', source: 'arrival', time: t(29) },
      { event_name: 'mochi_vpv', surface: 'bubble', component: 'bubble', source: 'replay', time: t(29) },
      { event_name: 'mochi_fetch', status: 'ok', duration_ms: 3000, time: t(29) },
      { event_name: 'mochi_fetch', status: 'offline', duration_ms: 100, time: t(29) },
      { event_name: 'mochi_resource', memory_mb: 180, time: t(29) },
    ];
    const text = usageSummary(events);
    expect(text).toContain('Days active: 2');
    expect(text).toContain('Panel opens: 3 (pet_click 2, keyboard 1)');
    expect(text).toContain('Rows seen / clicked: 2 / 1 (50%)');
    expect(text).toContain('Bubbles shown / clicked: 1 / 0 (0%)');
    expect(text).toContain('Refreshes: 2, 50% ok, median 3.0 s');
    expect(text).toContain('Memory: max 180 MB');
  });

  it('reads cleanly with no events', () => {
    expect(usageSummary([])).toContain('Rows seen / clicked: 0 / 0 (–)');
  });
});
