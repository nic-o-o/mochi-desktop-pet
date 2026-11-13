/* Green delegations: what Mochi launched on the devserver, kept locally so a
 * panel reopen still shows the worker pid and log path. Green itself keeps
 * working detached; this record is only Mochi's memory of the launch.
 */
/**
 * Green repair agents Mochi can launch: only Muse and Codex — Green accepts
 * `--agent muse|codex` and has no mapping for MetaCode or Claude Code, so
 * those stay in the picker as unavailable rather than launching a guess.
 */
export type DelegateAgent = 'muse' | 'codex';

export interface DelegateAgentOption {
  id: DelegateAgent | 'metacode' | 'claude';
  label: string;
  available: boolean;
}

export const DELEGATE_AGENT_OPTIONS: DelegateAgentOption[] = [
  { id: 'muse', label: 'Muse', available: true },
  { id: 'codex', label: 'Codex', available: true },
  { id: 'metacode', label: 'MetaCode', available: false },
  { id: 'claude', label: 'Claude Code', available: false },
];

export function isDelegateAgent(value: unknown): value is DelegateAgent {
  return value === 'muse' || value === 'codex';
}

/** Window event fired whenever the saved delegations change, so the status label in the row's meta line reloads its record and rechecks. */
export const DELEGATIONS_CHANGED_EVENT = 'mochi:delegations-changed';

export interface DelegateError {
  kind: string;
  message: string;
  fix?: string;
  /** The failing doctor check, when the failure came from Green doctor (e.g. 'docker'). */
  check?: string;
}

/** Result of one delegate launch, as the main process returns it over IPC. */
export interface DelegateResult {
  ok: boolean;
  taskSlug: string;
  agent: DelegateAgent;
  /** The launch was refused by the remote lease and this is the worker already holding it, not a new launch. */
  alreadyRunning?: boolean;
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
  /** The failure kind that produced a failed record, when known. */
  errorKind?: string;
  /** The failing doctor check that produced a failed record, when known. */
  errorCheck?: string;
}

/** A handler probe: what, if anything, is working on a task on the devserver. */
export interface HandlerProbe {
  handler: 'green' | 'none';
  pid: number | null;
  logPath: string | null;
  agent: DelegateAgent | null;
  kind: DelegateStatusKind | null;
  lastDecision?: string | null;
  lastActivityAgeSecs?: number | null;
  waitingMins?: number | null;
  waitingReason?: string | null;
  blockedReason?: string | null;
  hasBlocked?: boolean;
  hasTimingZero?: boolean;
  leaseAgeSecs?: number | null;
  checkedAtMs: number;
}

export interface HandlerProbeRequest {
  taskSlug: string;
  node: string;
  pid?: number | null;
  logPath?: string | null;
}

export interface HandlerProbeResult {
  ok: boolean;
  probe?: HandlerProbe;
  error?: DelegateError;
}

export interface StopWorkerRequest {
  taskSlug: string;
  node: string;
  pid: number;
  logPath?: string | null;
}

export interface StopWorkerResult {
  ok: boolean;
  taskSlug: string;
  pid?: number | null;
  stopped?: boolean;
  error?: DelegateError;
}

export interface DockerInstallResult {
  ok: boolean;
  taskSlug: string;
  alreadyInstalled?: boolean;
  daemonReachable?: boolean;
  needsRelogin?: boolean;
  error?: DelegateError;
}

/** True when a failed record is the Docker-missing doctor failure, including records saved before the failing check was stored. */
export function isDockerMissingFailure(record: DelegationRecord | null): boolean {
  if (!record || record.status !== 'failed') return false;
  if (record.errorCheck === 'docker') return true;
  return /docker\s+missing/i.test(record.errorMessage ?? '');
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

/** Drop one task's record, leaving the rest untouched. Never mutates. */
export function removeDelegation(records: DelegationRecord[], taskSlug: string): DelegationRecord[] {
  return records.filter((r) => r.taskSlug !== taskSlug);
}
