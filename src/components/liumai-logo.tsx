/** 六脉 (Liumai) brand mark — a hexagonal network core with six radial meridians.
 *
 * Flat, monochrome and stroke-only: six equal short strokes radiate from a
 * hexagon core (pulse + network node). Colour comes from `currentColor`, so the
 * mark is brand blue on light surfaces and ice-blue on dark ones, and callers
 * may override the tone with any `text-*` utility.
 *
 * Motion is opt-out (`animated`, default on) and deliberately restrained: a
 * 2.4s pulse travels around the six meridians while the core breathes on its
 * own 3s clock. Timing and amplitudes live in the `.lm-mark` rules in
 * globals.css — this component only passes the phased-animation inputs.
 * `prefers-reduced-motion: reduce` stops the loops and leaves the static mark.
 * Marks under 32px skip the sweep (only the core breathes) so 26–28px chrome
 * icons do not shimmer.
 */

import type { CSSProperties, FC } from "react";

interface Props {
  size?: number;
  className?: string;
  /** Accessible label; defaults to the short brand name. */
  label?: string;
  /** Animate the mark. Default: true; reduced-motion users see the static art. */
  animated?: boolean;
}

/** Uniform stroke weight for the core and all six meridians. */
const STROKE = 3.1;

/** Pointy-top hexagon, radius 7, centred in a 48×48 box. */
const CORE = "24,17 30.06,20.5 30.06,27.5 24,31 17.94,27.5 17.94,20.5";

/** Six short meridians pointing at the hexagon vertices (x1, y1, x2, y2). */
const MERIDIANS: Array<[number, number, number, number]> = [
  [24, 13.1, 24, 7.4],
  [33.44, 18.55, 38.38, 15.7],
  [33.44, 29.45, 38.38, 32.3],
  [24, 34.9, 24, 40.6],
  [14.56, 29.45, 9.62, 32.3],
  [14.56, 18.55, 9.62, 15.7],
];

/** Unit vector pointing outward along each meridian. The CSS keyframes own the
 *  amplitude (`--lm-shift`), so the direction stays derived from the geometry. */
const MERIDIAN_DIRECTIONS = MERIDIANS.map(([x1, y1, x2, y2]) => {
  const length = Math.hypot(x2 - x1, y2 - y1);
  return [(x2 - x1) / length, (y2 - y1) / length] as const;
});

const DEFAULT_TONE = "lm-brand-mark";

export const LiumaiLogo: FC<Props> = ({ size = 32, className, label = "六脉", animated = true }) => {
  // Keep the auto-adapting brand tone unless the caller already picked one.
  const hasCustomTone = /(^|\s)text-/.test(className ?? "");

  // Small marks (< 32px) only breathe; the sweep would alias at that scale.
  const motionClass = animated
    ? `lm-mark--motion${size < 32 ? " lm-mark--small" : ""}${size >= 64 ? " lm-mark--large" : ""}`
    : "";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={label}
      className={`shrink-0 ${hasCustomTone ? "" : DEFAULT_TONE} ${className ?? ""}`}
    >
      <g
        className={`lm-mark ${motionClass}`.trim()}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon className="lm-mark-core" points={CORE} />
        {MERIDIANS.map(([x1, y1, x2, y2], i) => (
          <line
            key={`${x1}-${y1}`}
            className="lm-mark-meridian"
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            style={
              {
                "--lm-i": i,
                "--lm-dx": MERIDIAN_DIRECTIONS[i][0],
                "--lm-dy": MERIDIAN_DIRECTIONS[i][1],
              } as CSSProperties
            }
          />
        ))}
      </g>
    </svg>
  );
};
