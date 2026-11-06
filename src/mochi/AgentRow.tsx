import { useId, useState } from 'react';
import type { AgentId, AgentJob } from './agentReviews.ts';
import { AGENT_IDS, AGENT_LABELS, isActive, jobLine } from './agentReviews.ts';
import { logClick, logClose } from './usage.ts';

/** What the panel needs to offer agent reviews on "Waiting for your review" rows. */
export interface AgentReviewControls {
  jobs: AgentJob[];
  onStart: (taskId: string, agents: AgentId[]) => void;
  onOpenReport: (taskId: string) => void;
}

/** Pick agents for one review. Claude Code is ticked by default; Start needs at least one. */
function AgentPicker({ taskId, onStart, onCancel }: { taskId: string; onStart: (agents: AgentId[]) => void; onCancel: () => void }) {
  const uid = useId();
  const [chosen, setChosen] = useState<Set<AgentId>>(() => new Set(['claude']));
  const toggle = (agent: AgentId) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent);
      else next.add(agent);
      return next;
    });
  return (
    <fieldset className="agent-picker" aria-describedby={`${uid}-note`}>
      <legend>Ask agents to review</legend>
      {AGENT_IDS.map((agent) => (
        <label key={agent} className="agent-choice">
          <input type="checkbox" checked={chosen.has(agent)} onChange={() => toggle(agent)} />
          {AGENT_LABELS[agent]}
        </label>
      ))}
      <p className="muted small" id={`${uid}-note`}>
        Runs on this Mac and usually takes 15–30 minutes. Nothing is submitted: you read the report and decide.
      </p>
      <div className="agent-picker-actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={chosen.size === 0}
          onClick={() => {
            const agents = AGENT_IDS.filter((a) => chosen.has(a));
            logClick('agent_review', 'start', { task_id: taskId, kind: agents.join('+') });
            onStart(agents);
          }}
        >
          Start
        </button>
      </div>
    </fieldset>
  );
}

/**
 * Under a review row: each agent's progress, a link to the report, and
 * "Ask agents" while no agent is working on this task.
 */
export function AgentRow({ taskId, jobs, nowMs, controls }: { taskId: string; jobs: AgentJob[]; nowMs: number; controls: AgentReviewControls }) {
  const [picking, setPicking] = useState(false);
  const busy = jobs.some(isActive);
  const hasReport = jobs.some((j) => j.status === 'done' || j.status === 'failed');
  return (
    <div className="agent-row">
      {jobs.length > 0 && (
        <ul className="agent-status-list">
          {jobs.map((j) => (
            <li key={j.id} className={`agent-status agent-${j.status}`}>
              {jobLine(j, nowMs)}
            </li>
          ))}
        </ul>
      )}
      <div className="agent-row-actions">
        {jobs.length > 0 && (
          <button
            type="button"
            className="btn-link agent-link"
            onClick={() => {
              logClick('glance_panel', 'agent_report', { section: 'waiting_review', task_id: taskId });
              controls.onOpenReport(taskId);
            }}
          >
            {hasReport ? 'View report' : 'View progress'}
          </button>
        )}
        {!busy && !picking && (
          <button
            type="button"
            className="btn-link agent-link"
            onClick={() => {
              logClick('glance_panel', 'ask_agents', { section: 'waiting_review', task_id: taskId });
              setPicking(true);
            }}
          >
            {jobs.length > 0 ? 'Ask again' : 'Ask agents'}
          </button>
        )}
      </div>
      {picking && (
        <AgentPicker
          taskId={taskId}
          onCancel={() => {
            logClose('agent_review', 'picker', { task_id: taskId });
            setPicking(false);
          }}
          onStart={(agents) => {
            setPicking(false);
            controls.onStart(taskId, agents);
          }}
        />
      )}
    </div>
  );
}
