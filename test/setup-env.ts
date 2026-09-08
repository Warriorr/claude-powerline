import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test file gets a private cache dir and Claude config dir, so no test
// can read or rewrite the live ~/.claude/powerline cache or parse the real
// transcripts under ~/.claude/projects. Test files that need their own
// fixtures still override these per test (see usage-index.test.ts).
const root = mkdtempSync(join(tmpdir(), "claude-powerline-jest-"));
const cacheDir = join(root, "cache");
const configDir = join(root, "config");
// getClaudePaths ignores a CLAUDE_CONFIG_DIR that does not exist and falls
// back to ~/.claude, which would make every full render in the suite parse
// the real transcripts. The directories must exist to take effect.
mkdirSync(join(configDir, "projects"), { recursive: true });
mkdirSync(cacheDir, { recursive: true });
process.env.CLAUDE_POWERLINE_CACHE_DIR = cacheDir;
process.env.CLAUDE_CONFIG_DIR = configDir;

process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Best effort; the OS reclaims tmpdir eventually.
  }
});
