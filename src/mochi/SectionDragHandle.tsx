/* The grip at a section header's left edge: hidden by CSS until its section is hovered or focused. */
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

export function SectionDragHandle({
  label,
  dragging,
  onPointerDown,
  onKeyDown,
}: {
  label: string;
  dragging: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={`section-drag-handle${dragging ? ' is-dragging' : ''}`}
      aria-label={`Drag ${label} to reorder`}
      title="Drag to reorder"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      <svg viewBox="0 0 10 16" width={10} height={16} fill="currentColor" aria-hidden="true" focusable="false">
        <circle cx={3} cy={3} r={1.4} />
        <circle cx={7} cy={3} r={1.4} />
        <circle cx={3} cy={8} r={1.4} />
        <circle cx={7} cy={8} r={1.4} />
        <circle cx={3} cy={13} r={1.4} />
        <circle cx={7} cy={13} r={1.4} />
      </svg>
    </button>
  );
}
