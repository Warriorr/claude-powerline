import { debug } from "../utils/logger";
import { CacheManager } from "../utils/cache";
import {
  loadIndexedUsageEntries,
  type IndexedUsageEntry,
} from "../utils/usageIndex";
import type { TokenBreakdown } from "./session";

export interface WeeklyUsageEntry {
  timestamp: Date;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  costUSD: number;
  model: string;
}

export interface WeeklyInfo {
  cost: number | null;
  tokens: number | null;
  tokenBreakdown: TokenBreakdown | null;
  weekStart: string;
  timeLeft: number | null;
  rateLimitPercentage: number | null;
  resetsAt: Date | null;
  projectedUsagePercentage: number | null;
  projectedUsageTrend: "up" | "down" | "flat" | null;
  /** Last non-flat trend direction, for sticky arrow in direction-only mode */
  lastNonFlatTrend: "up" | "down" | null;
  minutesToLimit: number | null;
  elapsedMinutes: number | null;
}

function getTotalTokens(usage: WeeklyUsageEntry["usage"]): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens
  );
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getWeekStart(): Date {
  const now = new Date();
  const weekStart = new Date(now);
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  weekStart.setDate(weekStart.getDate() - daysToMonday);
  weekStart.setHours(0, 0, 0, 0);
  return weekStart;
}

function convertToWeeklyEntry(entry: IndexedUsageEntry): WeeklyUsageEntry {
  return {
    timestamp: entry.timestamp,
    usage: {
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheCreationInputTokens: entry.cacheCreationInputTokens,
      cacheReadInputTokens: entry.cacheReadInputTokens,
    },
    costUSD: entry.costUSD,
    model: entry.model,
  };
}

export class WeeklyProvider {
  private async loadWeeklyEntries(): Promise<WeeklyUsageEntry[]> {
    const weekStart = getWeekStart();
    const weekStartString = formatDate(weekStart);

    debug(`Weekly segment: Loading entries from ${weekStartString}`);

    const indexedEntries = await loadIndexedUsageEntries({ since: weekStart });
    const weeklyEntries = indexedEntries.map(convertToWeeklyEntry);

    debug(
      `Weekly segment: Found ${weeklyEntries.length} entries from ${weekStartString}`,
    );

    return weeklyEntries;
  }

  private async getWeeklyEntries(): Promise<WeeklyUsageEntry[]> {
    try {
      return await this.loadWeeklyEntries();
    } catch (error) {
      debug("Error loading weekly entries:", error);
      return [];
    }
  }

  async getWeeklyInfo(rateLimits?: {
    used_percentage: number;
    resets_at: number;
  }): Promise<WeeklyInfo> {
    const weekStartString = formatDate(getWeekStart());

    try {
      const entries = await this.getWeeklyEntries();

      if (entries.length === 0) {
        const emptyWeekStart = getWeekStart();
        const emptyWeekDurationMs = 7 * 24 * 60 * 60 * 1000;
        const emptyNextWeekStart = new Date(
          emptyWeekStart.getTime() + emptyWeekDurationMs,
        );
        const emptyTimeLeftMs = Math.max(
          0,
          emptyNextWeekStart.getTime() - new Date().getTime(),
        );
        const emptyResetsAt = rateLimits?.resets_at
          ? new Date(rateLimits.resets_at * 1000)
          : null;
        const emptyTimeLeft = emptyResetsAt
          ? Math.max(
              0,
              Math.round(
                (emptyResetsAt.getTime() - new Date().getTime()) / (1000 * 60),
              ),
            )
          : Math.round(emptyTimeLeftMs / (1000 * 60));
        return {
          cost: null,
          tokens: null,
          tokenBreakdown: null,
          weekStart: weekStartString,
          timeLeft: emptyTimeLeft,
          rateLimitPercentage: rateLimits?.used_percentage ?? null,
          resetsAt: emptyResetsAt,
          projectedUsagePercentage: null,
          projectedUsageTrend: null,
          lastNonFlatTrend: null,
          minutesToLimit: null,
          elapsedMinutes: null,
        };
      }

      const totalCost = entries.reduce((sum, entry) => sum + entry.costUSD, 0);
      const totalTokens = entries.reduce(
        (sum, entry) => sum + getTotalTokens(entry.usage),
        0,
      );

      const tokenBreakdown = entries.reduce(
        (breakdown, entry) => ({
          input: breakdown.input + entry.usage.inputTokens,
          output: breakdown.output + entry.usage.outputTokens,
          cacheCreation:
            breakdown.cacheCreation + entry.usage.cacheCreationInputTokens,
          cacheRead: breakdown.cacheRead + entry.usage.cacheReadInputTokens,
        }),
        { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      );

      debug(
        `Weekly segment: $${totalCost.toFixed(2)}, ${totalTokens} tokens total`,
      );

      const weekDurationMs = 7 * 24 * 60 * 60 * 1000;
      const nextWeekStart = new Date(getWeekStart().getTime() + weekDurationMs);
      const timeLeftMs = Math.max(
        0,
        nextWeekStart.getTime() - new Date().getTime(),
      );
      const timeLeft = Math.round(timeLeftMs / (1000 * 60));
      const resetsAt = rateLimits?.resets_at
        ? new Date(rateLimits.resets_at * 1000)
        : null;
      const resolvedTimeLeft = resetsAt
        ? Math.max(
            0,
            Math.round(
              (resetsAt.getTime() - new Date().getTime()) / (1000 * 60),
            ),
          )
        : timeLeft;

      const now = new Date();
      const weekStartTime = getWeekStart();
      const elapsedMinutes = Math.round(
        (now.getTime() - weekStartTime.getTime()) / (1000 * 60),
      );

      let projectedUsagePercentage: number | null = null;
      let projectedUsageTrend: "up" | "down" | "flat" | null = null;
      let lastNonFlatTrend: "up" | "down" | null = null;
      let minutesToLimit: number | null = null;
      if (
        rateLimits?.used_percentage != null &&
        resolvedTimeLeft !== null &&
        elapsedMinutes > 0
      ) {
        const ratePerMinute = rateLimits.used_percentage / elapsedMinutes;
        projectedUsagePercentage =
          rateLimits.used_percentage + ratePerMinute * resolvedTimeLeft;
        if (projectedUsagePercentage > 100) {
          minutesToLimit = Math.round(
            (100 - rateLimits.used_percentage) / ratePerMinute,
          );
        }

        const previousProjected = await CacheManager.getTrend("weekly");
        if (previousProjected !== null) {
          const diff = projectedUsagePercentage - previousProjected;
          if (diff > 1) {
            projectedUsageTrend = "up";
            await CacheManager.setLastTrendDirection("weekly", "up");
          } else if (diff < -1) {
            projectedUsageTrend = "down";
            await CacheManager.setLastTrendDirection("weekly", "down");
          } else {
            projectedUsageTrend = "flat";
          }
        }
        lastNonFlatTrend = await CacheManager.getLastTrendDirection("weekly");
        await CacheManager.setTrend("weekly", projectedUsagePercentage);
      }

      return {
        cost: totalCost,
        tokens: totalTokens,
        tokenBreakdown,
        weekStart: weekStartString,
        timeLeft: resolvedTimeLeft,
        rateLimitPercentage: rateLimits?.used_percentage ?? null,
        resetsAt,
        projectedUsagePercentage,
        projectedUsageTrend,
        lastNonFlatTrend,
        minutesToLimit,
        elapsedMinutes,
      };
    } catch (error) {
      debug("Error getting weekly info:", error);
      return {
        cost: null,
        tokens: null,
        tokenBreakdown: null,
        weekStart: weekStartString,
        timeLeft: null,
        rateLimitPercentage: rateLimits?.used_percentage ?? null,
        resetsAt: rateLimits?.resets_at
          ? new Date(rateLimits.resets_at * 1000)
          : null,
        projectedUsagePercentage: null,
        projectedUsageTrend: null,
        lastNonFlatTrend: null,
        minutesToLimit: null,
        elapsedMinutes: null,
      };
    }
  }
}
