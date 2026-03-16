import type { PowerlineConfig } from "../config/loader";
import type { TuiData, BoxChars, LayoutMode } from "./types";

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
  const sym = (config.display.charset || "unicode") === "text" ? TEXT_SYMBOLS : SYMBOLS;
  const colors = data.colors;
  const panelWidth = calculatePanelWidth(terminalWidth);
  const innerWidth = panelWidth - 2;
  const contentWidth = innerWidth - 2;
  const mode = getLayoutMode(panelWidth);

  const lines: string[] = [];

  lines.push(buildTitleBar(data, box, innerWidth));

  const contextLine = buildContextLine(data, contentWidth, sym, reset, colors);
  if (contextLine) {
    lines.push(contentRow(box, contextLine, innerWidth));
  }

  if (mode === "wide") {
    renderWideMetrics(lines, data, box, contentWidth, innerWidth, sym, config, reset, colors);
    renderWideBottom(lines, data, box, contentWidth, innerWidth, sym, config, reset, colors);
  } else if (mode === "medium") {
    renderMediumMetrics(lines, data, box, contentWidth, innerWidth, sym, config, reset, colors);
    renderMediumBottom(lines, data, box, contentWidth, innerWidth, sym, config, reset, colors);
  } else {
    renderNarrowMetrics(lines, data, box, contentWidth, innerWidth, sym, config, reset, colors);
    renderNarrowBottom(lines, data, box, contentWidth, innerWidth, sym, config, reset, colors);
  }

  lines.push(bottomBorder(box, innerWidth));
  return lines.join("\n");
}
