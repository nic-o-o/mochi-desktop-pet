import { useEffect, useId, useState } from 'react';
import type { AgentId, AgentJob, ReviewSkill } from './agentReviews.ts';
import { AGENT_IDS, AGENT_LABELS, DEFAULT_SKILL_ID, isActive, jobLine, rememberSkill, rememberedSkill } from './agentReviews.ts';
import { listReviewSkills } from './shell.ts';
import { logClick, logClose } from './usage.ts';

/** What the panel needs to offer agent reviews on "Waiting for your review" rows. */
export interface AgentReviewControls {
  jobs: AgentJob[];
  onStart: (taskId: string, agents: AgentId[], skillId: string) => void;
  onOpenReport: (taskId: string) => void;
}

/* Your own skills first, then the (long) list of installed plugin review skills. */
const SKILL_GROUPS: Array<{ source: ReviewSkill['source']; label?: string }> = [
  { source: 'default' },
  { source: 'personal', label: 'Your skills' },
  { source: 'plugin', label: 'Plugin review skills' },
];

/**
 * Pick agents and a skill for one review. Claude Code is ticked by default; Start
 * needs at least one. The skill defaults to the Codimango review assistant, or the
 * one picked last time.
 */
function AgentPicker({ taskId, onStart, onCancel }: { taskId: string; onStart: (agents: AgentId[], skillId: string) => void; onCancel: () => void }) {
  const uid = useId();
  const [chosen, setChosen] = useState<Set<AgentId>>(() => new Set(['claude']));
  const [skills, setSkills] = useState<ReviewSkill[]>([]);
  const [skillId, setSkillId] = useState(DEFAULT_SKILL_ID);
  useEffect(() => {
    let alive = true;
    void listReviewSkills().then((list) => {
      if (!alive) return;
      setSkills(list);
      setSkillId(rememberedSkill(list));
    });
    return () => {
      alive = false;
    };
  }, []);
  const skill = skills.find((s) => s.id === skillId);
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
      {skills.length > 1 && (
        <label className="agent-skill">
          <span className="small">Skill</span>
          <select value={skillId} onChange={(e) => setSkillId(e.target.value)}>
            {SKILL_GROUPS.map(({ source, label }) => {
              const group = skills.filter((s) => s.source === source);
              if (group.length === 0) return null;
              const options = group.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ));
              return label ? (
                <optgroup key={source} label={label}>
                  {options}
                </optgroup>
              ) : (
                options
              );
            })}
          </select>
          {skill?.description && skill.source !== 'default' && <span className="muted small agent-skill-note">{skill.description}</span>}
        </label>
      )}
      <p className="muted small" id={`${uid}-note`}>
        Runs on this Mac and usually takes 15–30 minutes. Nothing is submitted: you read the report and decide.
        {skillId !== DEFAULT_SKILL_ID && ' With your own skill, the report shows as plain text with one Copy button unless the skill writes the review-form sections.'}
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
            // Which kind of skill (default / personal / plugin), never its name.
            logClick('agent_review', 'start', { task_id: taskId, kind: agents.join('+'), source: skill?.source ?? 'default' });
            rememberSkill(skillId);
            onStart(agents, skillId);
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
          onStart={(agents, skillId) => {
            setPicking(false);
            controls.onStart(taskId, agents, skillId);
          }}
        />
      )}
    </div>
  );
}
