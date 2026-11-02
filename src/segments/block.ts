import { debug } from "../utils/logger";
import { CacheManager } from "../utils/cache";
import type { ClaudeHookData } from "../utils/claude";
import {
  loadIndexedUsageEntries,
  type IndexedUsageEntry,
} from "../utils/usageIndex";

/** Remembers whether the last reported rate limits had a five_hour window. */
export const FIVE_HOUR_WINDOW_DOCUMENT = "five-hour-window";

export interface UsageEntry {
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

export interface BlockInfo {
  cost: number | null;
  tokens: number | null;
  weightedTokens: number | null;
  timeRemaining: number | null;
  timeElapsed: number | null;
  burnRate: number | null;
  tokenBurnRate: number | null;
  rateLimitPercentage: number | null;
  resetsAt: Date | null;
  projectedUsagePercentage: number | null;
  projectedUsageTrend: "up" | "down" | "flat" | null;
  /** Last non-flat trend direction, for sticky arrow in direction-only mode */
  lastNonFlatTrend: "up" | "down" | null;
  minutesToLimit: number | null;
}

function getModelRateLimitWeight(model: string): number {
  if (model.includes("opus")) return 5;
  if (model.includes("sonnet")) return 1;
  if (model.includes("haiku")) return 1;
  return 1;
}

function convertToUsageEntry(entry: IndexedUsageEntry): UsageEntry {
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

export class BlockProvider {
  private readonly sessionDurationHours = 5;

  private floorToHour(timestamp: Date): Date {
    const floored = new Date(timestamp);
    floored.setUTCMinutes(0, 0, 0);
    return floored;
  }

  private identifySessionBlocks(entries: UsageEntry[]): UsageEntry[][] {
    if (entries.length === 0) return [];

    const sessionDurationMs = this.sessionDurationHours * 60 * 60 * 1000;
    const blocks: UsageEntry[][] = [];
    const sortedEntries = [...entries].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    let currentBlockStart: Date | null = null;
    let currentBlockEntries: UsageEntry[] = [];

    for (const entry of sortedEntries) {
      const entryTime = entry.timestamp;

      if (currentBlockStart == null) {
        currentBlockStart = this.floorToHour(entryTime);
        currentBlockEntries = [entry];
      } else {
        const timeSinceBlockStart =
          entryTime.getTime() - currentBlockStart.getTime();
        const lastEntry = currentBlockEntries[currentBlockEntries.length - 1];
        if (lastEntry == null) {
          continue;
        }
        const lastEntryTime = lastEntry.timestamp;
        const timeSinceLastEntry =
          entryTime.getTime() - lastEntryTime.getTime();

        if (
          timeSinceBlockStart > sessionDurationMs ||
          timeSinceLastEntry > sessionDurationMs
        ) {
          blocks.push(currentBlockEntries);

          currentBlockStart = this.floorToHour(entryTime);
          currentBlockEntries = [entry];
        } else {
          currentBlockEntries.push(entry);
        }
      }
    }

    if (currentBlockStart != null && currentBlockEntries.length > 0) {
      blocks.push(currentBlockEntries);
    }

    return blocks;
  }

  private createBlockInfo(
    startTime: Date,
    entries: UsageEntry[],
  ): { block: UsageEntry[]; isActive: boolean } {
    const now = new Date();
    const sessionDurationMs = this.sessionDurationHours * 60 * 60 * 1000;
    const endTime = new Date(startTime.getTime() + sessionDurationMs);
    const lastEntry = entries[entries.length - 1];
    const actualEndTime = lastEntry != null ? lastEntry.timestamp : startTime;

    const isActive =
      now.getTime() - actualEndTime.getTime() < sessionDurationMs &&
      now < endTime;

    return { block: entries, isActive };
  }

  private findActiveBlock(blocks: UsageEntry[][]): UsageEntry[] | null {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (!block || block.length === 0) continue;

      const firstEntry = block[0];
      if (!firstEntry) continue;

      const blockStartTime = this.floorToHour(firstEntry.timestamp);
      const blockInfo = this.createBlockInfo(blockStartTime, block);

      if (blockInfo.isActive) {
        return blockInfo.block;
      }
    }

    return null;
  }

  private async loadUsageEntries(): Promise<UsageEntry[]> {
    try {
      debug(`Block segment: Loading entries for dynamic session blocks`);

      // Only the active 5h block matters, so entries are filtered by their
      // own timestamp rather than by which files were touched in the last
      // 24h (the old fileFilter-based semantics).
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const indexedEntries = await loadIndexedUsageEntries({ since });
      const allUsageEntries = indexedEntries.map(convertToUsageEntry);

      const sessionBlocks = this.identifySessionBlocks(allUsageEntries);
      debug(`Block segment: Found ${sessionBlocks.length} session blocks`);

      const activeBlock = this.findActiveBlock(sessionBlocks);

      let result: UsageEntry[] = [];
      if (activeBlock && activeBlock.length > 0) {
        debug(
          `Block segment: Found active block with ${activeBlock.length} entries`,
        );
        const blockStart = activeBlock[0];
        const blockEnd = activeBlock[activeBlock.length - 1];
        if (blockStart && blockEnd) {
          debug(
            `Block segment: Active block from ${blockStart.timestamp.toISOString()} to ${blockEnd.timestamp.toISOString()}`,
          );
        }
        result = activeBlock;
      } else {
        debug(`Block segment: No active block found`);
        result = [];
      }

      return result;
    } catch (error) {
      debug("Error loading block entries:", error);
      return [];
    }
  }

  /**
   * Whether a 5-hour window exists to report on. Claude Code sends
   * `rate_limits` only after a session's first API response and leaves out any
   * window the plan does not have or whose reset time has passed, so a report
   * without `five_hour` means there is no window right now. With no report at
   * all this render cannot tell, so the last observation decides: that keeps a
   * plan without the limit from flashing the segment at every session start,
   * while sessions that never get a report (API keys) keep the local block.
   */
  private async hasFiveHourWindow(
    rateLimits: ClaudeHookData["rate_limits"],
  ): Promise<boolean> {
    const reported = rateLimits ? Boolean(rateLimits.five_hour) : null;
    try {
      const stored = await CacheManager.getUsageDocument(
        FIVE_HOUR_WINDOW_DOCUMENT,
      );
      const lastSeen =
        typeof stored?.present === "boolean" ? stored.present : null;
      if (reported === null) {
        return lastSeen !== false;
      }
      if (reported !== lastSeen) {
        await CacheManager.setUsageDocument(FIVE_HOUR_WINDOW_DOCUMENT, {
          present: reported,
        });
      }
    } catch (error) {
      debug("Failed to access the 5-hour window observation:", error);
    }
    return reported ?? true;
  }

  /** Block info for this render, or null when there is no 5-hour window. */
  async getBlockInfo(
    rateLimits: ClaudeHookData["rate_limits"],
  ): Promise<BlockInfo | null> {
    if (!(await this.hasFiveHourWindow(rateLimits))) {
      debug("Block segment: No 5-hour window reported, hiding");
      return null;
    }
    return this.getActiveBlockInfo(rateLimits?.five_hour ?? undefined);
  }

  async getActiveBlockInfo(rateLimits?: {
    used_percentage: number;
    resets_at: number;
  }): Promise<BlockInfo> {
    try {
      const entries = await this.loadUsageEntries();

      if (entries.length === 0) {
        debug("Block segment: No entries in current block");
        return {
          cost: null,
          tokens: null,
          weightedTokens: null,
          timeRemaining: null,
          timeElapsed: null,
          burnRate: null,
          tokenBurnRate: null,
          rateLimitPercentage: rateLimits?.used_percentage ?? null,
          resetsAt: rateLimits?.resets_at
            ? new Date(rateLimits.resets_at * 1000)
            : null,
          projectedUsagePercentage: null,
          projectedUsageTrend: null,
          lastNonFlatTrend: null,
          minutesToLimit: null,
        };
      }

      const totalCost = entries.reduce((sum, entry) => sum + entry.costUSD, 0);
      const totalTokens = entries.reduce((sum, entry) => {
        return (
          sum +
          entry.usage.inputTokens +
          entry.usage.outputTokens +
          entry.usage.cacheCreationInputTokens +
          entry.usage.cacheReadInputTokens
        );
      }, 0);

      const weightedTokens = entries.reduce((sum, entry) => {
        const entryTokens =
          entry.usage.inputTokens +
          entry.usage.outputTokens +
          entry.usage.cacheCreationInputTokens +
          entry.usage.cacheReadInputTokens;
        const weight = getModelRateLimitWeight(entry.model);
        return sum + entryTokens * weight;
      }, 0);

      const now = new Date();
      let timeRemaining: number | null = null;

      if (rateLimits?.resets_at) {
        const resetTime = new Date(rateLimits.resets_at * 1000);
        timeRemaining = Math.max(
          0,
          Math.round((resetTime.getTime() - now.getTime()) / (1000 * 60)),
        );
      } else if (entries.length > 0) {
        const firstEntry = entries[0];
        if (firstEntry) {
          const sessionDurationMs = this.sessionDurationHours * 60 * 60 * 1000;
          const blockStartTime = this.floorToHour(firstEntry.timestamp);
          const sessionEndTime = new Date(
            blockStartTime.getTime() + sessionDurationMs,
          );

          timeRemaining = Math.max(
            0,
            Math.round(
              (sessionEndTime.getTime() - now.getTime()) / (1000 * 60),
            ),
          );
        }
      }

      const sessionDurationMinutes = this.sessionDurationHours * 60;
      const timeElapsed =
        timeRemaining !== null ? sessionDurationMinutes - timeRemaining : null;

      let burnRate: number | null = null;
      let tokenBurnRate: number | null = null;

      if (entries.length >= 1 && (totalCost > 0 || totalTokens > 0)) {
        const timestamps = entries
          .map((entry) => entry.timestamp)
          .sort((a, b) => a.getTime() - b.getTime());
        const firstEntry = timestamps[0];
        const lastEntry = timestamps[timestamps.length - 1];

        if (firstEntry && lastEntry) {
          const durationMinutes =
            (lastEntry.getTime() - firstEntry.getTime()) / (1000 * 60);

          if (durationMinutes > 0) {
            if (totalCost > 0) {
              burnRate = (totalCost / durationMinutes) * 60;
            }

            if (totalTokens > 0) {
              tokenBurnRate = (totalTokens / durationMinutes) * 60;
            }
          }
        }
      }

      debug(
        `Block segment: $${totalCost.toFixed(2)}, ${totalTokens} tokens, ${timeRemaining}m remaining, burn rate: ${burnRate ? "$" + burnRate.toFixed(2) + "/hr" : "N/A"}`,
      );

      let projectedUsagePercentage: number | null = null;
      let projectedUsageTrend: "up" | "down" | "flat" | null = null;
      let lastNonFlatTrend: "up" | "down" | null = null;
      let minutesToLimit: number | null = null;
      if (
        rateLimits?.used_percentage != null &&
        timeElapsed !== null &&
        timeElapsed > 0 &&
        timeRemaining !== null
      ) {
        const ratePerMinute = rateLimits.used_percentage / timeElapsed;
        projectedUsagePercentage =
          rateLimits.used_percentage + ratePerMinute * timeRemaining;
        if (projectedUsagePercentage > 100) {
          minutesToLimit = Math.round(
            (100 - rateLimits.used_percentage) / ratePerMinute,
          );
        }

        const previousProjected = await CacheManager.getTrend("block");
        if (previousProjected !== null) {
          const diff = projectedUsagePercentage - previousProjected;
          if (diff > 1) {
            projectedUsageTrend = "up";
            await CacheManager.setLastTrendDirection("block", "up");
          } else if (diff < -1) {
            projectedUsageTrend = "down";
            await CacheManager.setLastTrendDirection("block", "down");
          } else {
            projectedUsageTrend = "flat";
          }
        }
        lastNonFlatTrend = await CacheManager.getLastTrendDirection("block");
        await CacheManager.setTrend("block", projectedUsagePercentage);
      }

      return {
        cost: totalCost,
        tokens: totalTokens,
        weightedTokens,
        timeRemaining,
        timeElapsed,
        burnRate,
        tokenBurnRate,
        rateLimitPercentage: rateLimits?.used_percentage ?? null,
        resetsAt: rateLimits?.resets_at
          ? new Date(rateLimits.resets_at * 1000)
          : null,
        projectedUsagePercentage,
        projectedUsageTrend,
        lastNonFlatTrend,
        minutesToLimit,
      };
    } catch (error) {
      debug("Error getting active block info:", error);
      return {
        cost: null,
        tokens: null,
        weightedTokens: null,
        timeRemaining: null,
        timeElapsed: null,
        burnRate: null,
        tokenBurnRate: null,
        rateLimitPercentage: rateLimits?.used_percentage ?? null,
        resetsAt: rateLimits?.resets_at
          ? new Date(rateLimits.resets_at * 1000)
          : null,
        projectedUsagePercentage: null,
        projectedUsageTrend: null,
        lastNonFlatTrend: null,
        minutesToLimit: null,
      };
    }
  }
}
