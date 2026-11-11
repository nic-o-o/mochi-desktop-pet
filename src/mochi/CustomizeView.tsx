import { useEffect, useState } from 'react';
import type { PetState, XY } from './logic.ts';
import { GENERATE_ERROR_TEXT, PROMPT_EXAMPLES, PROMPT_MAX } from './looks.ts';
import type { LooksState, PetCandidate, PetLook } from './looks.ts';
import { MochiPet } from './MochiPet.tsx';
import { cancelPetGenerate, deleteLook, generatePet, keepLook, setCurrentLook } from './shell.ts';
import { logClick, logVpv } from './usage.ts';

/* The preview walks through every mood so the person sees the pet bob, bounce and tremble. */
const PREVIEW_MOODS: PetState[] = ['chilling', 'happy', 'sleepy', 'nervous', 'focused'];
const MOOD_MS = 1400;

type Phase = 'describe' | 'drawing' | 'picking';

interface CustomizeViewProps {
  anchor?: XY | null;
  looks: LooksState;
  reviewFrac: number;
  subFrac: number;
  /** A store call returned new looks / current look. */
  onLooksChange: (next: { looks: PetLook[]; currentId: string | null } | null) => void;
  /** Drawing started or stopped: the pet looks Focused while Mochi draws. */
  onDrawingChange: (drawing: boolean) => void;
  onClose: () => void;
}

/**
 * Customize Mochi: describe a look, Mochi draws three, pick one, preview it in
 * the real ring through every mood, keep it. My Mochis switches between saved
 * looks; Classic Mochi is always one click away.
 */
export function CustomizeView(props: CustomizeViewProps) {
  const { looks, onDrawingChange } = props;
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('describe');
  const [candidates, setCandidates] = useState<PetCandidate[]>([]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [moodAt, setMoodAt] = useState(0);
  const picked = candidates.find((c) => c.id === pickedId) ?? null;

  useEffect(() => {
    logVpv('customize', 'view', { enabled: looks.available });
  }, [looks.available]);

  useEffect(() => {
    onDrawingChange(phase === 'drawing');
  }, [phase, onDrawingChange]);
  useEffect(() => () => onDrawingChange(false), [onDrawingChange]);

  useEffect(() => {
    if (!picked) return;
    const id = window.setInterval(() => setMoodAt((m) => (m + 1) % PREVIEW_MOODS.length), MOOD_MS);
    return () => window.clearInterval(id);
  }, [picked]);

  async function draw() {
    setError('');
    setPhase('drawing');
    logClick('customize', 'generate');
    const r = await generatePet(text);
    if (r.ok) {
      setCandidates(r.candidates);
      setPickedId(r.candidates[0]?.id ?? null);
      setMoodAt(0);
      setPhase('picking');
      return;
    }
    setPhase(candidates.length ? 'picking' : 'describe');
    setError(GENERATE_ERROR_TEXT[r.error.kind] ?? GENERATE_ERROR_TEXT.error);
  }

  function cancel() {
    logClick('customize', 'cancel');
    cancelPetGenerate();
  }

  async function keep() {
    if (!picked) return;
    logClick('customize', 'keep', { result: picked.framed ? 'framed' : 'cutout' });
    const next = await keepLook(picked.id);
    if (!next) {
      setError(GENERATE_ERROR_TEXT.error);
      return;
    }
    props.onLooksChange(next);
    setCandidates([]);
    setPickedId(null);
    setText('');
    setPhase('describe');
  }

  async function switchTo(id: string | null) {
    logClick('customize', id ? 'switch' : 'reset');
    props.onLooksChange(await setCurrentLook(id));
  }

  async function remove(look: PetLook) {
    logClick('customize', 'delete');
    props.onLooksChange(await deleteLook(look.id));
  }

  return (
    <div className="mochi-scrim" onClick={props.onClose}>
      <section
        className="float-panel expanded-view customize-view"
        style={props.anchor ? { left: props.anchor.x, top: props.anchor.y } : undefined}
        role="dialog"
        aria-label="Customize Mochi"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="panel-header panel-header-sticky">
          <h2>Customize Mochi</h2>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close Customize Mochi">
            ×
          </button>
        </header>

        <div className="expanded-body">
          <label className="customize-describe">
            <span className="customize-label">Describe your Mochi</span>
            <textarea
              value={text}
              maxLength={PROMPT_MAX}
              rows={2}
              placeholder="a sleepy orange cat with a scarf"
              onChange={(e) => setText(e.target.value)}
              disabled={phase === 'drawing'}
            />
            <span className="muted small customize-count">
              {text.length}/{PROMPT_MAX}
            </span>
          </label>
          <div className="customize-examples" aria-label="Examples">
            {PROMPT_EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="customize-chip" onClick={() => setText(ex)} disabled={phase === 'drawing'}>
                {ex}
              </button>
            ))}
          </div>

          <div className="customize-actions">
            {phase === 'drawing' ? (
              <>
                <span className="muted small" role="status">
                  Mochi is drawing…
                </span>
                <button type="button" className="btn-secondary" onClick={cancel}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="btn-primary" onClick={() => void draw()} disabled={!text.trim()}>
                {candidates.length ? 'Draw again' : 'Draw Mochi'}
              </button>
            )}
          </div>
          {error && (
            <p className="customize-error" role="alert">
              {error}
            </p>
          )}

          {candidates.length > 0 && (
            <>
              <h3 className="customize-heading">Pick one</h3>
              <div className="customize-candidates">
                {candidates.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    className={c.id === pickedId ? 'customize-candidate is-picked' : 'customize-candidate'}
                    aria-pressed={c.id === pickedId}
                    aria-label={`Option ${i + 1}`}
                    onClick={() => {
                      logClick('customize', 'candidate', { position: i });
                      setPickedId(c.id);
                      setMoodAt(0);
                    }}
                  >
                    <img src={c.image} alt="" />
                  </button>
                ))}
              </div>
              {picked && (
                <div className="customize-preview">
                  <div className="customize-preview-pet" aria-label={`Preview, ${PREVIEW_MOODS[moodAt]}`}>
                    <MochiPet state={PREVIEW_MOODS[moodAt]} reviewFrac={props.reviewFrac} subFrac={props.subFrac} look={picked.image} />
                  </div>
                  <div>
                    <p className="small">This is how your Mochi moves through its moods.</p>
                    {picked.framed && (
                      <p className="muted small">The background couldn&apos;t be cut out cleanly, so it sits in a circle. Draw again for another try.</p>
                    )}
                    <button type="button" className="btn-primary" onClick={() => void keep()}>
                      Keep this Mochi
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          <h3 className="customize-heading">My Mochis</h3>
          <div className="customize-looks">
            <button
              type="button"
              className={looks.currentId === null ? 'customize-look is-current' : 'customize-look'}
              aria-pressed={looks.currentId === null}
              onClick={() => void switchTo(null)}
              title="Classic Mochi"
            >
              <span className="customize-look-pet">
                <MochiPet state="chilling" reviewFrac={0} subFrac={0} />
              </span>
              <span className="small">Classic</span>
            </button>
            {looks.looks.map((look) => (
              <div key={look.id} className={look.id === looks.currentId ? 'customize-look is-current' : 'customize-look'}>
                <button type="button" className="customize-look-pick" aria-pressed={look.id === looks.currentId} onClick={() => void switchTo(look.id)} title={look.prompt}>
                  <img src={look.image} alt={look.prompt} />
                </button>
                <button type="button" className="customize-look-delete" onClick={() => void remove(look)} aria-label={`Delete ${look.prompt}`} title="Delete">
                  ×
                </button>
              </div>
            ))}
          </div>
          {looks.currentId !== null && (
            <button type="button" className="btn-link" onClick={() => void switchTo(null)}>
              Reset to classic Mochi
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
