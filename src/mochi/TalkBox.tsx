import { useState } from 'react';
import type { FormEvent } from 'react';
import type { AskContext, AskResult } from './shell.ts';
import { saveThread, savedThread } from './talkThread.ts';
import type { TalkLine } from './talkThread.ts';

interface TalkBoxProps {
  /** Task counts Mochi may mention (no names). */
  context: AskContext;
  ask: (text: string, context: AskContext) => Promise<AskResult>;
  onOpenLink: (url: string) => void;
}

const SHOWN_LINES = 6;

/** "Talk to Mochi": a one-line chat with the pet, answered by Metamate 3. */
export function TalkBox({ context, ask, onOpenLink }: TalkBoxProps) {
  const [thread, setThread] = useState<TalkLine[]>(savedThread());
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Exclude<AskResult, { kind: 'answer' }> | null>(null);

  function append(line: TalkLine) {
    setThread((t) => saveThread([...t, line]));
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    append({ from: 'me', text });
    setDraft('');
    setProblem(null);
    setBusy(true);
    const result = await ask(text, context);
    setBusy(false);
    if (result.kind === 'answer') append({ from: 'mochi', text: result.text });
    else setProblem(result);
  }

  return (
    <div className="talk-box">
      {(thread.length > 0 || busy) && (
        <ul className="talk-thread" aria-live="polite" aria-label="Chat with Mochi">
          {thread.slice(-SHOWN_LINES).map((line, i) => (
            <li key={thread.length - SHOWN_LINES + i} className={`talk-line from-${line.from}`}>
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
              <button type="button" className="talk-link" onClick={() => onOpenLink(problem.fix)}>
                Give permission
              </button>
              , then send again.
            </>
          )}
        </p>
      )}
      <form className="talk-form" onSubmit={send}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Say something to Mochi…"
          aria-label="Message to Mochi"
          maxLength={2000}
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
