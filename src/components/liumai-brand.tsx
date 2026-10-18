/** 六脉 brand lockup — icon + 「六脉」 wordmark + compact platform subtitle. */

import type { FC } from "react";
import { LiumaiLogo } from "@/components/liumai-logo";

interface Props { size?: number; showText?: boolean; className?: string }

export const LiumaiBrand: FC<Props> = ({ size = 26, showText = true, className }) => (
  <span className={`flex items-center gap-2 shrink-0 ${className ?? ""}`}>
    <LiumaiLogo size={size} />
    {showText && (
      <span className="flex flex-col items-start justify-center leading-none">
        <span
          className="text-[15px] md:text-base font-bold tracking-tight text-text-primary whitespace-nowrap"
          style={{ fontFeatureSettings: "'ss01'" }}
        >
          六脉
        </span>
        <span className="mt-1 hidden whitespace-nowrap text-[10px] font-medium tracking-[0.08em] text-muted-foreground md:block">
          智能运维数智平台
        </span>
      </span>
    )}
  </span>
);
