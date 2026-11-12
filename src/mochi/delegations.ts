/* Green delegations: what Mochi launched on the devserver, kept locally so a
 * panel reopen still shows the worker pid and log path. Green itself keeps
 * working detached; this record is only Mochi's memory of the launch.
 */
export type DelegateAgent = 'codex';

export interface DelegateError {
  kind: string;
  message: string;
  fix?: string;
}

/** Result of one delegate launch, as the main process returns it over IPC. */
export interface DelegateResult {
  ok: boolean;
  taskSlug: string;
  agent: DelegateAgent;
  repo?: string | null;
  pid?: number | null;
  logPath?: string | null;
  decision?: string | null;
  timedOut?: boolean;
  error?: DelegateError;
}

export interface DelegationRecord {
  taskSlug: string;
  agent: DelegateAgent;
  status: 'started' | 'failed';
  pid: number | null;
  logPath: string | null;
  repo: string | null;
  node?: string;
  startedAtMs: number;
  errorMessage?: string;
  errorFix?: string;
}

/** Live worker status, from one probe of the devserver. */
export type DelegateStatusKind = 'starting' | 'working' | 'blocked' | 'done' | 'stopped' | 'unknown';

export interface DelegateStatus {
  kind: DelegateStatusKind;
  taskSlug: string;
  pid: number | null;
  logPath: string | null;
  lastDecision?: string | null;
  lastActivityAgeSecs?: number | null;
  checkedAtMs: number;
}

export interface DelegateStatusRequest {
  taskSlug: string;
  node: string;
  pid: number;
  logPath: string;
}

export interface DelegateStatusResult {
  ok: boolean;
  status?: DelegateStatus;
  error?: DelegateError;
}

export const DELEGATE_STATUS_LABELS: Record<DelegateStatusKind, string> = {
  starting: 'Green starting',
  working: 'Green working',
  blocked: 'Green blocked',
  done: 'Green done',
  stopped: 'Green not running',
  unknown: 'Green status unknown',
};

/** How long ago the worker log last changed, in one short phrase. */
export function formatActivityAge(ageSecs: number | null | undefined): string | null {
  if (ageSecs == null || ageSecs < 0) return null;
  if (ageSecs < 60) return 'just now';
  if (ageSecs < 3600) return `${Math.floor(ageSecs / 60)}m ago`;
  return `${Math.floor(ageSecs / 3600)}h ago`;
}

export const DELEGATIONS_STORAGE_KEY = 'mochi.delegations.v1';
export const DELEGATE_NODE_STORAGE_KEY = 'mochi.delegate-node.v1';

/**
 * A devserver node id, as the user typed it: trimmed, lowercased, scheme and
 * trailing path stripped, and rejected when it is not one hostname-like
 * token. Mirrors normalizeDelegateNode in electron/delegate.mjs, which is
 * the authoritative check before any agentcloudctl call; keep the two in
 * sync.
 */
export function normalizeDelegateNode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let value = input.trim().toLowerCase().replace(/^https?:\/\//, '');
  value = (value.split('/')[0] ?? '').replace(/\.+$/, '');
  if (!value || value.length > 253 || value.includes('..')) return null;
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(value) ? value : null;
}

/** The devserver the user named the first time they delegated, if any. */
export function loadDelegateNode(): string | null {
  try {
    return normalizeDelegateNode(localStorage.getItem(DELEGATE_NODE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveDelegateNode(node: string): void {
  try {
    localStorage.setItem(DELEGATE_NODE_STORAGE_KEY, node);
  } catch {
    /* storage unavailable — the node still applies for this delegation */
  }
}
const MAX_RECORDS = 20;

function isRecord(value: unknown): value is DelegationRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<DelegationRecord>;
  return typeof r.taskSlug === 'string' && r.taskSlug.length > 0 && (r.status === 'started' || r.status === 'failed');
}

/** Saved delegations, repaired: unknown entries dropped. Never throws. */
export function parseDelegations(raw: string | null): DelegationRecord[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord);
  } catch {
    return [];
  }
}

export function loadDelegations(): DelegationRecord[] {
  try {
    return parseDelegations(localStorage.getItem(DELEGATIONS_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveDelegations(records: DelegationRecord[]): void {
  try {
    localStorage.setItem(DELEGATIONS_STORAGE_KEY, JSON.stringify(records));
  } catch {
    /* storage unavailable — the record still applies for the session */
  }
}

/** Upsert one record for a task, newest first, capped. Never mutates. */
export function recordDelegation(records: DelegationRecord[], record: DelegationRecord): DelegationRecord[] {
  return [record, ...records.filter((r) => r.taskSlug !== record.taskSlug)].slice(0, MAX_RECORDS);
}
