import { useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { isTauri } from '../tauri';
import type { PetState, XY } from '../types';

export const PET_W = 168;
export const PET_H = 208;
const DRAG_THRESHOLD_PX = 6;

interface MochiPetProps {
  position: XY;
  petState: PetState;
  reviewFraction: number;
  submissionFraction: number;
  reviewCaption: string;
  submissionCaption: string;
  onPositionChange: (pos: XY) => void;
  onTap: () => void;
  onActiveChange: (active: boolean) => void;
  onInteract: () => void;
  onHide: () => void;
}

function clampPosition(x: number, y: number): XY {
  // In the Tauri overlay the webview is only as big as the visible UI,
  // so clamp against the full screen instead of the window.
  const maxX =
    (isTauri() && window.screen?.width
      ? window.screen.width
      : window.innerWidth) - PET_W;
  const maxY =
    (isTauri() && window.screen?.height
      ? window.screen.height
      : window.innerHeight) - PET_H;
  return {
    x: Math.min(Math.max(0, x), Math.max(0, maxX)),
    y: Math.min(Math.max(0, y), Math.max(0, maxY)),
  };
}

const RING_R = 72;
const REVIEW_RING = '#80b588';
const REVIEW_TRACK = 'rgba(128, 181, 136, 0.28)';
const SUBMISSION_RING = '#b2a898';
const SUBMISSION_TRACK = 'rgba(178, 168, 152, 0.32)';

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Single ring split half-and-half: reviews fill the top-left half,
 * submissions fill the bottom-right half. Each half shows its own
 * progress fraction over a soft track of the same hue.
 *
 * The SVG circle path starts at 3 o'clock and runs clockwise, so the
 * group is rotated 120°: local path units 0–50 land on clock positions
 * ~7–8 o'clock → 12 → ~1–2 o'clock (top-left half), and units 50–100
 * land on the bottom-right half. pathLength={100} keeps the dash
 * math in percent.
 */
function SplitRing({
  reviewFraction,
  submissionFraction,
}: {
  reviewFraction: number;
  submissionFraction: number;
}) {
  const reviewFill = clamp01(reviewFraction) * 50;
  const submissionFill = clamp01(submissionFraction) * 50;
  return (
    <g transform="rotate(120 84 84)">
      <circle
        cx={84}
        cy={84}
        r={RING_R}
        fill="none"
        stroke={REVIEW_TRACK}
        strokeWidth={7}
        pathLength={100}
        strokeDasharray="50 100"
        strokeDashoffset={0}
      />
      <circle
        cx={84}
        cy={84}
        r={RING_R}
        fill="none"
        stroke={SUBMISSION_TRACK}
        strokeWidth={7}
        pathLength={100}
        strokeDasharray="50 100"
        strokeDashoffset={-50}
      />
      {reviewFill > 0 && (
        <circle
          cx={84}
          cy={84}
          r={RING_R}
          fill="none"
          stroke={REVIEW_RING}
          strokeWidth={7}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${reviewFill} 100`}
          strokeDashoffset={0}
          className="mochi-ring-fill"
        />
      )}
      {submissionFill > 0 && (
        <circle
          cx={84}
          cy={84}
          r={RING_R}
          fill="none"
          stroke={SUBMISSION_RING}
          strokeWidth={7}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${submissionFill} 100`}
          strokeDashoffset={-50}
          className="mochi-ring-fill"
        />
      )}
    </g>
  );
}

function Face({ state }: { state: PetState }) {
  const ink = '#5b4a3f';
  switch (state) {
    case 'happy':
      return (
        <g stroke={ink} strokeWidth={3.5} strokeLinecap="round" fill="none">
          <path d="M40 66 q6 -9 12 0" />
          <path d="M68 66 q6 -9 12 0" />
          <ellipse cx={60} cy={82} rx={8} ry={6.5} fill="#8a4b3c" stroke="none" />
          <ellipse cx={36} cy={76} rx={6} ry={4} fill="#f5b8c1" stroke="none" />
          <ellipse cx={84} cy={76} rx={6} ry={4} fill="#f5b8c1" stroke="none" />
        </g>
      );
    case 'sleepy':
      return (
        <g stroke={ink} strokeWidth={3.5} strokeLinecap="round" fill="none">
          <path d="M40 68 h11" />
          <path d="M69 68 h11" />
          <path d="M55 84 q5 4 10 0" />
        </g>
      );
    case 'nervous':
      return (
        <g>
          <circle cx={46} cy={68} r={8} fill="#fff" stroke={ink} strokeWidth={3} />
          <circle cx={74} cy={68} r={8} fill="#fff" stroke={ink} strokeWidth={3} />
          <circle cx={47.5} cy={69.5} r={2.6} fill={ink} />
          <circle cx={75.5} cy={69.5} r={2.6} fill={ink} />
          <path
            d="M50 86 q5 -5 10 0 q5 5 10 0"
            stroke={ink}
            strokeWidth={3}
            fill="none"
            strokeLinecap="round"
          />
          <path
            d="M96 52 q7 10 0 16 q-7 -6 0 -16"
            fill="#9ed3f2"
            stroke="#5b97c4"
            strokeWidth={2}
          />
        </g>
      );
    case 'focused':
      return (
        <g>
          <path
            d="M34 56 l14 5"
            stroke={ink}
            strokeWidth={4}
            strokeLinecap="round"
          />
          <path
            d="M86 56 l-14 5"
            stroke={ink}
            strokeWidth={4}
            strokeLinecap="round"
          />
          <circle cx={47} cy={70} r={3.4} fill={ink} />
          <circle cx={73} cy={70} r={3.4} fill={ink} />
          <path
            d="M52 86 h16"
            stroke={ink}
            strokeWidth={3.5}
            strokeLinecap="round"
          />
          <rect x={28} y={30} width={64} height={10} rx={5} fill="#7c6cf0" />
          <rect x={82} y={32} width={14} height={6} rx={3} fill="#5a4bd0" />
        </g>
      );
    case 'chilling':
    default:
      return (
        <g stroke={ink} strokeWidth={3.5} strokeLinecap="round" fill="none">
          <path d="M41 68 q5 5 10 0" />
          <path d="M69 68 q5 5 10 0" />
          <path d="M54 80 q6 6 12 0" />
          <ellipse cx={36} cy={76} rx={5} ry={3.4} fill="#f5c9cf" stroke="none" />
          <ellipse cx={84} cy={76} rx={5} ry={3.4} fill="#f5c9cf" stroke="none" />
        </g>
      );
  }
}

export default function MochiPet(props: MochiPetProps) {
  const {
    position,
    petState,
    reviewFraction,
    submissionFraction,
    reviewCaption,
    submissionCaption,
    onPositionChange,
    onTap,
    onActiveChange,
    onInteract,
    onHide,
  } = props;

  const [hovering, setHovering] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  const setActive = (hover: boolean, drag: boolean) => {
    setHovering(hover);
    setDragging(drag);
    onActiveChange(hover || drag);
  };

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    onInteract();
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: position.x,
      originY: position.y,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setActive(true, true);
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      drag.moved = true;
    }
    if (drag.moved) {
      onInteract();
      onPositionChange(
        clampPosition(drag.originX + dx, drag.originY + dy),
      );
    }
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    const wasDrag = drag.moved;
    setActive(hovering, false);
    if (!wasDrag) {
      onTap();
    } else {
      onInteract();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onInteract();
      onTap();
    }
  };

  const style: CSSProperties = {
    left: position.x,
    top: position.y,
    width: PET_W,
  };

  return (
    <div
      className={`mochi mochi--${petState}`}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={`Mochi, feeling ${petState}. Activate to open the task panel.`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={() => {
        onInteract();
        setActive(true, dragging);
      }}
      onPointerLeave={() => setActive(false, false)}
      onKeyDown={handleKeyDown}
      data-testid="mochi-pet"
      data-state={petState}
    >
      <button
        type="button"
        className="mochi-hide"
        aria-label="Hide Mochi"
        title="Hide Mochi"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onInteract();
          onHide();
        }}
      >
        −
      </button>

      <div className="mochi-rings">
        <svg viewBox="0 0 168 168" aria-hidden="true">
          <SplitRing
            reviewFraction={reviewFraction}
            submissionFraction={submissionFraction}
          />
        </svg>
        <div className="mochi-body">
          <svg viewBox="0 0 120 116" aria-hidden="true">
            <ellipse cx={30} cy={34} rx={11} ry={13} fill="#fff1dc" stroke="#e3cfae" strokeWidth={3} />
            <ellipse cx={90} cy={34} rx={11} ry={13} fill="#fff1dc" stroke="#e3cfae" strokeWidth={3} />
            <ellipse cx={60} cy={66} rx={46} ry={40} fill="#fff7ea" stroke="#e3cfae" strokeWidth={3} />
            <Face state={petState} />
          </svg>
          {petState === 'sleepy' && (
            <span className="mochi-zzz" aria-hidden="true">
              z z z
            </span>
          )}
          {petState === 'nervous' && (
            <span className="mochi-alert-dot" aria-hidden="true">
              !
            </span>
          )}
        </div>
      </div>

      <div className="mochi-caption" aria-label={`Reviews ${reviewCaption}, submissions ${submissionCaption}`}>
        <span className="mochi-dot mochi-dot--review" aria-hidden="true" />
        {reviewCaption}
        <span className="mochi-caption-sep" aria-hidden="true">·</span>
        <span className="mochi-dot mochi-dot--submission" aria-hidden="true" />
        {submissionCaption}
      </div>
    </div>
  );
}
