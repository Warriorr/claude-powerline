import {
  BlockProvider,
  FIVE_HOUR_WINDOW_DOCUMENT,
} from "../src/segments/block";
import { PowerlineRenderer } from "../src/powerline";
import { CacheManager } from "../src/utils/cache";
import type { ClaudeHookData } from "../src/utils/claude";

const RESETS_AT = Math.floor(Date.now() / 1000) + 3600;
const FIVE_HOUR = { used_percentage: 40, resets_at: RESETS_AT };
const SEVEN_DAY = { used_percentage: 3, resets_at: RESETS_AT + 86400 };

// The block symbol for the "text" charset, so assertions match the segment
// itself and not a percentage some other segment happens to print.
const BLOCK_SYMBOL = "[5h]";

function hookData(rateLimits?: ClaudeHookData["rate_limits"]): ClaudeHookData {
  return {
    hook_event_name: "Status",
    session_id: "block-window-test",
    transcript_path: "/nonexistent/transcript.jsonl",
    cwd: "/nonexistent",
    model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
    workspace: { current_dir: "/nonexistent", project_dir: "/nonexistent" },
    ...(rateLimits ? { rate_limits: rateLimits } : {}),
  };
}

function renderer(style: "powerline" | "tui"): PowerlineRenderer {
  return new PowerlineRenderer({
    theme: "dark",
    display: {
      style,
      charset: "text",
      lines: [{ segments: { block: { enabled: true, type: "tokens" } } }],
    },
  } as ConstructorParameters<typeof PowerlineRenderer>[0]);
}

describe("5-hour window detection", () => {
  beforeEach(async () => {
    await CacheManager.removeUsageDocument(FIVE_HOUR_WINDOW_DOCUMENT);
  });

  describe("BlockProvider.getBlockInfo", () => {
    const provider = new BlockProvider();

    it("returns block info with the reported usage when five_hour is present", async () => {
      const info = await provider.getBlockInfo({
        five_hour: FIVE_HOUR,
        seven_day: SEVEN_DAY,
      });

      expect(info).not.toBeNull();
      expect(info?.rateLimitPercentage).toBe(40);
    });

    it("returns null when rate limits are reported without a five_hour window", async () => {
      expect(await provider.getBlockInfo({ seven_day: SEVEN_DAY })).toBeNull();
    });

    it("returns null when five_hour is explicitly null", async () => {
      const info = await provider.getBlockInfo({
        five_hour: null,
        seven_day: SEVEN_DAY,
      });

      expect(info).toBeNull();
    });

    it("keeps the local block when rate limits were never reported (API key sessions)", async () => {
      expect(await provider.getBlockInfo(undefined)).not.toBeNull();
    });

    it("stays hidden before the first API response once the window was seen missing", async () => {
      await provider.getBlockInfo({ seven_day: SEVEN_DAY });

      expect(await provider.getBlockInfo(undefined)).toBeNull();
    });

    it("stays visible before the first API response once the window was seen present", async () => {
      await provider.getBlockInfo({ five_hour: FIVE_HOUR });

      expect(await provider.getBlockInfo(undefined)).not.toBeNull();
    });

    it("comes back as soon as the window is reported again", async () => {
      await provider.getBlockInfo({ seven_day: SEVEN_DAY });

      const info = await provider.getBlockInfo({
        five_hour: FIVE_HOUR,
        seven_day: SEVEN_DAY,
      });

      expect(info).not.toBeNull();
      expect(await provider.getBlockInfo(undefined)).not.toBeNull();
    });

    it("hides again when a reported window goes away", async () => {
      await provider.getBlockInfo({ five_hour: FIVE_HOUR });

      expect(await provider.getBlockInfo({ seven_day: SEVEN_DAY })).toBeNull();
      expect(await provider.getBlockInfo(undefined)).toBeNull();
    });

    it("writes the observation only when it changes", async () => {
      const write = jest.spyOn(CacheManager, "setUsageDocument");
      try {
        await provider.getBlockInfo({ seven_day: SEVEN_DAY });
        await provider.getBlockInfo({ seven_day: SEVEN_DAY });

        expect(write).toHaveBeenCalledTimes(1);
      } finally {
        write.mockRestore();
      }
    });

    it("follows the report alone when the cache cannot be read", async () => {
      const read = jest
        .spyOn(CacheManager, "getUsageDocument")
        .mockRejectedValue(new Error("cache unavailable"));
      try {
        expect(
          await provider.getBlockInfo({ seven_day: SEVEN_DAY }),
        ).toBeNull();
        expect(
          await provider.getBlockInfo({ five_hour: FIVE_HOUR }),
        ).not.toBeNull();
        expect(await provider.getBlockInfo(undefined)).not.toBeNull();
      } finally {
        read.mockRestore();
      }
    });

    it("ignores an unrecognized stored observation", async () => {
      await CacheManager.setUsageDocument(FIVE_HOUR_WINDOW_DOCUMENT, {
        present: "maybe",
      });

      expect(await provider.getBlockInfo(undefined)).not.toBeNull();
    });
  });

  describe.each(["powerline", "tui"] as const)("%s rendering", (style) => {
    it("omits the block segment when the window is missing", async () => {
      const output = await renderer(style).generateStatusline(
        hookData({ seven_day: SEVEN_DAY }),
      );

      expect(output).not.toContain(BLOCK_SYMBOL);
    });

    it("shows the block segment when the window is present", async () => {
      const output = await renderer(style).generateStatusline(
        hookData({ five_hour: FIVE_HOUR, seven_day: SEVEN_DAY }),
      );

      expect(output).toContain(BLOCK_SYMBOL);
    });
  });
});
