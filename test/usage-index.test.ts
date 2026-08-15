import {
  mkdirSync,
  rmSync,
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
import { loadIndexedUsageEntries } from "../src/utils/usageIndex";

const debugMock = debug as jest.Mock;

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
  });

  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_POWERLINE_CACHE_DIR;
    rmSync(tempDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

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
    const entries = await loadIndexedUsageEntries({ since });

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

    await loadIndexedUsageEntries({ since });
    debugMock.mockClear();

    const entries = await loadIndexedUsageEntries({ since });

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
    const firstPass = await loadIndexedUsageEntries({ since });
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
    const secondPass = await loadIndexedUsageEntries({ since });

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
    const entries = await loadIndexedUsageEntries({ since });

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
    const entries = await loadIndexedUsageEntries({ since });

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
    const entries = await loadIndexedUsageEntries({ since });

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
    await loadIndexedUsageEntries({ since });

    const indexPathBefore = join(cacheDir, "usage", "file-index.json");
    const indexBefore = JSON.parse(readFileSync(indexPathBefore, "utf-8"));
    expect(indexBefore.files[fileA]).toBeDefined();

    // Age the file out of the retention window.
    const oldMtime = new Date(now - 9 * 24 * 60 * 60 * 1000);
    utimesSync(fileA, oldMtime, oldMtime);

    await loadIndexedUsageEntries({ since });

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
    await expect(loadIndexedUsageEntries({ since })).resolves.toHaveLength(1);
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
    const entries = await loadIndexedUsageEntries({ since });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hash).toBe("msg-j:req-j");
  });
});
