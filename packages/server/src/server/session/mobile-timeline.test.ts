import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import {
  compactMobileTimelineEntries,
  compactMobileTimelineEntriesWithState,
  MobileLiveStreamCompactor,
  type MobileTimelineEntryShape,
} from "./mobile-timeline.js";

function makeEntry(seq: number, item: AgentTimelineItem): MobileTimelineEntryShape {
  return {
    item,
    turnId: "turn-1",
    timestamp: `2026-11-24T18:00:0${seq}.000Z`,
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
  };
}

describe("compactMobileTimelineEntries", () => {
  it("collapses consecutive reasoning and tool_call items into one lightweight plain_text summary while preserving text, errors, and todos", () => {
    const hugeOutput = "x".repeat(50_000);
    const entries: MobileTimelineEntryShape[] = [
      makeEntry(1, { type: "user_message", text: "Fix the bug" }),
      makeEntry(2, { type: "reasoning", text: "First I will inspect provider.ts\n" + hugeOutput }),
      makeEntry(3, {
        type: "tool_call",
        callId: "c1",
        name: "shell",
        status: "completed",
        error: null,
        detail: {
          type: "shell",
          command: "npm test",
          cwd: "/repo",
          output: hugeOutput,
          exitCode: 0,
        },
      }),
      makeEntry(4, {
        type: "tool_call",
        callId: "c2",
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "/repo/src/provider.ts", content: hugeOutput },
      }),
      makeEntry(5, { type: "assistant_message", text: "Fixed and verified." }),
      makeEntry(6, { type: "error", message: "Something went wrong" }),
    ];

    const compacted = compactMobileTimelineEntries(entries);
    expect(compacted).toHaveLength(4);
    expect(compacted[0]!.item.type).toBe("user_message");
    expect(compacted[2]!.item.type).toBe("assistant_message");
    expect(compacted[3]!.item.type).toBe("error");

    const groupEntry = compacted[1]!;
    expect(groupEntry.seqStart).toBe(2);
    expect(groupEntry.seqEnd).toBe(4);
    expect(groupEntry.item.type).toBe("tool_call");
    if (groupEntry.item.type === "tool_call") {
      expect(groupEntry.item.name).toBe("mobile_steps");
      expect(groupEntry.item.status).toBe("completed");
      expect(groupEntry.item.detail.type).toBe("plain_text");
      if (groupEntry.item.detail.type === "plain_text") {
        expect(groupEntry.item.detail.label).toBe("3 steps · 1 thought · 1 command · 1 file read");
        expect(groupEntry.item.detail.text).toContain("[thought] First I will inspect provider.ts");
        expect(groupEntry.item.detail.text).toContain("$ npm test (exit 0)");
        expect(groupEntry.item.detail.text).toContain("Read provider.ts");
        expect(groupEntry.item.detail.text!.length).toBeLessThan(1000);
      }
    }
  });

  it("keeps running codex_retry and antigravity_quota_wait banners outside the collapsed group", () => {
    const entries: MobileTimelineEntryShape[] = [
      makeEntry(1, { type: "reasoning", text: "Checking..." }),
      makeEntry(2, {
        type: "tool_call",
        callId: "retry-1",
        name: "codex_retry",
        status: "running",
        error: null,
        detail: { type: "plain_text", label: "Reconnecting... (at capacity)" },
      }),
    ];

    const compacted = compactMobileTimelineEntries(entries);
    expect(compacted).toHaveLength(2);
    expect(compacted[1]!.item.type).toBe("tool_call");
    if (compacted[1]!.item.type === "tool_call") {
      expect(compacted[1]!.item.name).toBe("codex_retry");
    }
  });
});

describe("MobileLiveStreamCompactor", () => {
  it("coalesces live reasoning and tool updates under one callId and drops redundant output deltas", () => {
    const compactor = new MobileLiveStreamCompactor();

    const first = compactor.transformTimelineItem(
      "agent-1",
      {
        type: "tool_call",
        callId: "sh-1",
        name: "shell",
        status: "running",
        error: null,
        detail: { type: "shell", command: "npm test", output: "line 1" },
      },
      10,
    );
    expect(first.action).toBe("emit");

    // A second stdout chunk with the same command and running status produces the same summary -> dropped.
    const redundant = compactor.transformTimelineItem(
      "agent-1",
      {
        type: "tool_call",
        callId: "sh-1",
        name: "shell",
        status: "running",
        error: null,
        detail: { type: "shell", command: "npm test", output: "line 1\nline 2\nline 3" },
      },
      11,
    );
    expect(redundant.action).toBe("drop");

    // Individual tool completion keeps the process group active until the turn
    // boundary, so a fast tool/reasoning transition does not flicker.
    const completed = compactor.transformTimelineItem(
      "agent-1",
      {
        type: "tool_call",
        callId: "sh-1",
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "npm test", output: "done", exitCode: 0 },
      },
      12,
    );
    expect(completed.action).toBe("emit");
    if (first.action === "emit" && completed.action === "emit") {
      expect(first.item.type === "tool_call" && completed.item.type === "tool_call").toBe(true);
      if (first.item.type === "tool_call" && completed.item.type === "tool_call") {
        expect(completed.item.callId).toBe(first.item.callId);
        expect(completed.item.status).toBe("running");
      }
    }

    // Assistant reply resets the active group.
    const reply = compactor.transformTimelineItem(
      "agent-1",
      { type: "assistant_message", text: "All tests passed." },
      13,
    );
    expect(reply.action).toBe("emit");
    if (reply.action === "emit") {
      expect(reply.item.type).toBe("assistant_message");
    }
  });

  it("seeds from history tail so live updates reuse the same callId", () => {
    const history = compactMobileTimelineEntriesWithState([
      makeEntry(1, { type: "user_message", text: "Run checks" }),
      makeEntry(2, {
        type: "tool_call",
        callId: "c1",
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "npm test", exitCode: 0 },
      }),
    ]);

    expect(history.tailGroup).not.toBeNull();
    const compactor = new MobileLiveStreamCompactor();
    compactor.seedTailGroup("agent-1", history.tailGroup);

    const nextLive = compactor.transformTimelineItem(
      "agent-1",
      {
        type: "tool_call",
        callId: "c2",
        name: "read",
        status: "running",
        error: null,
        detail: { type: "read", filePath: "/repo/a.ts" },
      },
      3,
    );
    expect(nextLive.action).toBe("emit");
    if (nextLive.action === "emit" && nextLive.item.type === "tool_call") {
      expect(nextLive.item.callId).toBe(history.tailGroup!.groupId);
      expect(nextLive.item.status).toBe("running");
    }

    // Assistant narration passes through while the same turn remains active.
    const reply = compactor.transformTimelineItem(
      "agent-1",
      { type: "assistant_message", text: "Done." },
      4,
    );
    expect(reply.action).toBe("emit");
    if (reply.action === "emit") {
      expect(reply.settledBefore).toBeUndefined();
      expect(reply.item.type).toBe("assistant_message");
    }
  });

  it("keeps one history group across assistant narration in the same turn", () => {
    const compacted = compactMobileTimelineEntriesWithState([
      makeEntry(1, { type: "user_message", text: "Update the files" }),
      makeEntry(2, {
        type: "tool_call",
        callId: "shell-1",
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "npm test", exitCode: 0 },
      }),
      makeEntry(3, { type: "assistant_message", text: "I will edit the config next." }),
      makeEntry(4, {
        type: "tool_call",
        callId: "edit-1",
        name: "edit",
        status: "completed",
        error: null,
        detail: { type: "edit", filePath: "/repo/config.ts", unifiedDiff: "-old\n+new" },
      }),
    ]);

    expect(compacted.entries).toHaveLength(4);
    const firstSummary = compacted.entries[1]!.item;
    const secondSummary = compacted.entries[3]!.item;
    expect(firstSummary.type).toBe("tool_call");
    expect(secondSummary.type).toBe("tool_call");
    if (firstSummary.type === "tool_call" && secondSummary.type === "tool_call") {
      expect(secondSummary.callId).toBe(firstSummary.callId);
      expect(secondSummary.detail.type).toBe("plain_text");
      if (secondSummary.detail.type === "plain_text") {
        expect(secondSummary.detail.label).toMatch(/^2 steps/);
        expect(secondSummary.detail.text).toContain("$ npm test");
        expect(secondSummary.detail.text).toContain("Edit config.ts");
      }
    }
  });

  it("keeps a live group open across assistant narration", () => {
    const compactor = new MobileLiveStreamCompactor();
    const first = compactor.transformTimelineItem("agent-1", {
      type: "tool_call",
      callId: "shell-1",
      name: "shell",
      status: "running",
      error: null,
      detail: { type: "shell", command: "npm test" },
    });
    const narration = compactor.transformTimelineItem("agent-1", {
      type: "assistant_message",
      text: "I will edit the config next.",
    });
    const second = compactor.transformTimelineItem("agent-1", {
      type: "tool_call",
      callId: "edit-1",
      name: "edit",
      status: "running",
      error: null,
      detail: { type: "edit", filePath: "/repo/config.ts", unifiedDiff: "-old\n+new" },
    });

    expect(narration.action).toBe("emit");
    expect(second.action).toBe("emit");
    if (first.action === "emit" && first.item.type === "tool_call") {
      expect(second.action === "emit" && second.item.type === "tool_call").toBe(true);
      if (second.action === "emit" && second.item.type === "tool_call") {
        expect(second.item.callId).toBe(first.item.callId);
      }
    }
  });
});
