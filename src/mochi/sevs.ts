/* Codimango SEVs: a bubble when one opens and when it's mitigated, plus a line
 * at the top of the panel while it's open. The main process reads and filters
 * them (electron/sevs.mjs); this side decides what to tell, once per SEV.
 */
import { useEffect, useRef, useState } from 'react';
import { listSevs, onSevsChanged } from './shell.ts';

export interface Sev {
  id: string;
  level: number;
  open: boolean;
  title: string;
  url: string;
  createdAtMs: number;
  mitigatedAtMs?: number;
}

/** SEV IDs already told about, so each bubbles once across restarts. */
export interface SevMemory {
  open: string[];
  mitigated: string[];
}

export interface SevBubble {
  kind: 'sev_open' | 'sev_mitigated';
  sev: Sev;
}

export const SEVS_STORAGE_KEY = 'mochi.sevs.v1';
/** Only SEVs opened this recently bubble; older open ones just get the panel line. */
export const SEV_BUBBLE_WINDOW_MS = 24 * 3_600_000;

export function loadSevMemory(): SevMemory {
  try {
    const raw = JSON.parse(localStorage.getItem(SEVS_STORAGE_KEY) ?? 'null') as Partial<SevMemory> | null;
    return { open: Array.isArray(raw?.open) ? raw.open : [], mitigated: Array.isArray(raw?.mitigated) ? raw.mitigated : [] };
  } catch {
    return { open: [], mitigated: [] };
  }
}

function saveSevMemory(memory: SevMemory): void {
  try {
    localStorage.setItem(SEVS_STORAGE_KEY, JSON.stringify(memory));
  } catch {
    /* storage full or unavailable: worst case a SEV bubbles again */
  }
}

/**
 * What to bubble for a new SEV list: newly opened SEVs (from the last day), and
 * mitigation of a SEV Mochi told you about. Forgets SEVs no longer listed.
 */
export function sevBubbles(memory: SevMemory, sevs: Sev[], nowMs: number): { bubbles: SevBubble[]; memory: SevMemory } {
  const bubbles: SevBubble[] = [];
  const listed = new Set(sevs.map((s) => s.id));
  const open = memory.open.filter((id) => listed.has(id));
  const mitigated = memory.mitigated.filter((id) => listed.has(id));
  for (const sev of sevs) {
    if (sev.open && !open.includes(sev.id) && nowMs - sev.createdAtMs <= SEV_BUBBLE_WINDOW_MS) {
      bubbles.push({ kind: 'sev_open', sev });
      open.push(sev.id);
    } else if (!sev.open && open.includes(sev.id) && !mitigated.includes(sev.id)) {
      bubbles.push({ kind: 'sev_mitigated', sev });
      mitigated.push(sev.id);
    }
  }
  return { bubbles, memory: { open, mitigated } };
}

/** Panel lines shown at most; the rest are counted ("+2 more open"). */
export const SEV_LINES_MAX = 2;

/**
 * A SEV title as a short headline: up to the first "(", ";" or dash clause,
 * then cut on a word boundary. The full title stays on hover.
 */
export function sevHeadline(title: string, max = 48): string {
  const head = title.split(/\s*(?:[(;]|\s[—–-]\s)/)[0].trim() || title.trim();
  if (head.length <= max) return head;
  const cut = head.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,:]+$/, '')}…`;
}

/** Bubble text for a SEV. */
export function sevBubbleText({ kind, sev }: SevBubble): { title: string; detail: string } {
  const headline = sevHeadline(sev.title, 80);
  return kind === 'sev_open'
    ? { title: `Codimango SEV${sev.level} open`, detail: `${headline}. Submissions or validation may fail until it's fixed.` }
    : { title: 'Codimango SEV mitigated', detail: `${headline}. Retry anything it blocked.` };
}

/** Open SEVs for the panel line, plus a callback for the one bubble to show. */
export function useSevs(onBubble: (bubble: SevBubble) => void): Sev[] {
  const [sevs, setSevs] = useState<Sev[]>([]);
  const notify = useRef(onBubble);
  useEffect(() => {
    notify.current = onBubble;
  });
  useEffect(() => {
    let alive = true;
    const apply = (next: Sev[]) => {
      if (!alive) return;
      const { bubbles, memory } = sevBubbles(loadSevMemory(), next, Date.now());
      saveSevMemory(memory);
      setSevs(next);
      /* Several at once (first launch): show the most severe; the rest are in the panel. */
      if (bubbles.length > 0) notify.current(bubbles[0]);
    };
    void listSevs().then(apply);
    const unsubscribe = onSevsChanged(apply);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return sevs.filter((s) => s.open);
}
