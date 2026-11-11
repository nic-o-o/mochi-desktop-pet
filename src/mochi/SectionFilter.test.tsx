// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SectionFilter } from './OverviewPanel.tsx';
import { DEFAULT_NOTIFY } from './notifyPrefs.ts';
import { DEFAULT_SECTIONS, DEFAULT_SECTION_ORDER, SECTIONS } from './sections.ts';
import type { SectionOrder, SectionPrefs } from './sections.ts';

function Harness({ initialOrder = DEFAULT_SECTION_ORDER }: { initialOrder?: SectionOrder }) {
  const [order, setOrder] = useState<SectionOrder>(initialOrder);
  const [prefs, setPrefs] = useState<SectionPrefs>(DEFAULT_SECTIONS);
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
        notify={DEFAULT_NOTIFY}
        onNotifyChange={() => {}}
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
});
