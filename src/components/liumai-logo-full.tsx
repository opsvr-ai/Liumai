/** 六脉 full logo — the brand mark at display size, for the login page. */

import type { FC } from "react";
import { LiumaiLogo } from "@/components/liumai-logo";

interface Props { size?: number; className?: string }

export const LiumaiLogoFull: FC<Props> = ({ size = 320, className }) => (
  <LiumaiLogo size={size} className={className} label="六脉智能运维数智平台" />
);
