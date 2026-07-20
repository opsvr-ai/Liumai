/** Animated 六脉 logo for the login page.
Six data meridians pulse and contract, the core gently floats. */

import type { FC } from "react";

export const LoginLogo: FC<{ className?: string }> = ({ className }) => (
  <svg
    width="320"
    height="320"
    viewBox="0 0 320 320"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    <defs>
      {/* Core gradient */}
      <linearGradient id="coreGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#4f6bf7" />
        <stop offset="100%" stopColor="#7c8cf8" />
      </linearGradient>
      {/* Meridian gradient */}
      <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#4f6bf7" stopOpacity="0.6" />
        <stop offset="100%" stopColor="#7c8cf8" stopOpacity="0.2" />
      </linearGradient>
    </defs>

    <style>{`
      @keyframes pulse-ring { 0%,100% { opacity:0.06; r:105 } 50% { opacity:0.14; r:115 } }
      @keyframes pulse-ring2 { 0%,100% { opacity:0.04; r:125 } 50% { opacity:0.10; r:138 } }
      @keyframes float-core { 0%,100% { transform:translate(160px,162px) } 33% { transform:translate(162px,158px) } 66% { transform:translate(158px,164px) } }
      @keyframes line-lt { 0%,100% { d:path("M50,80 Q100,100 130,115") } 50% { d:path("M40,70 Q100,95 135,110") } }
      @keyframes line-lm { 0%,100% { d:path("M40,145 Q95,135 130,128") } 50% { d:path("M30,140 Q95,125 135,125") } }
      @keyframes line-lb { 0%,100% { d:path("M55,215 Q100,195 130,175") } 50% { d:path("M45,225 Q100,205 135,170") } }
      @keyframes line-rt { 0%,100% { d:path("M270,80 Q220,100 190,115") } 50% { d:path("M280,70 Q220,95 185,110") } }
      @keyframes line-rm { 0%,100% { d:path("M280,145 Q225,135 190,128") } 50% { d:path("M290,140 Q225,125 185,125") } }
      @keyframes line-rb { 0%,100% { d:path("M265,215 Q220,195 190,175") } 50% { d:path("M275,225 Q220,205 185,170") } }
      .ring1 { animation: pulse-ring 4s ease-in-out infinite; }
      .ring2 { animation: pulse-ring2 4s ease-in-out infinite 0.5s; }
      .core { animation: float-core 6s ease-in-out infinite; }
      .meridian { fill:none; stroke:url(#lineGrad); stroke-width:2.5; stroke-linecap:round; }
      .line-lt { animation: line-lt 3s ease-in-out infinite; }
      .line-lm { animation: line-lm 3s ease-in-out infinite 0.3s; }
      .line-lb { animation: line-lb 3s ease-in-out infinite 0.6s; }
      .line-rt { animation: line-rt 3s ease-in-out infinite 0.9s; }
      .line-rm { animation: line-rm 3s ease-in-out infinite 1.2s; }
      .line-rb { animation: line-rb 3s ease-in-out infinite 1.5s; }
    `}</style>

    {/* Outer pulse rings */}
    <circle cx="160" cy="162" r="105" className="ring1" fill="#4f6bf7" />
    <circle cx="160" cy="162" r="125" className="ring2" fill="#7c8cf8" />

    {/* Six animated meridians */}
    <path className="meridian line-lt" d="M50,80 Q100,100 130,115" />
    <path className="meridian line-lm" d="M40,145 Q95,135 130,128" />
    <path className="meridian line-lb" d="M55,215 Q100,195 130,175" />
    <path className="meridian line-rt" d="M270,80 Q220,100 190,115" />
    <path className="meridian line-rm" d="M280,145 Q225,135 190,128" />
    <path className="meridian line-rb" d="M265,215 Q220,195 190,175" />

    {/* Core group — floats independently */}
    <g className="core">
      {/* Outer hexagon */}
      <polygon
        points="160,115 200,138 200,186 160,209 120,186 120,138"
        fill="url(#coreGrad)"
        opacity="0.12"
      />
      {/* Inner hexagon */}
      <polygon
        points="160,128 188,144 188,180 160,196 132,180 132,144"
        fill="url(#coreGrad)"
        opacity="0.85"
      />
      {/* Center dot */}
      <circle cx="160" cy="162" r="10" fill="white" opacity="0.95" />
      <circle cx="160" cy="162" r="6" fill="url(#coreGrad)" opacity="0.6" />
    </g>
  </svg>
);
