import { stat } from "node:fs/promises";
import { debug } from "./logger";
import { CacheManager } from "./cache";
import { parseJsonlFileFrom, type ParsedEntry } from "./claude";

/** Most transcript bytes one render parses, so it can persist inside the 5 s statusline window. */
export const PARSE_CHUNK_BYTES = 8 * 1024 * 1024;

interface StateDocument<S> {
  version: number;
  endOffset: number;
  size: number;
  mtimeMs: number;
  /** Inode and path the offset belongs to; a mismatch means a replaced file. */
  ino: number;
  filePath: string;
  /** True when the parse stopped at the chunk limit, so more bytes remain. */
  capped?: boolean;
  state: S;
}

export interface IncrementalStateOptions<S> {
  filePath: string;
  /** Usage document name; must pass the CacheManager name guard. */
  documentName: string;
  /** Bump to discard documents written by an older state shape. */
  version: number;
  initial: () => S;
  isValid: (value: unknown) => value is S;
  /** Folds newly appended entries into the state; may mutate and return it. */
  fold: (state: S, entries: ParsedEntry[]) => S;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isStoredDocument<S>(
  doc: unknown,
  opts: IncrementalStateOptions<S>,
): doc is StateDocument<S> {
  if (typeof doc !== "object" || doc === null) return false;
  const d = doc as Record<string, unknown>;
  return (
    d.version === opts.version &&
    isSafeOffset(d.endOffset) &&
    isSafeOffset(d.size) &&
    // Inodes can exceed 2^53 (NTFS file ids), so only require a number.
    isFiniteNumber(d.ino) &&
    d.ino >= 0 &&
    isFiniteNumber(d.mtimeMs) &&
    d.mtimeMs >= 0 &&
    typeof d.filePath === "string" &&
    (d.capped === undefined || typeof d.capped === "boolean") &&
    opts.isValid(d.state)
  );
}

/**
 * Derived state for one transcript, kept up to date by reading only the bytes
 * appended since the last render, at most PARSE_CHUNK_BYTES per render: a
 * capped parse is stored with its new offset and flagged, so the next render
 * continues instead of taking the unchanged shortcut. Unchanged size and mtime
 * on a complete document means no read; a file smaller than the stored offset,
 * with another inode or path, or a missing or invalid document restarts at 0.
 * The document is written once per changed render. Resolves null when the file cannot be stat-ed or read.
 */
export async function readIncrementalState<S>(
  opts: IncrementalStateOptions<S>,
): Promise<S | null> {
  let stats;
  try {
    stats = await stat(opts.filePath);
  } catch (error) {
    debug(`Transcript stat failed for ${opts.filePath}: ${String(error)}`);
    return null;
  }

  const stored = await CacheManager.getUsageDocument(opts.documentName);
  const usable =
    isStoredDocument(stored, opts) &&
    stored.filePath === opts.filePath &&
    stored.ino === stats.ino &&
    stats.size >= stored.endOffset;
  if (
    usable &&
    !stored.capped &&
    stats.size === stored.size &&
    stats.mtimeMs === stored.mtimeMs
  ) {
    return stored.state;
  }

  const startOffset = usable ? stored.endOffset : 0;
  const base = usable ? stored.state : opts.initial();
  try {
    const { entries, endOffset, capped } = await parseJsonlFileFrom(
      opts.filePath,
      startOffset,
      PARSE_CHUNK_BYTES,
    );
    const state = opts.fold(base, entries);
    await CacheManager.setUsageDocument(opts.documentName, {
      version: opts.version,
      endOffset,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ino: stats.ino,
      filePath: opts.filePath,
      ...(capped ? { capped: true } : {}),
      state,
    } satisfies StateDocument<S>);
    await CacheManager.pruneSessionDocuments();
    return state;
  } catch (error) {
    debug(`Transcript read failed for ${opts.filePath}: ${String(error)}`);
    return null;
  }
}
