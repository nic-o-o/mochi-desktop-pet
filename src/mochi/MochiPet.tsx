import type { PetState } from './logic.ts';

interface MochiPetProps {
  state: PetState;
  /** 0..1 fill for the green (reviews) ring — already capped by the caller. */
  reviewFrac: number;
  /** 0..1 fill for the orange (submissions) ring — already capped by the caller. */
  subFrac: number;
}

const CX = 74;
const CY = 70;
/* Single split ring: green fills the upper half, orange the lower half.
   Arc ends stop short of the 3/9 o'clock joints so the round caps meet
   with a small gap instead of overlapping. */
const RING_R = 63;
const GAP_DEG = 6;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const ringPt = (deg: number) =>
  `${(CX + RING_R * Math.cos(toRad(deg))).toFixed(2)} ${(CY - RING_R * Math.sin(toRad(deg))).toFixed(2)}`;
const TOP_HALF = `M ${ringPt(180 - GAP_DEG)} A ${RING_R} ${RING_R} 0 0 1 ${ringPt(GAP_DEG)}`;
const BOTTOM_HALF = `M ${ringPt(180 + GAP_DEG)} A ${RING_R} ${RING_R} 0 0 0 ${ringPt(360 - GAP_DEG)}`;

/**
 * Placeholder "Mochi" illustration (SVG/CSS approximation — no design assets
 * were provided, so silhouette and expressions are original stand-ins).
 * Upper green half-ring = reviews completed / review goal.
 * Lower orange half-ring = submissions completed / submission goal.
 */
export function MochiPet({ state, reviewFrac, subFrac }: MochiPetProps) {
  const rev = Math.min(1, Math.max(0, reviewFrac));
  const sub = Math.min(1, Math.max(0, subFrac));
  return (
    <svg
      className={`mochi-svg mochi-${state}`}
      viewBox="0 0 148 148"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      {/* progress rings: one circle split in halves — green up, orange down.
          pathLength=100 makes each dash length a percent of its own half. */}
      <path d={TOP_HALF} className="ring-track" strokeWidth={7} fill="none" />
      {rev > 0 && (
        <path
          d={TOP_HALF}
          className="ring-progress ring-green"
          strokeWidth={7}
          fill="none"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${rev * 100} 100`}
        />
      )}
      <path d={BOTTOM_HALF} className="ring-track" strokeWidth={7} fill="none" />
      {sub > 0 && (
        <path
          d={BOTTOM_HALF}
          className="ring-progress ring-orange"
          strokeWidth={7}
          fill="none"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${sub * 100} 100`}
        />
      )}

      {/* body */}
      <g className="mochi-body">
        {/* tail */}
        <path
          d="M38 92 Q22 94 24 78 Q25 68 34 70"
          fill="none"
          stroke="#f3c98b"
          strokeWidth={9}
          strokeLinecap="round"
        />
        {/* ears */}
        <path d="M50 44 L44 22 L64 34 Z" fill="#fdf1de" stroke="#e8b96f" strokeWidth={2.5} strokeLinejoin="round" />
        <path d="M98 44 L104 22 L84 34 Z" fill="#fdf1de" stroke="#e8b96f" strokeWidth={2.5} strokeLinejoin="round" />
        <path d="M51 38 L48 28 L58 33 Z" fill="#f6c9d4" />
        <path d="M97 38 L100 28 L90 33 Z" fill="#f6c9d4" />
        {/* body blob */}
        <ellipse cx={CX} cy={CY + 4} rx={37} ry={35} fill="#fff8ee" stroke="#e8b96f" strokeWidth={2.5} />
        {/* feet */}
        <ellipse cx={58} cy={102} rx={10} ry={6} fill="#fbeed7" stroke="#e8b96f" strokeWidth={2} />
        <ellipse cx={90} cy={102} rx={10} ry={6} fill="#fbeed7" stroke="#e8b96f" strokeWidth={2} />
        {/* blush */}
        <ellipse cx={52} cy={76} rx={6} ry={4} fill="#f6c9d4" opacity={0.8} />
        <ellipse cx={96} cy={76} rx={6} ry={4} fill="#f6c9d4" opacity={0.8} />

        {state === 'chilling' && (
          <g stroke="#4a3f35" strokeWidth={2.5} strokeLinecap="round" fill="none">
            <path d="M58 66 Q62 70 66 66" />
            <path d="M82 66 Q86 70 90 66" />
            <path d="M68 78 Q74 83 80 78" />
          </g>
        )}

        {state === 'happy' && (
          <g>
            <circle cx={62} cy={66} r={6} fill="#4a3f35" />
            <circle cx={86} cy={66} r={6} fill="#4a3f35" />
            <circle cx={64} cy={64} r={2} fill="#fff" />
            <circle cx={88} cy={64} r={2} fill="#fff" />
            <path d="M66 78 Q74 88 82 78 Q74 82 66 78 Z" fill="#8a4b3c" />
            <path d="M70 81 Q74 85 78 81 Q74 83 70 81 Z" fill="#e98d8d" />
          </g>
        )}

        {state === 'sleepy' && (
          <g>
            <g stroke="#4a3f35" strokeWidth={2.5} strokeLinecap="round">
              <line x1={57} y1={67} x2={67} y2={67} />
              <line x1={81} y1={67} x2={91} y2={67} />
            </g>
            <ellipse cx={74} cy={80} rx={3.5} ry={4.5} fill="none" stroke="#4a3f35" strokeWidth={2.5} />
            <text x={100} y={40} fontSize={16} fill="#8a7f72" fontWeight="bold">z</text>
            <text x={110} y={28} fontSize={21} fill="#8a7f72" fontWeight="bold">z</text>
          </g>
        )}

        {state === 'nervous' && (
          <g>
            <ellipse cx={62} cy={66} rx={7} ry={8} fill="#fff" stroke="#4a3f35" strokeWidth={2} />
            <ellipse cx={86} cy={66} rx={7} ry={8} fill="#fff" stroke="#4a3f35" strokeWidth={2} />
            <circle cx={63} cy={68} r={2.5} fill="#4a3f35" />
            <circle cx={85} cy={68} r={2.5} fill="#4a3f35" />
            <path d="M67 80 Q70 77 73 80 Q76 83 79 80" fill="none" stroke="#4a3f35" strokeWidth={2.5} strokeLinecap="round" />
            <path d="M106 52 Q110 60 105 64 Q100 60 106 52 Z" fill="#bfe3f5" stroke="#7fb8d9" strokeWidth={1.5} />
          </g>
        )}

        {state === 'focused' && (
          <g>
            <g stroke="#4a3f35" strokeWidth={3} strokeLinecap="round">
              <line x1={54} y1={56} x2={68} y2={60} />
              <line x1={94} y1={56} x2={80} y2={60} />
            </g>
            <circle cx={62} cy={68} r={4.5} fill="#4a3f35" />
            <circle cx={86} cy={68} r={4.5} fill="#4a3f35" />
            <line x1={68} y1={80} x2={80} y2={80} stroke="#4a3f35" strokeWidth={2.5} strokeLinecap="round" />
          </g>
        )}
      </g>
    </svg>
  );
}
