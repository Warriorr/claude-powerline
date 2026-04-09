#!/usr/bin/env node

import process from "node:process";
import { json } from "node:stream/consumers";
import { PowerlineRenderer } from "./powerline";
import { loadConfigFromCLI } from "./config/loader";
import { debug } from "./utils/logger";
import type { ClaudeHookData } from "./utils/claude";

function showHelpText(): void {
  console.log(`
claude-powerline - Beautiful powerline statusline for Claude Code

Usage: claude-powerline [options]

Standalone Commands:
  -h, --help               Show this help

Debugging:
  CLAUDE_POWERLINE_DEBUG=1 Enable debug logging for troubleshooting

Claude Code Options (for settings.json):
  --theme=THEME            Set theme: dark, light, nord, tokyo-night, rose-pine, custom
  --style=STYLE            Set separator style: minimal, powerline, capsule, tui
  --charset=CHARSET        Set character set: unicode (default), text
  --config=PATH            Use custom config file path

See example config at: https://github.com/Owloops/claude-powerline/blob/main/.claude-powerline.json

`);
}

async function main(): Promise<void> {
  try {
    const showHelp =
      process.argv.includes("--help") || process.argv.includes("-h");

    if (showHelp) {
      showHelpText();
      process.exit(0);
    }

    if (process.stdin.isTTY === true) {
      console.error(`Error: This tool requires input from Claude Code

claude-powerline is designed to be used as a Claude Code statusLine command.
It reads hook data from stdin and outputs formatted statusline.

Add to ~/.claude/settings.json:
{
  "statusLine": {
    "type": "command",
    "command": "claude-powerline --style=powerline"
  }
}

Run with --help for more options.

To test output manually:
echo '{"session_id":"test-session","workspace":{"project_dir":"/path/to/project"},"model":{"id":"claude-sonnet-4-5","display_name":"Claude"}}' | claude-powerline --style=powerline`);
      process.exit(1);
    }

    debug(`Working directory: ${process.cwd()}`);
    debug(`Process args:`, process.argv);
    debug(`Color env: TERM=${process.env.TERM} COLORTERM=${process.env.COLORTERM} FORCE_COLOR=${process.env.FORCE_COLOR} WT_SESSION=${process.env.WT_SESSION ? "set" : "unset"} WSL_DISTRO_NAME=${process.env.WSL_DISTRO_NAME} TERM_PROGRAM=${process.env.TERM_PROGRAM}`);

    const hookData = (await json(process.stdin)) as ClaudeHookData;
    debug(`Received hook data:`, JSON.stringify(hookData, null, 2));
    // Temporary: dump all top-level keys to debug file
    try {
      const fs = await import("node:fs");
      fs.writeFileSync("/tmp/claude-hook-dump.json", JSON.stringify(hookData, null, 2));
    } catch {}

    if (!hookData) {
      console.error("Error: No input data received from stdin");
      showHelpText();
      process.exit(1);
    }

    const projectDir = hookData.workspace?.project_dir;
    const config = loadConfigFromCLI(process.argv, projectDir);
    debug(`Config: theme=${config.theme} colorCompatibility=${config.display.colorCompatibility} style=${config.display.style}`);
    const renderer = new PowerlineRenderer(config);
    const statusline = await renderer.generateStatusline(hookData);

    console.log(statusline);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error generating statusline:", errorMessage);
    process.exit(1);
  }
}

main();
