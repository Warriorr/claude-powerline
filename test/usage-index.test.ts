import {
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
  utimesSync,
  readFileSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { debug } from "../src/utils/logger";

jest.mock("../src/utils/logger", () => ({
  debug: jest.fn(),
}));

jest.mock("../src/segments/pricing", () => ({
  PricingService: {
    calculateCostForEntry: jest.fn().mockResolvedValue(0.01),
  },
}));

// Imported after the mocks above so usageIndex picks up the mocked modules.
import {
  loadIndexedUsageEntries,
  resetUsageIndexMemoForTests,
  usageIndexInternals,
} from "../src/utils/usageIndex";
import { CacheManager } from "../src/utils/cache";

const debugMock = debug as jest.Mock;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every statusline render is a fresh process, so the module-level index memo
 * starts empty. Tests that render twice must clear it the same way.
 */
async function loadFresh(since: Date) {
  resetUsageIndexMemoForTests();
  return loadIndexedUsageEntries({ since });
}

function usageLine(opts: {
  timestamp: string;
  messageId: string;
  requestId: string;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}): string {
  return JSON.stringify({
    timestamp: opts.timestamp,
    requestId: opts.requestId,
    message: {
      id: opts.messageId,
      model: opts.model ?? "claude-sonnet-4-5",
      usage: {
        input_tokens: opts.inputTokens ?? 10,
        output_tokens: opts.outputTokens ?? 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
}

function nonUsageLine(timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "user",
    message: { role: "user", content: "hello" },
  });
}

function debugMessages(): string[] {
  return debugMock.mock.calls.map((call) => String(call[0]));
}

function reuseSummaryLine(): string | undefined {
  return debugMessages().find((m) => /file\(s\) reused/.test(m));
}

describe("loadIndexedUsageEntries", () => {
  let tempDir: string;
  let claudeDir: string;
  let cacheDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `powerline-usage-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    claudeDir = join(tempDir, "claude");
    cacheDir = join(tempDir, "cache");
    projectDir = join(claudeDir, "projects", "-home-user-project");

    mkdirSync(projectDir, { recursive: true });

    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.CLAUDE_POWERLINE_CACHE_DIR = cacheDir;

    debugMock.mockClear();
    resetUsageIndexMemoForTests();
  });

  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_POWERLINE_CACHE_DIR;
    rmSync(tempDir, { recursive: true, force: true });
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  function indexPath(): string {
    return join(cacheDir, "usage", "file-index.json");
  }

  function readIndex(): {
    version: number;
    lastFullSweepMs: number;
    files: Record<string, { entries: unknown[] }>;
  } {
    return JSON.parse(readFileSync(indexPath(), "utf-8"));
  }

  /** Pushes the recorded sweep time past the interval so the next call sweeps fully. */
  function ageLastFullSweep(): void {
    const index = readIndex();
    index.lastFullSweepMs = Date.now() - 10 * 60 * 1000;
    writeFileSync(indexPath(), JSON.stringify(index));
  }

  it("parses files on first call and writes a per-file index, including subagent files", async () => {
    const now = Date.now();
    const sessionId = "session-a";
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(
      sessionFile,
      [
        usageLine({
          timestamp: new Date(now - 60_000).toISOString(),
          messageId: "msg-1",
          requestId: "req-1",
        }),
        nonUsageLine(new Date(now - 50_000).toISOString()),
      ].join("\n") + "\n",
    );

    const subagentsDir = join(projectDir, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    const agentFile = join(subagentsDir, "agent-x1.jsonl");
    writeFileSync(
      agentFile,
      usageLine({
        timestamp: new Date(now - 40_000).toISOString(),
        messageId: "msg-2",
        requestId: "req-2",
      }) + "\n",
    );

    const since = new Date(now - 24 * 60 * 60 * 1000);
    const entries = await loadFresh(since);

    expect(entries).toHaveLength(2);
    const hashes = entries.map((e) => e.hash).sort();
    expect(hashes).toEqual(["msg-1:req-1", "msg-2:req-2"]);

    const indexPath = join(cacheDir, "usage", "file-index.json");
    expect(existsSync(indexPath)).toBe(true);
    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    expect(index.version).toBe(1);
    expect(Object.keys(index.files).sort()).toEqual(
      [sessionFile, agentFile].sort(),
    );
    expect(index.files[sessionFile].entries).toHaveLength(1);
    expect(index.files[agentFile].entries).toHaveLength(1);
  });

  it("does not re-parse files whose mtime and size are unchanged", async () => {
    const now = Date.now();
    const sessionFile = join(projectDir, "session-b.jsonl");
    writeFileSync(
      sessionFile,
      usageLine({
        timestamp: new Date(now - 60_000).toISOString(),
        messageId: "msg-1",
        requestId: "req-1",
      }) + "\n",
    );

    const since = new Date(now - 24 * 60 * 60 * 1000);

    await loadFresh(since);
    debugMock.mockClear();

    const entries = await loadFresh(since);

    expect(entries).toHaveLength(1);
    const summary = reuseSummaryLine();
    expect(summary).toBeDefined();
    expect(summary).toMatch(/^usageIndex: 1 file\(s\) reused, 0 re-parsed/);
  });

  it("re-parses only the file that changed after a mtime/size bump", async () => {
    const now = Date.now();
    const fileA = join(projectDir, "session-c.jsonl");
    const fileB = join(projectDir, "session-d.jsonl");
    writeFileSync(
      fileA,
      usageLine({
        timestamp: new Date(now - 60_000).toISOString(),
        messageId: "msg-a1",
        requestId: "req-a1",
      }) + "\n",
    );
    writeFileSync(
      fileB,
      usageLine({
        timestamp: new Date(now - 60_000).toISOString(),
        messageId: "msg-b1",
        requestId: "req-b1",
      }) + "\n",
    );

    const since = new Date(now - 24 * 60 * 60 * 1000);
    const firstPass = await loadFresh(since);
    expect(firstPass).toHaveLength(2);

    appendFileSync(
      fileA,
      usageLine({
        timestamp: new Date(now - 10_000).toISOString(),
        messageId: "msg-a2",
        requestId: "req-a2",
      }) + "\n",
    );
    const bumpedMtime = new Date(now + 5_000);
    utimesSync(fileA, bumpedMtime, bumpedMtime);

    debugMock.mockClear();
    const secondPass = await loadFresh(since);

    const summary = reuseSummaryLine();
    expect(summary).toMatch(/^usageIndex: 1 file\(s\) reused, 1 re-parsed/);

    const hashes = secondPass.map((e) => e.hash).sort();
    expect(hashes).toEqual(["msg-a1:req-a1", "msg-a2:req-a2", "msg-b1:req-b1"]);
  });

  it("dedups entries with the same messageId+requestId across two files", async () => {
    const now = Date.now();
    const fileA = join(projectDir, "session-e.jsonl");
    const fileB = join(projectDir, "session-f.jsonl");
    const shared = usageLine({
      timestamp: new Date(now - 60_000).toISOString(),
      messageId: "shared-msg",
      requestId: "shared-req",
    });
    writeFileSync(fileA, shared + "\n");
    writeFileSync(fileB, shared + "\n");

    const since = new Date(now - 24 * 60 * 60 * 1000);
    const entries = await loadFresh(since);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.hash).toBe("shared-msg:shared-req");
  });

  it("excludes entries older than the `since` filter", async () => {
    const now = Date.now();
    const sessionFile = join(projectDir, "session-g.jsonl");
    writeFileSync(
      sessionFile,
      [
        usageLine({
          timestamp: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
          messageId: "old-msg",
          requestId: "old-req",
        }),
        usageLine({
          timestamp: new Date(now - 10 * 60 * 1000).toISOString(),
          messageId: "new-msg",
          requestId: "new-req",
        }),
      ].join("\n") + "\n",
    );

    const since = new Date(now - 60 * 60 * 1000);
    const entries = await loadFresh(since);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.hash).toBe("new-msg:new-req");
  });

  it("does not index a file whose mtime is older than the retention window", async () => {
    const now = Date.now();
    const staleFile = join(projectDir, "session-stale.jsonl");
    writeFileSync(
      staleFile,
      usageLine({
        timestamp: new Date(now - 9 * 24 * 60 * 60 * 1000).toISOString(),
        messageId: "stale-msg",
        requestId: "stale-req",
      }) + "\n",
    );
    const staleMtime = new Date(now - 9 * 24 * 60 * 60 * 1000);
    utimesSync(staleFile, staleMtime, staleMtime);

    const since = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const entries = await loadFresh(since);

    expect(entries).toHaveLength(0);

    const indexPath = join(cacheDir, "usage", "file-index.json");
    if (existsSync(indexPath)) {
      const index = JSON.parse(readFileSync(indexPath, "utf-8"));
      expect(index.files[staleFile]).toBeUndefined();
    }
  });

  it("drops a file from an existing index once it ages out of retention", async () => {
    const now = Date.now();
    const fileA = join(projectDir, "session-h.jsonl");
    writeFileSync(
      fileA,
      usageLine({
        timestamp: new Date(now - 60_000).toISOString(),
        messageId: "msg-h",
        requestId: "req-h",
      }) + "\n",
    );

    const since = new Date(now - 24 * 60 * 60 * 1000);
    await loadFresh(since);

    const indexPathBefore = join(cacheDir, "usage", "file-index.json");
    const indexBefore = JSON.parse(readFileSync(indexPathBefore, "utf-8"));
    expect(indexBefore.files[fileA]).toBeDefined();

    // Age the file out of the retention window. Retention is only enforced on
    // a full sweep, so push the recorded sweep time past the interval too.
    const oldMtime = new Date(now - 9 * 24 * 60 * 60 * 1000);
    utimesSync(fileA, oldMtime, oldMtime);
    ageLastFullSweep();

    await loadFresh(since);

    const indexAfter = JSON.parse(readFileSync(indexPathBefore, "utf-8"));
    expect(indexAfter.files[fileA]).toBeUndefined();
  });

  it("treats a corrupt index file as empty instead of throwing", async () => {
    mkdirSync(join(cacheDir, "usage"), { recursive: true });
    writeFileSync(
      join(cacheDir, "usage", "file-index.json"),
      "{not valid json",
    );

    const now = Date.now();
    const sessionFile = join(projectDir, "session-i.jsonl");
    writeFileSync(
      sessionFile,
      usageLine({
        timestamp: new Date(now - 60_000).toISOString(),
        messageId: "msg-i",
        requestId: "req-i",
      }) + "\n",
    );

    const since = new Date(now - 24 * 60 * 60 * 1000);
    await expect(loadFresh(since)).resolves.toHaveLength(1);
  });

  it("builds the index in memory when the lock is held and no index exists yet", async () => {
    const now = Date.now();
    writeFileSync(
      join(projectDir, "session-cold.jsonl"),
      usageLine({
        timestamp: new Date(now - 60_000).toISOString(),
        messageId: "msg-cold",
        requestId: "req-cold",
      }) + "\n",
    );
    mkdirSync(join(cacheDir, "locks"), { recursive: true });
    writeFileSync(
      join(cacheDir, "locks", "fileIndex.fetch.lock"),
      String(process.pid),
    );
    const writeSpy = jest.spyOn(CacheManager, "setFileIndex");

    const since = new Date(now - 24 * 60 * 60 * 1000);
    const entries = await loadFresh(since);

    expect(entries.map((e) => e.hash)).toEqual(["msg-cold:req-cold"]);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(existsSync(indexPath())).toBe(false);
    expect(existsSync(join(cacheDir, "locks", "fileIndex.fetch.lock"))).toBe(
      true,
    );
  });

  it("accepts a legacy index without lastFullSweepMs and sweeps it instead of rebuilding", async () => {
    const now = Date.now();
    const sessionFile = join(projectDir, "session-legacy.jsonl");
    writeFileSync(
      sessionFile,
      usageLine({
        timestamp: new Date(now - 60_000).toISOString(),
        messageId: "msg-legacy",
        requestId: "req-legacy",
      }) + "\n",
    );
    const since = new Date(now - 24 * 60 * 60 * 1000);
    await loadFresh(since);

    // Strip the field the way a pre-#2428 index on disk looks.
    const legacy = readIndex() as Partial<ReturnType<typeof readIndex>>;
    delete legacy.lastFullSweepMs;
    writeFileSync(indexPath(), JSON.stringify(legacy));
    debugMock.mockClear();

    const entries = await loadFresh(since);
    expect(entries).toHaveLength(1);
    expect(debugMock).toHaveBeenCalledWith(
      expect.stringContaining("1 file(s) reused, 0 re-parsed"),
    );
    expect(debugMock).not.toHaveBeenCalledWith(
      expect.stringContaining("unknown version/shape"),
    );
    expect(readIndex().lastFullSweepMs).toBeGreaterThan(0);
  });

  it("treats an index file with an unknown version as empty instead of throwing", async () => {
    mkdirSync(join(cacheDir, "usage"), { recursive: true });
    writeFileSync(
      join(cacheDir, "usage", "file-index.json"),
      JSON.stringify({ version: 999, files: { "/some/stale/path.jsonl": {} } }),
    );

    const now = Date.now();
    const sessionFile = join(projectDir, "session-j.jsonl");
    writeFileSync(
      sessionFile,
      usageLine({
        timestamp: new Date(now - 60_000).toISOString(),
        messageId: "msg-j",
        requestId: "req-j",
      }) + "\n",
    );

    const since = new Date(now - 24 * 60 * 60 * 1000);
    const entries = await loadFresh(since);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hash).toBe("msg-j:req-j");
  });

  it("loads and writes the index once for concurrent callers in one process", async () => {
    const now = Date.now();
    const sessionFile = join(projectDir, "session-k.jsonl");
    writeFileSync(
      sessionFile,
      usageLine({
        timestamp: new Date(now - 60_000).toISOString(),
        messageId: "msg-k",
        requestId: "req-k",
      }) + "\n",
    );

    const getSpy = jest.spyOn(CacheManager, "getFileIndex");
    const setSpy = jest.spyOn(CacheManager, "setFileIndex");

    const since = new Date(now - DAY_MS);
    resetUsageIndexMemoForTests();
    const [first, second] = await Promise.all([
      loadIndexedUsageEntries({ since }),
      loadIndexedUsageEntries({ since }),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it("serves the on-disk index untouched when another render holds the lock", async () => {
    const now = Date.now();
    mkdirSync(join(cacheDir, "usage"), { recursive: true });
    mkdirSync(join(cacheDir, "locks"), { recursive: true });

    // Deliberately absent from disk: proof that nothing was stat'ed or parsed.
    const ghostFile = join(projectDir, "session-ghost.jsonl");
    writeFileSync(
      indexPath(),
      JSON.stringify({
        version: 1,
        lastFullSweepMs: 0,
        files: {
          [ghostFile]: {
            mtimeMs: now,
            size: 10,
            entries: [
              {
                timestamp: now - 60_000,
                inputTokens: 1,
                outputTokens: 2,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                costUSD: 0.5,
                model: "claude-sonnet-4-5",
                hash: "locked-msg:locked-req",
              },
            ],
          },
        },
      }),
    );

    const lockFile = join(cacheDir, "locks", "fileIndex.fetch.lock");
    writeFileSync(lockFile, String(process.pid));

    const statSpy = jest.spyOn(usageIndexInternals, "stat");
    const setSpy = jest.spyOn(CacheManager, "setFileIndex");

    const entries = await loadFresh(new Date(now - DAY_MS));

    expect(entries).toHaveLength(1);
    expect(entries[0]!.hash).toBe("locked-msg:locked-req");
    expect(statSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
    expect(existsSync(lockFile)).toBe(true);
  });

  it("stats only recently touched files while the project directory is unchanged", async () => {
    const now = Date.now();
    const oldFile = join(projectDir, "session-old.jsonl");
    const recentFile = join(projectDir, "session-recent.jsonl");
    writeFileSync(
      oldFile,
      usageLine({
        timestamp: new Date(now - 8 * 60 * 60 * 1000).toISOString(),
        messageId: "msg-old",
        requestId: "req-old",
      }) + "\n",
    );
    writeFileSync(
      recentFile,
      usageLine({
        timestamp: new Date(now - 60_000).toISOString(),
        messageId: "msg-recent",
        requestId: "req-recent",
      }) + "\n",
    );
    const oldMtime = new Date(now - 8 * 60 * 60 * 1000);
    utimesSync(oldFile, oldMtime, oldMtime);

    const since = new Date(now - 30 * DAY_MS);
    await loadFresh(since);

    // Freeze the directory in the past so the quick sweep sees no new files.
    const dirMtime = new Date(now - 60_000);
    utimesSync(projectDir, dirMtime, dirMtime);

    const statSpy = jest.spyOn(usageIndexInternals, "stat");
    await loadFresh(since);

    const statted = statSpy.mock.calls.map((call) => call[0]);
    expect(statted).toContain(recentFile);
    expect(statted).not.toContain(oldFile);
    statSpy.mockRestore();

    // A new transcript moves the directory mtime, so it is re-read.
    const newFile = join(projectDir, "session-new.jsonl");
    writeFileSync(
      newFile,
      usageLine({
        timestamp: new Date(now - 30_000).toISOString(),
        messageId: "msg-new",
        requestId: "req-new",
      }) + "\n",
    );

    const entries = await loadFresh(since);
    expect(entries.map((e) => e.hash)).toContain("msg-new:req-new");
  });

  it("drops a file deleted from disk on the next full sweep", async () => {
    const now = Date.now();
    const fileA = join(projectDir, "session-l.jsonl");
    const fileB = join(projectDir, "session-m.jsonl");
    writeFileSync(
      fileA,
      usageLine({
        timestamp: new Date(now - 60_000).toISOString(),
        messageId: "msg-l",
        requestId: "req-l",
      }) + "\n",
    );
    writeFileSync(
      fileB,
      usageLine({
        timestamp: new Date(now - 60_000).toISOString(),
        messageId: "msg-m",
        requestId: "req-m",
      }) + "\n",
    );

    const since = new Date(now - DAY_MS);
    await loadFresh(since);
    expect(readIndex().files[fileA]).toBeDefined();

    unlinkSync(fileA);

    // Within the interval the deletion is invisible: the record survives.
    const quickPass = await loadFresh(since);
    expect(quickPass.map((e) => e.hash)).toContain("msg-l:req-l");

    ageLastFullSweep();
    const fullPass = await loadFresh(since);

    expect(readIndex().files[fileA]).toBeUndefined();
    expect(fullPass.map((e) => e.hash)).toEqual(["msg-m:req-m"]);
  });
});
