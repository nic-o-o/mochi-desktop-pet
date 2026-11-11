import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCustomizer } from './customize.mjs';
import { createLookStore } from './looks.mjs';
import { PROMPT_MAX, cleanPrompt, createFakeGenerator, petPrompt } from './petGenerator.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('sprite')]);
/* Codec stand-in: every image decodes to a white square with a dark centre. */
const codec = {
  decode: () => {
    const w = 20;
    const data = new Uint8ClampedArray(w * w * 4).fill(255);
    for (let y = 6; y < 14; y++) for (let x = 6; x < 14; x++) data.set([30, 30, 30, 255], (y * w + x) * 4);
    return { width: w, height: w, data };
  },
  encode: () => PNG,
  resize: (png) => png,
};
const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'pets');
const make = (generator = createFakeGenerator({ dir: fixtures, delayMs: 0 })) => {
  const logs = [];
  const store = createLookStore(fs.mkdtempSync(path.join(os.tmpdir(), 'looks-')));
  return { logs, store, c: createCustomizer({ store, generator, codec, log: (f) => logs.push(f) }) };
};

describe('prompt', () => {
  it('trims, collapses whitespace, caps the length, and wraps it for a sprite', () => {
    expect(cleanPrompt('  a   sleepy\ncat ')).toBe('a sleepy cat');
    expect(cleanPrompt('   ')).toBeNull();
    expect(cleanPrompt('x'.repeat(300))).toHaveLength(PROMPT_MAX);
    expect(petPrompt('a sleepy cat')).toContain('desktop pet character: a sleepy cat. Full body');
    expect(petPrompt('a sleepy cat')).toContain('plain solid white background');
  });
});

describe('customizer', () => {
  it('draws three candidates, logs the outcome without the prompt, and keeps one as the pet', async () => {
    const { c, logs, store } = make();
    const r = await c.generate('a sleepy orange cat');
    expect(r.ok).toBe(true);
    expect(r.candidates).toHaveLength(3);
    expect(r.candidates[0].image.startsWith('data:image/png;base64,')).toBe(true);
    expect(logs).toEqual([{ result: 'ok', duration_ms: expect.any(Number) }]);
    expect(JSON.stringify(logs)).not.toContain('cat');
    const state = c.keep(r.candidates[1].id);
    expect(state.currentId).toBe(store.current().id);
    expect(store.current().prompt).toBe('a sleepy orange cat');
    expect(c.keep('not-a-candidate')).toBeNull();
  });

  it('maps generator failures to their kind and logs them', async () => {
    const { c, logs } = make();
    expect(await c.generate('a dragon #refused')).toEqual({ ok: false, error: { kind: 'refused' } });
    expect(await c.generate('   ')).toEqual({ ok: false, error: { kind: 'empty' } });
    expect(logs).toEqual([{ result: 'refused', duration_ms: expect.any(Number) }]);
  });

  it('cancels a running generation', async () => {
    const { c } = make(createFakeGenerator({ dir: fixtures, delayMs: 5000 }));
    const pending = c.generate('a cat');
    c.cancel();
    expect(await pending).toEqual({ ok: false, error: { kind: 'cancelled' } });
  });

  it('does nothing without a generator (packaged B1 builds)', async () => {
    const { c } = make(null);
    expect(c.available()).toBe(false);
    expect(c.state()).toEqual({ looks: [], currentId: null });
    expect(await c.generate('a cat')).toEqual({ ok: false, error: { kind: 'error' } });
  });
});
