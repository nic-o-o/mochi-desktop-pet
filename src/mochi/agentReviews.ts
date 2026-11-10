/* Ask agents to review: the renderer's view of agent runs.
 * Runs live in the main process (electron/agentReview.mjs) and arrive through
 * the shell bridge on every change; this file holds the shared types, the row
 * and report wording, and the hook that keeps the list in sync. In a plain
 * browser there is no bridge, so the feature stays hidden.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskItem } from './logic.ts';
import { agentReviewsAvailable, listAgentReviews, onAgentReviewsChanged } from './shell.ts';

export type AgentId = 'claude' | 'codex';
export const AGENT_IDS: AgentId[] = ['claude', 'codex'];
export const AGENT_LABELS: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex' };

export type AgentJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface AgentFailure {
  kind: string;
  message: string;
  /** Command the person can run to fix it, e.g. `codimango auth setup`. */
  fix?: string;
}

/** A skill the picker offers. Ids come from the main process, which resolves the path. */
export interface ReviewSkill {
  id: string;
  source: 'default' | 'added' | 'personal' | 'plugin';
  label: string;
  description?: string;
}

export const DEFAULT_SKILL_ID = 'default';
const SKILL_STORAGE_KEY = 'mochi.reviewSkill';

/** The skill picked last time, if it is still offered; otherwise the default. */
export function rememberedSkill(skills: ReviewSkill[]): string {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(SKILL_STORAGE_KEY);
  } catch {
    /* storage unavailable: use the default */
  }
  return saved && skills.some((s) => s.id === saved) ? saved : DEFAULT_SKILL_ID;
}

const STARRED_STORAGE_KEY = 'mochi.reviewSkill.starred';

/** Skills the person starred in the picker (shown first). */
export function loadStarredSkills(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(STARRED_STORAGE_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Star or unstar one skill; returns the new list. The default skill is never starred. */
export function toggleStarredSkill(starred: string[], id: string): string[] {
  if (id === DEFAULT_SKILL_ID) return starred;
  const next = starred.includes(id) ? starred.filter((s) => s !== id) : [...starred, id];
  try {
    localStorage.setItem(STARRED_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: stars last for this session */
  }
  return next;
}

export function rememberSkill(id: string): void {
  try {
    localStorage.setItem(SKILL_STORAGE_KEY, id);
  } catch {
    /* storage unavailable: nothing to remember */
  }
}

export interface AgentJob {
  id: string;
  taskId: string;
  taskName: string;
  /** The task's updatedAt when the run started: a later change makes the report stale. */
  taskUpdatedAtMs: number | null;
  agent: AgentId;
  /** Set when the run uses one of the person's own skills instead of the default. */
  skill?: { id: string; label: string; source?: string };
  status: AgentJobStatus;
  /** The model that ran it: Claude Code reports it; for Codex it is the one in its settings. */
  model?: string;
  /** Tool calls so far: the only progress an agent reports. */
  steps: number;
  createdAtMs: number;
  startedAtMs?: number;
  endedAtMs?: number;
  /** The skill's output (markdown), when done. */
  report?: string;
  failure?: AgentFailure;
}

export interface AgentReviewStart {
  taskId: string;
  taskName: string;
  taskUpdatedAtMs?: number;
  agents: AgentId[];
  /** Omitted for the default skill. */
  skillId?: string;
}

/** One run per agent for a task (the store keeps only the latest), in agent order. */
export function jobsForTask(jobs: AgentJob[], taskId: string): AgentJob[] {
  return AGENT_IDS.flatMap((agent) => jobs.filter((j) => j.taskId === taskId && j.agent === agent).slice(-1));
}

export function isActive(job: AgentJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

export function minutesLabel(fromMs: number, nowMs: number): string {
  const min = Math.floor((nowMs - fromMs) / 60_000);
  return min < 1 ? 'under a minute' : `${min} min`;
}

/** Row wording: "Claude Code reviewing · 12 min", "Codex · my-skill · report ready". */
export function jobLine(job: AgentJob, nowMs: number): string {
  const label = job.skill ? `${AGENT_LABELS[job.agent]} · ${job.skill.label}` : AGENT_LABELS[job.agent];
  if (job.status === 'queued') return `${label} waiting to start`;
  if (job.status === 'running') return `${label} reviewing · ${minutesLabel(job.startedAtMs ?? job.createdAtMs, nowMs)}`;
  if (job.status === 'done') return `${label} · report ready`;
  return job.failure?.kind === 'cancelled' ? `${label} · stopped` : `${label} · failed`;
}

/** The task changed (push, validation, edit) after the run started. */
export function isStale(job: AgentJob, task: TaskItem | undefined): boolean {
  return job.taskUpdatedAtMs !== null && task?.updatedAtMs !== undefined && task.updatedAtMs > job.taskUpdatedAtMs;
}

/** Runs that were active in `prev` and have now finished (not ones the person stopped). */
export function newlyFinished(prev: AgentJob[], next: AgentJob[]): AgentJob[] {
  const wasActive = new Set(prev.filter(isActive).map((j) => j.id));
  return next.filter((j) => wasActive.has(j.id) && !isActive(j) && j.failure?.kind !== 'cancelled');
}

/**
 * The current runs, kept in sync with the main process. `onFinished` fires for
 * each run that finishes while Mochi is open (never for ones loaded at launch).
 */
export function useAgentReviews(onFinished: (job: AgentJob) => void) {
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const available = agentReviewsAvailable();
  const prev = useRef<AgentJob[]>([]);
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  });
  /* Every list from the main process goes through here, whichever call returned it. */
  const apply = useCallback((next: AgentJob[]) => {
    for (const job of newlyFinished(prev.current, next)) finished.current(job);
    prev.current = next;
    setJobs(next);
  }, []);
  useEffect(() => {
    if (!available) return;
    let alive = true;
    void listAgentReviews().then((next) => alive && apply(next));
    const unsubscribe = onAgentReviewsChanged((next) => alive && apply(next));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [available, apply]);
  return { available, jobs, apply };
}
