import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEventLog, readEvents, sanitizeEvent } from './events.mjs';

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
