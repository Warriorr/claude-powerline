import { renderTuiPanel } from "../src/tui/renderer";
import type { TuiData, BoxChars } from "../src/tui/types";
import type { PowerlineColors } from "../src/themes";
import type { PowerlineConfig } from "../src/config/loader";
import { BOX_CHARS } from "../src/utils/constants";
import { DEFAULT_CONFIG } from "../src/config/defaults";

// Use empty strings for colors so snapshots capture layout, not ANSI codes
const PLAIN_COLORS: PowerlineColors = {
  reset: "", modeBg: "", modeFg: "", gitBg: "", gitFg: "",
  modelBg: "", modelFg: "", sessionBg: "", sessionFg: "",
  blockBg: "", blockFg: "", todayBg: "", todayFg: "",
  tmuxBg: "", tmuxFg: "", contextBg: "", contextFg: "",
  contextWarningBg: "", contextWarningFg: "",
  contextCriticalBg: "", contextCriticalFg: "",
  metricsBg: "", metricsFg: "", versionBg: "", versionFg: "",
  envBg: "", envFg: "",
  weeklyBg: "", weeklyFg: "",
};

const tuiConfig: PowerlineConfig = {
  ...DEFAULT_CONFIG,
  display: {
    ...DEFAULT_CONFIG.display,
    style: "tui",
  },
};

function makeTuiData(overrides: Partial<TuiData> = {}): TuiData {
  return {
    hookData: {
      session_id: "test-session",
      transcript_path: "/fake/path.jsonl",
      workspace: { project_dir: "/home/user/project", current_dir: "/home/user/project" },
      model: { id: "claude-sonnet-4-6", display_name: "Claude 3.5 Sonnet" },
      cwd: "/home/user/project",
      hook_event_name: "test",
      version: "1.19.6",
    },
    usageInfo: { session: { cost: 0.0523, tokens: 42150, calculatedCost: 0.0523, officialCost: null, tokenBreakdown: null } },
    blockInfo: { cost: 0.12, tokens: 5000, weightedTokens: 5000, timeRemaining: 3600, timeElapsed: null, burnRate: 0.45, tokenBurnRate: null, rateLimitPercentage: null, resetsAt: null, projectedUsagePercentage: null, projectedUsageTrend: null, lastNonFlatTrend: null, minutesToLimit: null },
    todayInfo: { cost: 1.87, tokens: null, tokenBreakdown: null, date: "2026-03-17" },
    contextInfo: { totalTokens: 90000, maxTokens: 200000, usablePercentage: 45, percentage: 45, contextLeftPercentage: 55, usableTokens: 110000 },
    metricsInfo: { responseTime: 2.3, lastResponseTime: null, sessionDuration: 125, messageCount: 12, linesAdded: 48, linesRemoved: 15 },
    gitInfo: { branch: "feat/tui-mode", status: "dirty", ahead: 2, behind: 0 },
    tmuxSessionId: "dev",
    colors: PLAIN_COLORS,
    ...overrides,
  };
}

describe("TUI Panel Rendering", () => {
  describe("Wide layout (80+ cols)", () => {
    it("should render full panel with all data", () => {
      const result = renderTuiPanel(makeTuiData(), BOX_CHARS, "", 100, tuiConfig);
      expect(result).toMatchSnapshot();
    });

    it("should render with minimal data", () => {
      const result = renderTuiPanel(
        makeTuiData({ usageInfo: null, blockInfo: null, todayInfo: null, metricsInfo: null, gitInfo: null, tmuxSessionId: null }),
        BOX_CHARS, "", 100, tuiConfig,
      );
      expect(result).toMatchSnapshot();
    });
  });

  describe("Medium layout (55-79 cols)", () => {
    it("should render metrics across 2 lines", () => {
      const result = renderTuiPanel(makeTuiData(), BOX_CHARS, "", 65, tuiConfig);
      expect(result).toMatchSnapshot();
    });
  });

  describe("Narrow layout (<55 cols)", () => {
    it("should stack everything vertically", () => {
      const result = renderTuiPanel(makeTuiData(), BOX_CHARS, "", 40, tuiConfig);
      expect(result).toMatchSnapshot();
    });
  });

  describe("Edge cases", () => {
    it("should handle null terminal width", () => {
      const result = renderTuiPanel(makeTuiData(), BOX_CHARS, "", null, tuiConfig);
      expect(result).toMatchSnapshot();
    });

    it("should handle minimum panel width", () => {
      const result = renderTuiPanel(makeTuiData(), BOX_CHARS, "", 32, tuiConfig);
      expect(result).toMatchSnapshot();
    });

    it("should handle missing context info", () => {
      const result = renderTuiPanel(makeTuiData({ contextInfo: null }), BOX_CHARS, "", 100, tuiConfig);
      expect(result).toMatchSnapshot();
    });

    it("should handle context at warning level", () => {
      const result = renderTuiPanel(
        makeTuiData({ contextInfo: { totalTokens: 140000, maxTokens: 200000, usablePercentage: 70, percentage: 70, contextLeftPercentage: 30, usableTokens: 60000} }),
        BOX_CHARS, "", 100, tuiConfig,
      );
      expect(result).toMatchSnapshot();
    });

    it("should show git working tree counts", () => {
      const result = renderTuiPanel(
        makeTuiData({ gitInfo: { branch: "main", status: "dirty", ahead: 0, behind: 0, staged: 3, unstaged: 2, untracked: 1 } }),
        BOX_CHARS, "", 100, tuiConfig,
      );
      expect(result).toContain("(+3 ~2 ?1)");
      expect(result).toMatchSnapshot();
    });

    it("should handle context at critical level", () => {
      const result = renderTuiPanel(
        makeTuiData({ contextInfo: { totalTokens: 180000, maxTokens: 200000, usablePercentage: 90, percentage: 90, contextLeftPercentage: 10, usableTokens: 20000 } }),
        BOX_CHARS, "", 100, tuiConfig,
      );
      expect(result).toMatchSnapshot();
    });
  });
});
