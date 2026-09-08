import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

describe("jest environment isolation", () => {
  it("points the cache dir and Claude config dir at a private temp dir", () => {
    const cacheDir = process.env.CLAUDE_POWERLINE_CACHE_DIR ?? "";
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? "";

    expect(cacheDir.startsWith(tmpdir())).toBe(true);
    expect(configDir.startsWith(tmpdir())).toBe(true);
    expect(cacheDir).not.toContain(join(homedir(), ".claude"));
    expect(configDir).not.toContain(join(homedir(), ".claude"));
    expect(existsSync(configDir)).toBe(true);
    expect(readdirSync(join(configDir, "projects"))).toEqual([]);
  });
});
