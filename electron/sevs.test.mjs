import { describe, expect, it } from 'vitest';
import { createSevWatch, leadingJson, pickSevs } from './sevs.mjs';

const NOW = Date.parse('2026-11-06 12:00:00 PST');
const row = (over = {}) => ({
  sev_number: 'S728082',
  level: '3',
  status: 'In Progress',
  visibility: 'PUBLIC',
  created: '2026-11-06 06:46:26 PST',
  time_mitigated: '',
  url: 'https://www.internalfb.com/sevmanager/view/728082',
  title: 'Codimango: TBR mac_swe lane increased job timeouts',
  ...over,
});

describe('leadingJson', () => {
  it('reads the JSON before a trailing CLI hint, braces inside strings included', () => {
    expect(leadingJson('{"data":[{"title":"a } b"}]}\n\nPoll hint: subscribe instead')).toEqual({ data: [{ title: 'a } b' }] });
    expect(leadingJson('[1,2]')).toEqual([1, 2]);
    expect(leadingJson('Error: not logged in')).toBeNull();
  });
});

describe('pickSevs', () => {
  it('keeps a fresh open Codimango SEV with a short title', () => {
    expect(pickSevs([row()], NOW)).toEqual([
      {
        id: 'S728082',
        level: 3,
        open: true,
        title: 'TBR mac_swe lane increased job timeouts',
        url: 'https://www.internalfb.com/sevmanager/view/728082',
        createdAtMs: Date.parse('2026-11-06 06:46:26 PST'),
      },
    ]);
  });

  it('drops private, security, SEV4 and non-Codimango SEVs', () => {
    const rows = [
      row({ visibility: 'PRIVATE' }),
      row({ title: "can_modify_job_type: ANY on Async-Tier ACLs lets any employee rewrite Codimango's async plane" }),
      row({ title: 'Github PAT Tokens are exposed in the Codimango Github Org' }),
      row({ title: 'Codimango tasks containing PII' }),
      row({ level: '4' }),
      row({ title: 'ADO Track Partnerships alert cleanup' }),
    ];
    expect(pickSevs(rows, NOW)).toEqual([]);
  });

  it('keeps open SEVs from the last week, and mitigated ones for a day', () => {
    const rows = [
      row({ sev_number: 'S1', created: '2026-10-27 11:32:26 PDT', status: 'Blocked' }),
      row({ sev_number: 'S2', status: 'Mitigated', created: '2026-11-05 19:13:33 PST', time_mitigated: '2026-11-05 20:09:00 PST' }),
      row({ sev_number: 'S3', status: 'Mitigated', created: '2026-11-03 06:14:39 PST', time_mitigated: '2026-11-03 09:26:00 PST' }),
    ];
    expect(pickSevs(rows, NOW).map((s) => [s.id, s.open])).toEqual([['S2', false]]);
  });

  it('puts the most severe first and never trusts a non-SEV Manager link', () => {
    const rows = [row({ sev_number: 'S3' }), row({ sev_number: 'S2', level: '2', url: 'https://evil.example/x' })];
    const sevs = pickSevs(rows, NOW);
    expect(sevs.map((s) => s.id)).toEqual(['S2', 'S3']);
    expect(sevs[0].url).toBe('https://www.internalfb.com/sevmanager/view/2');
  });
});

describe('createSevWatch', () => {
  it('reports changes only, and keeps the last list when a read fails', async () => {
    const reads = [[row()], [row()], { error: 'ENOENT' }];
    const changes = [];
    const watch = createSevWatch({ read: async () => reads.shift(), now: () => NOW, onChange: (s) => changes.push(s) });
    await watch.refresh();
    await watch.refresh();
    expect(changes).toHaveLength(1);
    expect(await watch.refresh()).toHaveLength(1);
    expect(changes).toHaveLength(1);
  });
});
