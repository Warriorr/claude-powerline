import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

jest.mock("../src/utils/logger", () => ({
  debug: jest.fn(),
}));

// Imported after the mock above so cache picks up the mocked logger.
import { CacheManager, FILE_INDEX_TMP_STALE_MS } from "../src/utils/cache";

const DEAD_PID = 2147483646;
// A pid that exists but is not ours: on Linux pid 1 answers EPERM for an
// unprivileged caller, so the liveness probe reports it alive. Fall back to
// pid 2 in the unlikely case this suite itself runs as pid 1 in a container.
const LIVE_FOREIGN_PID = process.pid === 1 ? 2 : 1;

describe("CacheManager tmp file sweeping", () => {
  let tempDir: string;
  let cacheDir: string;
  let usageDir: string;
  let locksDir: string;
  let sigtermBaseline: number;

  const indexTmpName = (pid: number): string => `file-index.json.${pid}.tmp`;
  const lockTmpName = (pid: number): string =>
    `fileIndex.fetch.lock.${pid}.tmp`;

  function writeAged(dir: string, name: string, ageMs: number): string {
    const filePath = join(dir, name);
    fs.writeFileSync(filePath, "partial", "utf-8");
    const seconds = (Date.now() - ageMs) / 1000;
    fs.utimesSync(filePath, seconds, seconds);
    return filePath;
  }

  function writeIndexTmp(pid: number, ageMs: number): string {
    return writeAged(usageDir, indexTmpName(pid), ageMs);
  }

  beforeAll(() => {
    // Guards the pid-liveness assumption above: if the runner ever shares a pid
    // with the "foreign live process" fixture, fail loudly instead of silently
    // exercising the own-pid skip path.
    expect(process.pid).not.toBe(LIVE_FOREIGN_PID);
  });

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `powerline-file-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    cacheDir = join(tempDir, "cache");
    usageDir = join(cacheDir, "usage");
    locksDir = join(cacheDir, "locks");
    fs.mkdirSync(usageDir, { recursive: true });
    fs.mkdirSync(locksDir, { recursive: true });
    process.env.CLAUDE_POWERLINE_CACHE_DIR = cacheDir;
    sigtermBaseline = process.listenerCount("SIGTERM");
  });

  afterEach(() => {
    delete process.env.CLAUDE_POWERLINE_CACHE_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.restoreAllMocks();
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBaseline);
  });

  it("removes a sibling tmp file whose owning process is dead", async () => {
    const orphan = writeIndexTmp(DEAD_PID, 0);

    await CacheManager.setFileIndex({ hello: "world" });

    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("removes a sibling tmp file older than the staleness threshold even when its owner is alive", async () => {
    const orphan = writeIndexTmp(
      LIVE_FOREIGN_PID,
      FILE_INDEX_TMP_STALE_MS + 60_000,
    );

    await CacheManager.setFileIndex({ hello: "world" });

    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("keeps a sibling tmp file whose owner is alive and whose mtime is fresh", async () => {
    const inFlight = writeIndexTmp(LIVE_FOREIGN_PID, 0);

    await CacheManager.setFileIndex({ hello: "world" });

    expect(fs.existsSync(inFlight)).toBe(true);
  });

  it("keeps the tmp file belonging to the current process", async () => {
    const own = writeIndexTmp(process.pid, FILE_INDEX_TMP_STALE_MS + 60_000);

    await CacheManager.sweepStaleFileIndexTemps();

    expect(fs.existsSync(own)).toBe(true);
  });

  it("keeps files that do not match the file index tmp pattern", async () => {
    const weekly = join(usageDir, "weekly.json");
    const index = join(usageDir, "file-index.json");
    const oddball = join(usageDir, "file-index.json.notapid.tmp");
    fs.writeFileSync(weekly, "{}", "utf-8");
    fs.writeFileSync(index, "{}", "utf-8");
    fs.writeFileSync(oddball, "{}", "utf-8");

    await CacheManager.sweepStaleFileIndexTemps();

    expect(fs.existsSync(weekly)).toBe(true);
    expect(fs.existsSync(index)).toBe(true);
    expect(fs.existsSync(oddball)).toBe(true);
  });

  it("removes dead-pid lock tmp files while keeping live ones and real lock files", async () => {
    const deadLockTmp = writeAged(locksDir, lockTmpName(DEAD_PID), 0);
    const liveLockTmp = writeAged(locksDir, lockTmpName(LIVE_FOREIGN_PID), 0);
    const realLock = join(locksDir, "foo.lock");
    fs.writeFileSync(realLock, String(DEAD_PID), "utf-8");

    await CacheManager.sweepStaleFileIndexTemps();

    expect(fs.existsSync(deadLockTmp)).toBe(false);
    expect(fs.existsSync(liveLockTmp)).toBe(true);
    expect(fs.existsSync(realLock)).toBe(true);
  });

  it("publishes exactly one file-index.json, leaves no tmp behind, and reads back the data", async () => {
    const data = { "a.jsonl": { mtime: 1, entries: [] } };

    await CacheManager.setFileIndex(data);

    const files = fs.readdirSync(usageDir);
    expect(files.filter((f) => f === "file-index.json")).toHaveLength(1);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    await expect(CacheManager.getFileIndex()).resolves.toEqual(data);
  });

  it("removes an orphaned tmp belonging to any usage document, not just the file index", async () => {
    const orphan = writeAged(usageDir, `usage-index.json.${DEAD_PID}.tmp`, 0);
    const hashesOrphan = writeAged(
      usageDir,
      `folded-hashes.json.${DEAD_PID}.tmp`,
      0,
    );

    await CacheManager.sweepStaleFileIndexTemps();

    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(hashesOrphan)).toBe(false);
  });

  it("publishes a named usage document and reads it back", async () => {
    const data = { version: 2, buckets: { "1|0": [1, 2, 3] } };

    await CacheManager.setUsageDocument("usage-index", data);

    const files = fs.readdirSync(usageDir);
    expect(files.filter((f) => f === "usage-index.json")).toHaveLength(1);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    await expect(CacheManager.getUsageDocument("usage-index")).resolves.toEqual(
      data,
    );
  });

  it("removes a named usage document and tolerates a missing one", async () => {
    await CacheManager.setUsageDocument("folded-hashes", { version: 2 });
    expect(fs.existsSync(join(usageDir, "folded-hashes.json"))).toBe(true);

    await CacheManager.removeUsageDocument("folded-hashes");
    expect(fs.existsSync(join(usageDir, "folded-hashes.json"))).toBe(false);

    await expect(
      CacheManager.removeUsageDocument("folded-hashes"),
    ).resolves.toBeUndefined();
  });

  it("tolerates a missing usage cache directory", async () => {
    process.env.CLAUDE_POWERLINE_CACHE_DIR = join(tempDir, "does-not-exist");

    await expect(
      CacheManager.sweepStaleFileIndexTemps(),
    ).resolves.toBeUndefined();
  });

  it("tolerates an unlink error without throwing", async () => {
    writeIndexTmp(DEAD_PID, 0);
    jest
      .spyOn(fs.promises, "unlink")
      .mockRejectedValue(
        Object.assign(new Error("EACCES"), { code: "EACCES" }),
      );

    await expect(
      CacheManager.sweepStaleFileIndexTemps(),
    ).resolves.toBeUndefined();
  });

  it("removes its own tmp file when the index write fails", async () => {
    const failure = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    jest.spyOn(fs.promises, "rename").mockRejectedValue(failure);

    await CacheManager.setFileIndex({ hello: "world" });

    expect(fs.existsSync(join(usageDir, indexTmpName(process.pid)))).toBe(
      false,
    );
  });

  it("registers a SIGTERM handler during the write and removes it afterwards", async () => {
    const before = process.listenerCount("SIGTERM");
    let during = -1;
    const realWriteFile = fs.promises.writeFile;
    jest
      .spyOn(fs.promises, "writeFile")
      .mockImplementation(
        (...args: Parameters<typeof fs.promises.writeFile>) => {
          during = process.listenerCount("SIGTERM");
          return realWriteFile(...args);
        },
      );

    await CacheManager.setFileIndex({ hello: "world" });

    expect(during).toBe(before + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
  it("rejects document names that could escape the usage cache dir", async () => {
    await expect(CacheManager.getUsageDocument("../../escape")).rejects.toThrow(
      "Invalid usage document name",
    );
    await expect(
      CacheManager.setUsageDocument("a/b", { x: 1 }),
    ).rejects.toThrow("Invalid usage document name");
    await expect(CacheManager.removeUsageDocument("a.json")).rejects.toThrow(
      "Invalid usage document name",
    );
  });
});
