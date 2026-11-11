import { useEffect, useId, useState } from 'react';
import type { AgentId, AgentJob, ReviewSkill } from './agentReviews.ts';
import {
  AGENT_IDS,
  AGENT_LABELS,
  DEFAULT_SKILL_ID,
  isActive,
  jobLine,
  loadStarredSkills,
  rememberSkill,
  rememberedSkill,
  toggleStarredSkill,
} from './agentReviews.ts';
import { addReviewSkill, canAddReviewSkill, listReviewSkills, removeReviewSkill } from './shell.ts';
import { logClick, logClose } from './usage.ts';

/** What the panel needs to offer agent reviews on "Waiting for your review" rows. */
export interface AgentReviewControls {
  jobs: AgentJob[];
  onStart: (taskId: string, agents: AgentId[], skillId: string) => void;
  onOpenReport: (taskId: string) => void;
}

/* Default, then starred, then your own review skills (added, then personal), then
   installed plugin review skills. A starred skill moves out of its usual group. */
const SKILL_GROUPS: Array<{ sources: Array<ReviewSkill['source']>; label: string }> = [
  { sources: ['added', 'personal'], label: 'Your review skills' },
  { sources: ['plugin'], label: 'Plugin review skills' },
];

/**
 * The skill chooser: the current skill on a button; open, a filterable list where
 * every skill line ends in a star (☆ → yellow ★) and starred skills are listed first.
 */
export function SkillPicker({
  skills,
  value,
  starred,
  canAdd,
  onPick,
  onAdd,
  onToggleStar,
}: {
  skills: ReviewSkill[];
  value: string;
  starred: string[];
  canAdd: boolean;
  onPick: (id: string) => void;
  onAdd: () => void;
  onToggleStar: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = skills.find((s) => s.id === value);
  const q = query.trim().toLowerCase();
  const matches = (s: ReviewSkill) => !q || s.label.toLowerCase().includes(q);
  const groups: Array<{ label?: string; items: ReviewSkill[] }> = [
    { items: skills.filter((s) => s.source === 'default' && matches(s)) },
    {
      label: 'Starred',
      items: starred.map((id) => skills.find((s) => s.id === id)).filter((s): s is ReviewSkill => !!s && matches(s)),
    },
    ...SKILL_GROUPS.map(({ sources, label }) => ({
      label,
      items: skills.filter((s) => sources.includes(s.source) && !starred.includes(s.id) && matches(s)),
    })),
  ].filter((g) => g.items.length > 0);
  const close = () => {
    setOpen(false);
    setQuery('');
  };
  return (
    <div className="skill-picker">
      <button type="button" className="skill-picker-current" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <span className="skill-picker-label">{current?.label ?? 'Codimango review assistant (default)'}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="skill-list">
          <input
            className="skill-filter"
            type="search"
            placeholder="🔍  Search skills…"
            aria-label="Search skills"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <ul className="skill-rows" aria-label="Review skills">
            {groups.map((g) => (
              <li key={g.label ?? 'default'} className="skill-group">
                {g.label && <span className="skill-group-label">{g.label}</span>}
                <ul>
                  {g.items.map((s) => {
                    const isStarred = starred.includes(s.id);
                    return (
                      <li key={s.id} className={s.id === value ? 'skill-row is-current' : 'skill-row'}>
                        <button
                          type="button"
                          className="skill-row-pick"
                          aria-current={s.id === value ? 'true' : undefined}
                          title={s.description}
                          onClick={() => {
                            onPick(s.id);
                            close();
                          }}
                        >
                          <span className="skill-check" aria-hidden="true">
                            {s.id === value ? '✓' : ''}
                          </span>
                          {s.label}
                        </button>
                        {s.source !== 'default' && (
                          <button
                            type="button"
                            className={isStarred ? 'skill-star is-starred' : 'skill-star'}
                            aria-pressed={isStarred}
                            aria-label={isStarred ? `Unstar ${s.label}` : `Star ${s.label}`}
                            title={isStarred ? 'Unstar' : 'Star: list it first'}
                            onClick={() => onToggleStar(s.id)}
                          >
                            {isStarred ? '★' : '☆'}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
          {groups.length === 0 && <p className="muted small skill-empty">No skills match.</p>}
          {canAdd && (
            <button
              type="button"
              className="skill-add"
              onClick={() => {
                close();
                onAdd();
              }}
            >
              Add a skill…
            </button>
          )}
          <p className="muted small skill-hint">Lists skills with “review” in the name. Add a skill… for any other.</p>
        </div>
      )}
    </div>
  );
}

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
  const [starred, setStarred] = useState<string[]>(loadStarredSkills);
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
        <div className="agent-skill">
          <span className="small">Skill</span>
          <SkillPicker
            skills={skills}
            value={skillId}
            starred={starred}
            canAdd={canAddReviewSkill()}
            onPick={pickSkill}
            onAdd={() => pickSkill(ADD_SKILL)}
            onToggleStar={(id) => setStarred((prev) => toggleStarredSkill(prev, id))}
          />
          {skill?.description && skill.source !== 'default' && <span className="muted small agent-skill-note">{skill.description}</span>}
          {skillNote && <span className="small agent-skill-error">{skillNote}</span>}
          {skill?.source === 'added' && (
            <button type="button" className="btn-link agent-skill-remove" onClick={removeSkill}>
              Remove from list
            </button>
          )}
        </div>
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
