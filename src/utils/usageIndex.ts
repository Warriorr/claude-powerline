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
import {
  applyFold,
  collectFoldable,
  dedupeWithinFile,
  HOT_HORIZON_MS,
  parseBucketKey,
  pruneBuckets,
  pruneHashDays,
  readFoldedHashes,
  readUsageIndex,
  removeLegacyIndex,
  toHotEntry,
  USAGE_INDEX_RETENTION_DAYS,
  writeFoldedHashes,
  writeUsageIndex,
  type FoldedHashes,
  type HotEntry,
  type RawUsageEntry,
  type UsageBucket,
  type UsageIndex,
} from "./usageIndexStore";

export { USAGE_INDEX_RETENTION_DAYS };

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

/** A file the current sweep considers for (re)parsing. */
interface IndexCandidate {
  filePath: string;
  mtimeMs: number;
  size: number;
}

/** The index plus the lazily loaded documents that go with it. */
interface IndexBundle {
  index: UsageIndex;
  hashes: FoldedHashes | null;
  hashesDirty: boolean;
  migratedFromV1: boolean;
}

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

/** Loads the folded hash set once per process, on the paths that need it. */
async function loadHashes(
  bundle: IndexBundle,
  reason: string,
): Promise<FoldedHashes> {
  if (!bundle.hashes) {
    bundle.hashes = await readFoldedHashes(reason);
  }
  return bundle.hashes;
}

async function toRawEntry(entry: ParsedEntry): Promise<RawUsageEntry | null> {
  if (!entry.message?.usage) return null;

  let costUSD = entry.costUSD || 0;
  if (!costUSD && entry.raw) {
    costUSD = await PricingService.calculateCostForEntry(entry.raw);
  }

  return {
    timestampMs: entry.timestamp.getTime(),
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

async function parseFileForIndex(filePath: string): Promise<RawUsageEntry[]> {
  const parsedEntries = await parseJsonlFile(filePath);
  const raw = await Promise.all(parsedEntries.map(toRawEntry));
  return dedupeWithinFile(raw.filter((e): e is RawUsageEntry => e !== null));
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

/**
 * Drops entries a fork or a copied transcript brought along: a file the index
 * has never seen whose entries predate the fold watermark can only repeat
 * history another file already contributed.
 */
async function dropAlreadyFolded(
  bundle: IndexBundle,
  filePath: string,
  entries: RawUsageEntry[],
): Promise<RawUsageEntry[]> {
  const hasOldEntries = entries.some(
    (entry) => entry.timestampMs < bundle.index.foldedBeforeMs,
  );
  if (!hasOldEntries) return entries;

  const hashes = await loadHashes(bundle, `fork detection for ${filePath}`);
  const folded = new Set(Object.values(hashes.days).flat());
  return entries.filter((entry) => !entry.hash || !folded.has(entry.hash));
}

/** Re-parses the candidates whose (mtime, size) no longer match the index. */
async function reparseChanged(
  bundle: IndexBundle,
  candidates: IndexCandidate[],
): Promise<number> {
  const index = bundle.index;
  const stale = candidates.filter((candidate) => {
    const existing = index.files[candidate.filePath];
    return (
      !existing ||
      existing.mtimeMs !== candidate.mtimeMs ||
      existing.size !== candidate.size
    );
  });

  for (const file of stale) {
    const known = index.files[file.filePath];
    const parsed = await parseFileForIndex(file.filePath);
    // Transcripts are append only, so the folded prefix never changes. The
    // strict comparison is safe at the boundary: a fold takes every entry
    // older than the 26 h horizon in one pass, so two entries sharing the
    // millisecond at foldedUpToMs were folded together, and an appended line
    // always carries a fresh timestamp far above it.
    const entries = known
      ? parsed.filter((entry) => entry.timestampMs > known.foldedUpToMs)
      : await dropAlreadyFolded(bundle, file.filePath, parsed);

    index.files[file.filePath] = {
      mtimeMs: file.mtimeMs,
      size: file.size,
      foldedUpToMs: known?.foldedUpToMs ?? 0,
    };
    index.hot[file.filePath] = entries.map((entry) => toHotEntry(index, entry));
  }

  return stale.length;
}

/**
 * Reads every project directory and stats every transcript in it. This is the
 * only place records are dropped, both for files gone from disk and for files
 * that aged out of the retention window.
 */
async function fullSweep(
  bundle: IndexBundle,
  projectPaths: string[],
  nowMs: number,
): Promise<boolean> {
  const index = bundle.index;
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
      delete index.hot[filePath];
      dropped++;
    }
  }

  const reparsed = await reparseChanged(bundle, discovered.map(toCandidate));
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
 * Deletions, retention and folding are likewise only applied on a full sweep.
 */
async function quickSweep(
  bundle: IndexBundle,
  projectPaths: string[],
  nowMs: number,
): Promise<boolean> {
  const index = bundle.index;
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

  const reparsed = await reparseChanged(bundle, [...candidates.values()]);
  debug(
    `usageIndex: ${candidates.size - reparsed} file(s) reused, ${reparsed} re-parsed, 0 dropped (quick sweep)`,
  );
  return reparsed > 0;
}

/**
 * Folds every hot entry past the horizon into its 15 minute bucket, records
 * its hash for fork detection and prunes both documents to the retention
 * window. Only full sweeps fold, so the hash document is never read on the
 * ordinary render path.
 */
async function foldAndPrune(
  bundle: IndexBundle,
  nowMs: number,
): Promise<boolean> {
  const horizonMs = nowMs - HOT_HORIZON_MS;
  const foldable = collectFoldable(bundle.index, horizonMs);
  let changed = pruneBuckets(bundle.index, nowMs);

  if (foldable.length > 0) {
    const hashes = await loadHashes(
      bundle,
      `folding ${foldable.length} entries`,
    );
    applyFold(bundle.index, hashes, foldable);
    // Hash days are pruned only when the document is loaded for a fold. It
    // grows only through folds, and every fold prunes, so its size stays
    // bounded by the retention window plus one fold batch; loading 2 MB
    // every idle full sweep just to prune would cost more than it saves.
    pruneHashDays(hashes, nowMs);
    bundle.hashesDirty = true;
    changed = true;
    debug(`usageIndex: folded ${foldable.length} entries into buckets`);
  }

  bundle.index.foldedBeforeMs = horizonMs;
  return changed;
}

/**
 * Publishes the two documents. Each write is atomic on its own, but a render
 * can be killed between them, so the order matters: hashes go first. An
 * index that lags its hash document only re-folds a few entries whose
 * hashes are already recorded (harmless), whereas an index ahead of its
 * hashes would forget that a fold happened and let a later fork of that
 * history count twice, with nothing left to detect it.
 */
async function persistBundle(bundle: IndexBundle): Promise<void> {
  if (bundle.hashesDirty && bundle.hashes) {
    await writeFoldedHashes(bundle.hashes);
    bundle.hashesDirty = false;
  }
  await writeUsageIndex(bundle.index);
  // Idempotent (ENOENT is silent), so a crash after an earlier migration's
  // v2 write but before this unlink is cleaned up by the next persist.
  await removeLegacyIndex();
  bundle.migratedFromV1 = false;
}

async function refreshIndex(
  bundle: IndexBundle,
  opts: { persist: boolean } = { persist: true },
): Promise<void> {
  const nowMs = Date.now();
  const projectPaths = await findProjectPaths(getClaudePaths());
  const needsFullSweep =
    Object.keys(bundle.index.files).length === 0 ||
    nowMs - bundle.index.lastFullSweepMs > FULL_SWEEP_INTERVAL_MS;

  let changed = needsFullSweep
    ? await fullSweep(bundle, projectPaths, nowMs)
    : await quickSweep(bundle, projectPaths, nowMs);

  // Folding rewrites both documents, so it only runs on a sweep that is
  // already going to write, under the fetch lock.
  if (needsFullSweep && opts.persist) {
    changed = (await foldAndPrune(bundle, nowMs)) || changed;
  }

  // A full sweep always persists, if only to record its own timestamp;
  // otherwise the next render would sweep fully all over again.
  if (opts.persist && (changed || needsFullSweep || bundle.migratedFromV1)) {
    await persistBundle(bundle);
  }
}

function toBundle(loaded: {
  index: UsageIndex;
  hashes: FoldedHashes | null;
  migratedFromV1: boolean;
}): IndexBundle {
  return {
    index: loaded.index,
    hashes: loaded.hashes,
    // A migration builds the hash set in memory, so it has to be published
    // alongside the index that describes it.
    hashesDirty: loaded.migratedFromV1,
    migratedFromV1: loaded.migratedFromV1,
  };
}

/**
 * Claims the shared index for this render, refreshes it and returns it.
 * Statusline renders race each other, so the claim is a single try, never a
 * wait: a reader that loses the race takes the index as it stands and skips
 * discovery, stat, parse and write entirely. It then serves the previous
 * render's index, at most one render stale.
 */
async function buildIndex(): Promise<UsageIndex> {
  const lockAcquired = await CacheManager.tryAcquireFetchLock(FETCH_LOCK_NAME);
  if (!lockAcquired) {
    const bundle = toBundle(await readUsageIndex(Date.now()));
    if (Object.keys(bundle.index.files).length > 0) {
      debug("usageIndex: index lock held elsewhere, serving the index as is");
      return bundle.index;
    }
    // Cold cache (fresh install, cleared cache dir, or the first concurrent
    // renders after a format change): there is no previous index to serve,
    // and an empty one would render every segment as zero usage. Build a
    // private copy in memory instead; the lock holder owns the write.
    debug(
      "usageIndex: lock held elsewhere and no index on disk, building in memory",
    );
    await refreshIndex(bundle, { persist: false });
    return bundle.index;
  }

  try {
    const bundle = toBundle(await readUsageIndex(Date.now()));
    await refreshIndex(bundle);
    return bundle.index;
  } finally {
    await CacheManager.releaseFetchLock(FETCH_LOCK_NAME);
  }
}

let indexPromise: Promise<UsageIndex> | null = null;

/**
 * One index load per process. The block, today and weekly segments all ask
 * for entries during the same render, and discovery plus the multi-MB read
 * is the dominant cost, so the first caller does the work and the rest await
 * the same promise.
 */
function loadIndex(): Promise<UsageIndex> {
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

function materializeHot(entry: HotEntry, models: string[]): IndexedUsageEntry {
  return {
    timestamp: new Date(entry[0]),
    inputTokens: entry[1],
    outputTokens: entry[2],
    cacheCreationInputTokens: entry[3],
    cacheReadInputTokens: entry[4],
    costUSD: entry[5],
    model: models[entry[6]] ?? "unknown",
    hash: entry[7],
  };
}

/**
 * One synthetic entry standing in for a whole (slot, model) bucket. It carries
 * no hash, so it is never deduplicated, and its timestamp is the oldest entry
 * in the slot, which keeps a bucket inside the window it was folded from.
 */
function materializeBucket(
  bucket: UsageBucket,
  model: string,
): IndexedUsageEntry {
  return {
    timestamp: new Date(bucket[6]),
    inputTokens: bucket[1],
    outputTokens: bucket[2],
    cacheCreationInputTokens: bucket[3],
    cacheReadInputTokens: bucket[4],
    costUSD: bucket[0],
    model,
    hash: null,
  };
}

function selectEntries(index: UsageIndex, since: Date): IndexedUsageEntry[] {
  const sinceMs = since.getTime();
  const matching: IndexedUsageEntry[] = [];

  for (const entries of Object.values(index.hot)) {
    for (const entry of entries) {
      if (entry[0] >= sinceMs) {
        matching.push(materializeHot(entry, index.models));
      }
    }
  }

  for (const [key, bucket] of Object.entries(index.buckets)) {
    const parsed = parseBucketKey(key);
    if (!parsed || parsed.slotStart < sinceMs) continue;
    matching.push(
      materializeBucket(bucket, index.models[parsed.modelIdx] ?? "unknown"),
    );
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
 * Loads usage entries since `opts.since`, backed by an on-disk index that is
 * only rebuilt for files whose (mtime, size) changed since the last run.
 *
 * Entries newer than the hot horizon (26 h) come back raw, one per message,
 * so block can still find its 5 h gaps. Anything older is served as one
 * synthetic entry per 15 minute (slot, model) bucket, with `hash: null` and
 * the timestamp of the oldest entry in the slot: correct for callers that sum
 * (weekly), and never reached by callers whose window is 24 h or less.
 *
 * @note A `since` that reaches past the hot horizon is expected to be aligned
 *       to 15 minutes (weekly's local midnight always is); a `since` landing
 *       inside a slot drops that whole slot rather than part of it.
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
