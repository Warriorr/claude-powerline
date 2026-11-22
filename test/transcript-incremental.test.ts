import {
  appendFileSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import * as claude from "../src/utils/claude";
import { CacheManager } from "../src/utils/cache";
import { CacheTimerProvider } from "../src/segments/cacheTimer";
import { MetricsProvider } from "../src/segments/metrics";
import * as transcriptState from "../src/utils/transcriptState";
import type { ClaudeHookData } from "../src/utils/claude";

const cacheDir = process.env.CLAUDE_POWERLINE_CACHE_DIR as string;
const configDir = process.env.CLAUDE_CONFIG_DIR as string;
const workDir = join(configDir, "transcript-incremental");
const BASE = Date.now() - 3 * 60 * 60 * 1000;

type Line = Record<string, unknown>;
const ts = (offsetSec: number): string =>
  new Date(BASE + offsetSec * 1000).toISOString();
const text = (lines: Line[]): string =>
  lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

const user = (sec: number, extra: Line = {}): Line => ({
  type: "user",
  timestamp: ts(sec),
  message: { role: "user", content: "hi" },
  ...extra,
});
const toolResult = (sec: number): Line => ({
  type: "user",
  timestamp: ts(sec),
  message: { role: "user", content: [{ type: "tool_result" }] },
});
const assistant = (sec: number, cc?: Line, extra: Line = {}): Line => ({
  type: "assistant",
  timestamp: ts(sec),
  message: { role: "assistant", usage: cc ? { cache_creation: cc } : {} },
  ...extra,
});

/** The pre-incremental algorithms, over the whole file text. */
function oracleTimer(content: string): {
  lastUser: number | null;
  ttl: number | null;
} {
  let lastUser: number | null = null;
  let ttl: number | null = null;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (!e.timestamp) continue;
    const role = e.type || e.message?.role || e.message?.type;
    if (role === "user") lastUser = Date.parse(e.timestamp);
    const cc = e.message?.usage?.cache_creation;
    if (role === "assistant" && cc) {
      if ((cc.ephemeral_1h_input_tokens ?? 0) > 0) ttl = 3600;
      else if ((cc.ephemeral_5m_input_tokens ?? 0) > 0) ttl = 300;
    }
  }
  return { lastUser, ttl };
}

function oracleMetrics(content: string): {
  count: number;
  last: number | null;
} {
  const entries = content
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e.timestamp && e.isSidechain !== true);
  const isUser = (e: any): boolean =>
    (e.type || e.message?.role || e.message?.type) === "user" &&
    !(e.type === "user" && e.message?.content?.[0]?.type === "tool_result");
  let lastUser: number | null = null;
  let best: number | null = null;
  for (const e of entries.slice(-20)) {
    const t = new Date(e.timestamp).getTime();
    const type = e.type || e.message?.role || e.message?.type;
    if (isUser(e)) lastUser = t;
    else if (type === "assistant" && lastUser !== null) {
      const r = (t - lastUser) / 1000;
      if (r > 0.1 && r < 300) best = r;
    }
  }
  return { count: entries.filter(isUser).length, last: best };
}

beforeEach(() => mkdirSync(workDir, { recursive: true }));
afterEach(() => {
  jest.restoreAllMocks();
  rmSync(workDir, { recursive: true, force: true });
});

describe("CacheTimerProvider incremental state", () => {
  const file = join(workDir, "timer.jsonl");
  const run = (): Promise<any> =>
    new CacheTimerProvider().getCacheTimerInfo({
      transcript_path: file,
    } as ClaudeHookData);
  const expectMatchesOracle = async (): Promise<void> => {
    const { lastUser, ttl } = oracleTimer(
      require("node:fs").readFileSync(file, "utf8"),
    );
    const info = await run();
    expect(info.detectedTtlSeconds).toBe(ttl ?? undefined);
    const expected = Math.floor((Date.now() - lastUser!) / 1000);
    expect(Math.abs(info.elapsedSeconds - expected)).toBeLessThanOrEqual(2);
  };

  it("matches a full scan when the user line is old and the TTL line is new", async () => {
    writeFileSync(
      file,
      text([
        user(0),
        assistant(5, { ephemeral_5m_input_tokens: 10 }),
        user(60),
        assistant(65, {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        }),
      ]),
    );
    await expectMatchesOracle();

    appendFileSync(
      file,
      text([assistant(70, { ephemeral_1h_input_tokens: 99 })]),
    );
    await expectMatchesOracle();

    appendFileSync(file, text([user(120), assistant(125), toolResult(126)]));
    await expectMatchesOracle();
  });

  it("does not read an unchanged file, and reads only the tail after an append", async () => {
    writeFileSync(
      file,
      text([user(0), assistant(5, { ephemeral_5m_input_tokens: 1 })]),
    );
    const spy = jest.spyOn(claude, "parseJsonlFileFrom");
    await run();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toBe(0);

    await run();
    expect(spy).toHaveBeenCalledTimes(1);

    appendFileSync(file, text([user(30)]));
    await run();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[1]).toBeGreaterThan(0);
  });

  it("rebuilds from the start when the file is truncated or replaced", async () => {
    writeFileSync(
      file,
      text([user(0), assistant(5, { ephemeral_1h_input_tokens: 5 }), user(50)]),
    );
    await run();
    writeFileSync(
      file,
      text([user(10), assistant(12, { ephemeral_5m_input_tokens: 2 })]),
    );
    const spy = jest.spyOn(claude, "parseJsonlFileFrom");
    await expectMatchesOracle();
    expect(spy.mock.calls[0]?.[1]).toBe(0);
  });

  it("rebuilds from an invalid document", async () => {
    writeFileSync(
      file,
      text([user(0), assistant(5, { ephemeral_5m_input_tokens: 2 })]),
    );
    await run();
    const name = readdirSync(join(cacheDir, "usage")).find((f) =>
      f.startsWith("cache-timer-"),
    )!;
    writeFileSync(join(cacheDir, "usage", name), "{broken");
    await expectMatchesOracle();
  });
});

describe("MetricsProvider incremental state", () => {
  const file = join(workDir, "metrics.jsonl");
  let sessionId = "";
  let seq = 0;
  const hook = (): ClaudeHookData =>
    ({
      session_id: sessionId,
      cost: {
        total_cost_usd: 0,
        total_duration_ms: 1000,
        total_api_duration_ms: 1000,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
    }) as unknown as ClaudeHookData;
  const run = (): Promise<any> =>
    new MetricsProvider().getMetricsInfo(sessionId, hook());
  const expectMatchesOracle = async (): Promise<void> => {
    const want = oracleMetrics(require("node:fs").readFileSync(file, "utf8"));
    const got = await run();
    expect(got.messageCount).toBe(want.count);
    expect(got.lastResponseTime).toBe(want.last);
  };

  beforeEach(() => {
    sessionId = `metrics-session-${++seq}`;
    jest.spyOn(claude, "findTranscriptFile").mockResolvedValue(file);
  });

  /** n exchanges; the response time of exchange i is (i % 7) + 1 seconds. */
  const exchanges = (from: number, n: number): Line[] => {
    const lines: Line[] = [];
    for (let i = from; i < from + n; i++) {
      const t = i * 100;
      lines.push(user(t), assistant(t + (i % 7) + 1));
      if (i % 3 === 0) lines.push(toolResult(t + 50));
      if (i % 4 === 0)
        lines.push(assistant(t + 60, undefined, { isSidechain: true }));
    }
    return lines;
  };

  it("keeps the 20-entry window correct across chunk boundaries", async () => {
    writeFileSync(file, text(exchanges(0, 15)));
    await expectMatchesOracle();
    for (let chunk = 0; chunk < 4; chunk++) {
      appendFileSync(file, text(exchanges(15 + chunk * 3, 3)));
      await expectMatchesOracle();
    }
    // A window ending on an assistant-less tail: only users in the last 20.
    appendFileSync(
      file,
      text(Array.from({ length: 22 }, (_, i) => user(9000 + i))),
    );
    await expectMatchesOracle();
    expect((await run()).lastResponseTime).toBeNull();
  });

  it("ignores lines without a timestamp, as the full scan does", async () => {
    writeFileSync(file, text([user(0), { type: "last-prompt" }, assistant(3)]));
    await expectMatchesOracle();
    appendFileSync(file, text([{ type: "ai-title" }, user(10), assistant(12)]));
    await expectMatchesOracle();
  });

  it("does not read an unchanged file", async () => {
    writeFileSync(file, text(exchanges(0, 5)));
    const spy = jest.spyOn(claude, "parseJsonlFileFrom");
    await run();
    await run();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when the file is truncated", async () => {
    writeFileSync(file, text(exchanges(0, 12)));
    await run();
    writeFileSync(file, text(exchanges(0, 2)));
    await expectMatchesOracle();
  });
});

describe("CacheManager.pruneSessionDocuments", () => {
  const usageDir = join(cacheDir, "usage");
  const marker = join(usageDir, ".session-prune-marker");
  const DAY = 24 * 60 * 60;
  const ageDays = (name: string, days: number): void => {
    const when = Date.now() / 1000 - days * DAY;
    utimesSync(join(usageDir, name), when, when);
  };

  beforeEach(async () => {
    await CacheManager.ensureCacheDirectories();
    rmSync(marker, { force: true });
  });

  it("deletes old session documents, keeps fresh and unrelated ones", async () => {
    for (const name of [
      "session-totals-old.json",
      "cache-timer-old.json",
      "metrics-state-old.json",
      "session-totals-fresh.json",
      "usage-index.json",
    ]) {
      writeFileSync(join(usageDir, name), "{}");
    }
    for (const name of [
      "session-totals-old.json",
      "cache-timer-old.json",
      "metrics-state-old.json",
      "usage-index.json",
    ]) {
      ageDays(name, 8);
    }

    expect(await CacheManager.pruneSessionDocuments()).toBe(3);
    expect(existsSync(join(usageDir, "session-totals-old.json"))).toBe(false);
    expect(existsSync(join(usageDir, "cache-timer-old.json"))).toBe(false);
    expect(existsSync(join(usageDir, "metrics-state-old.json"))).toBe(false);
    expect(existsSync(join(usageDir, "session-totals-fresh.json"))).toBe(true);
    expect(existsSync(join(usageDir, "usage-index.json"))).toBe(true);
  });

  it("runs at most once per hour", async () => {
    writeFileSync(join(usageDir, "metrics-state-a.json"), "{}");
    ageDays("metrics-state-a.json", 9);
    expect(await CacheManager.pruneSessionDocuments()).toBe(1);

    writeFileSync(join(usageDir, "metrics-state-b.json"), "{}");
    ageDays("metrics-state-b.json", 9);
    expect(await CacheManager.pruneSessionDocuments()).toBe(0);
    expect(existsSync(join(usageDir, "metrics-state-b.json"))).toBe(true);

    const past = Date.now() / 1000 - 2 * 60 * 60;
    utimesSync(marker, past, past);
    expect(await CacheManager.pruneSessionDocuments()).toBe(1);
  });

  it("never throws when the cache directory is unusable", async () => {
    const original = process.env.CLAUDE_POWERLINE_CACHE_DIR;
    process.env.CLAUDE_POWERLINE_CACHE_DIR = join(workDir, "file-not-dir");
    writeFileSync(process.env.CLAUDE_POWERLINE_CACHE_DIR, "x");
    try {
      await expect(CacheManager.pruneSessionDocuments()).resolves.toBe(0);
    } finally {
      process.env.CLAUDE_POWERLINE_CACHE_DIR = original;
    }
  });
});

describe("bounded transcript bootstrap", () => {
  const CHUNK = 64 * 1024;
  const file = join(workDir, "bounded.jsonl");
  const run = (): Promise<any> =>
    new CacheTimerProvider().getCacheTimerInfo({
      transcript_path: file,
    } as ClaudeHookData);
  const bigFile = (): string => {
    const lines: Line[] = [];
    for (let i = 0; i < 1500; i++) {
      lines.push(
        user(i * 5, { pad: "p".repeat(100) }),
        assistant(i * 5 + 2, { ephemeral_5m_input_tokens: i === 40 ? 5 : 0 }),
      );
    }
    return text(lines);
  };

  beforeEach(() => {
    jest.replaceProperty(transcriptState, "PARSE_CHUNK_BYTES", CHUNK);
  });

  it("reaches the one-shot result across several renders, one chunk each", async () => {
    const content = bigFile();
    writeFileSync(file, content);
    const size = statSync(file).size;
    expect(size).toBeGreaterThan(CHUNK * 3);
    const spy = jest.spyOn(claude, "parseJsonlFileFrom");

    let renders = 0;
    let info: any;
    while (renders < 40) {
      const before = spy.mock.calls.length;
      info = await run();
      renders++;
      if (spy.mock.calls.length === before) break;
    }
    const parses = spy.mock.calls;
    expect(parses.length).toBeGreaterThan(2);
    expect(parses.length).toBeLessThan(renders);
    for (const call of parses) expect(call[2]).toBe(CHUNK);
    for (let i = 1; i < parses.length; i++) {
      expect(parses[i]![1]).toBeGreaterThan(parses[i - 1]![1] as number);
    }

    const { lastUser, ttl } = oracleTimer(content);
    expect(info.detectedTtlSeconds).toBe(ttl ?? undefined);
    expect(
      Math.abs(
        info.elapsedSeconds - Math.floor((Date.now() - lastUser!) / 1000),
      ),
    ).toBeLessThanOrEqual(2);
  });

  it("keeps the metrics window correct across capped renders", async () => {
    const sessionId = "bounded-metrics";
    writeFileSync(file, bigFile());
    jest.spyOn(claude, "findTranscriptFile").mockResolvedValue(file);
    const hook = {
      session_id: sessionId,
      cost: { total_cost_usd: 0, total_duration_ms: 1000 },
    } as unknown as ClaudeHookData;
    const spy = jest.spyOn(claude, "parseJsonlFileFrom");
    let got: any;
    for (let i = 0; i < 40; i++) {
      const before = spy.mock.calls.length;
      got = await new MetricsProvider().getMetricsInfo(sessionId, hook);
      if (spy.mock.calls.length === before) break;
    }
    const want = oracleMetrics(readFileSync(file, "utf8"));
    expect(got.messageCount).toBe(want.count);
    expect(got.lastResponseTime).toBe(want.last);
  });

  it("rebuilds from 0 when the file is replaced by a larger one", async () => {
    writeFileSync(
      file,
      text([user(0), assistant(5, { ephemeral_1h_input_tokens: 5 })]),
    );
    await run();
    const replacement = file + ".new";
    writeFileSync(
      replacement,
      text([
        user(10),
        assistant(12, { ephemeral_5m_input_tokens: 2 }),
        user(20, { pad: "q".repeat(200) }),
      ]),
    );
    renameSync(replacement, file);
    const spy = jest.spyOn(claude, "parseJsonlFileFrom");
    const info = await run();
    expect(spy.mock.calls[0]?.[1]).toBe(0);
    expect(info.detectedTtlSeconds).toBe(300);
  });

  it("rebuilds when the stored offset is not a safe integer", async () => {
    writeFileSync(
      file,
      text([user(0), assistant(5, { ephemeral_5m_input_tokens: 2 })]),
    );
    await run();
    // The newest cache-timer document is the one run() just wrote; earlier
    // tests leave documents for other transcripts in the same directory.
    const usageDir = join(cacheDir, "usage");
    const name = readdirSync(usageDir)
      .filter((f) => f.startsWith("cache-timer-"))
      .sort(
        (a, b) =>
          statSync(join(usageDir, b)).mtimeMs -
          statSync(join(usageDir, a)).mtimeMs,
      )[0]!;
    const path = join(usageDir, name);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.endOffset = 1.5;
    writeFileSync(path, JSON.stringify(doc));
    const spy = jest.spyOn(claude, "parseJsonlFileFrom");
    await run();
    expect(spy.mock.calls[0]?.[1]).toBe(0);
  });

  it("prunes old session documents after a state write", async () => {
    writeFileSync(file, text([user(0)]));
    const spy = jest.spyOn(CacheManager, "pruneSessionDocuments");
    await run();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
