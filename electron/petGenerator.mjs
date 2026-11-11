/* Drawing a pet (main process).
 *
 * A generator takes the person's description and returns candidate PNGs:
 *   generate({ prompt, n, signal }) → { ok: true, images: Buffer[] } | { ok: false, error: { kind } }
 * Error kinds the UI words: refused (content policy), busy (rate limit), limit
 * (daily cap), offline, error. B1 ships only the fake generator (fixture images,
 * for building the UI and for tests); B2 adds the real model behind a proxy
 * with the same interface. The description is never logged.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PROMPT_MAX = 200;
export const CANDIDATES = 3;
export const GENERATE_ERRORS = ['refused', 'busy', 'limit', 'offline', 'error'];

/** The person's text, trimmed and capped; null when empty. */
export function cleanPrompt(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, PROMPT_MAX);
  return t || null;
}

/** What the model is asked for: their text wrapped so results come out as sprites. */
export function petPrompt(text) {
  return (
    `A small cute desktop pet character: ${text}. Full body, centered, facing the viewer, ` +
    'flat cartoon style, bold outline, plain solid white background, no text, no shadow, no scenery.'
  );
}

/**
 * Fixture images instead of a model. `delayMs` mimics model latency; a prompt
 * containing "#refused", "#busy", "#limit", "#offline" or "#error" fails with
 * that kind, so every error state can be tried by hand.
 */
export function createFakeGenerator({ dir, delayMs = 1500, fsImpl = fs } = {}) {
  const files = () =>
    fsImpl
      .readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .sort()
      .map((f) => path.join(dir, f));
  return {
    kind: 'fake',
    async generate({ prompt, n = CANDIDATES, signal } = {}) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, delayMs);
        signal?.addEventListener('abort', () => (clearTimeout(t), resolve()));
      });
      if (signal?.aborted) return { ok: false, error: { kind: 'cancelled' } };
      const forced = GENERATE_ERRORS.find((k) => String(prompt).includes(`#${k}`));
      if (forced) return { ok: false, error: { kind: forced } };
      const all = files();
      if (all.length === 0) return { ok: false, error: { kind: 'error' } };
      return { ok: true, images: Array.from({ length: n }, (_, i) => fsImpl.readFileSync(all[i % all.length])) };
    },
  };
}
