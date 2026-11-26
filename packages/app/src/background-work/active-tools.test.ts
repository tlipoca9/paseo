import { describe, expect, test } from "vitest";
import type { AgentToolCallData, StreamItem } from "@/types/stream";
import {
  areActiveToolWorkItemsEqual,
  extractActiveToolCalls,
  filterDuplicateActiveTools,
} from "./active-tools";

function makeToolCallItem(overrides: {
  id: string;
  callId: string;
  name: string;
  status: "running" | "completed" | "failed" | "canceled";
  detail: AgentToolCallData["detail"];
  timestamp?: Date;
}): StreamItem {
  return {
    kind: "tool_call",
    id: overrides.id,
    timestamp: overrides.timestamp ?? new Date("2026-11-26T00:00:00.000Z"),
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: overrides.callId,
        name: overrides.name,
        status: overrides.status,
        error: null,
        detail: overrides.detail,
      },
    },
  };
}

describe("extractActiveToolCalls", () => {
  test("extracts running tool calls from tail and head while ignoring completed calls and status banners", () => {
    const tail: StreamItem[] = [
      makeToolCallItem({
        id: "t-1",
        callId: "call-bg",
        name: "shell",
        status: "running",
        detail: { type: "shell", command: "python backfill.py --batch 500" },
        timestamp: new Date("2026-11-26T00:00:00.000Z"),
      }),
      makeToolCallItem({
        id: "t-2",
        callId: "call-done",
        name: "read",
        status: "completed",
        detail: { type: "read", filePath: "/repo/a.ts" },
      }),
      makeToolCallItem({
        id: "t-3",
        callId: "retry-1",
        name: "codex_retry",
        status: "running",
        detail: { type: "plain_text", label: "Reconnecting..." },
      }),
    ];
    const head: StreamItem[] = [
      {
        kind: "assistant_message",
        id: "a-1",
        text: "Backfill is running in the background.",
        timestamp: new Date("2026-11-26T00:00:10.000Z"),
      },
      makeToolCallItem({
        id: "t-4",
        callId: "call-mcp",
        name: "mcp__github__list_pulls",
        status: "running",
        detail: { type: "unknown", input: null, output: null },
        timestamp: new Date("2026-11-26T00:00:15.000Z"),
      }),
    ];

    const active = extractActiveToolCalls(tail, head);
    expect(active).toEqual([
      {
        id: "call-bg",
        messageId: "t-1",
        kind: "shell",
        title: "python backfill.py --batch 500",
        command: null,
        startedAt: new Date("2026-11-26T00:00:00.000Z"),
      },
      {
        id: "call-mcp",
        messageId: "t-4",
        kind: "tool",
        title: "github / list_pulls",
        command: null,
        startedAt: new Date("2026-11-26T00:00:15.000Z"),
      },
    ]);
  });

  test("extracts genuinely running steps from compacted mobile_steps cards and ignores settled lines", () => {
    const tail: StreamItem[] = [
      makeToolCallItem({
        id: "m-1",
        callId: "mobile-group:2",
        name: "mobile_steps",
        status: "running",
        detail: {
          type: "plain_text",
          label: "2 steps · 1 command · 1 file read · 1 running",
          text: "• Read config.ts\n• $ python backfill.py (running)",
        },
        timestamp: new Date("2026-11-26T00:01:00.000Z"),
      }),
      makeToolCallItem({
        id: "m-2",
        callId: "mobile-group:5",
        name: "mobile_steps",
        status: "running",
        detail: {
          type: "plain_text",
          label: "1 step · 1 command",
          text: "• $ npm test (exit 0)",
        },
      }),
    ];

    const active = extractActiveToolCalls(tail, []);
    expect(active).toEqual([
      {
        id: "mobile-group:2:step:1",
        messageId: "m-1",
        kind: "shell",
        title: "python backfill.py",
        command: null,
        startedAt: new Date("2026-11-26T00:01:00.000Z"),
      },
    ]);
  });

  test("deduplicates running shell tools that are already represented by native backgroundWork", () => {
    const tools = extractActiveToolCalls(
      [
        makeToolCallItem({
          id: "t-1",
          callId: "bg-1",
          name: "shell",
          status: "running",
          detail: { type: "shell", command: "tail -f build.log" },
        }),
        makeToolCallItem({
          id: "t-2",
          callId: "sh-2",
          name: "shell",
          status: "running",
          detail: { type: "shell", command: "npm test" },
        }),
      ],
      [],
    );

    const filtered = filterDuplicateActiveTools(tools, [
      {
        id: "native-1",
        kind: "shell",
        description: "Watch build",
        command: "tail -f build.log",
        startedAt: "2026-11-26T00:00:00.000Z",
      },
    ]);

    expect(filtered.map((item) => item.id)).toEqual(["sh-2"]);
  });

  test("compares active tool lists structurally for selector stability", () => {
    const first = extractActiveToolCalls(
      [
        makeToolCallItem({
          id: "t-1",
          callId: "sh-1",
          name: "shell",
          status: "running",
          detail: { type: "shell", command: "npm test" },
        }),
      ],
      [],
    );
    const second = extractActiveToolCalls(
      [
        makeToolCallItem({
          id: "t-1",
          callId: "sh-1",
          name: "shell",
          status: "running",
          detail: { type: "shell", command: "npm test" },
        }),
      ],
      [],
    );
    expect(areActiveToolWorkItemsEqual(first, second)).toBe(true);
  });
});
