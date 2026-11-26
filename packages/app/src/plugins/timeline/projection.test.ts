import { describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { TimelineItemTransform } from "./model";
import {
  groupAdjacentPluginItems,
  mergeGroupedPluginTailAndHead,
  projectPluginTimelineItems,
} from "./projection";

function thought(text: string, status: "loading" | "ready" = "loading"): StreamItem {
  return {
    kind: "thought",
    id: "thought-1",
    text,
    status,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("plugin timeline projection", () => {
  it.each(["message", "finished", "errored", "permission-required", "closed"] as const)(
    "preserves immutable agent-message provenance for %s cards",
    (event) => {
      const agentMessage = {
        event,
        sender: { id: "remote::reviewer", title: "QA question-timing #7014/#7000/#6809" },
        text: "The original message, including **Markdown**.",
      };
      const source: StreamItem = {
        kind: "tool_call",
        id: "message-1",
        timestamp: new Date("2026-01-01T00:00:00.000Z"),
        payload: {
          source: "agent",
          data: {
            provider: "codex",
            callId: "delivery-1",
            name: "agent_message",
            status: "completed",
            error: null,
            detail: { type: "plain_text", text: agentMessage.text, icon: "bot" },
            agentMessage,
          },
        },
      };
      const inspect: TimelineItemTransform = ({ item }) => {
        expect(item.type).toBe("tool_call");
        if (item.type !== "tool_call") throw new Error("Expected a tool call");
        expect(item.agentMessage).toEqual(agentMessage);
        expect(item.agentMessage).not.toBe(agentMessage);
        expect(Object.isFrozen(item.agentMessage)).toBe(true);
        expect(Object.isFrozen(item.agentMessage?.sender)).toBe(true);
        return undefined;
      };
      expect(projectPluginTimelineItems([source], inspect)).toEqual([source]);
      expect(Object.isFrozen(agentMessage.sender)).toBe(false);
    },
  );

  it("does not expose mutable tool detail from stream state", () => {
    const detail = { type: "read" as const, filePath: "/repo/original.ts" };
    const source: StreamItem = {
      kind: "tool_call",
      id: "tool-1",
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: "call-1",
          name: "Read",
          status: "completed",
          error: null,
          detail,
        },
      },
    };
    const mutateDetail: TimelineItemTransform = ({ item }) => {
      if (item.type === "tool_call" && item.detail.type === "read") {
        item.detail.filePath = "/repo/mutated.ts";
      }
      return undefined;
    };

    expect(() => projectPluginTimelineItems([source], mutateDetail)).toThrow(TypeError);
    expect(detail.filePath).toBe("/repo/original.ts");
  });

  it("projects a streaming reasoning row from its first delta", () => {
    const transform: TimelineItemTransform = vi.fn(({ item, phase, sourceId }) => [
      {
        type: "plugin" as const,
        id: `${sourceId}/0`,
        pluginId: "inline-thinking",
        kind: "reasoning",
        version: 1,
        data: { text: item.type === "reasoning" ? item.text : "", phase },
      },
    ]);

    expect(projectPluginTimelineItems([thought("First")], transform)).toMatchObject([
      {
        kind: "plugin",
        id: "inline-thinking/thought-1/0",
        sourceId: "thought-1",
        sourceKind: "thought",
        data: { text: "First", phase: "streaming" },
      },
    ]);
  });

  it("memoizes projection on the source row reference", () => {
    const source = thought("Stable");
    const transform: TimelineItemTransform = vi.fn(() => undefined);
    projectPluginTimelineItems([source], transform);
    projectPluginTimelineItems([source], transform);

    expect(transform).toHaveBeenCalledOnce();
  });

  it("preserves whether a notification row came from an agent error or a notice", () => {
    const transform: TimelineItemTransform = vi.fn(() => undefined);
    const timestamp = new Date("2026-01-01T00:00:00.000Z");

    projectPluginTimelineItems(
      [
        {
          kind: "notification",
          sourceType: "error",
          id: "error-1",
          level: "error",
          message: "Agent failed",
          timestamp,
        },
        {
          kind: "notification",
          sourceType: "notification",
          id: "notice-1",
          level: "error",
          message: "Extension reported an error",
          timestamp,
        },
      ],
      transform,
    );

    expect(transform).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ item: { type: "error", message: "Agent failed" } }),
    );
    expect(transform).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        item: {
          type: "notification",
          level: "error",
          message: "Extension reported an error",
        },
      }),
    );
  });

  it("reprojects when streaming produces a new source row", () => {
    const transform: TimelineItemTransform = vi.fn(() => undefined);
    projectPluginTimelineItems([thought("First")], transform);
    projectPluginTimelineItems([thought("First second")], transform);

    expect(transform).toHaveBeenCalledTimes(2);
  });

  it("filters and explodes source rows", () => {
    const source = thought("Split", "ready");
    const exploded = projectPluginTimelineItems([source], ({ sourceId }) => [
      {
        type: "plugin",
        id: `${sourceId}/left`,
        pluginId: "split",
        kind: "part",
        version: 1,
        data: { side: "left" },
      },
      {
        type: "plugin",
        id: `${sourceId}/right`,
        pluginId: "split",
        kind: "part",
        version: 1,
        data: { side: "right" },
      },
    ]);
    const filtered = projectPluginTimelineItems([source], () => []);

    expect(exploded.map((item) => item.id)).toEqual([
      "split/thought-1/left",
      "split/thought-1/right",
    ]);
    expect(filtered).toEqual([]);
  });

  it("groups consecutive plugin items declaring matching __paseoGroup descriptors", () => {
    const t1 = new Date("2026-01-01T00:00:01.000Z");
    const t2 = new Date("2026-01-01T00:00:02.000Z");
    const t3 = new Date("2026-01-01T00:00:03.000Z");
    const makeTool = (id: string, name: string, timestamp: Date): StreamItem => ({
      kind: "plugin",
      id: `beautiful-chat/${id}/0`,
      sourceId: id,
      sourceKind: "tool_call",
      timestamp,
      pluginId: "beautiful-chat",
      pluginItemId: `${id}/0`,
      itemKind: "omp-tool-call",
      version: 1,
      data: {
        name,
        status: "completed",
        __paseoGroup: { kind: "omp-activity-group", version: 1, key: "activity" },
      },
    });
    const userMsg: StreamItem = {
      kind: "user_message",
      id: "u1",
      text: "hello",
      timestamp: t2,
    };

    const grouped = groupAdjacentPluginItems([
      makeTool("tool-1", "read_file", t1),
      makeTool("tool-2", "run_command", t2),
      userMsg,
      makeTool("tool-3", "edit_file", t3),
    ]);

    expect(grouped.items).toHaveLength(3);
    expect(grouped.items[0]).toMatchObject({
      kind: "plugin",
      id: "beautiful-chat/group:tool-1",
      sourceId: "tool-1",
      itemKind: "omp-activity-group",
      data: {
        groupKey: "activity",
        isTail: false,
        entries: [
          {
            sourceId: "tool-1",
            kind: "omp-tool-call",
            data: { name: "read_file", status: "completed" },
          },
          {
            sourceId: "tool-2",
            kind: "omp-tool-call",
            data: { name: "run_command", status: "completed" },
          },
        ],
      },
    });
    expect(grouped.items[1]).toBe(userMsg);
    expect(grouped.items[2]).toMatchObject({
      id: "beautiful-chat/group:tool-3",
      data: { isTail: true },
    });
    expect(grouped.hostIdByMemberId.get("tool-2")).toBe("beautiful-chat/group:tool-1");
  });

  it("merges streaming head items into a matching trailing grouped tail item", () => {
    const t1 = new Date("2026-01-01T00:00:01.000Z");
    const t2 = new Date("2026-01-01T00:00:02.000Z");
    const tail = groupAdjacentPluginItems([
      {
        kind: "plugin",
        id: "beautiful-chat/tool-1/0",
        sourceId: "tool-1",
        sourceKind: "tool_call",
        timestamp: t1,
        pluginId: "beautiful-chat",
        pluginItemId: "tool-1/0",
        itemKind: "omp-tool-call",
        version: 1,
        data: {
          name: "read_file",
          status: "completed",
          __paseoGroup: { kind: "omp-activity-group", version: 1, key: "activity" },
        },
      },
    ]).items;
    const head: StreamItem[] = [
      {
        kind: "plugin",
        id: "beautiful-chat/tool-2/0",
        sourceId: "tool-2",
        sourceKind: "tool_call",
        timestamp: t2,
        pluginId: "beautiful-chat",
        pluginItemId: "tool-2/0",
        itemKind: "omp-tool-call",
        version: 1,
        data: {
          name: "run_command",
          status: "running",
          __paseoGroup: { kind: "omp-activity-group", version: 1, key: "activity" },
        },
      },
    ];

    const merged = mergeGroupedPluginTailAndHead({ tail, head });
    expect(merged.head).toHaveLength(0);
    expect(merged.tail).toHaveLength(1);
    expect(merged.tail[0]).toMatchObject({
      id: "beautiful-chat/group:tool-1",
      data: {
        isTail: true,
        entries: [
          { sourceId: "tool-1", data: { name: "read_file" } },
          { sourceId: "tool-2", data: { name: "run_command", status: "running" } },
        ],
      },
    });
  });

  it("records endedAt when a group is sealed by a same-turn item, and omits it across user turns", () => {
    const t1 = new Date("2026-01-01T00:00:01.000Z");
    const t2 = new Date("2026-01-01T00:00:15.000Z");
    const t3 = new Date("2026-01-01T00:00:20.000Z");
    const tNextHour = new Date("2026-01-01T01:00:00.000Z");

    const makeTool = (id: string, timestamp: Date, turnId?: string): StreamItem => ({
      kind: "plugin",
      id: `lumen/${id}/0`,
      sourceId: id,
      sourceKind: "tool_call",
      timestamp,
      ...(turnId ? { turnId } : {}),
      pluginId: "lumen",
      pluginItemId: `${id}/0`,
      itemKind: "lumen-tool-call",
      version: 1,
      data: {
        name: "read_file",
        status: "completed",
        __paseoGroup: { kind: "lumen-step-trail", version: 1, key: "step-trail" },
      },
    });

    const assistantReply: StreamItem = {
      kind: "assistant_message",
      id: "a1",
      text: "Done.",
      timestamp: t2,
      turnId: "turn-1",
    };
    const nextUserMsg: StreamItem = {
      kind: "user_message",
      id: "u2",
      text: "Next question an hour later",
      timestamp: tNextHour,
      turnId: "turn-2",
    };

    const grouped = groupAdjacentPluginItems([
      makeTool("tool-1", t1, "turn-1"),
      assistantReply,
      makeTool("tool-2", t3, "turn-1"),
      nextUserMsg,
    ]);

    expect(grouped.items[0]).toMatchObject({
      id: "lumen/group:tool-1",
      data: { isTail: false, endedAt: t2.getTime() },
    });
    expect((grouped.items[2] as Extract<StreamItem, { kind: "plugin" }>).data).not.toHaveProperty(
      "endedAt",
    );

    // Sealing a trailing tail group when a same-turn assistant reply arrives in head
    const openTail = groupAdjacentPluginItems([makeTool("tool-3", t1, "turn-1")]).items;
    const sealed = mergeGroupedPluginTailAndHead({ tail: openTail, head: [assistantReply] });
    expect(sealed.tail[0]).toMatchObject({
      id: "lumen/group:tool-3",
      data: { isTail: false, endedAt: t2.getTime() },
    });
  });
});
