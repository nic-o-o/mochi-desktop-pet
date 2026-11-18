/* Customize Mochi: the renderer's side. Looks live in the main process
 * (electron/looks.mjs) and reach the renderer as data URLs; this file holds the
 * shared types, the wording, and the hook that keeps the current look in sync.
 */
import { useCallback, useEffect, useState } from 'react';
import type { PetState } from './logic.ts';
import { looksState, onLooksChanged, onOpenCustomize } from './shell.ts';

export const PROMPT_MAX = 200;
export const PROMPT_EXAMPLES = ['a sleepy orange cat with a scarf', 'a tiny blue dragon', 'a round panda with headphones', 'a fluffy pink bunny'];

export interface PetLook {
  id: string;
  createdAtMs: number;
  /** The description it was drawn from; stays on this Mac, never logged. */
  prompt: string;
  /** The sprite as a data URL. */
  image: string;
  /** Its picture in each mood, once drawn after keeping it; `image` is chilling and the fallback. */
  moods?: Partial<Record<PetState, string>>;
}

export interface LooksState {
  /** Whether this build can draw pets (B1: only when running from source). */
  available: boolean;
  /** Drawings are fixed practice images (the fake generator), not drawn from the description. */
  practice?: boolean;
  /** Drawing goes through Mochi's draw server, so the person signs in (Clerk) first. */
  signIn?: boolean;
  /** Kept looks get a picture per mood (drawn after keeping). */
  moods?: boolean;
  /** Looks whose moods are being drawn. */
  drawingMoods?: string[];
  looks: PetLook[];
  currentId: string | null;
}

/** What store calls and the main process's mochi:looks updates carry. */
export type LooksStoreState = Pick<LooksState, 'looks' | 'currentId' | 'drawingMoods'>;

/** The moods a kept look gets its own picture for (electron/petGenerator.mjs MOODS). */
export const LOOK_MOODS: PetState[] = ['happy', 'sleepy', 'nervous', 'focused'];

export interface PetCandidate {
  id: string;
  image: string;
  /** The background couldn't be cut out, so the drawing sits in a circle. */
  framed: boolean;
}

export type GenerateErrorKind = 'empty' | 'cancelled' | 'refused' | 'busy' | 'limit' | 'offline' | 'signin' | 'not_member' | 'error';
export type GenerateResult = { ok: true; candidates: PetCandidate[] } | { ok: false; error: { kind: GenerateErrorKind } };

/** What each failure says. Cancelled says nothing: the person asked for it. */
export const GENERATE_ERROR_TEXT: Record<GenerateErrorKind, string> = {
  empty: 'Describe how Mochi should look first.',
  cancelled: '',
  refused: "Mochi can't look like that. Try something else.",
  busy: 'Mochi is busy drawing for someone else. Try again in a minute.',
  limit: "You've hit today's drawing limit. Try again tomorrow.",
  offline: "Can't reach the drawing service (VPN or network?).",
  signin: 'Sign in again to draw.',
  not_member: "You're not on Mochi's tester list yet.",
  error: 'Something went wrong while drawing. Try again.',
};

export const EMPTY_LOOKS: LooksState = { available: false, looks: [], currentId: null };

/** The current look's picture for a mood (its kept picture until that mood is drawn), or null for classic. */
export function lookImage(state: LooksState, mood: PetState): string | null {
  const look = state.looks.find((l) => l.id === state.currentId);
  return look ? (look.moods?.[mood] ?? look.image) : null;
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
  /* Store calls and mood drawings resolve { looks, currentId, drawingMoods }; availability doesn't change. */
  const apply = useCallback((next: LooksStoreState | null) => {
    if (next) setState((prev) => ({ ...prev, looks: next.looks, currentId: next.currentId, drawingMoods: next.drawingMoods ?? prev.drawingMoods }));
  }, []);
  useEffect(() => onLooksChanged(apply), [apply]);
  return { state, apply };
}
