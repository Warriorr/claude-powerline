import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { debug } from "../utils/logger";
import { CACHE_TIMER_DOCUMENT_PREFIX } from "../utils/cache";
import { readIncrementalState } from "../utils/transcriptState";
import type { ClaudeHookData, ParsedEntry } from "../utils/claude";

export interface CacheTimerInfo {
  elapsedSeconds: number;
  detectedTtlSeconds?: number;
}

interface CacheTimerState {
  lastUserTimestampMs: number | null;
  lastTtlSeconds: number | null;
}

const CACHE_TIMER_STATE_VERSION = 1;

function isCacheTimerState(value: unknown): value is CacheTimerState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const ok = (x: unknown): boolean => x === null || typeof x === "number";
  return ok(v.lastUserTimestampMs) && ok(v.lastTtlSeconds);
}

function ttlFromEntry(raw: any): number | null {
  const cc = raw?.message?.usage?.cache_creation;
  if (!cc) return null;
  if ((cc.ephemeral_1h_input_tokens ?? 0) > 0) return 3600;
  if ((cc.ephemeral_5m_input_tokens ?? 0) > 0) return 300;
  return null;
}

/** Later entries win, so folding appended chunks equals one full scan. */
function foldCacheTimer(
  state: CacheTimerState,
  entries: ParsedEntry[],
): CacheTimerState {
  for (const { raw: rawEntry } of entries) {
    const raw = rawEntry as any;
    const role = raw.type || raw.message?.role || raw.message?.type;
    if (role === "user") {
      const t = Date.parse(raw.timestamp);
      if (!Number.isNaN(t)) state.lastUserTimestampMs = t;
    } else if (role === "assistant") {
      state.lastTtlSeconds = ttlFromEntry(raw) ?? state.lastTtlSeconds;
    }
  }
  return state;
}

function stateDocumentName(transcriptPath: string): string {
  const hash = createHash("sha1").update(transcriptPath).digest("hex");
  return `${CACHE_TIMER_DOCUMENT_PREFIX}${hash.slice(0, 16)}`;
}

export class CacheTimerProvider {
  async getCacheTimerInfo(
    hookData: ClaudeHookData,
  ): Promise<CacheTimerInfo | null> {
    const path = hookData?.transcript_path;
    if (!path) {
      debug("CacheTimer: no transcript_path in hookData");
      return null;
    }

    const state = await readIncrementalState<CacheTimerState>({
      filePath: path,
      documentName: stateDocumentName(path),
      version: CACHE_TIMER_STATE_VERSION,
      initial: () => ({ lastUserTimestampMs: null, lastTtlSeconds: null }),
      isValid: isCacheTimerState,
      fold: foldCacheTimer,
    });
    const anchor = state?.lastUserTimestampMs ?? (await this.fileMtime(path));
    if (anchor === null) return null;

    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - anchor) / 1000),
    );
    const detectedTtlSeconds = state?.lastTtlSeconds ?? undefined;
    return { elapsedSeconds, detectedTtlSeconds };
  }

  private async fileMtime(path: string): Promise<number | null> {
    try {
      const { mtime } = await stat(path);
      return mtime.getTime();
    } catch (error) {
      debug(`CacheTimer: stat failed for ${path}: ${String(error)}`);
      return null;
    }
  }
}
