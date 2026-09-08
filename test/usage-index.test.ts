import {
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
  utimesSync,
  statSync,
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
const SLOT_MS = 15 * 60 * 1000;
const ENTRY_COST = 0.01;

/**
 * Every statusline render is a fresh process, so the module-level index memo
 * starts empty. Tests that render twice must clear it the same way.
 */
async function loadFresh(since: Date) {
  resetUsageIndexMemoForTests();
  return loadIndexedUsageEntries({ since });
}

interface LineOpts {
  timestamp: string;
  messageId: string;
  requestId: string;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

function usageLine(opts: LineOpts): string {
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

/** A fixture line plus the file it belongs to, used for brute force sums. */
interface LineSpec {
  file: string;
  timestampMs: number;
  messageId: string;
  requestId: string;
  inputTokens: number;
  outputTokens: number;
  model?: string;
}

function specToLine(spec: LineSpec): string {
  return usageLine({
    timestamp: new Date(spec.timestampMs).toISOString(),
    messageId: spec.messageId,
    requestId: spec.requestId,
    inputTokens: spec.inputTokens,
    outputTokens: spec.outputTokens,
    model: spec.model,
  });
}

function writeSpecs(specs: LineSpec[]): void {
  const byFile = new Map<string, LineSpec[]>();
  for (const spec of specs) {
    const list = byFile.get(spec.file) ?? [];
    list.push(spec);
    byFile.set(spec.file, list);
  }
  for (const [file, list] of byFile) {
    writeFileSync(file, list.map(specToLine).join("\n") + "\n");
  }
}

/** Dedupe by hash (first by timestamp wins), then sum what `since` keeps. */
function bruteForce(specs: LineSpec[], sinceMs: number) {
  const sorted = [...specs].sort((a, b) => a.timestampMs - b.timestampMs);
  const seen = new Set<string>();
  const kept: LineSpec[] = [];
  for (const spec of sorted) {
    const hash = `${spec.messageId}:${spec.requestId}`;
    if (seen.has(hash)) continue;
    seen.add(hash);
    if (spec.timestampMs < sinceMs) continue;
    kept.push(spec);
  }
  return {
    kept,
    count: kept.length,
    costUSD: kept.length * ENTRY_COST,
    inputTokens: kept.reduce((sum, s) => sum + s.inputTokens, 0),
    outputTokens: kept.reduce((sum, s) => sum + s.outputTokens, 0),
    slots: new Set(
      kept.map(
        (s) =>
          `${Math.floor(s.timestampMs / SLOT_MS) * SLOT_MS}|${s.model ?? "claude-sonnet-4-5"}`,
      ),
    ),
  };
}

function sumEntries(entries: Array<Record<string, any>>) {
  return {
    count: entries.length,
    costUSD: entries.reduce((sum, e) => sum + e.costUSD, 0),
    inputTokens: entries.reduce((sum, e) => sum + e.inputTokens, 0),
    outputTokens: entries.reduce((sum, e) => sum + e.outputTokens, 0),
  };
}

function alignSlot(ms: number): Date {
  return new Date(Math.floor(ms / SLOT_MS) * SLOT_MS);
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
    return join(cacheDir, "usage", "usage-index.json");
  }

  function hashesPath(): string {
    return join(cacheDir, "usage", "folded-hashes.json");
  }

  function legacyIndexPath(): string {
    return join(cacheDir, "usage", "file-index.json");
  }

  interface StoredIndex {
    version: number;
    lastFullSweepMs: number;
    foldedBeforeMs: number;
    models: string[];
    files: Record<
      string,
      { mtimeMs: number; size: number; foldedUpToMs: number }
    >;
    hot: Record<string, Array<[number, ...unknown[]]>>;
    buckets: Record<string, number[]>;
  }

  function readIndex(): StoredIndex {
    return JSON.parse(readFileSync(indexPath(), "utf-8"));
  }

  function readHashes(): { version: number; days: Record<string, string[]> } {
    return JSON.parse(readFileSync(hashesPath(), "utf-8"));
  }

  /** Pushes the recorded sweep time past the interval so the next call sweeps fully. */
  function ageLastFullSweep(): void {
    const index = readIndex();
    index.lastFullSweepMs = Date.now() - 10 * 60 * 1000;
    writeFileSync(indexPath(), JSON.stringify(index));
  }

  function travelTo(ms: number): jest.SpyInstance {
    return jest.spyOn(Date, "now").mockReturnValue(ms);
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

    expect(existsSync(indexPath())).toBe(true);
    const index = readIndex();
    expect(index.version).toBe(2);
    expect(Object.keys(index.files).sort()).toEqual(
      [sessionFile, agentFile].sort(),
    );
    expect(index.hot[sessionFile]).toHaveLength(1);
    expect(index.hot[agentFile]).toHaveLength(1);
    expect(index.models).toContain("claude-sonnet-4-5");
  });

  it("stores a within-file duplicate once and returns it once", async () => {
    const now = Date.now();
    const sessionFile = join(projectDir, "session-dup.jsonl");
    const line = (offsetMs: number) =>
      usageLine({
        timestamp: new Date(now - offsetMs).toISOString(),
        messageId: "msg-dup",
        requestId: "req-dup",
      });
    writeFileSync(
      sessionFile,
      [line(60_000), line(59_000), line(58_000)].join("\n") + "\n",
    );

    const entries = await loadFresh(new Date(now - DAY_MS));

    expect(entries).toHaveLength(1);
    expect(entries[0]!.timestamp.getTime()).toBe(now - 60_000);
    expect(readIndex().hot[sessionFile]).toHaveLength(1);
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
        timestamp: new Date(now - 9 * DAY_MS).toISOString(),
        messageId: "stale-msg",
        requestId: "stale-req",
      }) + "\n",
    );
    const staleMtime = new Date(now - 9 * DAY_MS);
    utimesSync(staleFile, staleMtime, staleMtime);

    const since = new Date(now - 30 * DAY_MS);
    const entries = await loadFresh(since);

    expect(entries).toHaveLength(0);

    if (existsSync(indexPath())) {
      expect(readIndex().files[staleFile]).toBeUndefined();
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

    const since = new Date(now - DAY_MS);
    await loadFresh(since);
    expect(readIndex().files[fileA]).toBeDefined();

    // Age the file out of the retention window. Retention is only enforced on
    // a full sweep, so push the recorded sweep time past the interval too.
    const oldMtime = new Date(now - 9 * DAY_MS);
    utimesSync(fileA, oldMtime, oldMtime);
    ageLastFullSweep();

    await loadFresh(since);

    const indexAfter = readIndex();
    expect(indexAfter.files[fileA]).toBeUndefined();
    expect(indexAfter.hot[fileA]).toBeUndefined();
  });

  it("treats a corrupt index file as empty instead of throwing", async () => {
    mkdirSync(join(cacheDir, "usage"), { recursive: true });
    writeFileSync(indexPath(), "{not valid json");

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

    const since = new Date(now - DAY_MS);
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
    const writeSpy = jest.spyOn(CacheManager, "setUsageDocument");

    const since = new Date(now - DAY_MS);
    const entries = await loadFresh(since);

    expect(entries.map((e) => e.hash)).toEqual(["msg-cold:req-cold"]);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(existsSync(indexPath())).toBe(false);
    expect(existsSync(join(cacheDir, "locks", "fileIndex.fetch.lock"))).toBe(
      true,
    );
  });

  it("treats an index file with an unknown version as empty instead of throwing", async () => {
    mkdirSync(join(cacheDir, "usage"), { recursive: true });
    writeFileSync(
      indexPath(),
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

    const since = new Date(now - DAY_MS);
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

    const getSpy = jest.spyOn(CacheManager, "getUsageDocument");
    const setSpy = jest.spyOn(CacheManager, "setUsageDocument");

    const since = new Date(now - DAY_MS);
    resetUsageIndexMemoForTests();
    const [first, second] = await Promise.all([
      loadIndexedUsageEntries({ since }),
      loadIndexedUsageEntries({ since }),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(
      getSpy.mock.calls.filter((c) => c[0] === "usage-index"),
    ).toHaveLength(1);
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
        version: 2,
        lastFullSweepMs: 0,
        foldedBeforeMs: 0,
        models: ["claude-sonnet-4-5"],
        files: { [ghostFile]: { mtimeMs: now, size: 10, foldedUpToMs: 0 } },
        hot: {
          [ghostFile]: [
            [now - 60_000, 1, 2, 0, 0, 0.5, 0, "locked-msg:locked-req"],
          ],
        },
        buckets: {},
      }),
    );

    const lockFile = join(cacheDir, "locks", "fileIndex.fetch.lock");
    writeFileSync(lockFile, String(process.pid));

    const statSpy = jest.spyOn(usageIndexInternals, "stat");
    const setSpy = jest.spyOn(CacheManager, "setUsageDocument");

    const entries = await loadFresh(new Date(now - DAY_MS));

    expect(entries).toHaveLength(1);
    expect(entries[0]!.hash).toBe("locked-msg:locked-req");
    expect(entries[0]!.model).toBe("claude-sonnet-4-5");
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

  describe("folding", () => {
    const now = Date.now();
    let specs: LineSpec[];
    let since4d: Date;

    function buildFixture(): LineSpec[] {
      const f1 = join(projectDir, "session-eq-1.jsonl");
      const f2 = join(projectDir, "session-eq-2.jsonl");
      const f3 = join(projectDir, "session-eq-3.jsonl");
      const f4 = join(projectDir, "session-eq-4.jsonl");
      return [
        // Within-file duplicate: Claude Code streams one line per content block.
        {
          file: f1,
          timestampMs: now - 3 * DAY_MS,
          messageId: "m1",
          requestId: "r1",
          inputTokens: 100,
          outputTokens: 200,
        },
        {
          file: f1,
          timestampMs: now - 3 * DAY_MS + 1_000,
          messageId: "m1",
          requestId: "r1",
          inputTokens: 100,
          outputTokens: 200,
        },
        {
          file: f1,
          timestampMs: now - 3 * DAY_MS + 60_000,
          messageId: "m2",
          requestId: "r2",
          inputTokens: 5,
          outputTokens: 7,
          model: "<synthetic>",
        },
        {
          file: f2,
          timestampMs: now - 2 * DAY_MS,
          messageId: "m3",
          requestId: "r3",
          inputTokens: 300,
          outputTokens: 400,
        },
        // Cross-file duplicate: a forked session copies history into a new file.
        {
          file: f2,
          timestampMs: now - 2 * DAY_MS + 30_000,
          messageId: "m4",
          requestId: "r4",
          inputTokens: 11,
          outputTokens: 13,
        },
        {
          file: f3,
          timestampMs: now - 2 * DAY_MS + 30_000,
          messageId: "m4",
          requestId: "r4",
          inputTokens: 11,
          outputTokens: 13,
        },
        {
          file: f3,
          timestampMs: now - 90 * 60 * 1000,
          messageId: "m5",
          requestId: "r5",
          inputTokens: 21,
          outputTokens: 22,
        },
        {
          file: f4,
          timestampMs: now - 10 * 60 * 1000,
          messageId: "m6",
          requestId: "r6",
          inputTokens: 31,
          outputTokens: 32,
        },
        {
          file: f4,
          timestampMs: now - 2 * 60 * 60 * 1000,
          messageId: "m7",
          requestId: "r7",
          inputTokens: 41,
          outputTokens: 42,
        },
      ];
    }

    beforeEach(() => {
      specs = buildFixture();
      writeSpecs(specs);
      since4d = alignSlot(now - 4 * DAY_MS);
    });

    it("matches brute force sums with nothing folded yet", async () => {
      // Holding the lock keeps the build in memory, which never folds, so
      // this is the equivalence check against the pure raw entry index.
      mkdirSync(join(cacheDir, "locks"), { recursive: true });
      writeFileSync(
        join(cacheDir, "locks", "fileIndex.fetch.lock"),
        String(process.pid),
      );

      const entries = await loadFresh(since4d);
      const expected = bruteForce(specs, since4d.getTime());

      expect(entries).toHaveLength(expected.count);
      expect(sumEntries(entries).inputTokens).toBe(expected.inputTokens);
      expect(sumEntries(entries).outputTokens).toBe(expected.outputTokens);
      expect(sumEntries(entries).costUSD).toBeCloseTo(expected.costUSD, 10);
      expect(entries.every((e) => e.hash !== null)).toBe(true);
      expect(entries.map((e) => e.model)).toContain("<synthetic>");
    });

    it("folds past the hot horizon on the first full sweep without changing the sums", async () => {
      const entries = await loadFresh(since4d);
      const expected = bruteForce(specs, since4d.getTime());

      const actual = sumEntries(entries);
      expect(actual.inputTokens).toBe(expected.inputTokens);
      expect(actual.outputTokens).toBe(expected.outputTokens);
      expect(actual.costUSD).toBeCloseTo(expected.costUSD, 10);

      const horizonMs = now - 26 * 60 * 60 * 1000;
      const stale = expected.kept.filter((s) => s.timestampMs < horizonMs);
      const recent = expected.kept.filter((s) => s.timestampMs >= horizonMs);
      const staleSlots = new Set(
        stale.map(
          (s) =>
            `${Math.floor(s.timestampMs / SLOT_MS) * SLOT_MS}|${s.model ?? "claude-sonnet-4-5"}`,
        ),
      );

      expect(entries).toHaveLength(staleSlots.size + recent.length);
      expect(entries.filter((e) => e.hash === null)).toHaveLength(
        staleSlots.size,
      );

      const index = readIndex();
      expect(Object.keys(index.buckets)).toHaveLength(staleSlots.size);
      const hotCount = Object.values(index.hot).reduce(
        (sum, list) => sum + list.length,
        0,
      );
      expect(hotCount).toBe(recent.length);
    });

    it("returns only raw entries for a 24 hour window", async () => {
      const entries = await loadFresh(new Date(now - DAY_MS));
      expect(entries.every((e) => e.hash !== null)).toBe(true);
      expect(entries.map((e) => e.hash).sort()).toEqual([
        "m5:r5",
        "m6:r6",
        "m7:r7",
      ]);
    });

    it("matches brute force sums after a full sweep folds the old entries", async () => {
      await loadFresh(since4d);
      ageLastFullSweep();

      const clock = travelTo(now + 30 * 60 * 60 * 1000);
      const entries = await loadFresh(since4d);
      clock.mockRestore();

      const expected = bruteForce(specs, since4d.getTime());
      const actual = sumEntries(entries);
      expect(actual.inputTokens).toBe(expected.inputTokens);
      expect(actual.outputTokens).toBe(expected.outputTokens);
      expect(actual.costUSD).toBeCloseTo(expected.costUSD, 10);
      expect(entries.every((e) => e.hash === null)).toBe(true);
      expect(entries).toHaveLength(expected.slots.size);

      const index = readIndex();
      expect(Object.keys(index.buckets)).toHaveLength(expected.slots.size);
      const hotCount = Object.values(index.hot).reduce(
        (sum, list) => sum + list.length,
        0,
      );
      expect(hotCount).toBe(0);
      expect(index.foldedBeforeMs).toBe(
        now + 30 * 60 * 60 * 1000 - 26 * 60 * 60 * 1000,
      );

      const hashes = readHashes();
      expect(hashes.version).toBe(2);
      const folded = Object.values(hashes.days).flat();
      expect(folded.sort()).toEqual(
        ["m1:r1", "m2:r2", "m3:r3", "m4:r4", "m5:r5", "m6:r6", "m7:r7"].sort(),
      );
    });

    it("counts an appended line once when the rest of the file is folded", async () => {
      await loadFresh(since4d);
      ageLastFullSweep();
      const laterMs = now + 30 * 60 * 60 * 1000;
      let clock = travelTo(laterMs);
      await loadFresh(since4d);
      clock.mockRestore();

      const f4 = join(projectDir, "session-eq-4.jsonl");
      const appended: LineSpec = {
        file: f4,
        timestampMs: laterMs - 5 * 60 * 1000,
        messageId: "m8",
        requestId: "r8",
        inputTokens: 51,
        outputTokens: 52,
      };
      appendFileSync(f4, specToLine(appended) + "\n");
      const bumped = new Date(now + 60_000);
      utimesSync(f4, bumped, bumped);
      ageLastFullSweep();

      clock = travelTo(laterMs + 60_000);
      const entries = await loadFresh(since4d);
      clock.mockRestore();

      const expected = bruteForce([...specs, appended], since4d.getTime());
      const actual = sumEntries(entries);
      expect(actual.inputTokens).toBe(expected.inputTokens);
      expect(actual.outputTokens).toBe(expected.outputTokens);
      expect(actual.costUSD).toBeCloseTo(expected.costUSD, 10);

      const index = readIndex();
      expect(index.hot[f4]).toHaveLength(1);
      expect(index.hot[f4]![0]![0]).toBe(appended.timestampMs);
      expect(index.files[f4]!.foldedUpToMs).toBe(now - 10 * 60 * 1000);
    });

    it("drops copied lines from a forked transcript using the folded hash set", async () => {
      await loadFresh(since4d);
      ageLastFullSweep();
      const laterMs = now + 30 * 60 * 60 * 1000;
      let clock = travelTo(laterMs);
      await loadFresh(since4d);
      clock.mockRestore();

      const forkFile = join(projectDir, "session-fork.jsonl");
      const copied = specs.filter(
        (s) => s.messageId === "m3" || s.messageId === "m5",
      );
      const fresh: LineSpec = {
        file: forkFile,
        timestampMs: laterMs - 5 * 60 * 1000,
        messageId: "m9",
        requestId: "r9",
        inputTokens: 61,
        outputTokens: 62,
      };
      writeFileSync(
        forkFile,
        [...copied, fresh].map(specToLine).join("\n") + "\n",
      );

      ageLastFullSweep();
      const getSpy = jest.spyOn(CacheManager, "getUsageDocument");
      debugMock.mockClear();
      clock = travelTo(laterMs + 60_000);
      const entries = await loadFresh(since4d);
      clock.mockRestore();

      expect(
        getSpy.mock.calls.some((call) => call[0] === "folded-hashes"),
      ).toBe(true);
      expect(debugMessages().join("\n")).toMatch(/folded hash/i);

      const expected = bruteForce([...specs, fresh], since4d.getTime());
      const actual = sumEntries(entries);
      expect(actual.inputTokens).toBe(expected.inputTokens);
      expect(actual.outputTokens).toBe(expected.outputTokens);
      expect(actual.costUSD).toBeCloseTo(expected.costUSD, 10);

      const index = readIndex();
      expect(index.hot[forkFile]).toHaveLength(1);
      expect(index.hot[forkFile]![0]![0]).toBe(fresh.timestampMs);
    });

    it("prunes buckets and hash days older than the retention window", async () => {
      await loadFresh(since4d);
      ageLastFullSweep();
      let clock = travelTo(now + 30 * 60 * 60 * 1000);
      await loadFresh(since4d);
      clock.mockRestore();

      expect(Object.keys(readIndex().buckets).length).toBeGreaterThan(0);
      expect(Object.keys(readHashes().days).length).toBeGreaterThan(0);
      const staleDays = Object.keys(readHashes().days);

      // Far enough forward that every existing bucket falls out of retention,
      // with one new transcript to give the sweep something to fold.
      const farMs = now + 9 * DAY_MS;
      const lateFile = join(projectDir, "session-late.jsonl");
      const late: LineSpec = {
        file: lateFile,
        timestampMs: farMs - 27 * 60 * 60 * 1000,
        messageId: "m10",
        requestId: "r10",
        inputTokens: 71,
        outputTokens: 72,
      };
      writeFileSync(lateFile, specToLine(late) + "\n");
      const lateMtime = new Date(farMs);
      utimesSync(lateFile, lateMtime, lateMtime);
      ageLastFullSweep();

      clock = travelTo(farMs);
      await loadFresh(alignSlot(farMs - 4 * DAY_MS));
      clock.mockRestore();

      const index = readIndex();
      const slot = Math.floor(late.timestampMs / SLOT_MS) * SLOT_MS;
      expect(Object.keys(index.buckets)).toHaveLength(1);
      expect(Object.keys(index.buckets)[0]!.startsWith(`${slot}|`)).toBe(true);

      const days = Object.keys(readHashes().days);
      expect(days).toHaveLength(1);
      for (const stale of staleDays) {
        expect(days).not.toContain(stale);
      }
    });
  });

  describe("migration from the version 1 index", () => {
    const now = Date.now();

    interface V1Entry {
      timestamp: number;
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      costUSD: number;
      model: string;
      hash: string | null;
    }

    function v1Entry(spec: LineSpec): V1Entry {
      return {
        timestamp: spec.timestampMs,
        inputTokens: spec.inputTokens,
        outputTokens: spec.outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        costUSD: ENTRY_COST,
        model: spec.model ?? "claude-sonnet-4-5",
        hash: `${spec.messageId}:${spec.requestId}`,
      };
    }

    /**
     * Writes the transcripts and a matching v1 index so the migration has
     * nothing to re-parse: the (mtime, size) pairs are taken from disk.
     */
    function writeV1Index(specs: LineSpec[]): void {
      writeSpecs(specs);
      const files: Record<string, unknown> = {};
      const byFile = new Map<string, LineSpec[]>();
      for (const spec of specs) {
        const list = byFile.get(spec.file) ?? [];
        list.push(spec);
        byFile.set(spec.file, list);
      }
      for (const [file, list] of byFile) {
        // Whole seconds keep mtimeMs an integer on every platform.
        const stamp = new Date(Math.floor(now / 1000) * 1000);
        utimesSync(file, stamp, stamp);
        const stats = statSync(file);
        files[file] = {
          mtimeMs: stats.mtime.getTime(),
          size: stats.size,
          entries: list.map(v1Entry),
        };
      }
      mkdirSync(join(cacheDir, "usage"), { recursive: true });
      writeFileSync(
        legacyIndexPath(),
        JSON.stringify({ version: 1, lastFullSweepMs: now, files }),
      );
    }

    function migrationSpecs(): LineSpec[] {
      const recent = join(projectDir, "session-v1-recent.jsonl");
      const old = join(projectDir, "session-v1-old.jsonl");
      return [
        {
          file: recent,
          timestampMs: now - 60 * 60 * 1000,
          messageId: "v1a",
          requestId: "q1",
          inputTokens: 10,
          outputTokens: 20,
        },
        {
          file: recent,
          timestampMs: now - 60 * 60 * 1000 + 500,
          messageId: "v1a",
          requestId: "q1",
          inputTokens: 10,
          outputTokens: 20,
        },
        {
          file: recent,
          timestampMs: now - 30 * 60 * 1000,
          messageId: "v1b",
          requestId: "q2",
          inputTokens: 33,
          outputTokens: 44,
        },
        {
          file: old,
          timestampMs: now - 3 * DAY_MS,
          messageId: "v1c",
          requestId: "q3",
          inputTokens: 55,
          outputTokens: 66,
        },
      ];
    }

    it("converts a v1 index in place, writes both v2 documents and removes the v1 file", async () => {
      const specs = migrationSpecs();
      writeV1Index(specs);
      const since = alignSlot(now - 4 * DAY_MS);
      const setSpy = jest.spyOn(CacheManager, "setUsageDocument");

      const entries = await loadFresh(since);

      // Hashes must land before the index: a kill between the two writes may
      // leave an index behind its hashes (harmless re-fold) but never an
      // index ahead of them (a later fork of that history would count twice).
      expect(setSpy.mock.calls.map((call) => call[0])).toEqual([
        "folded-hashes",
        "usage-index",
      ]);

      const expected = bruteForce(specs, since.getTime());
      const actual = sumEntries(entries);
      expect(actual.inputTokens).toBe(expected.inputTokens);
      expect(actual.outputTokens).toBe(expected.outputTokens);
      expect(actual.costUSD).toBeCloseTo(expected.costUSD, 10);
      expect(actual.count).toBe(expected.count);

      const index = readIndex();
      expect(index.version).toBe(2);
      expect(readHashes().version).toBe(2);
      expect(existsSync(legacyIndexPath())).toBe(false);

      // The 3 day old entry folded; the two recent ones stayed hot.
      const oldFile = join(projectDir, "session-v1-old.jsonl");
      expect(Object.keys(index.buckets)).toHaveLength(1);
      expect(index.hot[oldFile] ?? []).toHaveLength(0);
      expect(index.files[oldFile]!.foldedUpToMs).toBe(now - 3 * DAY_MS);
    });

    it("serves a converted v1 index in memory without writing while the lock is held", async () => {
      const specs = migrationSpecs();
      writeV1Index(specs);
      mkdirSync(join(cacheDir, "locks"), { recursive: true });
      writeFileSync(
        join(cacheDir, "locks", "fileIndex.fetch.lock"),
        String(process.pid),
      );
      const setSpy = jest.spyOn(CacheManager, "setUsageDocument");
      const since = alignSlot(now - 4 * DAY_MS);

      const entries = await loadFresh(since);

      const expected = bruteForce(specs, since.getTime());
      expect(sumEntries(entries).inputTokens).toBe(expected.inputTokens);
      expect(setSpy).not.toHaveBeenCalled();
      expect(existsSync(indexPath())).toBe(false);
      expect(existsSync(hashesPath())).toBe(false);
      expect(existsSync(legacyIndexPath())).toBe(true);
    });

    it("ignores a v1 file with an unknown shape and builds from scratch", async () => {
      mkdirSync(join(cacheDir, "usage"), { recursive: true });
      writeFileSync(
        legacyIndexPath(),
        JSON.stringify({ version: 1, files: "not-an-object" }),
      );
      const sessionFile = join(projectDir, "session-v1-bad.jsonl");
      writeFileSync(
        sessionFile,
        usageLine({
          timestamp: new Date(now - 60_000).toISOString(),
          messageId: "msg-bad",
          requestId: "req-bad",
        }) + "\n",
      );

      const entries = await loadFresh(new Date(now - DAY_MS));

      expect(entries.map((e) => e.hash)).toEqual(["msg-bad:req-bad"]);
      expect(readIndex().version).toBe(2);
    });
  });
});
