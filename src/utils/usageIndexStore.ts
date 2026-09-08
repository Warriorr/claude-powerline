import { CacheManager } from "./cache";
import { debug } from "./logger";

/**
 * On-disk format of the shared usage index (version 2).
 *
 * Version 1 stored every parsed transcript entry verbatim, which grew to tens
 * of MB and was re-read and rewritten on every render. Version 2 keeps only
 * the recent entries raw ("hot") and folds everything older than the hot
 * horizon into fixed 15 minute (slot, model) buckets, which collapses months
 * of history into a few hundred rows.
 */
export const USAGE_INDEX_VERSION = 2;

/** Retention for both file records and folded buckets, in days. */
export const USAGE_INDEX_RETENTION_DAYS = 8;

/**
 * Entries younger than this stay raw. Block asks for 24 h and today for at
 * most 25 h (local midnight in the westernmost offset), so both windows are
 * always served entirely from raw entries and never see a folded bucket.
 */
export const HOT_HORIZON_MS = 26 * 60 * 60 * 1000;

/**
 * Bucket width. Every real timezone offset is a multiple of 15 minutes, so
 * weekly's local-midnight `since` always lands on a slot boundary.
 */
export const BUCKET_SLOT_MS = 15 * 60 * 1000;

const INDEX_DOCUMENT = "usage-index";
const HASHES_DOCUMENT = "folded-hashes";
const LEGACY_DOCUMENT = "file-index";

/**
 * A raw entry, stored as a tuple to keep the document small:
 * [timestamp, input, output, cacheCreation, cacheRead, costUSD, modelIdx, hash]
 */
export type HotEntry = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  string | null,
];

/**
 * A folded (slot, model) bucket:
 * [costUSD, input, output, cacheCreation, cacheRead, count, firstTs, lastTs]
 */
export type UsageBucket = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface UsageFileRecord {
  mtimeMs: number;
  size: number;
  /** Newest timestamp already folded for this file; re-parses skip that prefix. */
  foldedUpToMs: number;
}

export interface UsageIndex {
  version: number;
  lastFullSweepMs: number;
  /** Every entry older than this that was known at the last fold is bucketed. */
  foldedBeforeMs: number;
  models: string[];
  files: Record<string, UsageFileRecord>;
  hot: Record<string, HotEntry[]>;
  buckets: Record<string, UsageBucket>;
}

export interface FoldedHashes {
  version: number;
  /** Hashes of folded entries, grouped by UTC day so pruning is by key. */
  days: Record<string, string[]>;
}

/** The parse-time shape, before a model index is assigned. */
export interface RawUsageEntry {
  timestampMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUSD: number;
  model: string;
  hash: string | null;
}

export function emptyIndex(): UsageIndex {
  return {
    version: USAGE_INDEX_VERSION,
    lastFullSweepMs: 0,
    foldedBeforeMs: 0,
    models: [],
    files: {},
    hot: {},
    buckets: {},
  };
}

export function emptyHashes(): FoldedHashes {
  return { version: USAGE_INDEX_VERSION, days: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidIndex(value: unknown): value is UsageIndex {
  return (
    isRecord(value) &&
    value.version === USAGE_INDEX_VERSION &&
    isRecord(value.files) &&
    isRecord(value.hot) &&
    isRecord(value.buckets) &&
    Array.isArray(value.models)
  );
}

function isValidHashes(value: unknown): value is FoldedHashes {
  return (
    isRecord(value) &&
    value.version === USAGE_INDEX_VERSION &&
    isRecord(value.days)
  );
}

/** Returns the dictionary index of `model`, appending it when new. */
export function modelIndexFor(index: UsageIndex, model: string): number {
  const existing = index.models.indexOf(model);
  if (existing !== -1) return existing;
  index.models.push(model);
  return index.models.length - 1;
}

export function slotStartMs(timestampMs: number): number {
  return Math.floor(timestampMs / BUCKET_SLOT_MS) * BUCKET_SLOT_MS;
}

export function bucketKey(slotStart: number, modelIdx: number): string {
  return `${slotStart}|${modelIdx}`;
}

export function parseBucketKey(
  key: string,
): { slotStart: number; modelIdx: number } | null {
  const [slotPart, modelPart] = key.split("|");
  const slotStart = Number(slotPart);
  const modelIdx = Number(modelPart);
  if (!Number.isFinite(slotStart) || !Number.isFinite(modelIdx)) return null;
  return { slotStart, modelIdx };
}

export function utcDayKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export function toHotEntry(index: UsageIndex, entry: RawUsageEntry): HotEntry {
  return [
    entry.timestampMs,
    entry.inputTokens,
    entry.outputTokens,
    entry.cacheCreationInputTokens,
    entry.cacheReadInputTokens,
    entry.costUSD,
    modelIndexFor(index, entry.model),
    entry.hash,
  ];
}

/**
 * Keeps the first entry per hash by timestamp and drops the rest. Claude Code
 * streams one transcript line per content block, all carrying the same message
 * id, request id and usage, so a transcript is roughly half duplicates.
 */
export function dedupeWithinFile<
  T extends { timestampMs: number; hash: string | null },
>(entries: T[]): T[] {
  const sorted = [...entries].sort((a, b) => a.timestampMs - b.timestampMs);
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const entry of sorted) {
    if (entry.hash) {
      if (seen.has(entry.hash)) continue;
      seen.add(entry.hash);
    }
    kept.push(entry);
  }
  return kept;
}

function addToBucket(index: UsageIndex, entry: HotEntry): void {
  const key = bucketKey(slotStartMs(entry[0]), entry[6]);
  const existing = index.buckets[key];
  if (!existing) {
    index.buckets[key] = [
      entry[5],
      entry[1],
      entry[2],
      entry[3],
      entry[4],
      1,
      entry[0],
      entry[0],
    ];
    return;
  }
  existing[0] += entry[5];
  existing[1] += entry[1];
  existing[2] += entry[2];
  existing[3] += entry[3];
  existing[4] += entry[4];
  existing[5] += 1;
  existing[6] = Math.min(existing[6], entry[0]);
  existing[7] = Math.max(existing[7], entry[0]);
}

interface FoldCandidate {
  filePath: string;
  entry: HotEntry;
}

/** Every hot entry older than the horizon, oldest first across all files. */
export function collectFoldable(
  index: UsageIndex,
  horizonMs: number,
): FoldCandidate[] {
  const candidates: FoldCandidate[] = [];
  for (const [filePath, entries] of Object.entries(index.hot)) {
    for (const entry of entries) {
      if (entry[0] < horizonMs) candidates.push({ filePath, entry });
    }
  }
  return candidates.sort((a, b) => a.entry[0] - b.entry[0]);
}

/**
 * Moves the foldable entries into their buckets and records their hashes.
 * One pass with a seen set, oldest first, so a hash present in two files is
 * counted once and the first-by-timestamp copy wins, exactly as the query
 * time dedupe would have decided.
 */
export function applyFold(
  index: UsageIndex,
  hashes: FoldedHashes,
  candidates: FoldCandidate[],
): void {
  const alreadyFolded = new Set(Object.values(hashes.days).flat());
  const foldedUpTo = new Map<string, number>();

  for (const { filePath, entry } of candidates) {
    foldedUpTo.set(filePath, Math.max(foldedUpTo.get(filePath) ?? 0, entry[0]));
    const hash = entry[7];
    if (hash) {
      if (alreadyFolded.has(hash)) continue;
      alreadyFolded.add(hash);
      const day = utcDayKey(entry[0]);
      (hashes.days[day] ??= []).push(hash);
    }
    addToBucket(index, entry);
  }

  for (const [filePath, newest] of foldedUpTo) {
    const record = index.files[filePath];
    if (record) {
      record.foldedUpToMs = Math.max(record.foldedUpToMs, newest);
    }
    const foldedThrough = record?.foldedUpToMs ?? newest;
    index.hot[filePath] = (index.hot[filePath] ?? []).filter(
      (entry) => entry[0] > foldedThrough,
    );
  }
}

export function pruneBuckets(index: UsageIndex, nowMs: number): boolean {
  const cutoffMs = nowMs - USAGE_INDEX_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let pruned = false;
  for (const key of Object.keys(index.buckets)) {
    const parsed = parseBucketKey(key);
    if (!parsed || parsed.slotStart >= cutoffMs) continue;
    delete index.buckets[key];
    pruned = true;
  }
  return pruned;
}

export function pruneHashDays(hashes: FoldedHashes, nowMs: number): boolean {
  const cutoffDay = utcDayKey(
    nowMs - USAGE_INDEX_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  let pruned = false;
  for (const day of Object.keys(hashes.days)) {
    if (day >= cutoffDay) continue;
    delete hashes.days[day];
    pruned = true;
  }
  return pruned;
}

/** Version 1 record shape, kept only for the in-memory migration. */
interface LegacyRecord {
  mtimeMs: number;
  size: number;
  entries: Array<{
    timestamp: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    costUSD: number;
    model: string;
    hash: string | null;
  }>;
}

function isLegacyIndex(
  value: unknown,
): value is { version: number; files: Record<string, LegacyRecord> } {
  return isRecord(value) && value.version === 1 && isRecord(value.files);
}

/**
 * Converts a version 1 index without re-parsing a single transcript: dedupe
 * each record within its file, then fold everything past the hot horizon.
 * lastFullSweepMs stays 0 so the first sweep after the migration is full.
 */
export function migrateLegacyIndex(
  legacy: { files: Record<string, LegacyRecord> },
  nowMs: number,
): { index: UsageIndex; hashes: FoldedHashes } {
  const index = emptyIndex();
  const hashes = emptyHashes();

  for (const [filePath, record] of Object.entries(legacy.files)) {
    if (!isRecord(record) || !Array.isArray(record.entries)) continue;
    const entries = dedupeWithinFile(
      record.entries.map((entry) => ({
        timestampMs: entry.timestamp,
        inputTokens: entry.inputTokens ?? 0,
        outputTokens: entry.outputTokens ?? 0,
        cacheCreationInputTokens: entry.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: entry.cacheReadInputTokens ?? 0,
        costUSD: entry.costUSD ?? 0,
        model: entry.model ?? "unknown",
        hash: entry.hash ?? null,
      })),
    );
    index.files[filePath] = {
      mtimeMs: record.mtimeMs,
      size: record.size,
      foldedUpToMs: 0,
    };
    index.hot[filePath] = entries.map((entry) => toHotEntry(index, entry));
  }

  const horizonMs = nowMs - HOT_HORIZON_MS;
  applyFold(index, hashes, collectFoldable(index, horizonMs));
  pruneBuckets(index, nowMs);
  pruneHashDays(hashes, nowMs);
  index.foldedBeforeMs = horizonMs;
  return { index, hashes };
}

export interface LoadedIndex {
  index: UsageIndex;
  /** Set only by a migration, which builds the hash document in memory. */
  hashes: FoldedHashes | null;
  migratedFromV1: boolean;
}

/**
 * Reads the version 2 index, falling back to an in-memory migration of a
 * version 1 file-index.json. A reader never serves an empty index while a
 * valid old one is on disk.
 */
export async function readUsageIndex(nowMs: number): Promise<LoadedIndex> {
  let raw: unknown = null;
  try {
    raw = await CacheManager.getUsageDocument(INDEX_DOCUMENT);
  } catch (error) {
    debug(
      "usageIndex: failed to read the usage index, treating as empty:",
      error,
    );
  }

  if (isValidIndex(raw)) {
    if (typeof raw.lastFullSweepMs !== "number") raw.lastFullSweepMs = 0;
    if (typeof raw.foldedBeforeMs !== "number") raw.foldedBeforeMs = 0;
    return { index: raw, hashes: null, migratedFromV1: false };
  }
  if (raw !== null) {
    debug("usageIndex: ignoring usage index with unknown version/shape");
  }

  let legacy: unknown = null;
  try {
    legacy = await CacheManager.getUsageDocument(LEGACY_DOCUMENT);
  } catch (error) {
    debug("usageIndex: failed to read the version 1 index:", error);
  }
  if (isLegacyIndex(legacy)) {
    debug("usageIndex: migrating the version 1 index to version 2 in memory");
    const migrated = migrateLegacyIndex(legacy, nowMs);
    return { ...migrated, migratedFromV1: true };
  }
  if (legacy !== null) {
    debug("usageIndex: ignoring version 1 index with unknown shape");
  }

  return { index: emptyIndex(), hashes: null, migratedFromV1: false };
}

/**
 * Reads the folded hash set. Only the fold pass and fork detection need it,
 * so it never touches the ordinary render path.
 */
export async function readFoldedHashes(reason: string): Promise<FoldedHashes> {
  debug(`usageIndex: loading the folded hash set (${reason})`);
  try {
    const raw = await CacheManager.getUsageDocument(HASHES_DOCUMENT);
    if (isValidHashes(raw)) return raw;
    if (raw !== null) {
      debug("usageIndex: ignoring folded hashes with unknown version/shape");
    }
  } catch (error) {
    debug("usageIndex: failed to read the folded hashes:", error);
  }
  return emptyHashes();
}

export async function writeUsageIndex(index: UsageIndex): Promise<void> {
  await CacheManager.setUsageDocument(INDEX_DOCUMENT, index);
}

export async function writeFoldedHashes(hashes: FoldedHashes): Promise<void> {
  await CacheManager.setUsageDocument(HASHES_DOCUMENT, hashes);
}

export async function removeLegacyIndex(): Promise<void> {
  await CacheManager.removeUsageDocument(LEGACY_DOCUMENT);
}
