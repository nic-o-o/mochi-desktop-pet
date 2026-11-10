import { useEffect, useId, useState } from 'react';
import type { AgentId, AgentJob, ReviewSkill } from './agentReviews.ts';
import { AGENT_IDS, AGENT_LABELS, DEFAULT_SKILL_ID, isActive, jobLine, rememberSkill, rememberedSkill } from './agentReviews.ts';
import { addReviewSkill, canAddReviewSkill, listReviewSkills, removeReviewSkill } from './shell.ts';
import { logClick, logClose } from './usage.ts';

/** What the panel needs to offer agent reviews on "Waiting for your review" rows. */
export interface AgentReviewControls {
  jobs: AgentJob[];
  onStart: (taskId: string, agents: AgentId[], skillId: string) => void;
  onOpenReport: (taskId: string) => void;
}

/* Your own review skills first (added, then personal), then installed plugin review skills. */
const SKILL_GROUPS: Array<{ sources: Array<ReviewSkill['source']>; label?: string }> = [
  { sources: ['default'] },
  { sources: ['added', 'personal'], label: 'Your review skills' },
  { sources: ['plugin'], label: 'Plugin review skills' },
];
/* The menu's last entry opens the file picker instead of selecting a skill. */
const ADD_SKILL = '__add__';

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
  const [skillNote, setSkillNote] = useState('');
  const pickSkill = (value: string) => {
    setSkillNote('');
    if (value !== ADD_SKILL) {
      setSkillId(value);
      return;
    }
    logClick('agent_review', 'add_skill', { task_id: taskId });
    void addReviewSkill().then((got) => {
      if (!got) return; // cancelled
      setSkills(got.skills);
      if (got.id) setSkillId(got.id);
      else setSkillNote("That folder has no SKILL.md, so it isn't a skill.");
    });
  };
  const removeSkill = () => {
    void removeReviewSkill(skillId).then((list) => {
      if (!list) return;
      setSkills(list);
      setSkillId(DEFAULT_SKILL_ID);
    });
  };
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
      {(skills.length > 1 || canAddReviewSkill()) && (
        <label className="agent-skill">
          <span className="small">Skill</span>
          <select value={skillId} onChange={(e) => pickSkill(e.target.value)}>
            {SKILL_GROUPS.map(({ sources, label }) => {
              const group = skills.filter((s) => sources.includes(s.source));
              if (group.length === 0) return null;
              const options = group.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ));
              return label ? (
                <optgroup key={label} label={label}>
                  {options}
                </optgroup>
              ) : (
                options
              );
            })}
            {canAddReviewSkill() && <option value={ADD_SKILL}>Add a skill…</option>}
          </select>
          {skill?.description && skill.source !== 'default' && <span className="muted small agent-skill-note">{skill.description}</span>}
          {skillNote && <span className="small agent-skill-error">{skillNote}</span>}
          {skill?.source === 'added' && (
            <button type="button" className="btn-link agent-skill-remove" onClick={removeSkill}>
              Remove from list
            </button>
          )}
          <span className="muted small">Lists skills with “review” in the name. Use Add a skill… for any other.</span>
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
