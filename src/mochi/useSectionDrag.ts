/* Drag-to-reorder for the glance-panel sections: a grip handle at the left of
 * each shown section's header. The order previews live as the pointer crosses
 * section midpoints; dropping keeps the preview, cancelling (or Escape)
 * restores the starting order. Sections not shown keep their places. */
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { reorderInVisibleOrder } from './sections.ts';
import type { SectionKey, SectionOrder } from './sections.ts';
import { SECTION_EVENT_NAME, logClick } from './usage.ts';

/** A drag in progress: the full order and shown list at the start, the section
 * midpoints measured then, and the shown index the dragged section previews at. */
interface DragSession {
  key: SectionKey;
  from: number;
  fromShown: number;
  order: SectionOrder;
  shown: SectionKey[];
  midpoints: number[];
  target: number;
  preview: SectionOrder;
}

/** Section spacing when nothing is laid out yet (jsdom), so a drag still steps one section at a time. */
const DRAG_SECTION_FALLBACK_PX = 32;

export function useSectionDrag({
  listRef,
  order,
  shown,
  onOrderChange,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  order: SectionOrder;
  shown: SectionKey[];
  onOrderChange: (next: SectionOrder) => void;
}) {
  const dragRef = useRef<DragSession | null>(null);
  const [draggingKey, setDraggingKey] = useState<SectionKey | null>(null);
  const onOrderChangeRef = useRef(onOrderChange);
  useEffect(() => {
    onOrderChangeRef.current = onOrderChange;
  });

  useEffect(() => {
    if (!draggingKey) return;
    const finish = (cancelled: boolean) => {
      const session = dragRef.current;
      dragRef.current = null;
      setDraggingKey(null);
      if (!session) return;
      if (cancelled) {
        if (session.preview !== session.order) onOrderChangeRef.current(session.order);
      } else {
        const to = session.preview.indexOf(session.key);
        if (to !== session.from) {
          logClick('glance_panel', 'section_order', {
            section: SECTION_EVENT_NAME[session.key],
            action: 'drag',
            from: session.from,
            to,
          });
        }
      }
    };
    const onMove = (e: PointerEvent) => {
      const session = dragRef.current;
      if (!session) return;
      const target = session.midpoints.filter((mid, i) => i !== session.fromShown && mid < e.clientY).length;
      if (target === session.target) return;
      session.target = target;
      const next = reorderInVisibleOrder(session.order, session.key, session.shown, target);
      if (next !== session.preview) {
        session.preview = next;
        onOrderChangeRef.current(next);
      }
    };
    const onUp = () => finish(false);
    const onCancel = () => finish(true);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(true);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [draggingKey]);

  function startDrag(e: ReactPointerEvent<HTMLButtonElement>, key: SectionKey, shownIndex: number) {
    if (e.button !== 0 || dragRef.current) return;
    const rects = [...(listRef.current?.querySelectorAll('.glance-section') ?? [])].map((el) => el.getBoundingClientRect());
    const height = rects[0]?.height ?? 0;
    const midpoints =
      rects.length === shown.length && height > 0
        ? rects.map((rect) => rect.top + rect.height / 2)
        : shown.map((_, i) => e.clientY + (i - shownIndex) * DRAG_SECTION_FALLBACK_PX);
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable — the window listeners still track the drag */
    }
    dragRef.current = {
      key,
      from: order.indexOf(key),
      fromShown: shownIndex,
      order,
      shown,
      midpoints,
      target: shownIndex,
      preview: order,
    };
    setDraggingKey(key);
  }

  /* Keyboard equivalent of the drag: arrow keys on the handle move one shown step. */
  function moveWithKeys(e: ReactKeyboardEvent<HTMLButtonElement>, key: SectionKey, shownIndex: number) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const delta: -1 | 1 = e.key === 'ArrowUp' ? -1 : 1;
    logClick('glance_panel', 'section_order', { section: SECTION_EVENT_NAME[key], action: delta < 0 ? 'up' : 'down' });
    onOrderChange(reorderInVisibleOrder(order, key, shown, shownIndex + delta));
  }

  return { draggingKey, startDrag, moveWithKeys };
}
