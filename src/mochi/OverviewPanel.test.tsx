// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OverviewPanel } from './OverviewPanel.tsx';
import { DEFAULT_NOTIFY } from './notifyPrefs.ts';
import { DEFAULT_SECTIONS, DEFAULT_SECTION_ORDER } from './sections.ts';
import type { SectionOrder, SectionPrefs } from './sections.ts';
import type { TaskItem } from './logic.ts';

const NOW = 1_790_000_000_000;

function task(id: string, overrides: Partial<TaskItem>): TaskItem {
  return {
    id,
    title: id,
    type: 'review',
    priority: 'normal',
    status: 'pending_review',
    slaDueMs: NOW + 3_600_000,
    description: 'd',
    requester: 'Ann',
    ...overrides,
  };
}

const REVIEW = task('r1', { title: 'Review one', status: 'pending_review' });
const REVISION = task('v1', { title: 'Revision one', priority: 'high', status: 'revision_required' });
const READY = task('s1', { title: 'Ready one', status: 'draft', draftState: 'ready' });

function Harness() {
  const [order, setOrder] = useState<SectionOrder>(DEFAULT_SECTION_ORDER);
  const [prefs, setPrefs] = useState<SectionPrefs>(DEFAULT_SECTIONS);
  return (
    <OverviewPanel
      position={{ x: 0, y: 0 }}
      pending={[REVIEW]}
      revisions={[REVISION]}
      drafts={[]}
      submittable={[READY]}
      sections={prefs}
      onSectionsChange={setPrefs}
      sectionOrder={order}
      onSectionOrderChange={setOrder}
      notify={DEFAULT_NOTIFY}
      onNotifyChange={() => {}}
      reviewsCompleted={0}
      submissionsCompleted={0}
      goals={{ reviewGoal: 5, submissionGoal: 2 }}
      nowMs={NOW}
      onSaveGoals={() => {}}
      onClose={() => {}}
      onOpenTask={() => {}}
    />
  );
}

function headingOrder(): string[] {
  return [...document.querySelectorAll('.glance-section-head h3')].map((h) => h.textContent ?? '');
}

function dragHandle(label: string) {
  return screen.getByRole('button', { name: `Drag ${label} to reorder` });
}

function drag(handle: HTMLElement, fromY: number, toY: number) {
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 8, clientY: fromY, button: 0 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 8, clientY: toY });
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 8, clientY: toY });
}

afterEach(cleanup);

describe('OverviewPanel section drag handles', () => {
  it('shows the sections in the current order, each section starting with a drag handle before its head', () => {
    render(<Harness />);
    expect(headingOrder()).toEqual(['Ready for submission', 'Needs revision', 'Waiting for your review']);
    for (const section of document.querySelectorAll('.glance-section')) {
      expect(section.children[0].className).toContain('section-drag-handle');
      expect(section.querySelector('.glance-section-head h3')).toBeTruthy();
    }
    expect(dragHandle('Waiting for your review')).toBeTruthy();
  });

  it('drags a section up past the section above it', () => {
    render(<Harness />);
    // jsdom has no layout, so section positions fall back to the pointer-down
    // spot spaced one section apart: moving above the middle section's
    // midpoint drops the dragged section one place up.
    drag(dragHandle('Waiting for your review'), 72, 30);
    expect(headingOrder()).toEqual(['Ready for submission', 'Waiting for your review', 'Needs revision']);
  });

  it('drags a section down past the section below it', () => {
    render(<Harness />);
    drag(dragHandle('Ready for submission'), 8, 80);
    expect(headingOrder()).toEqual(['Needs revision', 'Waiting for your review', 'Ready for submission']);
  });

  it('drags a section to the very top', () => {
    render(<Harness />);
    drag(dragHandle('Waiting for your review'), 72, 0);
    expect(headingOrder()).toEqual(['Waiting for your review', 'Ready for submission', 'Needs revision']);
  });

  it('leaves the order alone when the handle is pressed without moving', () => {
    render(<Harness />);
    drag(dragHandle('Waiting for your review'), 72, 72);
    expect(headingOrder()).toEqual(['Ready for submission', 'Needs revision', 'Waiting for your review']);
  });

  it('cancelling a drag restores the starting order', () => {
    render(<Harness />);
    const handle = dragHandle('Waiting for your review');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 8, clientY: 72, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 8, clientY: 30 });
    expect(headingOrder()).toEqual(['Ready for submission', 'Waiting for your review', 'Needs revision']);
    fireEvent.pointerCancel(handle, { pointerId: 1, clientX: 8, clientY: 30 });
    expect(headingOrder()).toEqual(['Ready for submission', 'Needs revision', 'Waiting for your review']);
  });

  it('moves a section one step with the arrow keys on its handle', () => {
    render(<Harness />);
    fireEvent.keyDown(dragHandle('Ready for submission'), { key: 'ArrowDown' });
    expect(headingOrder()).toEqual(['Needs revision', 'Ready for submission', 'Waiting for your review']);
    fireEvent.keyDown(dragHandle('Ready for submission'), { key: 'ArrowUp' });
    expect(headingOrder()).toEqual(['Ready for submission', 'Needs revision', 'Waiting for your review']);
  });

  it('has no drag handle in the filter menu, which lists the dragged order', () => {
    render(<Harness />);
    drag(dragHandle('Waiting for your review'), 72, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Choose sections' }));
    const menu = document.querySelector('.section-menu');
    expect(menu?.querySelector('.section-drag-handle')).toBeNull();
    const rows = [...(menu?.querySelectorAll('.section-option-row') ?? [])].map((row) => row.textContent ?? '');
    expect(rows[0]).toContain('Waiting for your review');
    expect(rows[1]).toContain('Ready for submission');
    expect(rows[2]).toContain('Needs revision');
  });
});
