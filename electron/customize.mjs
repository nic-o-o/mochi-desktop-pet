/* Customize Mochi (main process): generate → sprites → keep → current look.
 *
 * Ties the generator (petGenerator.mjs), the cutout (sprite.mjs) and the look
 * store (looks.mjs) together. The latest candidates stay here; the renderer
 * gets data URLs to show and sends back a candidate id to keep, never image
 * bytes. One generation at a time: a new one cancels the last. Each finished
 * generation logs its outcome and latency (never the description).
 *
 * Keeping a look also draws its moods in the background (when the generator
 * can): the kept picture redrawn happy, sleepy, nervous and focused, each cut
 * out like the candidates. `onChange(state)` fires when they land.
 */
import { randomUUID } from 'node:crypto';
import { CANDIDATES, MOODS, cleanPrompt, petPrompt } from './petGenerator.mjs';
import { pngFromDataUrl } from './looks.mjs';
import { makeSprite } from './sprite.mjs';

const dataUrl = (png) => `data:image/png;base64,${png.toString('base64')}`;

export function createCustomizer({ store, generator, codec, log = () => {}, logMoods = () => {}, onChange = () => {}, now = Date.now }) {
  let running = null;
  /* Latest candidates: id → { png, prompt }. */
  let candidates = new Map();
  /* Looks whose moods are being drawn. */
  const drawingMoods = new Set();

  const fullState = () => ({ ...store.state(), drawingMoods: [...drawingMoods] });

  /** Draw a saved look's moods from its picture; resolves once they're saved (or failed). */
  async function drawMoods(id, token) {
    const look = store.list().find((l) => l.id === id);
    const image = look && pngFromDataUrl(look.image);
    if (!image || !generator?.drawMoods || drawingMoods.has(id)) return;
    drawingMoods.add(id);
    onChange(fullState());
    const started = now();
    let result;
    try {
      result = await generator.drawMoods({ image, token });
    } catch {
      result = { ok: false, error: { kind: 'error' } };
    }
    let saved = 0;
    if (result.ok) {
      for (const [mood, png] of Object.entries(result.moods)) {
        try {
          if (store.saveMood(id, mood, makeSprite(png, codec).png)) saved++;
        } catch {
          /* an image that can't be decoded is dropped */
        }
      }
    }
    drawingMoods.delete(id);
    logMoods({ result: !result.ok ? result.error.kind : saved === MOODS.length ? 'ok' : saved ? 'partial' : 'error', duration_ms: now() - started });
    onChange(fullState());
  }

  return {
    /** Whether this build can draw pets (B1: only with the fake generator, outside packaged builds). */
    available: () => Boolean(generator),
    /** The fake generator: the same practice drawings whatever the description. */
    practice: () => generator?.kind === 'fake',
    /** Drawing goes through the draw server, so the person must sign in (Clerk) first. */
    signIn: () => Boolean(generator?.needsSignIn),

    /** Whether kept looks get mood pictures (the draw server or a real model; not practice drawings). */
    moods: () => Boolean(generator?.drawMoods),

    state: () => (generator ? fullState() : { looks: [], currentId: null }),

    /**
     * Draw candidates for a description. Resolves { ok: true, candidates: [{ id, image, framed }] }
     * or { ok: false, error: { kind } } with kind empty | cancelled | refused | busy | limit | offline | error.
     */
    async generate(text, { token } = {}) {
      const prompt = cleanPrompt(text);
      if (!generator) return { ok: false, error: { kind: 'error' } };
      if (!prompt) return { ok: false, error: { kind: 'empty' } };
      running?.abort();
      const ac = new AbortController();
      running = ac;
      const started = now();
      let result;
      try {
        result = await generator.generate({ prompt: petPrompt(prompt), description: prompt, token, n: CANDIDATES, signal: ac.signal });
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

    /**
     * Save a candidate as a new look and make it the pet, then draw its moods in the
     * background; resolves the state, or null for an unknown id.
     */
    keep(candidateId, { token } = {}) {
      const c = candidates.get(candidateId);
      if (!c || !generator) return null;
      const id = store.save({ prompt: c.prompt, png: c.png });
      if (!id) return null;
      store.setCurrent(id);
      void drawMoods(id, token);
      return fullState();
    },

    /** Draw the moods of a look kept before moods existed (or whose drawing failed). */
    drawMoods(id, { token } = {}) {
      if (!generator) return null;
      void drawMoods(id, token);
      return fullState();
    },

    setCurrent: (id) => (generator ? (store.setCurrent(id), fullState()) : { looks: [], currentId: null }),
    remove: (id) => (generator ? (store.remove(id), fullState()) : { looks: [], currentId: null }),
  };
}
