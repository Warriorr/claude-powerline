import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CacheManager } from "../src/utils/cache";

describe("CacheManager fetch lock", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `powerline-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    process.env.CLAUDE_POWERLINE_CACHE_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.CLAUDE_POWERLINE_CACHE_DIR;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("acquires the lock when it is free", async () => {
    await expect(
      CacheManager.tryAcquireFetchLock("weeklyScoped"),
    ).resolves.toBe(true);
    const lockFile = join(tempDir, "locks", "weeklyScoped.fetch.lock");
    expect(existsSync(lockFile)).toBe(true);
    expect(readFileSync(lockFile, "utf-8")).toBe(String(process.pid));
  });

  it("refuses a second claim while the lock is held by a live process", async () => {
    await CacheManager.tryAcquireFetchLock("weeklyScoped");
    await expect(
      CacheManager.tryAcquireFetchLock("weeklyScoped"),
    ).resolves.toBe(false);
  });

  it("can reacquire after release", async () => {
    await CacheManager.tryAcquireFetchLock("weeklyScoped");
    await CacheManager.releaseFetchLock("weeklyScoped");
    await expect(
      CacheManager.tryAcquireFetchLock("weeklyScoped"),
    ).resolves.toBe(true);
  });

  it("steals a stale lock left by a dead process", async () => {
    mkdirSync(join(tempDir, "locks"), { recursive: true });
    writeFileSync(join(tempDir, "locks", "weeklyScoped.fetch.lock"), "999999");
    await expect(
      CacheManager.tryAcquireFetchLock("weeklyScoped"),
    ).resolves.toBe(true);
  });

  it("grants exactly one of two simultaneous claims", async () => {
    const results = await Promise.all([
      CacheManager.tryAcquireFetchLock("weeklyScoped"),
      CacheManager.tryAcquireFetchLock("weeklyScoped"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("honors the CLAUDE_POWERLINE_CACHE_DIR override for usage caches", async () => {
    await CacheManager.setUsageCache("weeklyScoped", { probe: true });
    expect(existsSync(join(tempDir, "usage", "weeklyScoped.json"))).toBe(true);
    const cached = await CacheManager.getUsageCache("weeklyScoped");
    expect(cached).toEqual({ probe: true });
  });
});
