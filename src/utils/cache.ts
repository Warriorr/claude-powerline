import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { debug } from "./logger";

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * A tmp file older than this is treated as abandoned even when a live process
 * still owns its pid: mtime staleness deliberately wins over liveness, which
 * is what covers pid reuse and platforms where the liveness probe is not
 * reliable. The tradeoff is that a writer still running after this long loses
 * its tmp, and that is safe here: a statusline render never lives anywhere
 * near five minutes, and the worst case for one that somehow does is a single
 * skipped index update, because its rename then fails with ENOENT and is
 * caught like any other write error.
 */
export const FILE_INDEX_TMP_STALE_MS = 5 * 60 * 1000;

const FILE_INDEX_TMP_PATTERN = /^file-index\.json\.(\d+)\.tmp$/;
// Fetch lock claims write "<lock>.<pid>.tmp" and hard-link it into place, so
// they leak the same way. The published lock file has no .tmp suffix and is
// therefore never matched by this pattern.
const LOCK_TMP_PATTERN = /^.+\.(\d+)\.tmp$/;

function isProcessAlive(pid: number): boolean {
  // A malformed pid parsed out of a filename must never be read as alive:
  // process.kill would throw ERR_INVALID_ARG_TYPE, not ESRCH.
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // ESRCH means the process is gone; EPERM means it is alive but owned by
    // somebody else, so the tmp file is not ours to reclaim on pid alone.
    return error?.code !== "ESRCH";
  }
}

/** Owning pid encoded in a tmp filename, or null when the name does not match. */
function tmpOwnerPid(entry: string, pattern: RegExp): number | null {
  const match = pattern.exec(entry);
  return match ? Number(match[1]) : null;
}

export class CacheManager {
  // Getters (not readonly fields) so tests can point the whole cache at a
  // temp directory via CLAUDE_POWERLINE_CACHE_DIR after module load.
  private static get CACHE_DIR(): string {
    return (
      process.env.CLAUDE_POWERLINE_CACHE_DIR ??
      path.join(homedir(), ".claude", "powerline")
    );
  }

  private static get USAGE_CACHE_DIR(): string {
    return path.join(this.CACHE_DIR, "usage");
  }

  private static get LOCKS_DIR(): string {
    return path.join(this.CACHE_DIR, "locks");
  }

  private static isLocked(name: string): boolean {
    const lockFile = path.join(this.LOCKS_DIR, name);
    if (!fs.existsSync(lockFile)) {
      return false;
    }

    try {
      const lockContent = fs.readFileSync(lockFile, "utf-8");
      const pid = parseInt(lockContent.trim(), 10);

      if (isNaN(pid)) {
        debug(`Invalid PID in lock file ${name}, removing stale lock`);
        fs.unlinkSync(lockFile);
        return false;
      }

      try {
        process.kill(pid, 0);
        return true;
      } catch (error: any) {
        if (error.code === "ESRCH") {
          debug(`Removing stale lock file ${name} for dead process ${pid}`);
          fs.unlinkSync(lockFile);
          return false;
        }
        debug(`Error checking process ${pid} for lock ${name}:`, error);
        return true;
      }
    } catch (error) {
      debug(`Error reading lock file ${name}:`, error);
      return true;
    }
  }

  private static async acquireLock(
    name: string,
    timeout = 5000,
  ): Promise<boolean> {
    const RETRY_DELAY_MS = 50;
    const FILE_CREATE_FLAG = "wx";

    await this.ensureCacheDirectories();
    const lockFile = path.join(this.LOCKS_DIR, name);
    const startTime = Date.now();
    const lockContent = String(process.pid);

    while (Date.now() - startTime < timeout) {
      try {
        await fs.promises.writeFile(lockFile, lockContent, {
          flag: FILE_CREATE_FLAG,
        });
        debug(`Lock acquired for ${name}`);
        return true;
      } catch (error: any) {
        if (error.code === "EEXIST") {
          await setTimeout(RETRY_DELAY_MS);
        } else {
          throw error;
        }
      }
    }
    debug(`Failed to acquire lock for ${name} within ${timeout}ms`);
    return false;
  }

  /**
   * Non-blocking cross-process claim for "I am fetching <name> right now".
   * Statusline renders race each other constantly; the loser must serve
   * cached data immediately rather than wait on the winner's network call,
   * so unlike acquireLock this never retries. Stale locks from dead
   * processes are cleaned up by the isLocked check.
   */
  static async tryAcquireFetchLock(name: string): Promise<boolean> {
    const lockName = `${name}.fetch.lock`;
    await this.ensureCacheDirectories();
    if (this.isLocked(lockName)) {
      return false;
    }
    const lockFile = path.join(this.LOCKS_DIR, lockName);
    // Claim via hard link instead of writeFile with "wx": writeFile creates
    // the file empty before writing content, and a concurrent isLocked can
    // read that empty window as a corrupt lock and delete it, allowing two
    // winners. link() is atomic and the content is complete on arrival.
    const tempFile = `${lockFile}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(tempFile, String(process.pid));
      await fs.promises.link(tempFile, lockFile);
      debug(`Fetch lock acquired for ${name}`);
      return true;
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        debug(`Error acquiring fetch lock for ${name}:`, error);
      }
      return false;
    } finally {
      await fs.promises.unlink(tempFile).catch(() => {});
    }
  }

  static async releaseFetchLock(name: string): Promise<void> {
    await this.releaseLock(`${name}.fetch.lock`);
  }

  private static async releaseLock(name: string): Promise<void> {
    const lockFile = path.join(this.LOCKS_DIR, name);
    try {
      await fs.promises.unlink(lockFile);
      debug(`Lock released for ${name}`);
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        debug(`Error releasing lock for ${name}:`, error);
      }
    }
  }

  static async ensureCacheDirectories(): Promise<void> {
    try {
      await Promise.all([
        fs.promises.mkdir(this.CACHE_DIR, { recursive: true }),
        fs.promises.mkdir(this.USAGE_CACHE_DIR, { recursive: true }),
        fs.promises.mkdir(this.LOCKS_DIR, { recursive: true }),
      ]);
    } catch (error) {
      debug("Failed to create cache directories:", error);
    }
  }

  static createProjectHash(projectPath: string): string {
    return createHash("md5").update(projectPath).digest("hex").substring(0, 8);
  }

  static async getUsageCache(
    cacheType: "today" | "block" | "pricing" | "weekly" | "weeklyScoped",
    latestMtime?: number,
  ): Promise<any | null> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 75;
    const FILE_ENCODING = "utf-8";

    await this.ensureCacheDirectories();
    const cachePath = path.join(this.USAGE_CACHE_DIR, `${cacheType}.json`);
    const lockName = `${cacheType}.usage.lock`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const isCurrentlyLocked = this.isLocked(lockName);
      if (isCurrentlyLocked) {
        debug(`Cache for ${cacheType} is locked, waiting...`);
        await setTimeout(RETRY_DELAY_MS);
        continue;
      }

      try {
        const content = await fs.promises.readFile(cachePath, FILE_ENCODING);
        const cached: CacheEntry<any> = JSON.parse(content);
        const cacheIsValid = !latestMtime || cached.timestamp >= latestMtime;

        if (cacheIsValid) {
          debug(`[CACHE-HIT] ${cacheType} disk cache: found`);
          return this.deserializeDates(cached.data);
        } else {
          debug(
            `${cacheType} cache outdated: cache=${cached.timestamp}, latest=${latestMtime}`,
          );
          return null;
        }
      } catch (error: any) {
        if (error.code === "ENOENT") {
          debug(`No shared ${cacheType} usage cache found`);
          return null;
        }
        const attemptNumber = attempt + 1;
        debug(
          `Attempt ${attemptNumber} failed to read ${cacheType} cache: ${error.message}. Retrying...`,
        );
        await setTimeout(RETRY_DELAY_MS);
      }
    }

    debug(`Failed to read ${cacheType} cache after ${MAX_RETRIES} attempts.`);
    return null;
  }

  private static deserializeDates(data: any): any {
    if (Array.isArray(data)) {
      return data.map((entry) => ({
        ...entry,
        timestamp: new Date(entry.timestamp),
      }));
    }
    return data;
  }

  static async setUsageCache(
    cacheType: "today" | "block" | "pricing" | "weekly" | "weeklyScoped",
    data: any,
    latestMtime?: number,
  ): Promise<void> {
    const lockName = `${cacheType}.usage.lock`;
    const lockAcquired = await this.acquireLock(lockName);
    if (!lockAcquired) {
      debug(`Could not acquire lock to set usage cache for ${cacheType}`);
      return;
    }

    try {
      await this.ensureCacheDirectories();
      const cachePath = path.join(this.USAGE_CACHE_DIR, `${cacheType}.json`);
      const cacheTimestamp = latestMtime || Date.now();
      const cacheEntry: CacheEntry<any> = {
        data,
        timestamp: cacheTimestamp,
      };
      const cacheContent = JSON.stringify(cacheEntry);

      await fs.promises.writeFile(cachePath, cacheContent, "utf-8");
      debug(`[CACHE-SET] ${cacheType} disk cache stored`);
    } catch (error) {
      debug(`Failed to save ${cacheType} usage cache:`, error);
    } finally {
      await this.releaseLock(lockName);
    }
  }

  /**
   * Reads the raw per-file usage index (see src/utils/usageIndex.ts).
   * Unlike getUsageCache, this is not a timestamp-gated snapshot: it stores
   * one incremental record per transcript file, so it is read and written
   * directly with no envelope or freshness check. Callers are responsible
   * for their own content-based invalidation (mtime + size per file).
   */
  static async getFileIndex(): Promise<any | null> {
    await this.ensureCacheDirectories();
    const indexPath = path.join(this.USAGE_CACHE_DIR, "file-index.json");
    try {
      const content = await fs.promises.readFile(indexPath, "utf-8");
      return JSON.parse(content);
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        debug(`Failed to read file index: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Removes tmp files abandoned by other processes, both the file index tmps
   * in the usage cache and the fetch lock claim tmps in the locks directory.
   * Either one is orphaned when a render is killed between write and publish
   * (session exit, or a faster refresh superseding a slow one); the index is
   * multi-MB, so those add up fast. A tmp is reclaimed when its owning process
   * is gone OR when its mtime is past FILE_INDEX_TMP_STALE_MS, whose docstring
   * explains why staleness is allowed to win over liveness. Best effort only:
   * every failure is logged and ignored so a sweep can never block the write
   * that follows it.
   */
  static async sweepStaleFileIndexTemps(): Promise<void> {
    await this.sweepStaleTemps(this.USAGE_CACHE_DIR, FILE_INDEX_TMP_PATTERN);
    await this.sweepStaleTemps(this.LOCKS_DIR, LOCK_TMP_PATTERN);
  }

  private static async sweepStaleTemps(
    dir: string,
    pattern: RegExp,
  ): Promise<void> {
    const now = Date.now();
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch (error: any) {
      debug(`Failed to list ${dir} for tmp sweep: ${error?.message}`);
      return;
    }

    const candidates = entries
      .map((entry) => ({ entry, pid: tmpOwnerPid(entry, pattern) }))
      .filter(
        (candidate): candidate is { entry: string; pid: number } =>
          candidate.pid !== null && candidate.pid !== process.pid,
      );

    for (const { entry, pid } of candidates) {
      const tmpPath = path.join(dir, entry);
      let expired = false;
      try {
        const stats = await fs.promises.lstat(tmpPath);
        expired = now - stats.mtimeMs > FILE_INDEX_TMP_STALE_MS;
      } catch (error: any) {
        debug(`Failed to stat stale tmp ${entry}: ${error?.message}`);
        continue;
      }

      if (!expired && isProcessAlive(pid)) {
        continue;
      }

      try {
        await fs.promises.unlink(tmpPath);
        debug(`Removed orphaned tmp file ${entry}`);
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          debug(`Failed to remove orphaned tmp ${entry}: ${error?.message}`);
        }
      }
    }
  }

  static async setFileIndex(data: any): Promise<void> {
    await this.ensureCacheDirectories();
    await this.sweepStaleFileIndexTemps();
    const indexPath = path.join(this.USAGE_CACHE_DIR, "file-index.json");
    const tempPath = `${indexPath}.${process.pid}.tmp`;
    // SIGKILL cannot be trapped, so a killed render still leaks a tmp; that
    // case is reclaimed by the sweep above on the next write.
    const onSigterm = (): void => {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Nothing to clean up, or we are already exiting: never block the exit.
      }
      process.removeListener("SIGTERM", onSigterm);
      process.kill(process.pid, "SIGTERM");
    };
    process.on("SIGTERM", onSigterm);
    try {
      await fs.promises.writeFile(tempPath, JSON.stringify(data), "utf-8");
      // Rename is atomic on the same filesystem, so concurrent readers never
      // observe a partially written index.
      await fs.promises.rename(tempPath, indexPath);
      debug("[CACHE-SET] fileIndex disk index stored");
    } catch (error) {
      debug("Failed to save file index:", error);
      await fs.promises.unlink(tempPath).catch(() => {});
    } finally {
      process.removeListener("SIGTERM", onSigterm);
    }
  }

  static async getTrend(key: "block" | "weekly"): Promise<number | null> {
    try {
      await this.ensureCacheDirectories();
      const trendPath = path.join(this.USAGE_CACHE_DIR, "trends.json");
      const content = await fs.promises.readFile(trendPath, "utf-8");
      const trends = JSON.parse(content);
      return trends[key] ?? null;
    } catch {
      return null;
    }
  }

  static async setTrend(key: "block" | "weekly", value: number): Promise<void> {
    try {
      await this.ensureCacheDirectories();
      const trendPath = path.join(this.USAGE_CACHE_DIR, "trends.json");
      let trends: Record<string, number | string> = {};
      try {
        const content = await fs.promises.readFile(trendPath, "utf-8");
        trends = JSON.parse(content);
      } catch {
        // file doesn't exist yet
      }
      trends[key] = value;
      await fs.promises.writeFile(trendPath, JSON.stringify(trends), "utf-8");
    } catch (error) {
      debug("Failed to save trend:", error);
    }
  }

  static async getLastTrendDirection(
    key: "block" | "weekly",
  ): Promise<"up" | "down" | null> {
    try {
      await this.ensureCacheDirectories();
      const trendPath = path.join(this.USAGE_CACHE_DIR, "trends.json");
      const content = await fs.promises.readFile(trendPath, "utf-8");
      const trends = JSON.parse(content);
      const val = trends[`${key}_direction`];
      return val === "up" || val === "down" ? val : null;
    } catch {
      return null;
    }
  }

  static async setLastTrendDirection(
    key: "block" | "weekly",
    direction: "up" | "down",
  ): Promise<void> {
    try {
      await this.ensureCacheDirectories();
      const trendPath = path.join(this.USAGE_CACHE_DIR, "trends.json");
      let trends: Record<string, number | string> = {};
      try {
        const content = await fs.promises.readFile(trendPath, "utf-8");
        trends = JSON.parse(content);
      } catch {
        // file doesn't exist yet
      }
      trends[`${key}_direction`] = direction;
      await fs.promises.writeFile(trendPath, JSON.stringify(trends), "utf-8");
    } catch (error) {
      debug("Failed to save trend direction:", error);
    }
  }
}
