import { BlockProvider } from "../src/segments/block";
import { TodayProvider } from "../src/segments/today";
import { SegmentRenderer } from "../src/segments/renderer";
import { CacheTimerProvider } from "../src/segments/cacheTimer";
import {
  parseScopedLimits,
  isCacheEntryFresh,
  buildCacheEntry,
  limitsFromCacheEntry,
  type WeeklyScopedCacheEntry,
} from "../src/segments/weeklyScoped";
import {
  formatCacheTimerElapsed,
  formatCacheTimerRemaining,
} from "../src/utils/formatters";
import type { ClaudeHookData } from "../src/utils/claude";
import { loadIndexedUsageEntries } from "../src/utils/usageIndex";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

jest.mock("../src/utils/usageIndex", () => ({
  loadIndexedUsageEntries: jest.fn(),
}));

const mockLoadEntries = loadIndexedUsageEntries as jest.MockedFunction<
  typeof loadIndexedUsageEntries
>;

describe("Segment Time Logic", () => {
  let tempDir: string;
  let mockEntries: any[];

  beforeEach(() => {
    tempDir = join(tmpdir(), `powerline-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const now = new Date();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    const hoursSinceMidnight = now.getHours();
    const blockNumber = Math.floor(hoursSinceMidnight / 5);
    const blockStart = new Date();
    blockStart.setHours(blockNumber * 5, 0, 0, 0);

    mockEntries = [
      {
        timestamp: new Date(midnight.getTime() + 2 * 60 * 60 * 1000),
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 50,
        costUSD: 25.5,
        model: "claude-3-5-sonnet",
        hash: null,
      },
      {
        timestamp: new Date(blockStart.getTime() + 60 * 60 * 1000),
        inputTokens: 2000,
        outputTokens: 1000,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 100,
        costUSD: 45.75,
        model: "claude-3-5-sonnet",
        hash: null,
      },
    ];

    mockLoadEntries.mockResolvedValue(mockEntries);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  describe("Block Segment", () => {
    it("should only include entries from current 5-hour window", async () => {
      const now = new Date();
      const hoursSinceMidnight = now.getHours();
      const blockNumber = Math.floor(hoursSinceMidnight / 5);
      const blockStart = new Date();
      blockStart.setHours(blockNumber * 5, 0, 0, 0);
      const blockEnd = new Date();
      blockEnd.setHours((blockNumber + 1) * 5, 0, 0, 0);

      const currentBlockEntry = {
        timestamp: new Date(blockStart.getTime() + 60 * 60 * 1000),
        inputTokens: 2000,
        outputTokens: 1000,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 100,
        costUSD: 45.75,
        model: "claude-3-5-sonnet",
        hash: null,
      };

      mockLoadEntries.mockResolvedValue([currentBlockEntry]);

      const blockProvider = new BlockProvider();
      const blockInfo = await blockProvider.getActiveBlockInfo();

      expect(blockInfo.cost).toBe(45.75);
      expect(blockInfo.tokens).toBe(3300);
      expect(blockInfo.timeRemaining).toBeGreaterThan(0);
      expect(blockInfo.timeRemaining).toBeLessThanOrEqual(360);
    });

    it("should calculate correct time remaining in current block", async () => {
      const now = new Date();
      const hoursSinceMidnight = now.getHours();
      const blockNumber = Math.floor(hoursSinceMidnight / 5);
      const blockStart = new Date();
      blockStart.setHours(blockNumber * 5, 0, 0, 0);

      const mockEntry = {
        timestamp: new Date(blockStart.getTime() + 30 * 60 * 1000),
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        costUSD: 1.0,
        model: "claude-3-5-sonnet",
        hash: null,
      };

      mockLoadEntries.mockResolvedValue([mockEntry]);

      const blockProvider = new BlockProvider();
      const blockInfo = await blockProvider.getActiveBlockInfo();

      const blockEnd = new Date();
      blockEnd.setHours((blockNumber + 1) * 5, 0, 0, 0);
      const expectedRemaining = Math.max(
        0,
        Math.round((blockEnd.getTime() - now.getTime()) / (1000 * 60)),
      );

      expect(blockInfo.timeRemaining).toBe(expectedRemaining);
    });
  });

  describe("Today Segment", () => {
    it("should include all entries since midnight", async () => {
      const todayProvider = new TodayProvider();
      const todayInfo = await todayProvider.getTodayInfo();

      expect(todayInfo.cost).toBe(71.25);
      expect(todayInfo.tokens).toBe(4950);

      expect(todayInfo.tokenBreakdown).toBeDefined();
      expect(todayInfo.tokenBreakdown!.input).toBe(3000);
      expect(todayInfo.tokenBreakdown!.output).toBe(1500);
      expect(todayInfo.tokenBreakdown!.cacheCreation).toBe(300);
      expect(todayInfo.tokenBreakdown!.cacheRead).toBe(150);
    });

    it("should format date consistently using local time", async () => {
      const todayProvider = new TodayProvider();
      const todayInfo = await todayProvider.getTodayInfo();

      const expectedDate = new Date();
      const year = expectedDate.getFullYear();
      const month = String(expectedDate.getMonth() + 1).padStart(2, "0");
      const day = String(expectedDate.getDate()).padStart(2, "0");
      const expectedDateStr = `${year}-${month}-${day}`;

      expect(todayInfo.date).toBe(expectedDateStr);
    });
  });

  describe("Time Zone Consistency", () => {
    it("should use local time consistently across segments", async () => {
      const now = new Date();

      const hoursSinceMidnight = now.getHours();
      const blockNumber = Math.floor(hoursSinceMidnight / 5);
      const blockStart = new Date();
      blockStart.setHours(blockNumber * 5, 0, 0, 0);

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      expect(blockStart.getTimezoneOffset()).toBe(now.getTimezoneOffset());
      expect(todayStart.getTimezoneOffset()).toBe(now.getTimezoneOffset());

      expect(blockStart.getTime()).toBeGreaterThanOrEqual(todayStart.getTime());
    });
  });

  describe("Edge Cases", () => {
    it("should handle no entries gracefully", async () => {
      mockLoadEntries.mockResolvedValue([]);

      const blockProvider = new BlockProvider();
      const todayProvider = new TodayProvider();

      const blockInfo = await blockProvider.getActiveBlockInfo();
      const todayInfo = await todayProvider.getTodayInfo();

      expect(blockInfo.cost).toBeNull();
      expect(blockInfo.tokens).toBeNull();
      expect(blockInfo.timeRemaining).toBeNull();

      expect(todayInfo.cost).toBeNull();
      expect(todayInfo.tokens).toBeNull();
      expect(todayInfo.tokenBreakdown).toBeNull();
    });

    it("should handle entries without usage data", async () => {
      // The shared index only ever stores entries that have usage data
      // (filtering happens once, in usageIndex.ts), so a transcript with
      // only non-usage lines surfaces here as an empty result.
      mockLoadEntries.mockResolvedValue([]);

      const blockProvider = new BlockProvider();
      const blockInfo = await blockProvider.getActiveBlockInfo();

      expect(blockInfo.cost).toBeNull();
      expect(blockInfo.tokens).toBeNull();
    });
  });

  describe("Directory Segment", () => {
    const config = { theme: "dark", display: { style: "minimal" } } as any;
    const symbols = {} as any;
    const colors = { modeBg: "#1e1e2e", modeFg: "#cdd6f4" } as any;

    let renderer: SegmentRenderer;
    let originalHome: string | undefined;

    beforeEach(() => {
      renderer = new SegmentRenderer(config, symbols);
      originalHome = process.env.HOME;
    });

    afterEach(() => {
      if (originalHome !== undefined) {
        process.env.HOME = originalHome;
      }
    });

    it("should fish-style abbreviate paths under HOME", () => {
      process.env.HOME = "/home/user";
      const hookData: ClaudeHookData = {
        hook_event_name: "Status",
        session_id: "test",
        transcript_path: "/tmp/test.json",
        cwd: "/home/user/repos/dotfiles",
        model: { id: "claude-3-5-sonnet", display_name: "Claude" },
        workspace: {
          current_dir: "/home/user/repos/dotfiles",
          project_dir: "/home/user/repos/dotfiles",
        },
      };

      const result = renderer.renderDirectory(hookData, colors, {
        enabled: true,
        style: "fish",
      });

      expect(result.text).toBe("~/r/dotfiles");
    });

    it("should fish-style abbreviate paths outside HOME", () => {
      process.env.HOME = "/home/user";
      const hookData: ClaudeHookData = {
        hook_event_name: "Status",
        session_id: "test",
        transcript_path: "/tmp/test.json",
        cwd: "/mnt/c/Users/andyb/repos/dotfiles",
        model: { id: "claude-3-5-sonnet", display_name: "Claude" },
        workspace: {
          current_dir: "/mnt/c/Users/andyb/repos/dotfiles",
          project_dir: "/mnt/c/Users/andyb/repos/dotfiles",
        },
      };

      const result = renderer.renderDirectory(hookData, colors, {
        enabled: true,
        style: "fish",
      });

      expect(result.text).toBe("/m/c/U/a/r/dotfiles");
    });

    it("should show relative path when inside a subdirectory of project", () => {
      process.env.HOME = "/home/user";
      const hookData: ClaudeHookData = {
        hook_event_name: "Status",
        session_id: "test",
        transcript_path: "/tmp/test.json",
        cwd: "/home/user/repos/dotfiles/src/components",
        model: { id: "claude-3-5-sonnet", display_name: "Claude" },
        workspace: {
          current_dir: "/home/user/repos/dotfiles/src/components",
          project_dir: "/home/user/repos/dotfiles",
        },
      };

      const result = renderer.renderDirectory(hookData, colors, {
        enabled: true,
        style: "fish",
      });

      expect(result.text).toBe("~/r/d/s/components");
    });
  });

  describe("Version Segment", () => {
    it("should render version from hook data", () => {
      const config = { theme: "dark", display: { style: "minimal" } } as any;
      const symbols = { version: "◈" } as any;
      const colors = {} as any;
      const renderer = new SegmentRenderer(config, symbols);

      const hookData: ClaudeHookData = {
        hook_event_name: "Status",
        session_id: "test-session",
        transcript_path: "/tmp/test.json",
        cwd: "/test",
        model: { id: "claude-3-5-sonnet", display_name: "Claude" },
        workspace: { current_dir: "/test", project_dir: "/test" },
        version: "1.0.80",
      };

      const result = renderer.renderVersion(hookData, colors);

      expect(result).not.toBeNull();
      expect(result?.text).toContain("v1.0.80");
    });
  });

  describe("Env Segment", () => {
    const config = { theme: "dark", display: { style: "minimal" } } as any;
    const symbols = { env: "⚙" } as any;
    const colors = { envBg: "#2d2d3d", envFg: "#d0a0d0" } as any;

    let renderer: SegmentRenderer;

    beforeEach(() => {
      renderer = new SegmentRenderer(config, symbols);
    });

    afterEach(() => {
      delete process.env.TEST_ENV_SEGMENT;
    });

    it("should return null when env var is unset", () => {
      delete process.env.TEST_ENV_SEGMENT;
      const result = renderer.renderEnv(colors, {
        enabled: true,
        variable: "TEST_ENV_SEGMENT",
      });
      expect(result).toBeNull();
    });

    it("should return null when env var is empty string", () => {
      process.env.TEST_ENV_SEGMENT = "";
      const result = renderer.renderEnv(colors, {
        enabled: true,
        variable: "TEST_ENV_SEGMENT",
      });
      expect(result).toBeNull();
    });

    it("should render with variable name as default prefix", () => {
      process.env.TEST_ENV_SEGMENT = "my-value";
      const result = renderer.renderEnv(colors, {
        enabled: true,
        variable: "TEST_ENV_SEGMENT",
      });
      expect(result).not.toBeNull();
      expect(result!.text).toBe("⚙ TEST_ENV_SEGMENT: my-value");
      expect(result!.bgColor).toBe(colors.envBg);
      expect(result!.fgColor).toBe(colors.envFg);
    });

    it("should render with custom prefix", () => {
      process.env.TEST_ENV_SEGMENT = "work-org";
      const result = renderer.renderEnv(colors, {
        enabled: true,
        variable: "TEST_ENV_SEGMENT",
        prefix: "Acct",
      });
      expect(result).not.toBeNull();
      expect(result!.text).toBe("⚙ Acct: work-org");
    });

    it("should render without prefix or colon when prefix is empty string", () => {
      process.env.TEST_ENV_SEGMENT = "work-org";
      const result = renderer.renderEnv(colors, {
        enabled: true,
        variable: "TEST_ENV_SEGMENT",
        prefix: "",
      });
      expect(result).not.toBeNull();
      expect(result!.text).toBe("⚙ work-org");
    });
  });

  describe("Session ID Segment", () => {
    const config = { theme: "dark", display: { style: "minimal" } } as any;
    const symbols = { session_id: "⌗" } as any;
    const colors = { sessionBg: "#1e1e2e", sessionFg: "#cdd6f4" } as any;
    const sessionId = "01abc123-def4-5678-9012-345678901234";

    let renderer: SegmentRenderer;

    beforeEach(() => {
      renderer = new SegmentRenderer(config, symbols);
    });

    it("should render session id with label by default", () => {
      const result = renderer.renderSessionId(sessionId, colors);
      expect(result.text).toBe(`⌗ ${sessionId}`);
    });

    it("should render session id with label when showIdLabel is true", () => {
      const result = renderer.renderSessionId(sessionId, colors, {
        enabled: true,
        showIdLabel: true,
      });
      expect(result.text).toBe(`⌗ ${sessionId}`);
    });

    it("should render session id without label when showIdLabel is false", () => {
      const result = renderer.renderSessionId(sessionId, colors, {
        enabled: true,
        showIdLabel: false,
      });
      expect(result.text).toBe(sessionId);
    });

    it("should use session colors", () => {
      const result = renderer.renderSessionId(sessionId, colors);
      expect(result.bgColor).toBe(colors.sessionBg);
      expect(result.fgColor).toBe(colors.sessionFg);
    });
  });

  describe("Context Segment Bar Styles", () => {
    const config = { theme: "dark", display: { style: "minimal" } } as any;
    const symbols = {
      context_time: "◔",
      bar_filled: "▪",
      bar_empty: "▫",
    } as any;
    const colors = {
      contextBg: "#1e1e2e",
      contextFg: "#cdd6f4",
      contextWarningBg: "#92400e",
      contextWarningFg: "#fbbf24",
      contextCriticalBg: "#991b1b",
      contextCriticalFg: "#fca5a5",
    } as any;

    const mkContext = (usedPct: number) => ({
      totalTokens: usedPct * 2000,
      percentage: usedPct,
      usablePercentage: usedPct,
      contextLeftPercentage: 100 - usedPct,
      maxTokens: 200000,
      usableTokens: (100 - usedPct) * 2000,
    });

    let renderer: SegmentRenderer;

    beforeEach(() => {
      renderer = new SegmentRenderer(config, symbols);
    });

    it("should render text style by default and fall back to text on null context", () => {
      const result = renderer.renderContext(mkContext(50), colors);
      expect(result!.text).toContain("◔");
      expect(result!.text).toContain("50%");

      const nullResult = renderer.renderContext(null, colors);
      expect(nullResult!.text).toMatch(/◔.*0.*100%/);
    });

    it("should use bar_filled/bar_empty symbols for 'bar' style and BAR_STYLES chars for custom styles", () => {
      const bar = renderer.renderContext(mkContext(50), colors, {
        enabled: true,
        displayStyle: "bar",
      });
      expect(bar!.text).toContain("▪");
      expect(bar!.text).toContain("▫");

      const blocks = renderer.renderContext(mkContext(50), colors, {
        enabled: true,
        displayStyle: "blocks",
      });
      expect(blocks!.text).toContain("█");
      expect(blocks!.text).toContain("░");
    });

    it("should render all standard styles with 10-char bars and correct fill/empty", () => {
      const styles: Array<{
        name: "blocks" | "squares" | "dots" | "line" | "filled" | "geometric";
        filled: string;
        empty: string;
      }> = [
        { name: "blocks", filled: "█", empty: "░" },
        { name: "squares", filled: "◼", empty: "◻" },
        { name: "dots", filled: "●", empty: "○" },
        { name: "line", filled: "━", empty: "┄" },
        { name: "filled", filled: "■", empty: "□" },
        { name: "geometric", filled: "▰", empty: "▱" },
      ];

      for (const { name, filled, empty } of styles) {
        const result = renderer.renderContext(mkContext(50), colors, {
          enabled: true,
          displayStyle: name,
        });
        const barPart = result!.text.split(" ")[0]!;
        expect(barPart).toHaveLength(10);
        expect(barPart).toContain(filled);
        expect(barPart).toContain(empty);
      }
    });

    it("should handle capped style edge cases: 0%, mid, and 100%", () => {
      const at0 = renderer.renderContext(mkContext(0), colors, {
        enabled: true,
        displayStyle: "capped",
      });
      expect(at0!.text).toMatch(/^╸┄{9}/);

      const at50 = renderer.renderContext(mkContext(50), colors, {
        enabled: true,
        displayStyle: "capped",
      });
      expect(at50!.text).toContain("━");
      expect(at50!.text).toContain("╸");
      expect(at50!.text).toContain("┄");

      const at100 = renderer.renderContext(mkContext(100), colors, {
        enabled: true,
        displayStyle: "capped",
      });
      expect(at100!.text).toMatch(/^━{10}/);
    });

    it("should render ball style with exactly one position marker", () => {
      const result = renderer.renderContext(mkContext(50), colors, {
        enabled: true,
        displayStyle: "ball",
      });
      const barPart = result!.text.split(" ")[0]!;
      expect(barPart).toHaveLength(10);
      expect((barPart.match(/●/g) || []).length).toBe(1);
    });

    it("should render empty bars on null context and text fallback for text style", () => {
      const barNull = renderer.renderContext(null, colors, {
        enabled: true,
        displayStyle: "squares",
      });
      expect(barNull!.text).toContain("◻".repeat(10));
      expect(barNull!.text).toContain("0%");

      const textNull = renderer.renderContext(null, colors, {
        enabled: true,
        displayStyle: "text",
      });
      expect(textNull!.text).toContain("◔");
    });

    it("should apply warning/critical colors based on context left percentage", () => {
      const warning = renderer.renderContext(mkContext(70), colors, {
        enabled: true,
        displayStyle: "blocks",
      });
      expect(warning!.bgColor).toBe(colors.contextWarningBg);

      const critical = renderer.renderContext(mkContext(90), colors, {
        enabled: true,
        displayStyle: "blocks",
      });
      expect(critical!.bgColor).toBe(colors.contextCriticalBg);

      const normal = renderer.renderContext(mkContext(50), colors, {
        enabled: true,
        displayStyle: "blocks",
      });
      expect(normal!.bgColor).toBe(colors.contextBg);
    });

    it("should toggle token count display with showPercentageOnly", () => {
      const withTokens = renderer.renderContext(mkContext(50), colors, {
        enabled: true,
        displayStyle: "blocks",
      });
      expect(withTokens!.text).toContain((100000).toLocaleString());
      expect(withTokens!.text).toContain("50%");

      const pctOnly = renderer.renderContext(mkContext(50), colors, {
        enabled: true,
        displayStyle: "blocks",
        showPercentageOnly: true,
      });
      expect(pctOnly!.text).toContain("50%");
      expect(pctOnly!.text).not.toContain((100000).toLocaleString());
    });
  });
});

describe("CacheTimer Segment", () => {
  let cacheTempDir: string;

  const rendererConfig = {
    theme: "dark",
    display: { style: "minimal" },
  } as any;
  const symbols = { cache_timer: "◴" } as any;
  const colors = {
    cacheTimerBg: "#1f3a1f",
    cacheTimerFg: "#90ee90",
    contextWarningBg: "#92400e",
    contextWarningFg: "#fbbf24",
    contextCriticalBg: "#991b1b",
    contextCriticalFg: "#fca5a5",
  } as any;

  beforeEach(() => {
    cacheTempDir = join(tmpdir(), `powerline-cache-timer-${Date.now()}`);
    mkdirSync(cacheTempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(cacheTempDir, { recursive: true, force: true });
  });

  it("formats elapsed seconds across all thresholds", () => {
    expect(formatCacheTimerElapsed(0)).toBe("0:00");
    expect(formatCacheTimerElapsed(3)).toBe("0:03");
    expect(formatCacheTimerElapsed(222)).toBe("3:42");
    expect(formatCacheTimerElapsed(299)).toBe("4:59");
    expect(formatCacheTimerElapsed(300)).toBe("5m");
    expect(formatCacheTimerElapsed(1050)).toBe("17m");
    expect(formatCacheTimerElapsed(3599)).toBe("59m");
    expect(formatCacheTimerElapsed(3600)).toBe("1h+");
    expect(formatCacheTimerElapsed(86400)).toBe("1h+");
  });

  it("formats remaining seconds against TTL with cold fallback", () => {
    expect(formatCacheTimerRemaining(3600)).toBe("60:00");
    expect(formatCacheTimerRemaining(3591)).toBe("59:51");
    expect(formatCacheTimerRemaining(125)).toBe("2:05");
    expect(formatCacheTimerRemaining(59)).toBe("0:59");
    expect(formatCacheTimerRemaining(0)).toBe("cold");
    expect(formatCacheTimerRemaining(-30)).toBe("cold");
  });

  it("escalates colors at 3m and 5m boundaries", () => {
    const renderer = new SegmentRenderer(rendererConfig, symbols);

    const healthy0 = renderer.renderCacheTimer({ elapsedSeconds: 0 }, colors);
    expect(healthy0.bgColor).toBe(colors.cacheTimerBg);
    expect(healthy0.fgColor).toBe(colors.cacheTimerFg);

    const healthy179 = renderer.renderCacheTimer(
      { elapsedSeconds: 179 },
      colors,
    );
    expect(healthy179.bgColor).toBe(colors.cacheTimerBg);

    const warn180 = renderer.renderCacheTimer({ elapsedSeconds: 180 }, colors);
    expect(warn180.bgColor).toBe(colors.contextWarningBg);
    expect(warn180.fgColor).toBe(colors.contextWarningFg);

    const warn299 = renderer.renderCacheTimer({ elapsedSeconds: 299 }, colors);
    expect(warn299.bgColor).toBe(colors.contextWarningBg);

    const critical300 = renderer.renderCacheTimer(
      { elapsedSeconds: 300 },
      colors,
    );
    expect(critical300.bgColor).toBe(colors.contextCriticalBg);
    expect(critical300.fgColor).toBe(colors.contextCriticalFg);

    const critical3600 = renderer.renderCacheTimer(
      { elapsedSeconds: 3600 },
      colors,
    );
    expect(critical3600.bgColor).toBe(colors.contextCriticalBg);
    expect(critical3600.text).toContain("1h+");
  });

  it("renders remaining mode with critical/warn thresholds and TTL override", () => {
    const renderer = new SegmentRenderer(rendererConfig, symbols);

    const fresh = renderer.renderCacheTimer({ elapsedSeconds: 10 }, colors, {
      enabled: true,
      displayMode: "remaining",
    });
    expect(fresh.text).toContain("59:50");
    expect(fresh.bgColor).toBe(colors.cacheTimerBg);

    const warn = renderer.renderCacheTimer({ elapsedSeconds: 3500 }, colors, {
      enabled: true,
      displayMode: "remaining",
    });
    expect(warn.bgColor).toBe(colors.contextWarningBg);

    const critical = renderer.renderCacheTimer(
      { elapsedSeconds: 3580 },
      colors,
      { enabled: true, displayMode: "remaining" },
    );
    expect(critical.bgColor).toBe(colors.contextCriticalBg);

    const cold = renderer.renderCacheTimer({ elapsedSeconds: 7200 }, colors, {
      enabled: true,
      displayMode: "remaining",
    });
    expect(cold.text).toContain("cold");
    expect(cold.bgColor).toBe(colors.contextCriticalBg);

    const customTtl = renderer.renderCacheTimer(
      { elapsedSeconds: 60 },
      colors,
      { enabled: true, displayMode: "remaining", ttlSeconds: 300 },
    );
    expect(customTtl.text).toContain("4:00");
    expect(customTtl.bgColor).toBe(colors.contextWarningBg);
  });

  it("renders remaining mode using detected TTL when no explicit ttlSeconds is set", () => {
    const renderer = new SegmentRenderer(rendererConfig, symbols);

    const detected1h = renderer.renderCacheTimer(
      { elapsedSeconds: 30, detectedTtlSeconds: 3600 },
      colors,
      { enabled: true, displayMode: "remaining" },
    );
    expect(detected1h.text).toContain("59:30");

    const detected5m = renderer.renderCacheTimer(
      { elapsedSeconds: 30, detectedTtlSeconds: 300 },
      colors,
      { enabled: true, displayMode: "remaining" },
    );
    expect(detected5m.text).toContain("4:30");

    const explicitOverride = renderer.renderCacheTimer(
      { elapsedSeconds: 120, detectedTtlSeconds: 3600 },
      colors,
      { enabled: true, displayMode: "remaining", ttlSeconds: 60 },
    );
    expect(explicitOverride.text).toContain("cold");
    expect(explicitOverride.bgColor).toBe(colors.contextCriticalBg);
  });

  it("anchors elapsed time to the last user entry in the transcript", async () => {
    const transcriptPath = join(cacheTempDir, "transcript.jsonl");
    const now = Date.now();
    const userTs = new Date(now - 120_000).toISOString();
    const content = [
      JSON.stringify({
        type: "user",
        message: { role: "user" },
        timestamp: new Date(now - 600_000).toISOString(),
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user" },
        timestamp: userTs,
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant" },
        timestamp: new Date(now - 15_000).toISOString(),
      }),
    ].join("\n");
    writeFileSync(transcriptPath, content);

    const provider = new CacheTimerProvider();
    const result = await provider.getCacheTimerInfo({
      transcript_path: transcriptPath,
    } as ClaudeHookData);

    expect(result).not.toBeNull();
    expect(result!.elapsedSeconds).toBeGreaterThanOrEqual(119);
    expect(result!.elapsedSeconds).toBeLessThanOrEqual(125);
  });

  it("autodetects TTL from assistant cache_creation usage tokens", async () => {
    const transcriptPath = join(cacheTempDir, "transcript-ttl-1h.jsonl");
    const now = Date.now();
    const content = [
      JSON.stringify({
        type: "user",
        message: { role: "user" },
        timestamp: new Date(now - 60_000).toISOString(),
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          usage: {
            cache_creation: {
              ephemeral_1h_input_tokens: 48153,
              ephemeral_5m_input_tokens: 0,
            },
          },
        },
        timestamp: new Date(now - 30_000).toISOString(),
      }),
    ].join("\n");
    writeFileSync(transcriptPath, content);

    const provider = new CacheTimerProvider();
    const result = await provider.getCacheTimerInfo({
      transcript_path: transcriptPath,
    } as ClaudeHookData);

    expect(result).not.toBeNull();
    expect(result!.detectedTtlSeconds).toBe(3600);
  });

  it("autodetects 5-minute TTL when only ephemeral_5m_input_tokens is set", async () => {
    const transcriptPath = join(cacheTempDir, "transcript-ttl-5m.jsonl");
    const now = Date.now();
    const content = [
      JSON.stringify({
        type: "user",
        message: { role: "user" },
        timestamp: new Date(now - 60_000).toISOString(),
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          usage: {
            cache_creation: {
              ephemeral_1h_input_tokens: 0,
              ephemeral_5m_input_tokens: 1200,
            },
          },
        },
        timestamp: new Date(now - 30_000).toISOString(),
      }),
    ].join("\n");
    writeFileSync(transcriptPath, content);

    const provider = new CacheTimerProvider();
    const result = await provider.getCacheTimerInfo({
      transcript_path: transcriptPath,
    } as ClaudeHookData);

    expect(result).not.toBeNull();
    expect(result!.detectedTtlSeconds).toBe(300);
  });

  it("omits detectedTtlSeconds when no cache_creation usage is recorded", async () => {
    const transcriptPath = join(cacheTempDir, "transcript-no-usage.jsonl");
    const now = Date.now();
    const content = [
      JSON.stringify({
        type: "user",
        message: { role: "user" },
        timestamp: new Date(now - 60_000).toISOString(),
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant" },
        timestamp: new Date(now - 30_000).toISOString(),
      }),
    ].join("\n");
    writeFileSync(transcriptPath, content);

    const provider = new CacheTimerProvider();
    const result = await provider.getCacheTimerInfo({
      transcript_path: transcriptPath,
    } as ClaudeHookData);

    expect(result).not.toBeNull();
    expect(result!.detectedTtlSeconds).toBeUndefined();
  });

  it("falls back to file mtime when the transcript has no user timestamps", async () => {
    const transcriptPath = join(cacheTempDir, "transcript-empty.jsonl");
    writeFileSync(transcriptPath, "not-json\n");

    const provider = new CacheTimerProvider();
    const result = await provider.getCacheTimerInfo({
      transcript_path: transcriptPath,
    } as ClaudeHookData);

    expect(result).not.toBeNull();
    expect(result!.elapsedSeconds).toBeGreaterThanOrEqual(0);
    expect(result!.elapsedSeconds).toBeLessThanOrEqual(5);
  });

  it("returns null when there is no transcript path", async () => {
    const provider = new CacheTimerProvider();
    const result = await provider.getCacheTimerInfo({} as ClaudeHookData);
    expect(result).toBeNull();
  });
});

describe("WeeklyScoped Segment", () => {
  const rendererConfig = {
    theme: "dark",
    display: { style: "minimal" },
  } as any;
  const symbols = { weekly_scoped: "" } as any;
  const colors = {
    weeklyScopedBg: "#252525",
    weeklyScopedFg: "#ffa500",
  } as any;

  const apiBody = {
    five_hour: { utilization: 5 },
    seven_day: { utilization: 28 },
    limits: [
      {
        kind: "session",
        percent: 5,
        resets_at: "2026-07-18T12:39:59.921059+00:00",
        scope: null,
      },
      {
        kind: "weekly_all",
        percent: 28,
        resets_at: "2026-07-20T17:59:59.921085+00:00",
        scope: null,
      },
      {
        kind: "weekly_scoped",
        percent: 47,
        resets_at: "2026-07-20T17:59:59.921406+00:00",
        scope: { model: { id: null, display_name: "Fable" } },
      },
    ],
  };

  describe("parseScopedLimits", () => {
    it("extracts only weekly_scoped entries with the model name", () => {
      const limits = parseScopedLimits(apiBody);
      expect(limits).toHaveLength(1);
      expect(limits[0]!.displayName).toBe("Fable");
      expect(limits[0]!.usedPercentage).toBe(47);
      expect(limits[0]!.resetsAt).toEqual(
        new Date("2026-07-20T17:59:59.921406+00:00"),
      );
    });

    it("returns empty for plans without scoped limits", () => {
      const body = {
        limits: [{ kind: "session", percent: 5 }],
      };
      expect(parseScopedLimits(body)).toEqual([]);
    });

    it("skips scoped entries without a model display name or percent", () => {
      const body = {
        limits: [
          { kind: "weekly_scoped", percent: 47, scope: { model: null } },
          {
            kind: "weekly_scoped",
            scope: { model: { display_name: "Fable" } },
          },
        ],
      };
      expect(parseScopedLimits(body)).toEqual([]);
    });

    it("tolerates malformed bodies", () => {
      expect(parseScopedLimits(null)).toEqual([]);
      expect(parseScopedLimits("nonsense")).toEqual([]);
      expect(parseScopedLimits({})).toEqual([]);
      expect(parseScopedLimits({ limits: "not-an-array" })).toEqual([]);
    });

    it("nulls invalid reset timestamps instead of propagating them", () => {
      const body = {
        limits: [
          {
            kind: "weekly_scoped",
            percent: 12,
            resets_at: "not-a-date",
            scope: { model: { display_name: "Fable" } },
          },
        ],
      };
      const limits = parseScopedLimits(body);
      expect(limits).toHaveLength(1);
      expect(limits[0]!.resetsAt).toBeNull();
    });
  });

  describe("serve-stale cache logic", () => {
    const now = Date.parse("2026-07-18T12:00:00Z");
    const fableLimit = {
      displayName: "Fable",
      usedPercentage: 47,
      resetsAt: "2026-07-20T17:59:59.921Z",
    };

    const okEntry = (ageMs: number): WeeklyScopedCacheEntry => ({
      status: "ok",
      at: now - ageMs,
      limits: [fableLimit],
      lastSuccessAt: now - ageMs,
    });

    describe("isCacheEntryFresh", () => {
      it("keeps successful results for 60 seconds", () => {
        expect(isCacheEntryFresh(okEntry(30_000), now)).toBe(true);
        expect(isCacheEntryFresh(okEntry(90_000), now)).toBe(false);
      });

      it("backs off for 5 minutes after a failure", () => {
        const errorEntry: WeeklyScopedCacheEntry = {
          status: "error",
          at: now - 90_000,
          limits: [fableLimit],
          lastSuccessAt: now - 400_000,
        };
        expect(isCacheEntryFresh(errorEntry, now)).toBe(true);
        expect(
          isCacheEntryFresh({ ...errorEntry, at: now - 400_000 }, now),
        ).toBe(false);
      });

      it("treats legacy entries without a status as stale", () => {
        expect(isCacheEntryFresh({ limits: [] } as any, now)).toBe(false);
      });

      it("treats future timestamps as stale instead of fresh forever", () => {
        expect(isCacheEntryFresh(okEntry(-30_000), now)).toBe(false);
      });

      it("rejects entries whose limits field is not an array", () => {
        const corrupted = { ...okEntry(30_000), limits: "garbage" as any };
        expect(isCacheEntryFresh(corrupted, now)).toBe(false);
      });
    });

    describe("buildCacheEntry", () => {
      it("records a successful fetch with its limits", () => {
        const entry = buildCacheEntry(null, apiBody, now);
        expect(entry.status).toBe("ok");
        expect(entry.at).toBe(now);
        expect(entry.lastSuccessAt).toBe(now);
        expect(entry.limits).toHaveLength(1);
        expect(entry.limits[0]!.displayName).toBe("Fable");
      });

      it("keeps an authoritative empty success empty", () => {
        const entry = buildCacheEntry(okEntry(90_000), { limits: [] }, now);
        expect(entry.status).toBe("ok");
        expect(entry.limits).toEqual([]);
      });

      it("carries the last good limits through a failed fetch", () => {
        const previous = okEntry(90_000);
        const entry = buildCacheEntry(previous, null, now);
        expect(entry.status).toBe("error");
        expect(entry.at).toBe(now);
        expect(entry.limits).toEqual(previous.limits);
        expect(entry.lastSuccessAt).toBe(previous.lastSuccessAt);
      });

      it("stays empty when a fetch fails with no prior success", () => {
        const entry = buildCacheEntry(null, null, now);
        expect(entry.status).toBe("error");
        expect(entry.limits).toEqual([]);
        expect(entry.lastSuccessAt).toBeNull();
      });
    });

    describe("limitsFromCacheEntry", () => {
      it("revives dates from cached limits", () => {
        const limits = limitsFromCacheEntry(okEntry(30_000), now);
        expect(limits).toHaveLength(1);
        expect(limits[0]!.resetsAt).toEqual(
          new Date("2026-07-20T17:59:59.921Z"),
        );
      });

      it("drops limits whose reset time has already passed", () => {
        const entry: WeeklyScopedCacheEntry = {
          status: "error",
          at: now,
          limits: [{ ...fableLimit, resetsAt: "2026-07-17T00:00:00Z" }],
          lastSuccessAt: now - 1000,
        };
        expect(limitsFromCacheEntry(entry, now)).toEqual([]);
      });

      it("keeps limits without a reset timestamp", () => {
        const entry: WeeklyScopedCacheEntry = {
          status: "error",
          at: now,
          limits: [{ ...fableLimit, resetsAt: null }],
          lastSuccessAt: now - 1000,
        };
        expect(limitsFromCacheEntry(entry, now)).toHaveLength(1);
      });

      it("skips malformed cached limit items instead of throwing", () => {
        const entry: WeeklyScopedCacheEntry = {
          status: "ok",
          at: now,
          limits: [
            fableLimit,
            null,
            { displayName: 42, usedPercentage: "high" },
            "junk",
          ] as any,
          lastSuccessAt: now,
        };
        const limits = limitsFromCacheEntry(entry, now);
        expect(limits).toHaveLength(1);
        expect(limits[0]!.displayName).toBe("Fable");
      });

      it("returns empty for a non-array limits field", () => {
        const entry = {
          status: "ok",
          at: now,
          limits: "garbage",
          lastSuccessAt: now,
        } as any;
        expect(limitsFromCacheEntry(entry, now)).toEqual([]);
      });
    });
  });

  describe("renderWeeklyScoped", () => {
    const renderer = new SegmentRenderer(rendererConfig, symbols);

    it("hides the segment entirely when no scoped limit exists", () => {
      const result = renderer.renderWeeklyScoped({ limits: [] }, colors);
      expect(result).toBeNull();
    });

    it("renders the model name and used percentage", () => {
      const result = renderer.renderWeeklyScoped(
        {
          limits: [
            { displayName: "Fable", usedPercentage: 47.4, resetsAt: null },
          ],
        },
        colors,
      );
      expect(result).not.toBeNull();
      expect(result!.text).toContain("Fable 47%");
      expect(result!.bgColor).toBe(colors.weeklyScopedBg);
      expect(result!.fgColor).toBe(colors.weeklyScopedFg);
    });

    it("supports left percentage mode", () => {
      const result = renderer.renderWeeklyScoped(
        {
          limits: [
            { displayName: "Fable", usedPercentage: 47, resetsAt: null },
          ],
        },
        colors,
        { enabled: true, percentageMode: "left" },
      );
      expect(result!.text).toContain("Fable 53% left");
    });

    it("shows time until reset when enabled", () => {
      const resetsAt = new Date(Date.now() + 26 * 60 * 60 * 1000);
      const result = renderer.renderWeeklyScoped(
        { limits: [{ displayName: "Fable", usedPercentage: 47, resetsAt }] },
        colors,
        { enabled: true, showTimeLeft: true },
      );
      expect(result!.text).toMatch(/\(1d \dh left\)/);
    });

    it("can hide the model name and icon", () => {
      const result = renderer.renderWeeklyScoped(
        {
          limits: [
            { displayName: "Fable", usedPercentage: 47, resetsAt: null },
          ],
        },
        colors,
        { enabled: true, showModelName: false, showIcon: false },
      );
      expect(result!.text).toBe("47%");
    });

    it("joins multiple scoped limits", () => {
      const result = renderer.renderWeeklyScoped(
        {
          limits: [
            { displayName: "Fable", usedPercentage: 47, resetsAt: null },
            { displayName: "Opus", usedPercentage: 12, resetsAt: null },
          ],
        },
        colors,
        { enabled: true, showIcon: false },
      );
      expect(result!.text).toBe("Fable 47%, Opus 12%");
    });
  });
});
