import { debug } from "../utils/logger";
import {
  findTranscriptFile,
  type ClaudeHookData,
  type ParsedEntry,
} from "../utils/claude";
import { METRICS_DOCUMENT_PREFIX } from "../utils/cache";
import { readIncrementalState } from "../utils/transcriptState";

export interface MetricsInfo {
  responseTime: number | null;
  lastResponseTime: number | null;
  sessionDuration: number | null;
  messageCount: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
}

/** Fields calculateLastResponseTime reads from one transcript entry. */
interface WindowEntry {
  /** Milliseconds since epoch, or null when the timestamp did not parse. */
  t: number | null;
  user: boolean;
  assistant: boolean;
}

interface MetricsState {
  messageCount: number;
  /** The last RESPONSE_WINDOW non-sidechain entries, oldest first. */
  window: WindowEntry[];
}

const METRICS_STATE_VERSION = 1;
const RESPONSE_WINDOW = 20;

function isMetricsState(value: unknown): value is MetricsState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.messageCount === "number" &&
    Array.isArray(v.window) &&
    v.window.every(
      (w) =>
        typeof w === "object" &&
        w !== null &&
        (w.t === null || typeof w.t === "number") &&
        typeof w.user === "boolean" &&
        typeof w.assistant === "boolean",
    )
  );
}

function foldMetrics(
  state: MetricsState,
  entries: ParsedEntry[],
): MetricsState {
  for (const { raw: rawEntry, isSidechain } of entries) {
    const raw = rawEntry as any;
    if (isSidechain) continue;
    const messageType = raw.type || raw.message?.role || raw.message?.type;
    const isToolResult =
      raw.type === "user" && raw.message?.content?.[0]?.type === "tool_result";
    const user = messageType === "user" && !isToolResult;
    if (user) state.messageCount++;
    const t = new Date(raw.timestamp).getTime();
    state.window.push({
      t: Number.isNaN(t) ? null : t,
      user,
      assistant: messageType === "assistant",
    });
  }
  state.window = state.window.slice(-RESPONSE_WINDOW);
  return state;
}

function stateDocumentName(sessionId: string): string {
  return `${METRICS_DOCUMENT_PREFIX}${sessionId.replace(/[^\w-]/g, "_")}`;
}

export class MetricsProvider {
  private async loadState(sessionId: string): Promise<MetricsState> {
    const empty = (): MetricsState => ({ messageCount: 0, window: [] });
    try {
      const transcriptPath = await findTranscriptFile(sessionId);
      if (!transcriptPath) {
        debug(`No transcript found for session: ${sessionId}`);
        return empty();
      }

      debug(`Loading transcript from: ${transcriptPath}`);
      const state = await readIncrementalState<MetricsState>({
        filePath: transcriptPath,
        documentName: stateDocumentName(sessionId),
        version: METRICS_STATE_VERSION,
        initial: empty,
        isValid: isMetricsState,
        fold: foldMetrics,
      });
      return state ?? empty();
    } catch (error) {
      debug(`Error loading transcript for ${sessionId}:`, error);
      return empty();
    }
  }

  private calculateLastResponseTime(window: WindowEntry[]): number | null {
    if (window.length === 0) return null;

    let lastUserTime: number | null = null;
    let bestResponseTime: number | null = null;

    for (const entry of window) {
      const time = entry.t ?? NaN;
      if (entry.user) {
        lastUserTime = time;
      } else if (entry.assistant && lastUserTime !== null) {
        const responseTime = (time - lastUserTime) / 1000;
        if (responseTime > 0.1 && responseTime < 300) {
          bestResponseTime = responseTime;
        }
      }
    }

    return bestResponseTime;
  }

  async getMetricsInfo(
    sessionId: string,
    hookData: ClaudeHookData,
  ): Promise<MetricsInfo> {
    try {
      debug(`Getting metrics from hook data for session: ${sessionId}`);

      if (!hookData.cost) {
        debug(`No cost data available in hook data`);
        return {
          responseTime: null,
          lastResponseTime: null,
          sessionDuration: null,
          messageCount: null,
          linesAdded: null,
          linesRemoved: null,
        };
      }

      const { messageCount, window } = await this.loadState(sessionId);
      const lastResponseTime = this.calculateLastResponseTime(window);

      return {
        responseTime: hookData.cost.total_api_duration_ms / 1000,
        lastResponseTime,
        sessionDuration: hookData.cost.total_duration_ms / 1000,
        messageCount,
        linesAdded: hookData.cost.total_lines_added,
        linesRemoved: hookData.cost.total_lines_removed,
      };
    } catch (error) {
      debug(
        `Error getting metrics from hook data for session ${sessionId}:`,
        error,
      );
      return {
        responseTime: null,
        lastResponseTime: null,
        sessionDuration: null,
        messageCount: null,
        linesAdded: null,
        linesRemoved: null,
      };
    }
  }
}
