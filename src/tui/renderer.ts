import type { PowerlineConfig } from "../config/loader";
import type { TuiData, BoxChars, LayoutMode, RenderCtx } from "./types";

import { SYMBOLS, TEXT_SYMBOLS } from "../utils/constants";
import { contentRow, bottomBorder } from "./primitives";
import { buildTitleBar, buildContextLine } from "./sections";
import {
  renderWideMetrics,
  renderWideBottom,
  renderMediumMetrics,
  renderMediumBottom,
  renderNarrowMetrics,
  renderNarrowBottom,
} from "./layouts";

// Synchronized Output (DEC mode 2026): prevents tearing on multi-line renders.
// Terminals that don't support it silently ignore these sequences.
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

const MIN_PANEL_WIDTH = 32;
const WIDE_THRESHOLD = 80;
const MEDIUM_THRESHOLD = 55;

function getLayoutMode(panelWidth: number): LayoutMode {
  if (panelWidth >= WIDE_THRESHOLD) {
    return "wide";
  }
  if (panelWidth >= MEDIUM_THRESHOLD) {
    return "medium";
  }
  return "narrow";
}

function calculatePanelWidth(terminalWidth: number | null): number {
  if (terminalWidth && terminalWidth > 0) {
    return Math.max(MIN_PANEL_WIDTH, terminalWidth);
  }
  return 80;
}

export function renderTuiPanel(
  data: TuiData,
  box: BoxChars,
  reset: string,
  terminalWidth: number | null,
  config: PowerlineConfig,
): string {
  const sym =
    (config.display.charset || "unicode") === "text" ? TEXT_SYMBOLS : SYMBOLS;
  const colors = data.colors;
  const panelWidth = calculatePanelWidth(terminalWidth);
  const innerWidth = panelWidth - 2;
  const contentWidth = innerWidth - 2;
  const mode = getLayoutMode(panelWidth);

  const lines: string[] = [];

  lines.push(buildTitleBar(data, box, innerWidth, config));

  const contextLine = buildContextLine(data, contentWidth, sym, reset, colors);
  if (contextLine) {
    lines.push(contentRow(box, contextLine, innerWidth));
  }

  const ctx: RenderCtx = {
    lines,
    data,
    box,
    contentWidth,
    innerWidth,
    sym,
    config,
    reset,
    colors,
  };

  if (mode === "wide") {
    renderWideMetrics(ctx);
    renderWideBottom(ctx);
  } else if (mode === "medium") {
    renderMediumMetrics(ctx);
    renderMediumBottom(ctx);
  } else {
    renderNarrowMetrics(ctx);
    renderNarrowBottom(ctx);
  }

  lines.push(bottomBorder(box, innerWidth));
  return SYNC_START + lines.join("\n") + SYNC_END;
}
