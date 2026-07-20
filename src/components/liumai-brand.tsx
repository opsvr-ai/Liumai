/** 六脉 brand mark — icon + platform name, for sidebar / header. */

import type { FC } from "react";
import { LiumaiLogo } from "@/components/liumai-logo";

interface Props { size?: number; showText?: boolean; className?: string }

export const LiumaiBrand: FC<Props> = ({ size = 28, showText = true, className }) => (
  <div className={`flex items-center gap-2 shrink-0 ${className ?? ""}`}>
    <LiumaiLogo size={size} />
    {showText && (
      <span
        className="text-base md:text-lg font-bold tracking-tight text-text-primary whitespace-nowrap"
        style={{ fontFeatureSettings: "'ss01'" }}
      >
        六脉
      </span>
    )}
  </div>
);
