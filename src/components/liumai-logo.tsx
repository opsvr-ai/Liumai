/** 六脉 (Liumai) platform logo — six data meridians converging into an AI core.

Concepts visually represented:
- 6 flowing lines (六脉 — six meridians/vessels carrying data)
- Central diamond (AI/LLM intelligence core)
- Outward pulse rings (real-time monitoring)
*/

import type { FC } from "react";

interface Props {
  size?: number;
  className?: string;
}

export const LiumaiLogo: FC<Props> = ({ size = 32, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-label="六脉 Liumai"
    role="img"
  >
    {/* Outer pulse ring */}
    <circle cx="24" cy="24" r="22" stroke="currentColor" strokeWidth="1" opacity="0.15" />
    <circle cx="24" cy="24" r="18" stroke="currentColor" strokeWidth="0.5" opacity="0.1" />

    {/* Six meridians — flowing data conduits */}
    {/* Top-left → center */}
    <path d="M4 14 Q14 18 20 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.7" fill="none" />
    {/* Mid-left → center */}
    <path d="M3 26 Q12 24 19 23" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.85" fill="none" />
    {/* Bottom-left → center */}
    <path d="M6 38 Q13 32 20 27" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.6" fill="none" />

    {/* Top-right → center */}
    <path d="M44 14 Q34 18 28 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.7" fill="none" />
    {/* Mid-right → center */}
    <path d="M45 26 Q36 24 29 23" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.85" fill="none" />
    {/* Bottom-right → center */}
    <path d="M42 38 Q35 32 28 27" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.6" fill="none" />

    {/* Central AI core — diamond/hexagon shape */}
    <polygon
      points="24,17 31,22 31,30 24,35 17,30 17,22"
      fill="currentColor"
      opacity="0.15"
    />
    <polygon
      points="24,19 29,22.5 29,28.5 24,32 19,28.5 19,22.5"
      fill="currentColor"
      opacity="0.85"
    />

    {/* Inner pulse dot */}
    <circle cx="24" cy="25.5" r="3" fill="white" opacity="0.9" />
  </svg>
);
