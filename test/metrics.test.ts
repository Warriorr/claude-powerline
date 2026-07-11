import { MetricsProvider } from "../src/segments/metrics";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as claudePaths from "../src/utils/claude";
import type { ClaudeHookData } from "../src/utils/claude";

describe("Metrics Provider", () => {
  let tempDir: string;
  let metricsProvider: MetricsProvider;

  const createMockHookData = (sessionId: string): ClaudeHookData => ({
    hook_event_name: "Status",
    session_id: sessionId,
    transcript_path: `/path/to/${sessionId}.jsonl`,
    cwd: "/test/cwd",
    model: {
      id: "claude-opus-4-1",
      display_name: "Opus",
    },
    workspace: {
      current_dir: "/test/workspace",
      project_dir: "/test/project",
    },
    version: "1.0.0",
    cost: {
      total_cost_usd: 0.5,
      total_duration_ms: 120000,
      total_api_duration_ms: 5000,
      total_lines_added: 25,
      total_lines_removed: 10,
    },
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "metrics-test-"));
    metricsProvider = new MetricsProvider();
  });

  afterEach(() => {
    try {
      unlinkSync(join(tempDir, "test.jsonl"));
    } catch {}
  });

  it("calculates metrics from valid transcript", async () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const transcriptContent = [
      `{"timestamp": "${new Date(oneHourAgo.getTime()).toISOString()}", "type": "user", "message": {"content": "Hello"}}`,
      `{"timestamp": "${new Date(oneHourAgo.getTime() + 5000).toISOString()}", "type": "assistant", "message": {"content": "Hi!", "usage": {"input_tokens": 10, "output_tokens": 20}}, "costUSD": 0.50}`,
      `{"timestamp": "${new Date(oneHourAgo.getTime() + 60000).toISOString()}", "type": "user", "message": {"content": "How are you?"}}`,
      `{"timestamp": "${new Date(oneHourAgo.getTime() + 63000).toISOString()}", "type": "assistant", "message": {"content": "Good!", "usage": {"input_tokens": 15, "output_tokens": 25}}, "costUSD": 0.75}`,
    ].join("\n");

    const transcriptPath = join(tempDir, "test.jsonl");
    writeFileSync(transcriptPath, transcriptContent);

    jest
      .spyOn(claudePaths, "findTranscriptFile")
      .mockResolvedValue(transcriptPath);

    const mockHookData = createMockHookData("test-session");
    const metrics = await metricsProvider.getMetricsInfo(
      "test-session",
      mockHookData,
    );

    expect(metrics.messageCount).toBe(2);
    expect(metrics.sessionDuration).toBe(120);
    expect(metrics.responseTime).toBe(5);
    expect(metrics.lastResponseTime).toBeGreaterThan(0);
    expect(metrics.linesAdded).toBe(25);
    expect(metrics.linesRemoved).toBe(10);
  });

  it("handles missing transcript gracefully", async () => {
    jest.spyOn(claudePaths, "findTranscriptFile").mockResolvedValue(null);

    const mockHookData = createMockHookData("nonexistent-session");
    const metrics = await metricsProvider.getMetricsInfo(
      "nonexistent-session",
      mockHookData,
    );

    expect(metrics.messageCount).toBe(0);
    expect(metrics.sessionDuration).toBe(120);
    expect(metrics.responseTime).toBe(5);
    expect(metrics.lastResponseTime).toBeNull();
    expect(metrics.linesAdded).toBe(25);
    expect(metrics.linesRemoved).toBe(10);
  });

  it("handles empty transcript gracefully", async () => {
    const transcriptPath = join(tempDir, "test.jsonl");
    writeFileSync(transcriptPath, "");

    jest
      .spyOn(claudePaths, "findTranscriptFile")
      .mockResolvedValue(transcriptPath);

    const mockHookData = createMockHookData("empty-session");
    const metrics = await metricsProvider.getMetricsInfo(
      "empty-session",
      mockHookData,
    );

    expect(metrics.messageCount).toBe(0);
    expect(metrics.sessionDuration).toBe(120);
    expect(metrics.responseTime).toBe(5);
    expect(metrics.lastResponseTime).toBeNull();
    expect(metrics.linesAdded).toBe(25);
    expect(metrics.linesRemoved).toBe(10);
  });
});
