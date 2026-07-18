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
const CACHE_TTL_MS = 60 * 1000;

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

interface CachedScopedLimit {
  displayName: string;
  usedPercentage: number;
  resetsAt: string | null;
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

export class WeeklyScopedProvider {
  async getWeeklyScopedInfo(): Promise<WeeklyScopedInfo> {
    try {
      const cached = await CacheManager.getUsageCache(
        "weeklyScoped",
        Date.now() - CACHE_TTL_MS,
      );
      if (cached?.limits) {
        debug("Using cached scoped weekly limits");
        return { limits: fromCachedLimits(cached.limits) };
      }

      const token = await readOAuthToken();
      const body = token ? await fetchUsageData(token) : null;
      const limits = body ? parseScopedLimits(body) : [];

      // Cache failures as empty results too, so a broken fetch or missing
      // credentials never causes a network attempt on every render.
      await CacheManager.setUsageCache("weeklyScoped", {
        limits: toCachedLimits(limits),
      });

      debug(`Scoped weekly limits: ${limits.length} found`);
      return { limits };
    } catch (error) {
      debug("Error getting scoped weekly info:", error);
      return { limits: [] };
    }
  }
}
