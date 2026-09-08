import {
  stripAnsi,
  visibleLength,
  parseProcStat,
  ttyPathFromTtyNr,
  findParentTtyFromProc,
  getTerminalWidth,
} from "../src/utils/terminal";
import { PowerlineRenderer } from "../src/powerline";
import { DEFAULT_CONFIG } from "../src/config/defaults";
import type { PowerlineConfig } from "../src/config/loader";

describe("terminal utilities", () => {
  describe("stripAnsi", () => {
    it("should remove ANSI color codes", () => {
      const input = "\x1b[38;2;255;0;0mred text\x1b[0m";
      expect(stripAnsi(input)).toBe("red text");
    });

    it("should handle multiple ANSI codes", () => {
      const input = "\x1b[48;2;0;0;255m\x1b[38;2;255;255;255m text \x1b[0m";
      expect(stripAnsi(input)).toBe(" text ");
    });

    it("should return unchanged string without ANSI codes", () => {
      const input = "plain text";
      expect(stripAnsi(input)).toBe("plain text");
    });

    it("should handle empty string", () => {
      expect(stripAnsi("")).toBe("");
    });
  });

  describe("visibleLength", () => {
    it("should return correct length without ANSI codes", () => {
      const input = "\x1b[38;2;255;0;0mhello\x1b[0m";
      expect(visibleLength(input)).toBe(5);
    });

    it("should return length of plain text", () => {
      expect(visibleLength("hello world")).toBe(11);
    });

    it("should return 0 for empty string", () => {
      expect(visibleLength("")).toBe(0);
    });

    it("should handle string with only ANSI codes", () => {
      expect(visibleLength("\x1b[0m\x1b[38;2;0;0;0m")).toBe(0);
    });
  });
});

describe("autoWrap functionality", () => {
  const createConfig = (
    overrides: Partial<PowerlineConfig> = {},
  ): PowerlineConfig => ({
    ...DEFAULT_CONFIG,
    display: {
      ...DEFAULT_CONFIG.display,
      autoWrap: true,
      style: "minimal",
      ...overrides.display,
    },
    ...overrides,
  });

  const mockHookData = {
    session_id: "test-session",
    transcript_path: "/fake/path.jsonl",
    workspace: {
      project_dir: "/test/project",
      current_dir: "/test/project",
    },
    model: {
      id: "claude-3-5-sonnet",
      display_name: "Claude",
    },
    cwd: "/test/project",
    hook_event_name: "test",
  };

  describe("configuration", () => {
    it("should have autoWrap true by default", () => {
      expect(DEFAULT_CONFIG.display.autoWrap).toBe(true);
    });

    it("should accept autoWrap true in config", () => {
      const config = createConfig();
      expect(config.display.autoWrap).toBe(true);
    });
  });

  describe("rendering with autoWrap", () => {
    it("should generate statusline with autoWrap enabled", async () => {
      const config = createConfig();
      const renderer = new PowerlineRenderer(config);
      const result = await renderer.generateStatusline(mockHookData);

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    });

    it("should respect manual line breaks with autoWrap", async () => {
      const config = createConfig({
        display: {
          ...DEFAULT_CONFIG.display,
          autoWrap: true,
          style: "minimal",
          lines: [
            {
              segments: {
                directory: { enabled: true, showBasename: true },
                model: { enabled: true },
              },
            },
            {
              segments: {
                session: {
                  enabled: true,
                  type: "tokens",
                  costSource: "calculated",
                },
                context: { enabled: true, showPercentageOnly: false },
              },
            },
          ],
        },
      });

      const renderer = new PowerlineRenderer(config);
      const result = await renderer.generateStatusline(mockHookData);

      expect(result).toContain("\n");
    });

    it("should not produce empty lines", async () => {
      const config = createConfig({
        display: {
          ...DEFAULT_CONFIG.display,
          autoWrap: true,
          style: "minimal",
          lines: [
            {
              segments: {
                directory: { enabled: true, showBasename: true },
              },
            },
            {
              segments: {
                model: { enabled: false },
              },
            },
            {
              segments: {
                session: {
                  enabled: true,
                  type: "tokens",
                  costSource: "calculated",
                },
              },
            },
          ],
        },
      });

      const renderer = new PowerlineRenderer(config);
      const result = await renderer.generateStatusline(mockHookData);
      const lines = result.split("\n");

      for (const line of lines) {
        expect(stripAnsi(line).trim().length).toBeGreaterThan(0);
      }
    });
  });
});

describe("proc-based tty discovery", () => {
  describe("parseProcStat", () => {
    it("should parse ppid and ttyNr when comm contains spaces and parens", () => {
      const line =
        "12345 (my (odd) prog) S 6789 12345 12345 34817 12345 4194304 1234 0 0 0";
      expect(parseProcStat(line)).toEqual({ ppid: 6789, ttyNr: 34817 });
    });

    it("should parse a plain stat line", () => {
      const line = "42 (node) S 1 42 42 0 -1 4194304 900 0 0 0";
      expect(parseProcStat(line)).toEqual({ ppid: 1, ttyNr: 0 });
    });

    it("should return null for malformed input", () => {
      expect(parseProcStat("not a stat line")).toBeNull();
      expect(parseProcStat("")).toBeNull();
    });
  });

  describe("ttyPathFromTtyNr", () => {
    it("should decode major 136 pty devices", () => {
      expect(ttyPathFromTtyNr(34817)).toBe("/dev/pts/1");
    });

    it("should decode major 137 pty devices with the 256 offset", () => {
      expect(ttyPathFromTtyNr((137 << 8) | 5)).toBe("/dev/pts/261");
    });

    it("should decode high minor bits stored above bit 20", () => {
      expect(ttyPathFromTtyNr(0x10882c)).toBe("/dev/pts/300");
    });

    it("should decode virtual consoles on major 4", () => {
      expect(ttyPathFromTtyNr((4 << 8) | 1)).toBe("/dev/tty1");
    });

    it("should decode serial consoles on major 4", () => {
      expect(ttyPathFromTtyNr((4 << 8) | 64)).toBe("/dev/ttyS0");
    });

    it("should return null when there is no controlling terminal", () => {
      expect(ttyPathFromTtyNr(0)).toBeNull();
    });

    it("should return null for an unknown major", () => {
      expect(ttyPathFromTtyNr((5 << 8) | 3)).toBeNull();
    });
  });

  describe("findParentTtyFromProc", () => {
    it("should walk up parents until a tty is found", () => {
      const stats: Record<number, string> = {
        100: "100 (node) S 90 100 100 0 -1 4194304 1 0 0 0",
        90: "90 (sh) S 80 90 90 0 -1 4194304 1 0 0 0",
        80: "80 (wezterm) S 1 80 80 34817 -1 4194304 1 0 0 0",
      };
      const read = (pid: number) => stats[pid] ?? null;
      expect(findParentTtyFromProc(100, read)).toBe("/dev/pts/1");
    });

    it("should stop at init without a tty", () => {
      const stats: Record<number, string> = {
        100: "100 (node) S 1 100 100 0 -1 4194304 1 0 0 0",
        1: "1 (systemd) S 0 1 1 0 -1 4194304 1 0 0 0",
      };
      const read = (pid: number) => stats[pid] ?? null;
      expect(findParentTtyFromProc(100, read)).toBeNull();
    });

    it("should return null when /proc is unreadable", () => {
      expect(findParentTtyFromProc(100, () => null)).toBeNull();
    });

    it("should not loop forever on a cyclic parent chain", () => {
      const read = (pid: number) =>
        `${pid} (a) S ${pid} ${pid} ${pid} 0 -1 4194304 1 0 0 0`;
      expect(findParentTtyFromProc(100, read)).toBeNull();
    });
  });
});

describe("getTerminalWidth", () => {
  const originalColumns = process.env.COLUMNS;

  afterEach(() => {
    if (originalColumns === undefined) {
      delete process.env.COLUMNS;
    } else {
      process.env.COLUMNS = originalColumns;
    }
  });

  it("should honor COLUMNS first and apply the 70% reserve", () => {
    process.env.COLUMNS = "200";
    expect(getTerminalWidth()).toBe(140);
  });

  it("should ignore an invalid COLUMNS value", () => {
    process.env.COLUMNS = "nonsense";
    const width = getTerminalWidth();
    expect(width === null || width > 0).toBe(true);
  });
});
