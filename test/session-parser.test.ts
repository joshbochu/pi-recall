import { describe, expect, it } from "vitest";
import { parseSessionContent } from "../src/session-parser.js";

function jsonl(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

describe("parseSessionContent", () => {
  it("extracts Pi metadata and user/assistant text", () => {
    const content = jsonl([
      {
        type: "session",
        version: 3,
        id: "session-123",
        timestamp: "2026-01-02T03:04:05.000Z",
        cwd: "/work/app",
        parentSession: "/work/parent.jsonl",
      },
      {
        type: "message",
        id: "user0001",
        parentId: null,
        timestamp: "2026-01-02T03:04:06.000Z",
        message: { role: "user", content: "Deploy the staging app", timestamp: 1_767_322_646_000 },
      },
      {
        type: "message",
        id: "asst0001",
        parentId: "user0001",
        timestamp: "2026-01-02T03:04:07.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "I deployed it." },
            { type: "toolCall", id: "call", name: "bash", arguments: {} },
          ],
          timestamp: 1_767_322_647_000,
          provider: "test",
          model: "test",
          api: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
        },
      },
      {
        type: "message",
        id: "tool0001",
        parentId: "asst0001",
        timestamp: "2026-01-02T03:04:08.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call",
          toolName: "bash",
          content: [{ type: "text", text: "noisy tool output" }],
          isError: false,
          timestamp: 1_767_322_648_000,
        },
      },
      {
        type: "session_info",
        id: "info0001",
        parentId: "tool0001",
        timestamp: "2026-01-02T03:04:09.000Z",
        name: "Staging deploy",
      },
    ]);

    const parsed = parseSessionContent("/sessions/session.jsonl", content, 1_800_000_000_000);

    expect(parsed.summary).toMatchObject({
      id: "session-123",
      cwd: "/work/app",
      name: "Staging deploy",
      messageCount: 2,
      firstMessage: "Deploy the staging app",
      parentSessionPath: "/work/parent.jsonl",
    });
    expect(parsed.documents.map((document) => [document.role, document.content])).toEqual([
      ["user", "Deploy the staging app"],
      ["assistant", "I deployed it."],
    ]);
    expect(parsed.documents[0]!.sessionName).toBe("Staging deploy");
    expect(parsed.documents[1]!.timestamp).toBe(1_767_322_647_000);
  });

  it("skips malformed lines and falls back to path metadata", () => {
    const content = [
      "not json",
      JSON.stringify({
        type: "message",
        id: "user0001",
        parentId: null,
        timestamp: "2026-01-02T03:04:06.000Z",
        message: { role: "user", content: [{ type: "text", text: "Remember this" }] },
      }),
    ].join("\n");

    const parsed = parseSessionContent("/sessions/fallback.jsonl", content, 1234);
    expect(parsed.summary.id).toBe("fallback");
    expect(parsed.summary.modified).toBe(Date.parse("2026-01-02T03:04:06.000Z"));
    expect(parsed.documents).toHaveLength(1);
  });

  it("joins consecutive messages from the same role like upstream Recall", () => {
    const content = jsonl([
      {
        type: "session",
        version: 3,
        id: "joined",
        timestamp: "2026-01-02T03:00:00.000Z",
        cwd: "/work/app",
      },
      {
        type: "message",
        id: "user0001",
        parentId: null,
        timestamp: "2026-01-02T03:01:00.000Z",
        message: { role: "user", content: "Part one", timestamp: 1_767_322_460_000 },
      },
      {
        type: "message",
        id: "user0002",
        parentId: "user0001",
        timestamp: "2026-01-02T03:02:00.000Z",
        message: { role: "user", content: "Part two", timestamp: 1_767_322_520_000 },
      },
    ]);

    const parsed = parseSessionContent("/sessions/joined.jsonl", content, 1234);
    expect(parsed.documents).toHaveLength(1);
    expect(parsed.documents[0]).toMatchObject({
      content: "Part one\n\nPart two",
      entryId: "user0002",
      messageIndex: 0,
      timestamp: 1_767_322_520_000,
    });
    expect(parsed.summary.modified).toBe(1_767_322_520_000);
  });
});
