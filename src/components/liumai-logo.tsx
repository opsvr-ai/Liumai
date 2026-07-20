/** 六脉 icon-only logo — six energy meridians with animated pulse effects, no text. */

import type { FC } from "react";

interface Props { size?: number; className?: string }

export const LiumaiLogo: FC<Props> = ({ size = 32, className }) => (
  <svg width={size} height={size} viewBox="0 0 512 512" fill="none"
    xmlns="http://www.w3.org/2000/svg" className={className} aria-label="六脉" role="img">
    <defs>
      <linearGradient id="lioBgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#0B0F19" /><stop offset="100%" stopColor="#1A1A2E" />
      </linearGradient>
      <linearGradient id="lioCoreGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#06B6D4" /><stop offset="100%" stopColor="#8B5CF6" />
      </linearGradient>
      <linearGradient id="lioLineGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#3B82F6" /><stop offset="100%" stopColor="#06B6D4" />
      </linearGradient>
      <linearGradient id="lioNodeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#1E3A8A" /><stop offset="100%" stopColor="#312E81" />
      </linearGradient>
      <filter id="lioGlowStrong" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="4" result="blur" /><feComposite in="SourceGraphic" in2="blur" operator="over" />
      </filter>
      <filter id="lioGlowSoft" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="8" result="blur" /><feComposite in="SourceGraphic" in2="blur" operator="over" />
      </filter>
      <filter id="lioGlowBeam" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="15" result="blur" /><feComposite in="SourceGraphic" in2="blur" operator="over" />
      </filter>
    </defs>

    <rect width="512" height="512" rx="40" fill="url(#lioBgGrad)" />

    {/* Orbital rings */}
    <circle cx="256" cy="256" r="180" fill="none" stroke="#3B82F6" strokeWidth="1.5" strokeDasharray="8 12" opacity="0.3" />
    <circle cx="256" cy="256" r="190" fill="none" stroke="#8B5CF6" strokeWidth="1" strokeDasharray="4 16" opacity="0.2" />

    {/* Static meridians */}
    <g fill="none">
      {[[320,300,377.2,326],[256,330,256,396],[192,300,134.8,326],[192,212,134.8,186],[256,182,256,116],[320,212,377.2,186]].map(([cx,cy,ex,ey], i) => (
        <g key={i}>
          <path d={`M 256 256 Q ${cx} ${cy}, ${ex} ${ey}`} stroke="url(#lioLineGrad)" strokeWidth="3" opacity="0.6" />
          <path d={`M 256 256 Q ${cx} ${cy}, ${ex} ${ey}`} stroke="#06B6D4" strokeWidth="2" strokeDasharray="1 10" strokeLinecap="round" />
        </g>
      ))}
    </g>

    {/* Terminal nodes */}
    <g transform="translate(256, 256)">
      {[[121.2,70],[0,140],[-121.2,70],[-121.2,-70],[0,-140],[121.2,-70]].map(([x, y], i) => (
        <g key={i} transform={`translate(${x}, ${y}) rotate(15)`}>
          <polygon points="20,0 10,17.32 -10,17.32 -20,0 -10,-17.32 10,-17.32" fill="url(#lioNodeGrad)" stroke="#06B6D4" strokeWidth="2" />
          <circle cx="0" cy="0" r="4" fill="#FFF" opacity="0.8" />
        </g>
      ))}
    </g>

    {/* Core */}
    <circle cx="256" cy="256" r="60" fill="#06B6D4" opacity="0.1" filter="url(#lioGlowBeam)" />
    <circle cx="256" cy="256" r="50" fill="none" stroke="#8B5CF6" strokeWidth="2" strokeDasharray="15 20" opacity="0.8" />
    <polygon points="45,0 22.5,38.97 -22.5,38.97 -45,0 -22.5,-38.97 22.5,-38.97" fill="none" stroke="url(#lioCoreGrad)" strokeWidth="3" transform="translate(256, 256) rotate(15)" filter="url(#lioGlowStrong)" />
    <polygon points="25,0 12.5,21.65 -12.5,21.65 -25,0 -12.5,-21.65 12.5,-21.65" fill="#3B82F6" opacity="0.6" transform="translate(256, 256) rotate(45)" />
    <circle cx="256" cy="256" r="10" fill="#FFF" filter="url(#lioGlowStrong)" />
    <path d="M 246 256 L 266 256 M 256 246 L 256 266" stroke="#0B0F19" strokeWidth="2" />

    {/* Animated energy pulses — six meridians */}
    <g fill="none">
      {[[320,300,377.2,326,0],[256,330,256,396,0.5],[192,300,134.8,326,1],[192,212,134.8,186,1.5],[256,182,256,116,2],[320,212,377.2,186,2.5]].map(([cx,cy,ex,ey,delay], i) => (
        <g key={i}>
          <path d={`M 256 256 Q ${cx} ${cy}, ${ex} ${ey}`} stroke="#00FFFF" strokeWidth="8" strokeLinecap="round" strokeDasharray="8 250" opacity="0.6" filter="url(#lioGlowSoft)">
            <animate attributeName="stroke-dashoffset" from="0" to="-260" dur="2.5s" repeatCount="indefinite" begin={`${delay}s`} />
          </path>
          <path d={`M 256 256 Q ${cx} ${cy}, ${ex} ${ey}`} stroke="#FFF" strokeWidth="3" strokeLinecap="round" strokeDasharray="1 250" filter="url(#lioGlowStrong)">
            <animate attributeName="stroke-dashoffset" from="0" to="-260" dur="2.5s" repeatCount="indefinite" begin={`${delay}s`} />
          </path>
        </g>
      ))}
    </g>
  </svg>
);
