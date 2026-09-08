import { stat as fsStat } from "node:fs/promises";
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
  /**
   * Epoch ms of the last full sweep (readdir plus stat of every project
   * directory). Between full sweeps only files that can plausibly have
   * changed are stat'ed; see quickSweep.
   */
  lastFullSweepMs: number;
  files: Record<string, FileIndexRecord>;
}

/** A file the current sweep considers for (re)parsing. */
interface IndexCandidate {
  filePath: string;
  mtimeMs: number;
  size: number;
}

// Retention is fixed regardless of the caller's `since`, so block (24h),
// today (midnight) and weekly (Monday minus a lookback day) all share one
// index built from the same file set. 8 days comfortably covers weekly's
// widest window (week start minus 1 day for the file-mtime margin).
export const USAGE_INDEX_RETENTION_DAYS = 8;

// Stays at 1: the per-file record shape is unchanged since v1.22.0, and
// lastFullSweepMs is optional on read (normalized to 0, which forces one
// full sweep). Bumping the version would reject every existing index and
// trigger a from-scratch re-parse of all transcripts under the fetch lock,
// which a killed render never finishes while every other render serves the
// rejected file as empty (observed 2026-09-08, card #2428).
const FILE_INDEX_VERSION = 1;
const FETCH_LOCK_NAME = "fileIndex";
const FULL_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const RECENT_FILE_WINDOW_MS = 6 * 60 * 60 * 1000;
// Linux stamps inode times from a coarse clock (one timer tick), so a
// directory written just after a sweep can carry an mtime a few ms older
// than the sweep's own Date.now(). Comparing against a padded threshold
// keeps such a directory visible; the cost is one extra readdir for renders
// that land within the padding of a full sweep.
const DIR_MTIME_SLACK_MS = 2_000;

/**
 * Indirection over fs.stat so tests can observe exactly which paths a sweep
 * touches. Production code always goes through the real stat.
 */
export const usageIndexInternals = {
  async stat(path: string): Promise<{ mtimeMs: number; size: number }> {
    const stats = await fsStat(path);
    // Rounded to whole ms the same way Node builds stats.mtime from the
    // float mtimeMs, so a quick-sweep stat compares equal to the Date-derived
    // mtime a full sweep records for the same file.
    return { mtimeMs: Math.round(stats.mtimeMs), size: stats.size };
  },
};

function emptyIndex(): FileIndex {
  return { version: FILE_INDEX_VERSION, lastFullSweepMs: 0, files: {} };
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
    if (typeof raw.lastFullSweepMs !== "number") {
      raw.lastFullSweepMs = 0;
    }
    return raw;
  } catch (error) {
    debug("usageIndex: failed to parse file index, treating as empty:", error);
    return emptyIndex();
  }
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

function retentionFilter(
  nowMs: number,
): (filePath: string, modTime: Date) => boolean {
  const cutoffMs = nowMs - USAGE_INDEX_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return (_filePath: string, modTime: Date): boolean =>
    modTime.getTime() >= cutoffMs;
}

function toCandidate(file: {
  filePath: string;
  mtime: Date;
  size: number;
}): IndexCandidate {
  return {
    filePath: file.filePath,
    mtimeMs: file.mtime.getTime(),
    size: file.size,
  };
}

/** Re-parses the candidates whose (mtime, size) no longer match the index. */
async function reparseChanged(
  index: FileIndex,
  candidates: IndexCandidate[],
): Promise<number> {
  const stale = candidates.filter((candidate) => {
    const existing = index.files[candidate.filePath];
    return (
      !existing ||
      existing.mtimeMs !== candidate.mtimeMs ||
      existing.size !== candidate.size
    );
  });

  await Promise.all(
    stale.map(async (file) => {
      const entries = await parseFileForIndex(file.filePath);
      index.files[file.filePath] = {
        mtimeMs: file.mtimeMs,
        size: file.size,
        entries,
      };
    }),
  );

  return stale.length;
}

/**
 * Reads every project directory and stats every transcript in it. This is the
 * only place records are dropped, both for files gone from disk and for files
 * that aged out of the retention window.
 */
async function fullSweep(
  index: FileIndex,
  projectPaths: string[],
  nowMs: number,
): Promise<boolean> {
  const keepFile = retentionFilter(nowMs);
  const discoveredResults = await Promise.all(
    projectPaths.map((projectPath) =>
      collectProjectFiles(projectPath, keepFile),
    ),
  );
  const discovered = discoveredResults.flat();
  const discoveredPaths = new Set(discovered.map((f) => f.filePath));

  let dropped = 0;
  for (const filePath of Object.keys(index.files)) {
    if (!discoveredPaths.has(filePath)) {
      delete index.files[filePath];
      dropped++;
    }
  }

  const reparsed = await reparseChanged(index, discovered.map(toCandidate));
  index.lastFullSweepMs = nowMs;

  debug(
    `usageIndex: ${discovered.length - reparsed} file(s) reused, ${reparsed} re-parsed, ${dropped} dropped (full sweep)`,
  );
  return reparsed > 0 || dropped > 0;
}

async function statDirectoryMtime(dirPath: string): Promise<number | null> {
  try {
    return (await usageIndexInternals.stat(dirPath)).mtimeMs;
  } catch (error) {
    debug(`usageIndex: failed to stat directory ${dirPath}:`, error);
    return null;
  }
}

/**
 * Between full sweeps only files that can plausibly have changed are stat'ed.
 * A directory's mtime moves when a transcript is created, deleted or renamed,
 * but not when an existing one is appended to, so a directory untouched since
 * the last full sweep can only hold files the index already knows; of those,
 * only the ones written inside RECENT_FILE_WINDOW_MS belong to a session that
 * could still be running.
 *
 * Known gap: a session resumed after more than RECENT_FILE_WINDOW_MS idle is
 * picked up by the next full sweep, at most FULL_SWEEP_INTERVAL_MS later.
 * Deletions and retention are likewise only applied on a full sweep.
 */
async function quickSweep(
  index: FileIndex,
  projectPaths: string[],
  nowMs: number,
): Promise<boolean> {
  const keepFile = retentionFilter(nowMs);
  const candidates = new Map<string, IndexCandidate>();

  const rediscovered = await Promise.all(
    projectPaths.map(async (projectPath) => {
      const dirMtimeMs = await statDirectoryMtime(projectPath);
      const unchangedBefore = index.lastFullSweepMs - DIR_MTIME_SLACK_MS;
      if (dirMtimeMs === null || dirMtimeMs < unchangedBefore) return [];
      return collectProjectFiles(projectPath, keepFile);
    }),
  );
  for (const file of rediscovered.flat()) {
    candidates.set(file.filePath, toCandidate(file));
  }

  const recentCutoffMs = nowMs - RECENT_FILE_WINDOW_MS;
  const recentPaths = Object.entries(index.files)
    .filter(
      ([filePath, record]) =>
        record.mtimeMs >= recentCutoffMs && !candidates.has(filePath),
    )
    .map(([filePath]) => filePath);

  await Promise.all(
    recentPaths.map(async (filePath) => {
      try {
        const snapshot = await usageIndexInternals.stat(filePath);
        candidates.set(filePath, { filePath, ...snapshot });
      } catch (error) {
        debug(`usageIndex: failed to stat ${filePath}:`, error);
      }
    }),
  );

  const reparsed = await reparseChanged(index, [...candidates.values()]);
  debug(
    `usageIndex: ${candidates.size - reparsed} file(s) reused, ${reparsed} re-parsed, 0 dropped (quick sweep)`,
  );
  return reparsed > 0;
}

async function refreshIndex(
  index: FileIndex,
  opts: { persist: boolean } = { persist: true },
): Promise<void> {
  const nowMs = Date.now();
  const projectPaths = await findProjectPaths(getClaudePaths());
  const needsFullSweep =
    Object.keys(index.files).length === 0 ||
    nowMs - index.lastFullSweepMs > FULL_SWEEP_INTERVAL_MS;

  const changed = needsFullSweep
    ? await fullSweep(index, projectPaths, nowMs)
    : await quickSweep(index, projectPaths, nowMs);

  // A full sweep always persists, if only to record its own timestamp;
  // otherwise the next render would sweep fully all over again.
  if (opts.persist && (changed || needsFullSweep)) {
    await CacheManager.setFileIndex(index);
  }
}

/**
 * Claims the shared index for this render, refreshes it and returns it.
 * Statusline renders race each other, so the claim is a single try, never a
 * wait: a reader that loses the race takes the index as it stands and skips
 * discovery, stat, parse and write entirely. It then serves the previous
 * render's index, at most one render stale.
 */
async function buildIndex(): Promise<FileIndex> {
  const lockAcquired = await CacheManager.tryAcquireFetchLock(FETCH_LOCK_NAME);
  if (!lockAcquired) {
    const index = await readFileIndex();
    if (Object.keys(index.files).length > 0) {
      debug("usageIndex: index lock held elsewhere, serving the index as is");
      return index;
    }
    // Cold cache (fresh install, cleared cache dir, or the first concurrent
    // renders after a format change): there is no previous index to serve,
    // and an empty one would render every segment as zero usage. Build a
    // private copy in memory instead; the lock holder owns the write.
    debug(
      "usageIndex: lock held elsewhere and no index on disk, building in memory",
    );
    await refreshIndex(index, { persist: false });
    return index;
  }

  try {
    const index = await readFileIndex();
    await refreshIndex(index);
    return index;
  } finally {
    await CacheManager.releaseFetchLock(FETCH_LOCK_NAME);
  }
}

let indexPromise: Promise<FileIndex> | null = null;

/**
 * One index load per process. The block, today and weekly segments all ask
 * for entries during the same render, and discovery plus the multi-MB read
 * is the dominant cost, so the first caller does the work and the rest await
 * the same promise.
 */
function loadIndex(): Promise<FileIndex> {
  if (!indexPromise) {
    indexPromise = buildIndex().catch((error) => {
      indexPromise = null;
      throw error;
    });
  }
  return indexPromise;
}

/** Test hook: drops the per-process memo so each case starts cold. */
export function resetUsageIndexMemoForTests(): void {
  indexPromise = null;
}

function selectEntries(index: FileIndex, since: Date): IndexedUsageEntry[] {
  const sinceMs = since.getTime();
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
  const index = await loadIndex();
  return selectEntries(index, opts.since);
}
