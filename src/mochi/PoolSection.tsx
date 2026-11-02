import { useState } from 'react';
import { CODIMANGO_TASK_URL, poolState } from './pool.ts';
import type { PoolTask } from './shell.ts';

interface PoolSectionProps {
  tasks: PoolTask[];
  updated: string | null;
  onOpen: (url: string) => void;
}

/** "Too easy: help a teammate": the team's pool of tasks stuck at too easy. */
export function PoolSection({ tasks, updated, onOpen }: PoolSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const open = tasks.filter((t) => poolState(t) === 'open').length;
  const shown = expanded ? tasks : tasks.slice(0, 2);
  const remaining = tasks.length - shown.length;
  return (
    <div className="glance-section pool-section">
      <div className="glance-section-head">
        <h3>Too easy: help a teammate</h3>
        <span className="count-pill" aria-label={`${open} open`}>
          {open}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="muted small">No teammate is stuck at too easy right now.</p>
      ) : (
        <>
          <ul className="glance-list">
            {shown.map((t) => (
              <li key={t.name} className="glance-row">
                <button
                  type="button"
                  className="glance-title"
                  onClick={() => t.id && onOpen(`${CODIMANGO_TASK_URL}${t.id}`)}
                  disabled={!t.id}
                  title={t.name}
                >
                  {t.name}
                </button>
                <div className="glance-meta">
                  <span className="muted">
                    {t.owner} · too easy after {t.rounds} rounds{t.saturated ? ' · owner thinks it’s saturated' : ''}
                  </span>
                  <span className={`glance-flag ${poolState(t) === 'open' ? 'tone-ok' : 'tone-light'}`}>{poolState(t)}</span>
                </div>
              </li>
            ))}
          </ul>
          {remaining > 0 && (
            <button type="button" className="glance-more" onClick={() => setExpanded(true)}>
              View {remaining} more ▾
            </button>
          )}
          {expanded && tasks.length > 2 && (
            <button type="button" className="glance-more" onClick={() => setExpanded(false)}>
              Show less ▴
            </button>
          )}
        </>
      )}
      {updated && <p className="muted small pool-updated">Team pool, updated {new Date(updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</p>}
    </div>
  );
}
