/* Customize Mochi: the renderer's side. Looks live in the main process
 * (electron/looks.mjs) and reach the renderer as data URLs; this file holds the
 * shared types, the wording, and the hook that keeps the current look in sync.
 */
import { useCallback, useEffect, useState } from 'react';
import { looksState, onOpenCustomize } from './shell.ts';

export const PROMPT_MAX = 200;
export const PROMPT_EXAMPLES = ['a sleepy orange cat with a scarf', 'a tiny blue dragon', 'a round panda with headphones', 'a fluffy pink bunny'];

export interface PetLook {
  id: string;
  createdAtMs: number;
  /** The description it was drawn from; stays on this Mac, never logged. */
  prompt: string;
  /** The sprite as a data URL. */
  image: string;
}

export interface LooksState {
  /** Whether this build can draw pets (B1: only when running from source). */
  available: boolean;
  looks: PetLook[];
  currentId: string | null;
}

export interface PetCandidate {
  id: string;
  image: string;
  /** The background couldn't be cut out, so the drawing sits in a circle. */
  framed: boolean;
}

export type GenerateErrorKind = 'empty' | 'cancelled' | 'refused' | 'busy' | 'limit' | 'offline' | 'error';
export type GenerateResult = { ok: true; candidates: PetCandidate[] } | { ok: false; error: { kind: GenerateErrorKind } };

/** What each failure says. Cancelled says nothing: the person asked for it. */
export const GENERATE_ERROR_TEXT: Record<GenerateErrorKind, string> = {
  empty: 'Describe how Mochi should look first.',
  cancelled: '',
  refused: "Mochi can't look like that. Try something else.",
  busy: 'Mochi is busy drawing for someone else. Try again in a minute.',
  limit: "You've hit today's drawing limit. Try again tomorrow.",
  offline: "Can't reach the drawing service (VPN or network?).",
  error: 'Something went wrong while drawing. Try again.',
};

export const EMPTY_LOOKS: LooksState = { available: false, looks: [], currentId: null };

export function currentImage(state: LooksState): string | null {
  return state.looks.find((l) => l.id === state.currentId)?.image ?? null;
}

/** The saved looks and the current one, loaded at start; `onOpen` fires for the Dock menu item. */
export function useLooks(onOpen: () => void) {
  const [state, setState] = useState<LooksState>(EMPTY_LOOKS);
  useEffect(() => {
    let alive = true;
    void looksState().then((s) => alive && s && setState(s));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => onOpenCustomize(onOpen), [onOpen]);
  /* Store calls resolve { looks, currentId }; availability doesn't change. */
  const apply = useCallback((next: { looks: PetLook[]; currentId: string | null } | null) => {
    if (next) setState((prev) => ({ ...prev, looks: next.looks, currentId: next.currentId }));
  }, []);
  return { state, apply };
}
