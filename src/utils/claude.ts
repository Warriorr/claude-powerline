import { open, readdir, readFile, stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { join, posix } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { debug } from "./logger";

export interface ClaudeHookData {
  hook_event_name: string;
  session_id: string;
  transcript_path: string;
  cwd: string;
  model: {
    id: string;
    display_name: string;
  };
  workspace: {
    current_dir: string;
    project_dir: string;
  };
  version?: string;
  output_style?: {
    name: string;
  };
  cost?: {
    total_cost_usd: number;
    total_duration_ms: number;
    total_api_duration_ms: number;
    total_lines_added: number;
    total_lines_removed: number;
  };
  context_window?: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_size: number;
    used_percentage?: number | null;
    remaining_percentage?: number | null;
    current_usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
  exceeds_200k_tokens?: boolean;
  rate_limits?: {
    five_hour?: {
      used_percentage: number;
      resets_at: number;
    } | null;
    seven_day?: {
      used_percentage: number;
      resets_at: number;
    };
  };
  effort?: {
    level?: string;
  };
  thinking?: {
    enabled?: boolean;
  };
}

export function getClaudePaths(): string[] {
  const paths: string[] = [];

  const envPath = process.env.CLAUDE_CONFIG_DIR;
  if (envPath) {
    envPath.split(",").forEach((path) => {
      const trimmedPath = path.trim();
      if (existsSync(trimmedPath)) {
        paths.push(trimmedPath);
      }
    });
  }

  if (paths.length === 0) {
    const homeDir = homedir();
    const configPath = join(homeDir, ".config", "claude");
    const claudePath = join(homeDir, ".claude");

    if (existsSync(configPath)) {
      paths.push(configPath);
    }
    if (existsSync(claudePath)) {
      paths.push(claudePath);
    }
  }

  return paths;
}

export async function findProjectPaths(
  claudePaths: string[],
): Promise<string[]> {
  const projectPaths: string[] = [];

  for (const claudePath of claudePaths) {
    const projectsDir = join(claudePath, "projects");

    if (existsSync(projectsDir)) {
      try {
        const entries = await readdir(projectsDir, {
          withFileTypes: true,
        });

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const projectPath = posix.join(projectsDir, entry.name);
            projectPaths.push(projectPath);
          }
        }
      } catch (error) {
        debug(`Failed to read projects directory ${projectsDir}:`, error);
      }
    }
  }

  return projectPaths;
}

export async function findTranscriptFile(
  sessionId: string,
): Promise<string | null> {
  const claudePaths = getClaudePaths();
  const projectPaths = await findProjectPaths(claudePaths);

  for (const projectPath of projectPaths) {
    const transcriptPath = posix.join(projectPath, `${sessionId}.jsonl`);
    if (existsSync(transcriptPath)) {
      return transcriptPath;
    }
  }

  return null;
}

const FIRST_LINE_MAX_BYTES = 64 * 1024;

/**
 * The sessionId of a transcript's first line. A first line longer than the
 * 64 KB read (a Task prompt with pasted content) arrives cut off and is not
 * valid JSON; Claude Code writes sessionId near the start of every line, so
 * the cut-off prefix still carries it.
 */
function firstLineSessionId(firstLine: string): string | undefined {
  try {
    const parsed = JSON.parse(firstLine);
    return typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
  } catch {
    return /"sessionId"\s*:\s*"([^"]+)"/.exec(firstLine)?.[1];
  }
}

/** Reads only the first line of a file (bounded to the first 64 KB). */
async function readFirstLine(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(FIRST_LINE_MAX_BYTES);
    const { bytesRead } = await handle.read(buf, 0, FIRST_LINE_MAX_BYTES, 0);
    const newline = buf.indexOf(0x0a);
    const end = newline === -1 || newline >= bytesRead ? bytesRead : newline;
    return buf.toString("utf8", 0, end);
  } finally {
    await handle.close();
  }
}

export async function findAgentTranscripts(
  sessionId: string,
  projectPath: string,
): Promise<string[]> {
  const agentFiles: string[] = [];

  const subagentsDir = posix.join(projectPath, sessionId, "subagents");

  try {
    const files = await readdir(subagentsDir);
    const agentFileNames = files.filter(
      (f) => f.startsWith("agent-") && f.endsWith(".jsonl"),
    );

    for (const fileName of agentFileNames) {
      const filePath = posix.join(subagentsDir, fileName);
      try {
        const firstLine = await readFirstLine(filePath);
        if (firstLine && firstLineSessionId(firstLine) === sessionId) {
          agentFiles.push(filePath);
        }
      } catch {
        debug(`Failed to check agent file ${filePath}`);
      }
    }
  } catch (error) {
    debug(`Failed to read subagents directory ${subagentsDir}:`, error);
  }

  return agentFiles;
}

export async function getEarliestTimestamp(
  filePath: string,
): Promise<Date | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    let earliestDate: Date | null = null;
    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const json = JSON.parse(line);
        if (json.timestamp && typeof json.timestamp === "string") {
          const date = new Date(json.timestamp);
          if (!isNaN(date.getTime())) {
            if (earliestDate === null || date < earliestDate) {
              earliestDate = date;
            }
          }
        }
      } catch {
        continue;
      }
    }
    return earliestDate;
  } catch (error) {
    debug(`Failed to get earliest timestamp for ${filePath}:`, error);
    return null;
  }
}

export async function sortFilesByTimestamp(
  files: string[],
  oldestFirst = true,
): Promise<string[]> {
  const filesWithTimestamps = await Promise.all(
    files.map(async (file) => ({
      file,
      timestamp: await getEarliestTimestamp(file),
    })),
  );

  return filesWithTimestamps
    .sort((a, b) => {
      if (a.timestamp === null && b.timestamp === null) return 0;
      if (a.timestamp === null) return 1;
      if (b.timestamp === null) return -1;
      const sortOrder = oldestFirst ? 1 : -1;
      return sortOrder * (a.timestamp.getTime() - b.timestamp.getTime());
    })
    .map((item) => item.file);
}

export async function getFileModificationDate(
  filePath: string,
): Promise<Date | null> {
  try {
    const stats = await stat(filePath);
    return stats.mtime;
  } catch {
    return null;
  }
}

export interface ParsedEntry {
  timestamp: Date;
  message?: {
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    model?: string;
  };
  costUSD?: number;
  isSidechain?: boolean;
  raw: Record<string, unknown>;
}

export function createUniqueHash(entry: ParsedEntry): string | null {
  const messageId =
    entry.message?.id ||
    (typeof entry.raw.message === "object" &&
    entry.raw.message !== null &&
    "id" in entry.raw.message
      ? (entry.raw.message.id as string)
      : undefined);
  const requestId =
    "requestId" in entry.raw ? (entry.raw.requestId as string) : undefined;

  if (!messageId || !requestId) {
    return null;
  }

  return `${messageId}:${requestId}`;
}

const STREAMING_THRESHOLD_BYTES = 1024 * 1024;

export async function parseJsonlFile(filePath: string): Promise<ParsedEntry[]> {
  try {
    const stats = await stat(filePath);
    const fileSizeBytes = stats.size;
    let entries: ParsedEntry[];

    if (fileSizeBytes > STREAMING_THRESHOLD_BYTES) {
      debug(
        `Using streaming parser for large file ${filePath} (${Math.round(fileSizeBytes / 1024)}KB)`,
      );
      entries = await parseJsonlFileStreaming(filePath);
    } else {
      entries = await parseJsonlFileInMemory(filePath);
    }

    debug(`Parsed ${entries.length} entries from ${filePath}`);

    return entries;
  } catch (error) {
    debug(`Failed to read file ${filePath}:`, error);
    return [];
  }
}

/**
 * Parses one JSONL line into a ParsedEntry. Returns null for blank lines,
 * lines that are not valid JSON and records without a timestamp.
 */
function parseJsonlLine(line: string): ParsedEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const raw = JSON.parse(trimmed);
    if (!raw.timestamp) return null;

    return {
      timestamp: new Date(raw.timestamp),
      message: raw.message,
      costUSD: typeof raw.costUSD === "number" ? raw.costUSD : undefined,
      isSidechain: raw.isSidechain === true,
      raw,
    };
  } catch (parseError) {
    debug(`Failed to parse JSONL line: ${parseError}`);
    return null;
  }
}

async function parseJsonlFileInMemory(
  filePath: string,
): Promise<ParsedEntry[]> {
  const content = await readFile(filePath, "utf-8");
  const entries: ParsedEntry[] = [];

  for (const line of content.split("\n")) {
    const entry = parseJsonlLine(line);
    if (entry) entries.push(entry);
  }

  return entries;
}

async function parseJsonlFileStreaming(
  filePath: string,
): Promise<ParsedEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: ParsedEntry[] = [];
    const fileStream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      const entry = parseJsonlLine(line);
      if (entry) entries.push(entry);
    });

    rl.on("close", () => {
      resolve(entries);
    });

    rl.on("error", (error) => {
      debug(`Streaming parser error for ${filePath}:`, error);
      reject(error);
    });

    fileStream.on("error", (error) => {
      debug(`File stream error for ${filePath}:`, error);
      reject(error);
    });
  });
}

export interface IncrementalParseResult {
  entries: ParsedEntry[];
  endOffset: number;
}

/**
 * Incremental reader for append-only JSONL files.
 *
 * Reads from byte `startOffset` to EOF and parses only complete lines (those
 * terminated by "\n"). `endOffset` is the byte offset just after the last
 * consumed newline, so pass it back as the next `startOffset`: a partial
 * trailing line (Claude Code may be mid-write) is left unconsumed and is
 * re-read once it is complete. Offsets are bytes, never characters, so
 * multi-byte UTF-8 does not shift them. The read buffer stays bounded by the
 * stream chunk size plus one line, but every parsed entry of the range is
 * returned at once, so a first read of a large file from offset 0 holds all
 * of its entries in memory. When nothing complete is found,
 * `endOffset === startOffset`. Rejects on I/O errors (for example a missing
 * file); callers decide how to degrade.
 */
export async function parseJsonlFileFrom(
  filePath: string,
  startOffset = 0,
): Promise<IncrementalParseResult> {
  const entries: ParsedEntry[] = [];
  let consumed = 0;
  let pending: Buffer = Buffer.alloc(0);

  for await (const chunk of createReadStream(filePath, {
    start: startOffset,
  })) {
    const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let lineStart = 0;
    let newline = buf.indexOf(0x0a, lineStart);
    while (newline !== -1) {
      const entry = parseJsonlLine(buf.toString("utf8", lineStart, newline));
      if (entry) entries.push(entry);
      lineStart = newline + 1;
      newline = buf.indexOf(0x0a, lineStart);
    }
    consumed += lineStart;
    pending = buf.subarray(lineStart);
  }

  return { entries, endOffset: startOffset + consumed };
}

type FileStat = { filePath: string; mtime: Date; size: number };

/**
 * One stat per file: callers that need the size for change detection get it
 * here rather than stat-ing the same file a second time.
 */
async function statFile(filePath: string): Promise<FileStat | null> {
  try {
    const stats = await stat(filePath);
    return { filePath, mtime: stats.mtime, size: stats.size };
  } catch {
    return null;
  }
}

export async function collectProjectFiles(
  projectPath: string,
  fileFilter?: (filePath: string, modTime: Date) => boolean,
): Promise<FileStat[]> {
  try {
    const entries = await readdir(projectPath, { withFileTypes: true });

    const sessionFiles = entries
      .filter((e) => !e.isDirectory() && e.name.endsWith(".jsonl"))
      .map((e) => statFile(posix.join(projectPath, e.name)));

    const subagentFiles = entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const subagentsDir = posix.join(projectPath, e.name, "subagents");
        try {
          const files = await readdir(subagentsDir);
          return files
            .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"))
            .map((f) => statFile(posix.join(subagentsDir, f)));
        } catch {
          return [];
        }
      });

    const [sessionResults, subagentResults] = await Promise.all([
      Promise.all(sessionFiles),
      Promise.all(subagentFiles).then((nested) => Promise.all(nested.flat())),
    ]);

    return [...sessionResults, ...subagentResults].filter(
      (s): s is FileStat =>
        s !== null && (!fileFilter || fileFilter(s.filePath, s.mtime)),
    );
  } catch (dirError) {
    debug(`Failed to read project directory ${projectPath}:`, dirError);
    return [];
  }
}

/**
 * Loads entries from Claude projects with deterministic deduplication.
 * @param timeFilter Optional filter to apply based on timestamp
 * @param fileFilter Optional filter to apply based on file path and modification time
 * @param sortFiles Whether to sort files by modification time
 * @returns Deduplicated entries sorted by timestamp
 * @note Sorts entries by timestamp before deduplication to ensure consistent
 *       duplicate selection. Otherwise, parallel file loading causes race conditions
 *       where different duplicates are kept on each run, leading to flickering values.
 */
export async function loadEntriesFromProjects(
  timeFilter?: (entry: ParsedEntry) => boolean,
  fileFilter?: (filePath: string, modTime: Date) => boolean,
  sortFiles = false,
): Promise<ParsedEntry[]> {
  const claudePaths = getClaudePaths();
  const projectPaths = await findProjectPaths(claudePaths);
  const processedHashes = new Set<string>();

  const allFilesPromises = projectPaths.map((projectPath) =>
    collectProjectFiles(projectPath, fileFilter),
  );

  const allFileResults = await Promise.all(allFilesPromises);
  const allFilesWithMtime = allFileResults.flat();

  if (sortFiles) {
    allFilesWithMtime.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }

  const allFiles = allFilesWithMtime.map((file) => file.filePath);

  const entries: ParsedEntry[] = [];

  const filePromises = allFiles.map(async (filePath) => {
    const fileEntries = await parseJsonlFile(filePath);
    return fileEntries.filter((entry) => !timeFilter || timeFilter(entry));
  });

  const fileResults = await Promise.all(filePromises);
  for (const fileEntries of fileResults) {
    entries.push(...fileEntries);
  }

  entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const deduplicatedEntries: ParsedEntry[] = [];
  for (const entry of entries) {
    const uniqueHash = createUniqueHash(entry);
    if (uniqueHash && processedHashes.has(uniqueHash)) {
      continue;
    }
    if (uniqueHash) {
      processedHashes.add(uniqueHash);
    }
    deduplicatedEntries.push(entry);
  }

  return deduplicatedEntries;
}

/**
 * Read the speed/effort mode from the last assistant entry in the transcript.
 * Returns "standard" or "fast" (or null if unavailable).
 */
export async function getSpeedFromTranscript(
  transcriptPath: string,
): Promise<string | null> {
  try {
    if (!existsSync(transcriptPath)) return null;

    const stats = await stat(transcriptPath);
    const { open } = await import("node:fs/promises");
    const fd = await open(transcriptPath, "r");
    try {
      // Read the last 8KB of the file to find the last assistant entry
      const readSize = Math.min(stats.size, 8192);
      const buffer = Buffer.alloc(readSize);
      await fd.read(buffer, 0, readSize, stats.size - readSize);
      const tail = buffer.toString("utf-8");

      const lines = tail.split("\n").filter((l) => l.trim());

      // Walk backwards to find the last assistant entry with speed
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]!);
          if (obj.type === "assistant" && obj.message?.usage?.speed) {
            return obj.message.usage.speed;
          }
        } catch {
          continue;
        }
      }
    } finally {
      await fd.close();
    }

    return null;
  } catch (error) {
    debug("Failed to read speed from transcript:", error);
    return null;
  }
}
