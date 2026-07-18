import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { debug } from "../utils/logger";
import { getClaudePaths } from "../utils/claude";
import { CacheManager } from "../utils/cache";

export interface ScopedWeeklyLimit {
  /** Model display name from the API, e.g. "Fable" or "Sonnet" */
  displayName: string;
  usedPercentage: number;
  resetsAt: Date | null;
}

export interface WeeklyScopedInfo {
  limits: ScopedWeeklyLimit[];
}

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const FETCH_TIMEOUT_MS = 5000;
const OK_TTL_MS = 60 * 1000;
// Longer backoff after failures: the usage endpoint rate-limits per account
// and rejected requests may themselves count against the limit.
const ERROR_BACKOFF_MS = 5 * 60 * 1000;

interface RawUsageLimit {
  kind?: string;
  percent?: number;
  resets_at?: string | null;
  scope?: {
    model?: {
      display_name?: string | null;
    } | null;
  } | null;
}

export interface CachedScopedLimit {
  displayName: string;
  usedPercentage: number;
  resetsAt: string | null;
}

export interface WeeklyScopedCacheEntry {
  status: "ok" | "error";
  /** When this status was recorded */
  at: number;
  /** Limits from the most recent successful fetch */
  limits: CachedScopedLimit[];
  lastSuccessAt: number | null;
}

/**
 * Extract model-scoped weekly limits from the /api/oauth/usage response.
 * The server models per-model weekly caps as `limits[]` entries with
 * `kind: "weekly_scoped"` and the model name in `scope.model.display_name`;
 * plans without a secondary weekly limit simply have no such entries.
 */
export function parseScopedLimits(body: unknown): ScopedWeeklyLimit[] {
  if (!body || typeof body !== "object") {
    return [];
  }

  const limits = (body as { limits?: unknown }).limits;
  if (!Array.isArray(limits)) {
    return [];
  }

  const scoped: ScopedWeeklyLimit[] = [];
  for (const entry of limits as RawUsageLimit[]) {
    if (entry?.kind !== "weekly_scoped") {
      continue;
    }
    const displayName = entry.scope?.model?.display_name;
    if (!displayName || typeof entry.percent !== "number") {
      continue;
    }
    const parsedReset = entry.resets_at ? new Date(entry.resets_at) : null;
    scoped.push({
      displayName,
      usedPercentage: entry.percent,
      resetsAt:
        parsedReset && !Number.isNaN(parsedReset.getTime())
          ? parsedReset
          : null,
    });
  }

  return scoped;
}

async function readOAuthToken(): Promise<string | null> {
  for (const claudePath of getClaudePaths()) {
    const credentialsPath = join(claudePath, ".credentials.json");
    try {
      const content = await readFile(credentialsPath, "utf-8");
      const credentials = JSON.parse(content);
      const oauth = credentials?.claudeAiOauth;
      const token = oauth?.accessToken;
      if (typeof token !== "string" || token.length === 0) {
        continue;
      }
      if (
        typeof oauth.expiresAt === "number" &&
        oauth.expiresAt <= Date.now()
      ) {
        debug("OAuth token expired, skipping scoped weekly limit fetch");
        return null;
      }
      return token;
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        debug(`Failed to read credentials from ${credentialsPath}:`, error);
      }
    }
  }
  return null;
}

async function fetchUsageData(token: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      debug(`Usage endpoint returned HTTP ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    debug("Failed to fetch usage data:", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toCachedLimits(limits: ScopedWeeklyLimit[]): CachedScopedLimit[] {
  return limits.map((limit) => ({
    displayName: limit.displayName,
    usedPercentage: limit.usedPercentage,
    resetsAt: limit.resetsAt ? limit.resetsAt.toISOString() : null,
  }));
}

function fromCachedLimits(limits: CachedScopedLimit[]): ScopedWeeklyLimit[] {
  return limits.map((limit) => ({
    displayName: limit.displayName,
    usedPercentage: limit.usedPercentage,
    resetsAt: limit.resetsAt ? new Date(limit.resetsAt) : null,
  }));
}

function isValidCachedLimit(limit: unknown): limit is CachedScopedLimit {
  if (!limit || typeof limit !== "object") {
    return false;
  }
  const candidate = limit as Partial<CachedScopedLimit>;
  return (
    typeof candidate.displayName === "string" &&
    typeof candidate.usedPercentage === "number" &&
    (candidate.resetsAt === null || typeof candidate.resetsAt === "string")
  );
}

function isKnownEntryShape(entry: unknown): entry is WeeklyScopedCacheEntry {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const candidate = entry as Partial<WeeklyScopedCacheEntry>;
  return (
    (candidate.status === "ok" || candidate.status === "error") &&
    typeof candidate.at === "number" &&
    Array.isArray(candidate.limits)
  );
}

export function isCacheEntryFresh(
  entry: WeeklyScopedCacheEntry | null | undefined,
  now: number,
): boolean {
  if (!isKnownEntryShape(entry)) {
    return false;
  }
  const age = now - entry.at;
  // A future timestamp (clock skew) would otherwise stay fresh forever.
  if (age < 0) {
    return false;
  }
  return age < (entry.status === "ok" ? OK_TTL_MS : ERROR_BACKOFF_MS);
}

/**
 * Fold a fetch outcome into the next cache entry. A successful response is
 * authoritative even when it contains no scoped limits (the plan simply has
 * none); a failed fetch (body null) carries the previous successful limits
 * forward so the segment can serve stale data instead of hiding.
 */
export function buildCacheEntry(
  previous: WeeklyScopedCacheEntry | null,
  body: unknown,
  now: number,
): WeeklyScopedCacheEntry {
  if (body) {
    return {
      status: "ok",
      at: now,
      limits: toCachedLimits(parseScopedLimits(body)),
      lastSuccessAt: now,
    };
  }
  return {
    status: "error",
    at: now,
    limits: (previous?.limits ?? []).filter(isValidCachedLimit),
    lastSuccessAt: previous?.lastSuccessAt ?? null,
  };
}

/**
 * Limits that are still meaningful to render: a stale percentage whose reset
 * time has passed belongs to a finished weekly window and is dropped.
 */
export function limitsFromCacheEntry(
  entry: WeeklyScopedCacheEntry,
  now: number,
): ScopedWeeklyLimit[] {
  const cachedLimits = Array.isArray(entry?.limits)
    ? entry.limits.filter(isValidCachedLimit)
    : [];
  return fromCachedLimits(cachedLimits).filter(
    (limit) => !limit.resetsAt || limit.resetsAt.getTime() > now,
  );
}

export class WeeklyScopedProvider {
  async getWeeklyScopedInfo(): Promise<WeeklyScopedInfo> {
    try {
      const now = Date.now();
      const raw = await CacheManager.getUsageCache("weeklyScoped");
      // Legacy or corrupted cache entries ({limits} without status/at, or a
      // non-array limits field) are ambiguous, so they neither count as
      // fresh nor seed the stale fallback.
      const cached = isKnownEntryShape(raw) ? raw : null;

      if (cached && isCacheEntryFresh(cached, now)) {
        debug(`Using cached scoped weekly limits (status: ${cached.status})`);
        return { limits: limitsFromCacheEntry(cached, now) };
      }
      const token = await readOAuthToken();
      const body = token ? await fetchUsageData(token) : null;
      const entry = buildCacheEntry(cached, body, now);
      await CacheManager.setUsageCache("weeklyScoped", entry);

      const limits = limitsFromCacheEntry(entry, now);
      debug(
        `Scoped weekly limits: ${limits.length} usable (fetch ${entry.status})`,
      );
      return { limits };
    } catch (error) {
      debug("Error getting scoped weekly info:", error);
      return { limits: [] };
    }
  }
}
