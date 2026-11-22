import { debug } from "../utils/logger";
import { PricingService } from "./pricing";
import {
  findTranscriptFile,
  findAgentTranscripts,
  parseJsonlFileFrom,
  type ParsedEntry,
  type ClaudeHookData,
} from "../utils/claude";
import { CacheManager } from "../utils/cache";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";

export interface SessionUsageEntry {
  timestamp: string;
  message: {
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  costUSD?: number;
}

export interface SessionUsage {
  totalCost: number;
  breakdown: TokenBreakdown;
  entryCount: number;
}

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface SessionInfo {
  cost: number | null;
  calculatedCost: number | null;
  officialCost: number | null;
  tokens: number | null;
  tokenBreakdown: TokenBreakdown | null;
}

export interface UsageInfo {
  session: SessionInfo;
}

/** Running totals for one transcript file, valid up to `endOffset`. */
interface FileTotals {
  endOffset: number;
  size: number;
  mtimeMs: number;
  /** Inode at endOffset; a file replaced by a rename gets a new one. */
  ino: number;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  totalCost: number;
  usageEntryCount: number;
  /** True when the last parse stopped at its byte budget with bytes left. */
  capped?: boolean;
}

/** Cached document: one per session, keyed by transcript file path. */
interface SessionTotalsDocument {
  version: 1;
  files: Record<string, FileTotals>;
}

const SESSION_TOTALS_VERSION = 1;

/** Transcript bytes parsed per render across the main and subagent files. */
export const SESSION_PARSE_BUDGET_BYTES = 16 * 1024 * 1024;

const OFFSET_KEYS = ["endOffset", "size"] as const;
const TOTAL_KEYS = [
  "input",
  "output",
  "cacheCreation",
  "cacheRead",
  "totalCost",
  "usageEntryCount",
] as const;

function emptyTotals(): FileTotals {
  return {
    endOffset: 0,
    size: 0,
    mtimeMs: 0,
    ino: 0,
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
    totalCost: 0,
    usageEntryCount: 0,
  };
}

function documentName(sessionId: string): string {
  return `session-totals-${sessionId.replace(/[^\w-]/g, "_")}`;
}

function isValidRecord(value: unknown): value is FileTotals {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    OFFSET_KEYS.every(
      (k) => Number.isSafeInteger(rec[k]) && (rec[k] as number) >= 0,
    ) &&
    TOTAL_KEYS.every(
      (k) => Number.isFinite(rec[k]) && (rec[k] as number) >= 0,
    ) &&
    // Inodes can exceed 2^53 (NTFS file ids), so only require a number.
    Number.isFinite(rec.ino) &&
    (rec.ino as number) >= 0 &&
    Number.isFinite(rec.mtimeMs) &&
    (rec.capped === undefined || typeof rec.capped === "boolean")
  );
}

async function loadDocument(name: string): Promise<Record<string, FileTotals>> {
  const doc = await CacheManager.getUsageDocument(name);
  if (!doc || doc.version !== SESSION_TOTALS_VERSION || !doc.files) return {};
  return doc.files as Record<string, FileTotals>;
}

async function addEntries(
  totals: FileTotals,
  entries: ParsedEntry[],
): Promise<void> {
  for (const entry of entries) {
    const usage = entry.message?.usage;
    if (!usage) continue;
    totals.input += usage.input_tokens || 0;
    totals.output += usage.output_tokens || 0;
    totals.cacheCreation += usage.cache_creation_input_tokens || 0;
    totals.cacheRead += usage.cache_read_input_tokens || 0;
    totals.totalCost +=
      entry.costUSD !== undefined
        ? entry.costUSD
        : await PricingService.calculateCostForEntry(entry.raw);
    totals.usageEntryCount++;
  }
}

/**
 * Brings one file's totals up to date, reading only the bytes appended since
 * the stored endOffset. A smaller file (truncated) or a new inode (replaced)
 * restarts at 0. Transcripts are append only, so a file rewritten in place to
 * at least its old size is not detected. At most maxBytes are parsed; a capped
 * file keeps its partial totals and is flagged so the next render continues. A file that is gone returns null; any other failure keeps
 * the stored totals, so a transient error neither drops the file from this
 * render nor forces a full re-parse on the next one.
 */
async function refreshFileTotals(
  filePath: string,
  stored: unknown,
  maxBytes: number,
): Promise<{ totals: FileTotals | null; spent: number }> {
  const previous = isValidRecord(stored) ? stored : null;
  let stats;
  try {
    stats = await stat(filePath);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { totals: null, spent: 0 };
    }
    debug(`Failed to stat transcript ${filePath}:`, error);
    return { totals: previous, spent: 0 };
  }

  let totals = previous ?? emptyTotals();
  if (stats.size < totals.endOffset || stats.ino !== totals.ino) {
    totals = emptyTotals();
  }
  if (
    !totals.capped &&
    stats.size === totals.size &&
    stats.mtimeMs === totals.mtimeMs
  ) {
    return { totals, spent: 0 };
  }

  const next = { ...totals };
  let spent = 0;
  try {
    const { entries, endOffset, capped } = await parseJsonlFileFrom(
      filePath,
      totals.endOffset,
      maxBytes,
    );
    await addEntries(next, entries);
    next.endOffset = endOffset;
    next.capped = capped;
    spent = endOffset - totals.endOffset;
  } catch (error) {
    debug(`Failed to read transcript ${filePath}:`, error);
    return { totals: previous, spent: 0 };
  }
  next.size = stats.size;
  next.mtimeMs = stats.mtimeMs;
  next.ino = stats.ino;
  return { totals: next, spent };
}

export class SessionProvider {
  async getSessionUsage(sessionId: string): Promise<SessionUsage | null> {
    try {
      const transcriptPath = await findTranscriptFile(sessionId);
      if (!transcriptPath) {
        debug(`No transcript found for session: ${sessionId}`);
        return null;
      }

      const agentTranscripts = await findAgentTranscripts(
        sessionId,
        dirname(transcriptPath),
      );
      debug(`Found ${agentTranscripts.length} agent transcripts for session`);

      const name = documentName(sessionId);
      const previous = await loadDocument(name);
      const files: Record<string, FileTotals> = {};
      let budget = SESSION_PARSE_BUDGET_BYTES;
      for (const filePath of [transcriptPath, ...agentTranscripts]) {
        const stored = previous[filePath];
        if (budget <= 0) {
          // Over budget: keep the previous record as is until a later render.
          if (isValidRecord(stored)) files[filePath] = stored;
          continue;
        }
        const { totals, spent } = await refreshFileTotals(
          filePath,
          stored,
          budget,
        );
        budget -= spent;
        if (totals) files[filePath] = totals;
      }

      await CacheManager.setUsageDocument(name, {
        version: SESSION_TOTALS_VERSION,
        files,
      } satisfies SessionTotalsDocument);
      await CacheManager.pruneSessionDocuments();

      return this.sumTotals(Object.values(files));
    } catch (error) {
      debug(`Error reading session usage for ${sessionId}:`, error);
      return null;
    }
  }

  private sumTotals(all: FileTotals[]): SessionUsage {
    const usage: SessionUsage = {
      totalCost: 0,
      breakdown: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      entryCount: 0,
    };
    for (const t of all) {
      usage.totalCost += t.totalCost;
      usage.breakdown.input += t.input;
      usage.breakdown.output += t.output;
      usage.breakdown.cacheCreation += t.cacheCreation;
      usage.breakdown.cacheRead += t.cacheRead;
      usage.entryCount += t.usageEntryCount;
    }
    return usage;
  }

  calculateTokenBreakdown(entries: SessionUsageEntry[]): TokenBreakdown {
    return entries.reduce(
      (breakdown, entry) => ({
        input: breakdown.input + (entry.message.usage.input_tokens || 0),
        output: breakdown.output + (entry.message.usage.output_tokens || 0),
        cacheCreation:
          breakdown.cacheCreation +
          (entry.message.usage.cache_creation_input_tokens || 0),
        cacheRead:
          breakdown.cacheRead +
          (entry.message.usage.cache_read_input_tokens || 0),
      }),
      { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    );
  }

  async getSessionInfo(
    sessionId: string,
    hookData?: ClaudeHookData,
  ): Promise<SessionInfo> {
    const sessionUsage = await this.getSessionUsage(sessionId);

    if (!sessionUsage || sessionUsage.entryCount === 0) {
      return {
        cost: null,
        calculatedCost: null,
        officialCost: null,
        tokens: null,
        tokenBreakdown: null,
      };
    }

    const tokenBreakdown = sessionUsage.breakdown;
    const totalTokens =
      tokenBreakdown.input +
      tokenBreakdown.output +
      tokenBreakdown.cacheCreation +
      tokenBreakdown.cacheRead;

    const calculatedCost = sessionUsage.totalCost;
    const hookDataCost = hookData?.cost?.total_cost_usd ?? null;
    const cost = calculatedCost ?? hookDataCost;

    return {
      cost,
      calculatedCost,
      officialCost: hookDataCost,
      tokens: totalTokens,
      tokenBreakdown,
    };
  }
}

export class UsageProvider {
  private sessionProvider = new SessionProvider();

  async getUsageInfo(
    sessionId: string,
    hookData?: ClaudeHookData,
  ): Promise<UsageInfo> {
    try {
      debug(`Starting usage info retrieval for session: ${sessionId}`);

      const sessionInfo = await this.sessionProvider.getSessionInfo(
        sessionId,
        hookData,
      );

      return {
        session: sessionInfo,
      };
    } catch (error) {
      debug(`Error getting usage info for session ${sessionId}:`, error);
      return {
        session: {
          cost: null,
          calculatedCost: null,
          officialCost: null,
          tokens: null,
          tokenBreakdown: null,
        },
      };
    }
  }
}
