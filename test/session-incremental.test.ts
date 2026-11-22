import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import * as claude from "../src/utils/claude";
import { parseJsonlFileFrom } from "../src/utils/claude";
import { SessionProvider } from "../src/segments/session";

const configDir = process.env.CLAUDE_CONFIG_DIR as string;
const projectDir = join(configDir, "projects", "proj-incremental");

function usageLine(
  input: number,
  output: number,
  cost: number,
  extra: Record<string, unknown> = {},
): string {
  return (
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      costUSD: cost,
      message: {
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
        },
      },
      ...extra,
    }) + "\n"
  );
}

describe("parseJsonlFileFrom", () => {
  const file = join(projectDir, "reader.jsonl");

  beforeEach(() => {
    mkdirSync(projectDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(file, { force: true });
  });

  it("returns only appended complete lines and a byte endOffset", async () => {
    const first = usageLine(1, 2, 0.1, {
      note: "h\u00e9llo \u20ac \u{1F600}",
    });
    writeFileSync(file, first);
    const a = await parseJsonlFileFrom(file, 0);
    expect(a.entries).toHaveLength(1);
    expect(a.endOffset).toBe(Buffer.byteLength(first, "utf8"));
    expect(a.endOffset).toBeGreaterThan(first.length);

    const second = usageLine(5, 6, 0.2);
    appendFileSync(file, second);
    const b = await parseJsonlFileFrom(file, a.endOffset);
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]!.costUSD).toBe(0.2);
    expect(b.endOffset).toBe(a.endOffset + Buffer.byteLength(second, "utf8"));
  });

  it("does not consume a partial trailing line until it is completed", async () => {
    const first = usageLine(1, 2, 0.1);
    const second = usageLine(5, 6, 0.2);
    const cut = Math.floor(second.length / 2);
    writeFileSync(file, first + second.slice(0, cut));

    const a = await parseJsonlFileFrom(file, 0);
    expect(a.entries).toHaveLength(1);
    expect(a.endOffset).toBe(Buffer.byteLength(first, "utf8"));

    appendFileSync(file, second.slice(cut));
    const b = await parseJsonlFileFrom(file, a.endOffset);
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]!.costUSD).toBe(0.2);
    expect(b.endOffset).toBe(Buffer.byteLength(first + second, "utf8"));
  });
});

describe("SessionProvider incremental totals", () => {
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const mainFile = join(projectDir, sessionId + ".jsonl");
  const subDir = join(projectDir, sessionId, "subagents");
  const agentFile = join(subDir, "agent-a1.jsonl");
  const provider = new SessionProvider();

  function agentLine(input: number, cost: number): string {
    return usageLine(input, 1, cost, { sessionId });
  }

  async function fromScratch() {
    const entries = [
      ...(await claude.parseJsonlFile(mainFile)),
      ...(await claude.parseJsonlFile(agentFile)),
    ].filter((e) => e.message?.usage);
    const u = (
      k:
        | "input_tokens"
        | "output_tokens"
        | "cache_creation_input_tokens"
        | "cache_read_input_tokens",
    ) => entries.reduce((s, e) => s + (e.message?.usage?.[k] || 0), 0);
    return {
      input: u("input_tokens"),
      output: u("output_tokens"),
      cacheCreation: u("cache_creation_input_tokens"),
      cacheRead: u("cache_read_input_tokens"),
      cost: entries.reduce((s, e) => s + (e.costUSD ?? 0), 0),
    };
  }

  beforeEach(() => {
    mkdirSync(subDir, { recursive: true });
    writeFileSync(mainFile, usageLine(10, 20, 0.5) + usageLine(11, 21, 0.25));
    writeFileSync(agentFile, agentLine(100, 1));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const { CacheManager } = await import("../src/utils/cache");
    await CacheManager.removeUsageDocument("session-totals-" + sessionId);
    rmSync(mainFile, { force: true });
    rmSync(join(projectDir, sessionId), { recursive: true, force: true });
  });

  it("includes subagent files in the totals", async () => {
    const usage = await provider.getSessionUsage(sessionId);
    expect(usage!.breakdown.input).toBe(10 + 11 + 100);
    expect(usage!.entryCount).toBe(3);
    expect(usage!.totalCost).toBeCloseTo(1.75);
  });

  it("matches a from-scratch parse after appends", async () => {
    await provider.getSessionUsage(sessionId);
    appendFileSync(mainFile, usageLine(7, 8, 0.125));
    appendFileSync(agentFile, agentLine(9, 2));
    const usage = await provider.getSessionUsage(sessionId);
    const expected = await fromScratch();
    expect(usage!.breakdown).toEqual({
      input: expected.input,
      output: expected.output,
      cacheCreation: expected.cacheCreation,
      cacheRead: expected.cacheRead,
    });
    expect(usage!.totalCost).toBeCloseTo(expected.cost);
    expect(usage!.entryCount).toBe(5);
  });

  it("does not read an unchanged file again", async () => {
    await provider.getSessionUsage(sessionId);
    const spy = jest.spyOn(claude, "parseJsonlFileFrom");
    const usage = await provider.getSessionUsage(sessionId);
    expect(spy).not.toHaveBeenCalled();
    expect(usage!.entryCount).toBe(3);
  });

  it("reads only the appended bytes", async () => {
    await provider.getSessionUsage(sessionId);
    const size = readFileSync(mainFile).length;
    appendFileSync(mainFile, usageLine(1, 1, 0.1));
    const spy = jest.spyOn(claude, "parseJsonlFileFrom");
    await provider.getSessionUsage(sessionId);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(mainFile, size);
  });

  it("re-parses a truncated or replaced file from 0", async () => {
    await provider.getSessionUsage(sessionId);
    writeFileSync(mainFile, usageLine(1, 1, 0.1));
    const usage = await provider.getSessionUsage(sessionId);
    expect(usage!.entryCount).toBe(2);
    expect(usage!.breakdown.input).toBe(1 + 100);
    expect(usage!.totalCost).toBeCloseTo(1.1);
  });

  it("keeps a subagent whose first line is longer than 64 KB", async () => {
    const bigAgent = join(subDir, "agent-big.jsonl");
    const longPrompt = "x".repeat(200 * 1024);
    writeFileSync(
      bigAgent,
      JSON.stringify({
        parentUuid: null,
        sessionId,
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: longPrompt },
      }) +
        "\n" +
        agentLine(50, 0.5),
    );
    const usage = await provider.getSessionUsage(sessionId);
    expect(usage!.breakdown.input).toBe(10 + 11 + 100 + 50);
    expect(usage!.entryCount).toBe(4);
  });

  it("re-parses a file replaced by a larger one from 0", async () => {
    await provider.getSessionUsage(sessionId);
    const replacement = mainFile + ".new";
    writeFileSync(
      replacement,
      usageLine(1, 1, 0.1) + usageLine(2, 2, 0.1) + usageLine(3, 3, 0.1),
    );
    renameSync(replacement, mainFile);
    const usage = await provider.getSessionUsage(sessionId);
    expect(usage!.breakdown.input).toBe(1 + 2 + 3 + 100);
    expect(usage!.entryCount).toBe(4);
  });

  it("keeps the previous totals when a file cannot be read", async () => {
    await provider.getSessionUsage(sessionId);
    appendFileSync(mainFile, usageLine(7, 8, 0.125));
    jest
      .spyOn(claude, "parseJsonlFileFrom")
      .mockRejectedValueOnce(
        Object.assign(new Error("busy"), { code: "EBUSY" }),
      );
    const during = await provider.getSessionUsage(sessionId);
    expect(during!.breakdown.input).toBe(10 + 11 + 100);
    const after = await provider.getSessionUsage(sessionId);
    expect(after!.breakdown.input).toBe(10 + 11 + 100 + 7);
  });

  it("rebuilds from a corrupt document", async () => {
    await provider.getSessionUsage(sessionId);
    const { CacheManager } = await import("../src/utils/cache");
    await CacheManager.setUsageDocument("session-totals-" + sessionId, {
      junk: true,
    });
    const usage = await provider.getSessionUsage(sessionId);
    expect(usage!.entryCount).toBe(3);
  });
});
