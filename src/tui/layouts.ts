import type { RenderCtx } from "./types";

import { formatCost } from "../utils/formatters";
import { contentRow, divider, spreadEven, spreadTwo, colorize } from "./primitives";
import {
  collectMetricSegments,
  collectActivityParts,
  collectWorkspaceParts,
  collectFooterParts,
  formatBlockSegment,
  formatSessionSegment,
  formatTodaySegment,
} from "./sections";

// --- Wide layout (80+ cols): metrics on 1 line, workspace+footer on 1 line ---

export function renderWideMetrics(ctx: RenderCtx): void {
  const { lines, data, box, contentWidth, innerWidth, sym, config, reset, colors } = ctx;
  const segments = collectMetricSegments(data, sym, config, reset, colors);
  if (segments.length > 0) {
    lines.push(contentRow(box, spreadEven(segments, contentWidth), innerWidth));
  }
}

export function renderWideBottom(ctx: RenderCtx): void {
  const { lines, data, box, contentWidth, innerWidth, sym, config, reset, colors } = ctx;
  const leftParts = collectWorkspaceParts(data, sym, reset, colors);
  const rightParts = collectFooterParts(data, sym, config, reset, colors);

  const leftStr = leftParts.join("  ");
  const rightStr = rightParts.join(" · ");

  if (leftStr || rightStr) {
    lines.push(divider(box, innerWidth));
    lines.push(contentRow(box, spreadTwo(leftStr, rightStr, contentWidth), innerWidth));
  }
}

// --- Medium layout (55-79 cols): metrics on 2 lines, workspace and footer separate ---

export function renderMediumMetrics(ctx: RenderCtx): void {
  const { lines, data, box, contentWidth, innerWidth, sym, config, reset, colors } = ctx;
  const line1Parts: string[] = [];
  const line2Parts: string[] = [];

  if (data.blockInfo) {
    line1Parts.push(colorize(formatBlockSegment(data.blockInfo, sym, config), colors.blockFg, reset));
  }
  if (data.todayInfo) {
    line1Parts.push(colorize(formatTodaySegment(data.todayInfo, sym, config), colors.todayFg, reset));
  }

  if (data.usageInfo) {
    line2Parts.push(colorize(formatSessionSegment(data.usageInfo, sym, config), colors.sessionFg, reset));
  }
  const activityParts = collectActivityParts(data, sym);
  if (activityParts.length > 0) {
    line2Parts.push(colorize(activityParts.join(" · "), colors.metricsFg, reset));
  }

  if (line1Parts.length > 0) {
    lines.push(contentRow(box, spreadTwo(line1Parts[0] ?? "", line1Parts[1] ?? "", contentWidth), innerWidth));
  }
  if (line2Parts.length > 0) {
    lines.push(contentRow(box, spreadTwo(line2Parts[0] ?? "", line2Parts[1] ?? "", contentWidth), innerWidth));
  }
}

export function renderMediumBottom(ctx: RenderCtx): void {
  const { lines, data, box, contentWidth, innerWidth, sym, config, reset, colors } = ctx;
  const workspaceParts = collectWorkspaceParts(data, sym, reset, colors);
  if (workspaceParts.length > 0) {
    lines.push(divider(box, innerWidth));
    lines.push(contentRow(box, spreadTwo(workspaceParts[0] ?? "", workspaceParts[1] ?? "", contentWidth), innerWidth));
  }

  const footerParts = collectFooterParts(data, sym, config, reset, colors);
  if (footerParts.length > 0) {
    lines.push(divider(box, innerWidth));
    lines.push(contentRow(box, footerParts.join(" · "), innerWidth));
  }
}

// --- Narrow layout (<55 cols): everything stacks ---

export function renderNarrowMetrics(ctx: RenderCtx): void {
  const { lines, data, box, contentWidth, innerWidth, sym, config, reset, colors } = ctx;
  if (data.blockInfo) {
    lines.push(contentRow(box, colorize(formatBlockSegment(data.blockInfo, sym, config), colors.blockFg, reset), innerWidth));
  }

  const sessionAndToday: string[] = [];
  if (data.usageInfo) {
    sessionAndToday.push(colorize(`${sym.session_cost} ${formatCost(data.usageInfo.session.cost)}`, colors.sessionFg, reset));
  }
  if (data.todayInfo) {
    sessionAndToday.push(colorize(`${sym.today_cost} ${formatCost(data.todayInfo.cost)} today`, colors.todayFg, reset));
  }
  if (sessionAndToday.length > 0) {
    lines.push(contentRow(box, spreadTwo(sessionAndToday[0] ?? "", sessionAndToday[1] ?? "", contentWidth), innerWidth));
  }
}

export function renderNarrowBottom(ctx: RenderCtx): void {
  const { lines, data, box, contentWidth, innerWidth, sym, config, reset, colors } = ctx;
  const workspaceParts = collectWorkspaceParts(data, sym, reset, colors);
  if (workspaceParts.length > 0) {
    lines.push(divider(box, innerWidth));
    lines.push(contentRow(box, spreadTwo(workspaceParts[0] ?? "", workspaceParts[1] ?? "", contentWidth), innerWidth));
  }

  const footerParts = collectFooterParts(data, sym, config, reset, colors);
  if (footerParts.length > 0) {
    lines.push(contentRow(box, footerParts.join(" · "), innerWidth));
  }
}
