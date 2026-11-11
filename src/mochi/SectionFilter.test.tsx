// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SectionFilter } from './OverviewPanel.tsx';
import { DEFAULT_SECTIONS, DEFAULT_SECTION_ORDER, SECTIONS } from './sections.ts';
import type { SectionOrder, SectionPrefs } from './sections.ts';

function Harness({
  initialOrder = DEFAULT_SECTION_ORDER,
  initialPrefs = DEFAULT_SECTIONS,
}: {
  initialOrder?: SectionOrder;
  initialPrefs?: SectionPrefs;
}) {
  const [order, setOrder] = useState<SectionOrder>(initialOrder);
  const [prefs, setPrefs] = useState<SectionPrefs>(initialPrefs);
  const [open, setOpen] = useState(false);
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
        open={open}
        onOpenChange={setOpen}
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
        open
        onOpenChange={() => {}}
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

  it('contains no notification kinds: those live behind the bell', () => {
    render(<Harness />);
    openMenu();
    expect(screen.queryByText('Notify me about')).toBeNull();
    expect(screen.queryByText('Validation failed')).toBeNull();
    expect(screen.getByText('Show in panel')).toBeTruthy();
  });
});
