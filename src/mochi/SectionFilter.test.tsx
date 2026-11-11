// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SectionFilter } from './OverviewPanel.tsx';
import { DEFAULT_NOTIFY, NOTIFY_KINDS } from './notifyPrefs.ts';
import type { NotifyPrefs } from './notifyPrefs.ts';
import { DEFAULT_SECTIONS, DEFAULT_SECTION_ORDER, SECTIONS } from './sections.ts';
import type { SectionOrder, SectionPrefs } from './sections.ts';

function Harness({
  initialOrder = DEFAULT_SECTION_ORDER,
  initialPrefs = DEFAULT_SECTIONS,
  initialNotify = DEFAULT_NOTIFY,
}: {
  initialOrder?: SectionOrder;
  initialPrefs?: SectionPrefs;
  initialNotify?: NotifyPrefs;
}) {
  const [order, setOrder] = useState<SectionOrder>(initialOrder);
  const [prefs, setPrefs] = useState<SectionPrefs>(initialPrefs);
  const [notify, setNotify] = useState<NotifyPrefs>(initialNotify);
  return (
    <>
      <button type="button" onClick={() => setOrder(['reviews', 'submittable', 'revisions', 'drafts'])}>
        Reorder from the main panel
      </button>
      <SectionFilter
        prefs={prefs}
        counts={{ revisions: 1, reviews: 2, drafts: 0, submittable: 3 }}
        onChange={setPrefs}
        order={order}
        notify={notify}
        onNotifyChange={setNotify}
      />
    </>
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose sections' }));
}

function rowLabels(): string[] {
  return [...document.querySelectorAll('.section-option-row')].map((row) => {
    const label = SECTIONS.find(({ label }) => row.textContent?.includes(label));
    if (!label) throw new Error(`row without a known section label: ${row.textContent}`);
    return label.key;
  });
}

function rowByKey(key: string): Element {
  const row = [...document.querySelectorAll('.section-option-row')].find((r) => r.textContent?.includes(SECTIONS.find((s) => s.key === key)?.label ?? key));
  if (!row) throw new Error(`no section row for ${key}`);
  return row;
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

describe('SectionFilter', () => {
  it('lists sections in the current order, with no drag handle or arrow buttons', () => {
    render(<Harness />);
    openMenu();
    expect(rowLabels()).toEqual([...DEFAULT_SECTION_ORDER]);
    expect(screen.queryByRole('button', { name: /Drag .* to reorder/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Move .* (up|down)/ })).toBeNull();
    expect(document.querySelector('.section-drag-handle')).toBeNull();
  });

  it('follows an order changed elsewhere, in the same menu', () => {
    render(<Harness />);
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Reorder from the main panel' }));
    expect(rowLabels()).toEqual(['reviews', 'submittable', 'revisions', 'drafts']);
  });

  it('still toggles a section on and off', () => {
    const onChange = vi.fn();
    render(
      <SectionFilter
        prefs={DEFAULT_SECTIONS}
        counts={{ revisions: 1, reviews: 2, drafts: 0, submittable: 3 }}
        onChange={onChange}
        order={DEFAULT_SECTION_ORDER}
        notify={DEFAULT_NOTIFY}
        onNotifyChange={() => {}}
      />,
    );
    openMenu();
    fireEvent.click(screen.getByText('Drafts').closest('label')!.querySelector('input')!);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SECTIONS, drafts: true });
  });

  it('moves an unselected section to the bottom, greyed, keeping the saved order elsewhere', () => {
    render(<Harness initialOrder={['drafts', 'submittable', 'revisions', 'reviews']} />);
    openMenu();
    expect(rowLabels()).toEqual(['submittable', 'revisions', 'reviews', 'drafts']);
    expect(rowByKey('drafts').className).toContain('is-off');
    expect(rowByKey('submittable').className).not.toContain('is-off');
    expect(rowByKey('revisions').className).not.toContain('is-off');
  });

  it('moves several unselected sections to the bottom in their saved relative order', () => {
    render(
      <Harness
        initialPrefs={{ submittable: true, revisions: false, reviews: false, drafts: true }}
      />,
    );
    openMenu();
    expect(rowLabels()).toEqual(['submittable', 'drafts', 'revisions', 'reviews']);
    expect(rowByKey('revisions').className).toContain('is-off');
    expect(rowByKey('reviews').className).toContain('is-off');
    expect(rowByKey('drafts').className).not.toContain('is-off');
  });

  it('moves a section down when unchecked and back up when checked again', () => {
    render(<Harness initialOrder={['reviews', 'submittable', 'revisions', 'drafts']} />);
    openMenu();
    expect(rowLabels()).toEqual(['reviews', 'submittable', 'revisions', 'drafts']);
    clickCheckbox('Waiting for your review');
    expect(rowLabels()).toEqual(['submittable', 'revisions', 'reviews', 'drafts']);
    expect(rowByKey('reviews').className).toContain('is-off');
    clickCheckbox('Waiting for your review');
    expect(rowLabels()).toEqual(['reviews', 'submittable', 'revisions', 'drafts']);
    expect(rowByKey('reviews').className).not.toContain('is-off');
  });

  it('moves unselected notification kinds to the bottom, greyed, keeping their order', () => {
    render(
      <Harness
        initialNotify={{ ...DEFAULT_NOTIFY, validation_passed: false, sev: false }}
      />,
    );
    openMenu();
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

  it('moves a notification kind down when unchecked and back up when checked again', () => {
    render(<Harness />);
    openMenu();
    clickCheckbox('Validation passed');
    expect(notifyLabels().at(-1)).toBe('validation_passed');
    expect(notifyLabelByKey('validation_passed').className).toContain('is-off');
    clickCheckbox('Validation passed');
    expect(notifyLabels()[1]).toBe('validation_passed');
    expect(notifyLabelByKey('validation_passed').className).not.toContain('is-off');
  });
});
