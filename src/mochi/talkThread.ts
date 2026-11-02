/* The chat with Mochi, kept outside the panel: the panel unmounts when it closes. */
export interface TalkLine {
  from: 'me' | 'mochi';
  text: string;
}

let thread: TalkLine[] = [];

export function savedThread(): TalkLine[] {
  return thread;
}

export function saveThread(next: TalkLine[]): TalkLine[] {
  thread = next;
  return next;
}

/** Tests: forget the chat. */
export function resetTalkThread(): void {
  thread = [];
}
