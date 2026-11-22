import { open, stat as fsStat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { debug } from "./logger";
import { CacheManager } from "./cache";
import {
  getClaudePaths,
  findProjectPaths,
  collectProjectFiles,
  parseJsonlFileFrom,
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
  type UsageFileRecord,
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
 * Wall time the lock holder may spend parsing transcripts before it stops
 * taking new files and persists what it has. Claude Code replaces a render
 * after a few seconds, and a holder killed before persisting leaves the next
 * holder the same backlog, so progress has to land in chunks.
 */
export const PARSE_BUDGET_MS = 1_500;

/**
 * Bytes one file may contribute to a single parse. A first parse of an 86 MB
 * transcript takes about 10 s, longer than a render lives, so it would never
 * persist; capped at this size a file is bootstrapped across several renders
 * instead, each one checkpointing its offset. At roughly 8 MB/s this keeps a
 * single chunk near one second.
 */
export const PARSE_CHUNK_BYTES = 8 * 1024 * 1024;

/** Read size for the backward scan that finds the start of a line. */
const LINE_SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * Indirection over fs.stat so tests can observe exactly which paths a sweep
 * touches. Production code always goes through the real stat.
 */
export const usageIndexInternals = {
  /** Overridable so tests can force the budget to run out. */
  parseBudgetMs: PARSE_BUDGET_MS,
  /** Overridable so tests can split a small file into several chunks. */
  parseChunkBytes: PARSE_CHUNK_BYTES,
  parseFrom: parseJsonlFileFrom,
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

function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Returns the offset of the first byte of the line containing byte
 * `offset`: `offset` itself when the byte before it is a newline,
 * otherwise just after the previous newline (0 when there is none).
 */
async function lineStartAtOrBefore(
  filePath: string,
  offset: number,
): Promise<number> {
  const handle = await open(filePath, "r");
  try {
    let end = offset;
    while (end > 0) {
      const start = Math.max(0, end - LINE_SCAN_CHUNK_BYTES);
      const buf = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(buf, 0, buf.length, start);
      const newline = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline !== -1) return start + newline + 1;
      end = start;
    }
    return 0;
  } finally {
    await handle.close();
  }
}

/** Where a re-parse starts and whether it extends the file's hot entries. */
interface ParsePlan {
  startOffset: number;
  append: boolean;
  /** Resuming a record written before parsedOffset existed. */
  legacy: boolean;
}

/**
 * Plans the parse of a stale candidate. A record without parsedOffset comes
 * from a build that parsed every file whole, so its hot entries reflect a
 * parse up to at least its stored size: it resumes from the start of the
 * line holding that byte (a line that was partial then was not parsed) and
 * the hash dedupe drops any overlap. Treating it as offset 0 instead would
 * re-parse every transcript at once, the from-scratch rebuild that never
 * finished on 2026-09-08. A file smaller than its resume point was
 * truncated or replaced and is parsed whole.
 */
async function planParse(
  known: UsageFileRecord | undefined,
  file: IndexCandidate,
): Promise<ParsePlan> {
  const whole = { startOffset: 0, append: false, legacy: false };
  if (!known) return whole;

  const legacy = !isOffset(known.parsedOffset);
  const resumeAt = legacy ? known.size : known.parsedOffset;
  if (!isOffset(resumeAt) || file.size < resumeAt) return whole;
  if (!legacy) return { startOffset: resumeAt, append: true, legacy };

  const startOffset = await lineStartAtOrBefore(file.filePath, resumeAt);
  return { startOffset, append: true, legacy };
}

/**
 * Drops entries of a new chunk that the file's hot entries already hold.
 * dedupeWithinFile keeps the earliest copy per hash, which for an append only
 * transcript is the copy an earlier chunk already stored. Entries folded into
 * buckets are at or below foldedUpToMs and were filtered out before this.
 * A legacy resume can re-read a few lines the old whole-file parse already
 * stored; those without a hash cannot be matched, so any that are not newer
 * than the newest stored entry are taken to be that overlap.
 */
function dropSeenInFile(
  entries: RawUsageEntry[],
  previous: HotEntry[],
  legacy: boolean,
): RawUsageEntry[] {
  const seen = new Set(previous.map((entry) => entry[7]));
  const newestMs = legacy
    ? previous.reduce((max, entry) => Math.max(max, entry[0]), -Infinity)
    : -Infinity;
  return entries.filter((entry) =>
    entry.hash ? !seen.has(entry.hash) : entry.timestampMs > newestMs,
  );
}

/** How much one refresh may parse, both measured from its start. */
interface ParseLimits {
  /** performance.now() past which no further file is taken. */
  deadlineMs: number;
  /** Bytes a single file may contribute to one parse. */
  chunkBytes: number;
}

interface ParsedChunk {
  entries: RawUsageEntry[];
  endOffset: number;
  /** The parse stopped at the chunk cap; complete lines may remain. */
  capped: boolean;
}

async function parseChunk(
  filePath: string,
  startOffset: number,
  maxBytes: number,
): Promise<ParsedChunk> {
  const parsed = await usageIndexInternals.parseFrom(
    filePath,
    startOffset,
    maxBytes,
  );
  const raw = await Promise.all(parsed.entries.map(toRawEntry));
  return {
    entries: dedupeWithinFile(
      raw.filter((e): e is RawUsageEntry => e !== null),
    ),
    endOffset: parsed.endOffset,
    capped: parsed.capped,
  };
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

/**
 * Drops the entries of a chunk that are already counted elsewhere. For a
 * known file that is its own folded prefix: transcripts are append only, so
 * that prefix never changes. The strict comparison is safe at the boundary:
 * a fold takes every entry older than the 26 h horizon in one pass, so two
 * entries sharing the millisecond at foldedUpToMs were folded together, and
 * an appended line always carries a fresh timestamp far above it. A file
 * under fork detection (never seen before, or still being bootstrapped from
 * a first parse the chunk cap cut short) is also checked against the folded
 * hash set, chunk by chunk, so copied history never counts twice.
 */
async function dropFolded(
  bundle: IndexBundle,
  file: IndexCandidate,
  known: UsageFileRecord | undefined,
  entries: RawUsageEntry[],
): Promise<RawUsageEntry[]> {
  const unfolded = known
    ? entries.filter((entry) => entry.timestampMs > known.foldedUpToMs)
    : entries;
  return isForkChecked(known)
    ? dropAlreadyFolded(bundle, file.filePath, unfolded)
    : unfolded;
}

function isForkChecked(known: UsageFileRecord | undefined): boolean {
  return !known || known.forkCheckPending === true;
}

/**
 * The record after a parse. It keeps the real (mtime, size) the sweep saw;
 * a capped parse is marked instead, which is what keeps the file stale (and
 * stat'ed by quick sweeps) until a parse reaches its end.
 */
function parsedRecord(
  file: IndexCandidate,
  known: UsageFileRecord | undefined,
  endOffset: number,
  capped: boolean,
): UsageFileRecord {
  const record: UsageFileRecord = {
    mtimeMs: file.mtimeMs,
    size: file.size,
    foldedUpToMs: known?.foldedUpToMs ?? 0,
    parsedOffset: endOffset,
  };
  if (capped) record.parseCapped = true;
  if (capped && isForkChecked(known)) record.forkCheckPending = true;
  return record;
}

/**
 * Parses up to `chunkBytes` of what a stale file gained since its last parse
 * and stores it. Returns true when the chunk cap left complete lines unread,
 * so the file still needs another parse. Throws on I/O errors, leaving the
 * record untouched so a later sweep retries it.
 */
async function reparseFile(
  bundle: IndexBundle,
  file: IndexCandidate,
  chunkBytes: number,
): Promise<boolean> {
  const index = bundle.index;
  const known = index.files[file.filePath];
  const plan = await planParse(known, file);
  const chunk = await parseChunk(file.filePath, plan.startOffset, chunkBytes);
  const entries = await dropFolded(bundle, file, known, chunk.entries);
  const previous = plan.append ? (index.hot[file.filePath] ?? []) : [];
  const added = dropSeenInFile(entries, previous, plan.legacy);
  // A cap that stopped at or past the size this sweep saw left none of
  // those bytes unread; whatever was appended since moves (mtime, size), so
  // the file is stale again without the marker. Treating it as capped would
  // hold the full sweep back one more render for nothing.
  const capped = chunk.capped && chunk.endOffset < file.size;

  index.files[file.filePath] = parsedRecord(
    file,
    known,
    chunk.endOffset,
    capped,
  );
  index.hot[file.filePath] = [
    ...previous,
    ...added.map((entry) => toHotEntry(index, entry)),
  ];
  return capped;
}

interface ReparseResult {
  /** Stale candidates found. */
  stale: number;
  reparsed: number;
  /**
   * Stale candidates left for a later sweep: skipped because the budget ran
   * out, or parsed only up to the chunk cap. A partial trailing line is not
   * deferral; it waits for the file to change like any up-to-date file.
   */
  deferred: number;
}

function isStale(index: UsageIndex, candidate: IndexCandidate): boolean {
  const existing = index.files[candidate.filePath];
  return (
    !existing ||
    existing.parseCapped === true ||
    existing.mtimeMs !== candidate.mtimeMs ||
    existing.size !== candidate.size
  );
}

/** Rough count of bytes a candidate still has to parse. */
function pendingBytes(index: UsageIndex, candidate: IndexCandidate): number {
  const known = index.files[candidate.filePath];
  const resumeAt = known ? (known.parsedOffset ?? known.size) : 0;
  return resumeAt <= candidate.size
    ? candidate.size - resumeAt
    : candidate.size;
}

/**
 * Re-parses the candidates whose (mtime, size) no longer match the index,
 * cheapest first so live sessions (a few appended lines each) stay current
 * while a backlog is worked off. Once the deadline passes it stops taking
 * new files; their records stay as they were, so they are still stale for
 * the next holder. At least one file is always parsed, so every holder makes
 * progress, and no file contributes more than one chunk per holder, so a
 * huge transcript is bootstrapped across several renders, each persisting
 * its offset, instead of a parse no render lives long enough to finish.
 */
async function reparseChanged(
  bundle: IndexBundle,
  candidates: IndexCandidate[],
  limits: ParseLimits,
): Promise<ReparseResult> {
  const index = bundle.index;
  const stale = candidates
    .filter((candidate) => isStale(index, candidate))
    .map((candidate) => ({ candidate, cost: pendingBytes(index, candidate) }))
    .sort((a, b) => a.cost - b.cost)
    .map(({ candidate }) => candidate);

  let attempted = 0;
  let reparsed = 0;
  let capped = 0;
  for (const file of stale) {
    if (attempted > 0 && performance.now() >= limits.deadlineMs) break;
    attempted++;
    try {
      if (await reparseFile(bundle, file, limits.chunkBytes)) capped++;
      reparsed++;
    } catch (error) {
      debug(`usageIndex: failed to parse ${file.filePath}:`, error);
    }
  }

  const deferred = stale.length - attempted + capped;
  return { stale: stale.length, reparsed, deferred };
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
  limits: ParseLimits,
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

  const result = await reparseChanged(
    bundle,
    discovered.map(toCandidate),
    limits,
  );
  // A sweep cut short by the budget or the chunk cap keeps the old
  // timestamp, so the next holder sweeps fully again and picks up the
  // deferred files. The drops
  // above are still sound: discovery itself saw every directory.
  if (result.deferred === 0) index.lastFullSweepMs = nowMs;

  debug(
    `usageIndex: ${discovered.length - result.stale} file(s) reused, ${result.reparsed} re-parsed, ${dropped} dropped, ${result.deferred} deferred (full sweep)`,
  );
  return result.reparsed > 0 || dropped > 0;
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
 * A file whose parse the chunk cap cut short is stat'ed however old it is,
 * so a large transcript keeps being bootstrapped between full sweeps.
 *
 * Known gap: a session resumed after more than RECENT_FILE_WINDOW_MS idle is
 * picked up by the next full sweep, at most FULL_SWEEP_INTERVAL_MS later.
 * Deletions, retention and folding are likewise only applied on a full sweep.
 */
async function quickSweep(
  bundle: IndexBundle,
  projectPaths: string[],
  nowMs: number,
  limits: ParseLimits,
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
        (record.mtimeMs >= recentCutoffMs || record.parseCapped === true) &&
        !candidates.has(filePath),
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

  const result = await reparseChanged(bundle, [...candidates.values()], limits);
  debug(
    `usageIndex: ${candidates.size - result.stale} file(s) reused, ${result.reparsed} re-parsed, 0 dropped, ${result.deferred} deferred (quick sweep)`,
  );
  return result.reparsed > 0;
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
  // The budget runs from here, not from the first parse: discovery and stat
  // take render time too, and a holder killed before it persists loses all
  // of it.
  const startedMs = performance.now();
  const nowMs = Date.now();
  const projectPaths = await findProjectPaths(getClaudePaths());
  const needsFullSweep =
    Object.keys(bundle.index.files).length === 0 ||
    nowMs - bundle.index.lastFullSweepMs > FULL_SWEEP_INTERVAL_MS;

  // Only a holder that persists is budgeted and chunked: a cut-short
  // in-memory build would serve partial totals with nothing on disk to
  // resume from.
  const limits: ParseLimits = opts.persist
    ? {
        deadlineMs: startedMs + usageIndexInternals.parseBudgetMs,
        chunkBytes: usageIndexInternals.parseChunkBytes,
      }
    : {
        deadlineMs: Number.POSITIVE_INFINITY,
        chunkBytes: Number.POSITIVE_INFINITY,
      };
  let changed = needsFullSweep
    ? await fullSweep(bundle, projectPaths, nowMs, limits)
    : await quickSweep(bundle, projectPaths, nowMs, limits);

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
