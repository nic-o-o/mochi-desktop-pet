import { useState } from 'react';
import type { ClipboardEvent, DragEvent, FormEvent } from 'react';
import type { AskContext, AskImage, AskResult } from './shell.ts';
import { saveThread, savedThread } from './talkThread.ts';
import { elapsedMs, logClick, logVpv, mark } from './usage.ts';
import type { TalkLine } from './talkThread.ts';

interface TalkBoxProps {
  /** Task counts Mochi may mention (no names). */
  context: AskContext;
  ask: (text: string, context: AskContext, images?: AskImage[]) => Promise<AskResult>;
  onOpenLink: (url: string) => void;
}

const SHOWN_LINES = 6;
/* What Metamate 3 accepts (agentcloudctl send --image). */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const MAX_IMAGES = 5;

interface Staged {
  image: AskImage;
  preview: string;
}

/** A thumbnail URL, or '' where the browser can't make one (tests). */
function previewOf(file: Blob): string {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '';
}

/** "Talk to Mochi": a one-line chat with the pet, answered by Metamate 3. Drop or paste a screenshot to show it. */
export function TalkBox({ context, ask, onOpenLink }: TalkBoxProps) {
  const [thread, setThread] = useState<TalkLine[]>(savedThread());
  const [draft, setDraft] = useState('');
  const [staged, setStaged] = useState<Staged[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Exclude<AskResult, { kind: 'answer' }> | null>(null);

  function append(line: TalkLine) {
    setThread((t) => saveThread([...t, line]));
  }

  async function addFiles(files: File[]) {
    const pictures = files.filter((f) => f.type.startsWith('image/'));
    if (pictures.length === 0) return;
    const bad = pictures.find((f) => !IMAGE_TYPES.includes(f.type) || f.size > MAX_IMAGE_BYTES);
    if (bad) {
      setProblem({
        kind: 'error',
        message: IMAGE_TYPES.includes(bad.type) ? 'That picture is too big for Mochi (7 MB max).' : 'Mochi can look at PNG, JPEG, GIF or WebP pictures.',
      });
      return;
    }
    const added = await Promise.all(
      pictures.map(async (f) => ({ image: { type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) }, preview: previewOf(f) })),
    );
    setProblem(null);
    setStaged((s) => [...s, ...added].slice(0, MAX_IMAGES));
  }

  function onDragOver(e: DragEvent) {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void addFiles([...(e.dataTransfer?.files ?? [])]);
  }

  function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if ((!text && staged.length === 0) || busy) return;
    const pictures = staged;
    append({ from: 'me', text, images: pictures.map((p) => p.preview).filter(Boolean) });
    setDraft('');
    setStaged([]);
    setProblem(null);
    setBusy(true);
    /* Usage: the kind of message and the outcome only, never the words or the pictures. */
    logClick('talk', 'send', { kind: text && pictures.length ? 'text_and_picture' : pictures.length ? 'picture' : 'text' });
    const started = mark();
    const result = await ask(text, context, pictures.length ? pictures.map((p) => p.image) : undefined);
    logVpv('talk', 'answer', { result: result.kind, duration_ms: elapsedMs(started) });
    setBusy(false);
    if (result.kind === 'answer') append({ from: 'mochi', text: result.text });
    else setProblem(result);
  }

  return (
    <div
      className={`talk-box${dragging ? ' is-dragging' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {(thread.length > 0 || busy) && (
        <ul className="talk-thread" aria-live="polite" aria-label="Chat with Mochi">
          {thread.slice(-SHOWN_LINES).map((line, i) => (
            <li key={thread.length - SHOWN_LINES + i} className={`talk-line from-${line.from}`}>
              {line.images?.map((src) => (
                <img key={src} className="talk-image" src={src} alt="Picture you shared" />
              ))}
              {line.text}
            </li>
          ))}
          {busy && (
            <li className="talk-line from-mochi is-thinking" aria-label="Mochi is thinking">
              …
            </li>
          )}
        </ul>
      )}
      {problem && (
        <p className="talk-problem" role="status">
          {problem.message}
          {problem.kind === 'access_needed' && (
            <>
              {' '}
              <button
                type="button"
                className="talk-link"
                onClick={() => {
                  logClick('talk', 'give_permission');
                  onOpenLink(problem.fix);
                }}
              >
                Give permission
              </button>
              , then send again.
            </>
          )}
        </p>
      )}
      {staged.length > 0 && (
        <ul className="talk-staged" aria-label="Pictures to send">
          {staged.map((p, i) => (
            <li key={i}>
              {p.preview && <img src={p.preview} alt={`Picture ${i + 1}`} />}
              <button
                type="button"
                className="talk-unstage"
                aria-label={`Remove picture ${i + 1}`}
                onClick={() => setStaged((s) => s.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="talk-form" onSubmit={send}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={onPaste}
          placeholder={dragging ? 'Drop to show Mochi…' : 'Say something to Mochi…'}
          aria-label="Message to Mochi"
          maxLength={2000}
        />
        <button type="submit" disabled={busy || (!draft.trim() && staged.length === 0)}>
          Send
        </button>
      </form>
    </div>
  );
}
