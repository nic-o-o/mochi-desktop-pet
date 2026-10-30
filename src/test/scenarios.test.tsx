// @vitest-environment jsdom
/* Runs every scenario in scenarios/*.yaml against the real App (see scenarios/README.md).
 * A scenario's `events:` expectations show as todo until usage logging exists. */
import { describe, it } from 'vitest';
import { parse } from 'yaml';
import { runScenario } from './scenarios/runner.tsx';
import type { ScenarioFile } from './scenarios/runner.tsx';

const files = import.meta.glob('../../scenarios/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

for (const [path, raw] of Object.entries(files)) {
  const file = parse(raw) as ScenarioFile;
  describe(path.split('/').pop() ?? path, () => {
    for (const sc of file.scenarios) {
      it(`${sc.id}: ${sc.title}`, () => runScenario(file, sc));
      if (JSON.stringify(sc.steps).includes('"events"')) it.todo(`${sc.id}: usage events (pending usage logging)`);
    }
  });
}
