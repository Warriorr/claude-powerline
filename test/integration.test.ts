import { PowerlineRenderer } from "../src/powerline";
import type { ClaudeHookData } from "../src/utils/claude";

jest.mock("../src/segments/session", () => ({
  SessionProvider: jest.fn().mockImplementation(() => ({
    getSessionInfo: jest.fn().mockResolvedValue({
      cost: 0.05,
      tokens: 1650,
      tokenBreakdown: {
        input: 1000,
        output: 500,
        cacheCreation: 100,
        cacheRead: 50,
      },
    }),
  })),
  UsageProvider: jest.fn().mockImplementation(() => ({
    getUsageInfo: jest.fn().mockResolvedValue({
      session: {
        cost: 0.05,
        tokens: 1650,
        tokenBreakdown: {
          input: 1000,
          output: 500,
          cacheCreation: 100,
          cacheRead: 50,
        },
      },
    }),
  })),
}));

jest.mock("node:child_process", () => ({
  exec: jest
    .fn()
    .mockImplementation((cmd: string, _options: any, callback: any) => {
      let result = "";
      if (cmd.includes("git branch --show-current")) result = "main\n";
      else if (cmd.includes("git status --porcelain")) result = "";
      else if (cmd.includes("git rev-list --count")) result = "0\n";

      if (typeof callback === "function") {
        callback(null, { stdout: result, stderr: "" });
      }
      return result;
    }),
}));

describe("Integration Tests", () => {
  const mockHookData: ClaudeHookData = {
    hook_event_name: "Status",
    session_id: "test-session-123",
    transcript_path: "/path/to/transcript.json",
    cwd: "/Users/test/claude-powerline",
    model: {
      id: "claude-opus-4",
      display_name: "Claude Opus",
    },
    workspace: {
      current_dir: "/Users/test/claude-powerline",
      project_dir: "/Users/test/claude-powerline",
    },
  };

  it("should generate complete statusline without ccusage dependency", async () => {
    const config = {
      theme: "dark" as const,
      display: {
        lines: [
          {
            segments: {
              directory: { enabled: true },
              git: { enabled: true, showSha: false },
              model: { enabled: true },
              session: { enabled: true, type: "tokens" as const },
            },
          },
        ],
      },
    };

    const renderer = new PowerlineRenderer(config);
    const result = await renderer.generateStatusline(mockHookData);

    expect(result).toContain("claude-powerline");
    expect(result).toContain("1.6K tokens");
    expect(result).toContain("Claude Opus");
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
    expect(result.length).toBeGreaterThan(0);
  });

  it("should handle session segment with different usage types", async () => {
    const baseConfig = {
      theme: "dark" as const,
      display: {
        lines: [
          {
            segments: {
              session: { enabled: true, type: "cost" as const },
            },
          },
        ],
      },
    };

    const renderer = new PowerlineRenderer(baseConfig);
    const result = await renderer.generateStatusline(mockHookData);

    expect(result).toContain("$0.05");
  });

  it("should work with minimal configuration", async () => {
    const minimalConfig = {
      theme: "light" as const,
      display: {
        lines: [
          {
            segments: {
              directory: { enabled: true },
            },
          },
        ],
      },
    };

    const renderer = new PowerlineRenderer(minimalConfig);
    const result = await renderer.generateStatusline(mockHookData);

    expect(result).toBeTruthy();
    expect(result).toContain("claude-powerline");
  });

  it("should handle empty segment configuration gracefully", async () => {
    const emptyConfig = {
      theme: "dark" as const,
      display: {
        lines: [
          {
            segments: {},
          },
        ],
      },
    };

    const renderer = new PowerlineRenderer(emptyConfig);
    const result = await renderer.generateStatusline(mockHookData);

    expect(typeof result).toBe("string");
  });
});
