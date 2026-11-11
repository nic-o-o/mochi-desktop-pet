// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { NotifyMenu } from './OverviewPanel.tsx';
import { DEFAULT_NOTIFY, NOTIFY_KINDS } from './notifyPrefs.ts';
import type { NotifyPrefs } from './notifyPrefs.ts';

function Harness({
  initialNotify = DEFAULT_NOTIFY,
  initialOpen = true,
  unread,
}: {
  initialNotify?: NotifyPrefs;
  initialOpen?: boolean;
  unread?: number;
}) {
  const [notify, setNotify] = useState<NotifyPrefs>(initialNotify);
  const [open, setOpen] = useState(initialOpen);
  return (
    <NotifyMenu
      notify={notify}
      onNotifyChange={setNotify}
      open={open}
      onOpenChange={setOpen}
      unread={unread}
    />
  );
}

function notifyLabels(): string[] {
  return [...document.querySelectorAll('.section-menu > .section-option')].map((label) => {
    const kind = NOTIFY_KINDS.find(({ label: text }) => label.textContent?.includes(text));
    if (!kind) throw new Error(`label without a known notify kind: ${label.textContent}`);
    return kind.key;
  });
}

function notifyLabelByKey(key: string): Element {
  const label = [...document.querySelectorAll('.section-menu > .section-option')].find((l) =>
    l.textContent?.includes(NOTIFY_KINDS.find((k) => k.key === key)?.label ?? key),
  );
  if (!label) throw new Error(`no notify label for ${key}`);
  return label;
}

function clickCheckbox(labelText: string) {
  const input = screen.getByText(labelText).closest('label')!.querySelector('input')!;
  fireEvent.click(input);
}

afterEach(cleanup);

describe('NotifyMenu', () => {
  it('stays closed until the bell is clicked, then shows only the notify kinds', () => {
    render(<Harness initialOpen={false} />);
    expect(screen.queryByText('Notify me about')).toBeNull();
    expect(screen.queryByText('Validation failed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Notification settings' }));
    expect(screen.getByText('Notify me about')).toBeTruthy();
    expect(screen.getByText('Validation failed')).toBeTruthy();
    expect(screen.queryByText('Show in panel')).toBeNull();
    expect(screen.queryByText('Needs revision')).toBeNull();
  });

  it('shows the unread count on the bell and reflects the open state', () => {
    render(<Harness initialOpen={false} unread={3} />);
    const bell = screen.getByRole('button', { name: 'Notification settings' });
    expect(bell.getAttribute('aria-expanded')).toBe('false');
    expect(bell.textContent).toContain('3');
    fireEvent.click(bell);
    expect(bell.getAttribute('aria-expanded')).toBe('true');
  });

  it('moves unselected kinds to the bottom, greyed, keeping their order', () => {
    render(<Harness initialNotify={{ ...DEFAULT_NOTIFY, validation_passed: false, sev: false }} />);
    expect(notifyLabels()).toEqual([
      'validation_failed',
      'needs_revision',
      'accepted',
      'rejected',
      'review_assigned',
      'review_started',
      'agent_review',
      'validation_passed',
      'sev',
    ]);
    expect(notifyLabelByKey('validation_passed').className).toContain('is-off');
    expect(notifyLabelByKey('sev').className).toContain('is-off');
    expect(notifyLabelByKey('validation_failed').className).not.toContain('is-off');
  });

  it('moves a kind down when unchecked and back up when checked again', () => {
    render(<Harness />);
    clickCheckbox('Validation passed');
    expect(notifyLabels().at(-1)).toBe('validation_passed');
    expect(notifyLabelByKey('validation_passed').className).toContain('is-off');
    clickCheckbox('Validation passed');
    expect(notifyLabels()[1]).toBe('validation_passed');
    expect(notifyLabelByKey('validation_passed').className).not.toContain('is-off');
  });
});
