import type { PetState } from '../types';

/** Seconds without interaction before Mochi gets sleepy. */
export const IDLE_THRESHOLD_SECONDS = 10;

export interface PetStateFlags {
  panelOpen: boolean;
  bubbleVisible: boolean;
  hoverOrDrag: boolean;
  idleSeconds: number;
}

/**
 * Deterministic state resolution.
 * Priority: focused > nervous > happy > sleepy > chilling.
 */
export function resolvePetState(flags: PetStateFlags): PetState {
  if (flags.panelOpen) return 'focused';
  if (flags.bubbleVisible) return 'nervous';
  if (flags.hoverOrDrag) return 'happy';
  if (flags.idleSeconds >= IDLE_THRESHOLD_SECONDS) return 'sleepy';
  return 'chilling';
}
