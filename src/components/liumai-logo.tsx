/** 六脉 icon-only logo — user-designed, transparent background. */

import type { FC } from "react";

interface Props { size?: number; className?: string }

export const LiumaiLogo: FC<Props> = ({ size = 32, className }) => (
  <svg
    width={size} height={size}
    viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg"
    className={className} aria-label="六脉" role="img"
  >
    <defs>
      <linearGradient id="coreGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#06B6D4" />
        <stop offset="100%" stopColor="#8B5CF6" />
      </linearGradient>
      <linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#3B82F6" />
        <stop offset="100%" stopColor="#06B6D4" />
      </linearGradient>
      <linearGradient id="nodeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#1E3A8A" />
        <stop offset="100%" stopColor="#312E81" />
      </linearGradient>
      <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="4" result="blur" />
        <feComposite in="SourceGraphic" in2="blur" operator="over" />
      </filter>
      <filter id="glowSoft" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="8" result="blur" />
        <feComposite in="SourceGraphic" in2="blur" operator="over" />
      </filter>
    </defs>

    {/* Orbital rings */}
    <circle cx="256" cy="256" r="180" fill="none" stroke="#3B82F6" strokeWidth="1.5" strokeDasharray="8 12" opacity="0.3" />
    <circle cx="256" cy="256" r="190" fill="none" stroke="#8B5CF6" strokeWidth="1" strokeDasharray="4 16" opacity="0.2" />

    {/* Six meridians */}
    <g fill="none">
      <path d="M 256 256 Q 320 300, 377.2 326" stroke="url(#lineGrad)" strokeWidth="4" filter="url(#glowSoft)" />
      <path d="M 256 256 Q 256 330, 256 396" stroke="url(#lineGrad)" strokeWidth="4" filter="url(#glowSoft)" />
      <path d="M 256 256 Q 192 300, 134.8 326" stroke="url(#lineGrad)" strokeWidth="4" filter="url(#glowSoft)" />
      <path d="M 256 256 Q 192 212, 134.8 186" stroke="url(#lineGrad)" strokeWidth="4" filter="url(#glowSoft)" />
      <path d="M 256 256 Q 256 182, 256 116" stroke="url(#lineGrad)" strokeWidth="4" filter="url(#glowSoft)" />
      <path d="M 256 256 Q 320 212, 377.2 186" stroke="url(#lineGrad)" strokeWidth="4" filter="url(#glowSoft)" />
      {/* Data pulse dots */}
      <g stroke="#06B6D4" strokeWidth="2" strokeDasharray="1 10" strokeLinecap="round">
        <path d="M 256 256 Q 320 300, 377.2 326" />
        <path d="M 256 256 Q 256 330, 256 396" />
        <path d="M 256 256 Q 192 300, 134.8 326" />
        <path d="M 256 256 Q 192 212, 134.8 186" />
        <path d="M 256 256 Q 256 182, 256 116" />
        <path d="M 256 256 Q 320 212, 377.2 186" />
      </g>
    </g>

    {/* Six terminal nodes */}
    <g transform="translate(256, 256)">
      {[[121.2,70],[0,140],[-121.2,70],[-121.2,-70],[0,-140],[121.2,-70]].map(([x, y], i) => (
        <g key={i} transform={`translate(${x}, ${y}) rotate(15)`}>
          <polygon points="20,0 10,17.32 -10,17.32 -20,0 -10,-17.32 10,-17.32" fill="url(#nodeGrad)" stroke="#06B6D4" strokeWidth="2" />
          <circle cx="0" cy="0" r="4" fill="#FFFFFF" opacity="0.8" />
        </g>
      ))}
    </g>

    {/* AI Core */}
    <circle cx="256" cy="256" r="60" fill="#06B6D4" opacity="0.1" filter="url(#glowSoft)" />
    <circle cx="256" cy="256" r="50" fill="none" stroke="#8B5CF6" strokeWidth="2" strokeDasharray="15 20" opacity="0.8" />
    <polygon points="45,0 22.5,38.97 -22.5,38.97 -45,0 -22.5,-38.97 22.5,-38.97" fill="none" stroke="url(#coreGrad)" strokeWidth="3" transform="translate(256, 256) rotate(15)" filter="url(#glow)" />
    <polygon points="25,0 12.5,21.65 -12.5,21.65 -25,0 -12.5,-21.65 12.5,-21.65" fill="#3B82F6" opacity="0.6" transform="translate(256, 256) rotate(45)" />
    <circle cx="256" cy="256" r="10" fill="#FFFFFF" filter="url(#glow)" />
    <path d="M 246 256 L 266 256 M 256 246 L 256 266" stroke="#0B0F19" strokeWidth="2" />
  </svg>
);
