import { stat } from "node:fs/promises";
import { debug } from "./logger";
import { CacheManager } from "./cache";
import { parseJsonlFileFrom, type ParsedEntry } from "./claude";

interface StateDocument<S> {
  version: number;
  endOffset: number;
  size: number;
  mtimeMs: number;
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

function isStoredDocument<S>(
  doc: unknown,
  opts: IncrementalStateOptions<S>,
): doc is StateDocument<S> {
  if (typeof doc !== "object" || doc === null) return false;
  const d = doc as Record<string, unknown>;
  return (
    d.version === opts.version &&
    isFiniteNumber(d.endOffset) &&
    isFiniteNumber(d.size) &&
    isFiniteNumber(d.mtimeMs) &&
    opts.isValid(d.state)
  );
}

/**
 * Derived state for one transcript, kept up to date by reading only the bytes
 * appended since the last render. Unchanged size and mtime means no read; a
 * file smaller than the stored offset (truncated or replaced) or a missing or
 * invalid document restarts at 0. The document is written once per changed
 * render. Resolves null when the file cannot be stat-ed or read.
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
    isStoredDocument(stored, opts) && stats.size >= stored.endOffset;
  if (
    usable &&
    stats.size === stored.size &&
    stats.mtimeMs === stored.mtimeMs
  ) {
    return stored.state;
  }

  const startOffset = usable ? stored.endOffset : 0;
  const base = usable ? stored.state : opts.initial();
  try {
    const { entries, endOffset } = await parseJsonlFileFrom(
      opts.filePath,
      startOffset,
    );
    const state = opts.fold(base, entries);
    await CacheManager.setUsageDocument(opts.documentName, {
      version: opts.version,
      endOffset,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      state,
    } satisfies StateDocument<S>);
    return state;
  } catch (error) {
    debug(`Transcript read failed for ${opts.filePath}: ${String(error)}`);
    return null;
  }
}
