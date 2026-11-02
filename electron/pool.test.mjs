import { describe, expect, it } from 'vitest';
import { fetchPool, pickPool } from './pool.mjs';

const POOL = {
  updated: '2026-11-02T20:31+00:00',
  min_rounds: 3,
  tasks: {
    'ember-llm-speaker-attribution-parity': { id: '284566', owner: 'arnavnarula', rounds: 25, active: false },
    'ember-ios-friendship-rerequest': { id: '293219', owner: 'nuhaqadir', rounds: 3, active: false, claimed_by: 'zixuanchen' },
    'ember-keep-the-round-word-out-of-guesser-chat-e59c2-debrax': { id: '615297', owner: 'debrax', rounds: 17, active: true },
    'ember-notifications-inbox-fcm-banner': { id: '271032', owner: 'arnavnarula', rounds: 19, owner_flagged_saturated: true },
  },
};

describe('pickPool', () => {
  it("drops your own tasks and lists the rest most-tried first", () => {
    const out = pickPool(POOL, 'debrax');
    expect(out.tasks.map((t) => t.name)).toEqual([
      'ember-llm-speaker-attribution-parity',
      'ember-notifications-inbox-fcm-banner',
      'ember-ios-friendship-rerequest',
    ]);
    expect(out.tasks[2]).toMatchObject({ owner: 'nuhaqadir', claimedBy: 'zixuanchen', id: '293219' });
    expect(out.tasks[1].saturated).toBe(true);
    expect(out.updated).toBe(POOL.updated);
  });
});

describe('fetchPool', () => {
  it('prefers the published pool on GitHub', async () => {
    const out = await fetchPool({ github: async () => POOL, checkout: () => null, me: 'debrax' });
    expect(out.ok && out.tasks).toHaveLength(3);
  });

  it('falls back to a local checkout when GitHub has none', async () => {
    const out = await fetchPool({ github: async () => null, checkout: () => POOL, me: 'nuhaqadir' });
    expect(out.ok && out.tasks.map((t) => t.owner)).not.toContain('nuhaqadir');
  });

  it('says so when no pool is published yet', async () => {
    expect(await fetchPool({ github: async () => null, checkout: () => null, me: 'debrax' })).toMatchObject({ ok: false, kind: 'missing' });
  });
});
