import type { UsageInfo } from "../segments/session";
import type { BlockInfo } from "../segments/block";
import type { TodayInfo } from "../segments/today";
import type { ContextInfo } from "../segments/context";
import type { MetricsInfo } from "../segments/metrics";
import type { GitInfo } from "../segments/git";
import type { ClaudeHookData } from "../utils/claude";
import type { PowerlineColors } from "../themes";

import { SYMBOLS, TEXT_SYMBOLS } from "../utils/constants";

export interface BoxChars {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
  readonly teeLeft: string;
  readonly teeRight: string;
}

export interface TuiData {
  hookData: ClaudeHookData;
  usageInfo: UsageInfo | null;
  blockInfo: BlockInfo | null;
  todayInfo: TodayInfo | null;
  contextInfo: ContextInfo | null;
  metricsInfo: MetricsInfo | null;
  gitInfo: GitInfo | null;
  tmuxSessionId: string | null;
  colors: PowerlineColors;
}

export type SymbolSet = typeof SYMBOLS | typeof TEXT_SYMBOLS;

export type LayoutMode = "wide" | "medium" | "narrow";

export interface RenderCtx {
  lines: string[];
  data: TuiData;
  box: BoxChars;
  contentWidth: number;
  innerWidth: number;
  sym: SymbolSet;
  config: import("../config/loader").PowerlineConfig;
  reset: string;
  colors: PowerlineColors;
}
