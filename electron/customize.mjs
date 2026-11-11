/* Customize Mochi (main process): generate → sprites → keep → current look.
 *
 * Ties the generator (petGenerator.mjs), the cutout (sprite.mjs) and the look
 * store (looks.mjs) together. The latest candidates stay here; the renderer
 * gets data URLs to show and sends back a candidate id to keep, never image
 * bytes. One generation at a time: a new one cancels the last. Each finished
 * generation logs its outcome and latency (never the description).
 */
import { randomUUID } from 'node:crypto';
import { CANDIDATES, cleanPrompt, petPrompt } from './petGenerator.mjs';
import { makeSprite } from './sprite.mjs';

const dataUrl = (png) => `data:image/png;base64,${png.toString('base64')}`;

export function createCustomizer({ store, generator, codec, log = () => {}, now = Date.now }) {
  let running = null;
  /* Latest candidates: id → { png, prompt }. */
  let candidates = new Map();

  return {
    /** Whether this build can draw pets (B1: only with the fake generator, outside packaged builds). */
    available: () => Boolean(generator),
    /** The fake generator: the same practice drawings whatever the description. */
    practice: () => generator?.kind === 'fake',

    state: () => (generator ? store.state() : { looks: [], currentId: null }),

    /**
     * Draw candidates for a description. Resolves { ok: true, candidates: [{ id, image, framed }] }
     * or { ok: false, error: { kind } } with kind empty | cancelled | refused | busy | limit | offline | error.
     */
    async generate(text) {
      const prompt = cleanPrompt(text);
      if (!generator) return { ok: false, error: { kind: 'error' } };
      if (!prompt) return { ok: false, error: { kind: 'empty' } };
      running?.abort();
      const ac = new AbortController();
      running = ac;
      const started = now();
      let result;
      try {
        result = await generator.generate({ prompt: petPrompt(prompt), n: CANDIDATES, signal: ac.signal });
      } catch {
        result = { ok: false, error: { kind: 'error' } };
      }
      if (running === ac) running = null;
      if (ac.signal.aborted) return { ok: false, error: { kind: 'cancelled' } };
      const sprites = [];
      if (result.ok) {
        for (const png of result.images) {
          try {
            const s = makeSprite(png, codec);
            sprites.push({ id: randomUUID(), png: s.png, framed: s.framed });
          } catch {
            /* an image that can't be decoded is dropped */
          }
        }
      }
      const outcome = !result.ok ? result.error.kind : sprites.length ? 'ok' : 'error';
      log({ result: outcome, duration_ms: now() - started });
      if (outcome !== 'ok') return { ok: false, error: { kind: outcome } };
      candidates = new Map(sprites.map((s) => [s.id, { png: s.png, prompt }]));
      return { ok: true, candidates: sprites.map((s) => ({ id: s.id, image: dataUrl(s.png), framed: s.framed })) };
    },

    cancel() {
      running?.abort();
    },

    /** Save a candidate as a new look and make it the pet; resolves the store state, or null for an unknown id. */
    keep(candidateId) {
      const c = candidates.get(candidateId);
      if (!c || !generator) return null;
      const id = store.save({ prompt: c.prompt, png: c.png });
      return id ? store.setCurrent(id) : null;
    },

    setCurrent: (id) => (generator ? store.setCurrent(id) : { looks: [], currentId: null }),
    remove: (id) => (generator ? store.remove(id) : { looks: [], currentId: null }),
  };
}
