import { stat } from "node:fs/promises";
import { debug } from "./logger";
import { CacheManager } from "./cache";
import {
  getClaudePaths,
  findProjectPaths,
  collectProjectFiles,
  parseJsonlFile,
  createUniqueHash,
  type ParsedEntry,
} from "./claude";
import { PricingService } from "../segments/pricing";

/**
 * A lean, pre-costed usage entry drawn from the shared per-file index.
 * This is the common shape consumed by the block/today/weekly segments;
 * unlike ParsedEntry it never carries the raw transcript line.
 */
export interface IndexedUsageEntry {
  timestamp: Date;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUSD: number;
  model: string;
  hash: string | null;
}

/** Serialized form stored on disk: timestamp as epoch ms, no Date objects. */
interface SerializedUsageEntry {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUSD: number;
  model: string;
  hash: string | null;
}

interface FileIndexRecord {
  mtimeMs: number;
  size: number;
  entries: SerializedUsageEntry[];
}

interface FileIndex {
  version: 1;
  files: Record<string, FileIndexRecord>;
}

// Retention is fixed regardless of the caller's `since`, so block (24h),
// today (midnight) and weekly (Monday minus a lookback day) all share one
// index built from the same file set. 8 days comfortably covers weekly's
// widest window (week start minus 1 day for the file-mtime margin).
export const USAGE_INDEX_RETENTION_DAYS = 8;

const FILE_INDEX_VERSION = 1;
const LOCK_WAIT_TOTAL_MS = 15_000;
const LOCK_WAIT_INTERVAL_MS = 100;
const FETCH_LOCK_NAME = "fileIndex";

function emptyIndex(): FileIndex {
  return { version: FILE_INDEX_VERSION, files: {} };
}

function isValidFileIndex(value: unknown): value is FileIndex {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as FileIndex).version === FILE_INDEX_VERSION &&
    typeof (value as FileIndex).files === "object" &&
    (value as FileIndex).files !== null
  );
}

async function readFileIndex(): Promise<FileIndex> {
  try {
    const raw = await CacheManager.getFileIndex();
    if (!isValidFileIndex(raw)) {
      if (raw !== null) {
        debug("usageIndex: ignoring file index with unknown version/shape");
      }
      return emptyIndex();
    }
    return raw;
  } catch (error) {
    debug("usageIndex: failed to parse file index, treating as empty:", error);
    return emptyIndex();
  }
}

/**
 * Waits (briefly, non-fatally) for a cross-process claim on the shared
 * index. Statusline renders race each other; without this, N concurrent
 * processes would each rebuild the same stale files at once. If the lock
 * can't be acquired within the budget we proceed unlocked rather than fail:
 * a duplicated rebuild is wasted work, not a correctness problem, since the
 * final write is a full-index replace.
 */
async function acquireIndexLock(): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_TOTAL_MS;
  while (Date.now() < deadline) {
    if (await CacheManager.tryAcquireFetchLock(FETCH_LOCK_NAME)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_INTERVAL_MS));
  }
  debug("usageIndex: proceeding without file-index lock (timed out waiting)");
  return false;
}

function deserialize(entry: SerializedUsageEntry): IndexedUsageEntry {
  return {
    timestamp: new Date(entry.timestamp),
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheCreationInputTokens: entry.cacheCreationInputTokens,
    cacheReadInputTokens: entry.cacheReadInputTokens,
    costUSD: entry.costUSD,
    model: entry.model,
    hash: entry.hash,
  };
}

async function toSerializedEntry(
  entry: ParsedEntry,
): Promise<SerializedUsageEntry | null> {
  if (!entry.message?.usage) return null;

  let costUSD = entry.costUSD || 0;
  if (!costUSD && entry.raw) {
    costUSD = await PricingService.calculateCostForEntry(entry.raw);
  }

  return {
    timestamp: entry.timestamp.getTime(),
    inputTokens: entry.message.usage.input_tokens || 0,
    outputTokens: entry.message.usage.output_tokens || 0,
    cacheCreationInputTokens:
      entry.message.usage.cache_creation_input_tokens || 0,
    cacheReadInputTokens: entry.message.usage.cache_read_input_tokens || 0,
    costUSD,
    model: entry.message?.model || "unknown",
    hash: createUniqueHash(entry),
  };
}

async function parseFileForIndex(
  filePath: string,
): Promise<SerializedUsageEntry[]> {
  const parsedEntries = await parseJsonlFile(filePath);
  const serialized = await Promise.all(parsedEntries.map(toSerializedEntry));
  return serialized.filter((e): e is SerializedUsageEntry => e !== null);
}

/**
 * Loads usage entries since `opts.since`, backed by an on-disk per-file
 * index that is only rebuilt for files whose (mtime, size) changed since
 * the last run. Replaces the old pattern of re-parsing every transcript
 * under ~/.claude/projects on any cache miss.
 *
 * @note Sorts entries by timestamp before deduplication (mirrors the old
 *       loadEntriesFromProjects contract) so duplicate selection is
 *       deterministic across parallel file loads, preventing flicker.
 */
export async function loadIndexedUsageEntries(opts: {
  since: Date;
}): Promise<IndexedUsageEntry[]> {
  const retentionCutoffMs =
    Date.now() - USAGE_INDEX_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const claudePaths = getClaudePaths();
  const projectPaths = await findProjectPaths(claudePaths);

  const fileFilter = (_filePath: string, modTime: Date): boolean =>
    modTime.getTime() >= retentionCutoffMs;

  const discoveredFileResults = await Promise.all(
    projectPaths.map((projectPath) =>
      collectProjectFiles(projectPath, fileFilter),
    ),
  );
  const discoveredFiles = discoveredFileResults.flat();

  const lockAcquired = await acquireIndexLock();

  try {
    const index = await readFileIndex();
    const discoveredPaths = new Set(discoveredFiles.map((f) => f.filePath));

    let dropped = 0;
    for (const filePath of Object.keys(index.files)) {
      if (!discoveredPaths.has(filePath)) {
        delete index.files[filePath];
        dropped++;
      }
    }

    const statResults = await Promise.all(
      discoveredFiles.map(async (file) => {
        try {
          const stats = await stat(file.filePath);
          return {
            filePath: file.filePath,
            mtimeMs: file.mtime.getTime(),
            size: stats.size,
          };
        } catch (error) {
          debug(`usageIndex: failed to stat ${file.filePath}:`, error);
          return null;
        }
      }),
    );

    let reused = 0;
    const filesToParse: { filePath: string; mtimeMs: number; size: number }[] =
      [];
    for (const fileStat of statResults) {
      if (!fileStat) continue;
      const existing = index.files[fileStat.filePath];
      if (
        existing &&
        existing.mtimeMs === fileStat.mtimeMs &&
        existing.size === fileStat.size
      ) {
        reused++;
        continue;
      }
      filesToParse.push(fileStat);
    }

    if (filesToParse.length > 0) {
      await Promise.all(
        filesToParse.map(async (file) => {
          const entries = await parseFileForIndex(file.filePath);
          index.files[file.filePath] = {
            mtimeMs: file.mtimeMs,
            size: file.size,
            entries,
          };
        }),
      );
    }

    debug(
      `usageIndex: ${reused} file(s) reused, ${filesToParse.length} re-parsed, ${dropped} dropped`,
    );

    if (filesToParse.length > 0 || dropped > 0) {
      await CacheManager.setFileIndex(index);
    }

    const sinceMs = opts.since.getTime();
    const matching: IndexedUsageEntry[] = [];
    for (const record of Object.values(index.files)) {
      for (const entry of record.entries) {
        if (entry.timestamp >= sinceMs) {
          matching.push(deserialize(entry));
        }
      }
    }

    matching.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const seenHashes = new Set<string>();
    const deduplicated: IndexedUsageEntry[] = [];
    for (const entry of matching) {
      if (entry.hash) {
        if (seenHashes.has(entry.hash)) continue;
        seenHashes.add(entry.hash);
      }
      deduplicated.push(entry);
    }

    return deduplicated;
  } finally {
    if (lockAcquired) {
      await CacheManager.releaseFetchLock(FETCH_LOCK_NAME);
    }
  }
}
