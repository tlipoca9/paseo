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

    // Assistant reply settles the completed group (from forceRunning -> completed) and closes it.
    const reply = compactor.transformTimelineItem(
      "agent-1",
      { type: "assistant_message", text: "All tests passed." },
      13,
    );
    expect(reply.action).toBe("emit");
    if (reply.action === "emit") {
      expect(reply.item.type).toBe("assistant_message");
      expect(reply.settledBefore).toBeDefined();
      expect(reply.settledBefore?.status).toBe("completed");
      if (first.action === "emit" && first.item.type === "tool_call") {
        expect(reply.settledBefore?.callId).toBe(first.item.callId);
      }
    }
    expect(compactor.activeGroup("agent-1")).toBeNull();
  });

  it("seeds from history tail so live updates reuse the same callId, then cuts off on assistant reply", () => {
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

    // Assistant reply closes the active group while preserving genuinely running steps.
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
    expect(compactor.activeGroup("agent-1")).toBeNull();
  });

  it("splits history groups at non-empty assistant messages to preserve chronological order", () => {
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
      makeEntry(3, { type: "assistant_message", text: "Phase 1 complete." }),
      makeEntry(4, {
        type: "tool_call",
        callId: "edit-1",
        name: "edit",
        status: "completed",
        error: null,
        detail: { type: "edit", filePath: "/repo/config.ts", unifiedDiff: "-old\n+new" },
      }),
      makeEntry(5, { type: "assistant_message", text: "Phase 2 complete." }),
      makeEntry(6, {
        type: "tool_call",
        callId: "read-1",
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "/repo/readme.md" },
      }),
    ]);

    expect(compacted.entries).toHaveLength(6);
    expect(compacted.entries.map((entry) => entry.item.type)).toEqual([
      "user_message",
      "tool_call",
      "assistant_message",
      "tool_call",
      "assistant_message",
      "tool_call",
    ]);

    const firstSummary = compacted.entries[1]!.item;
    const secondSummary = compacted.entries[3]!.item;
    const thirdSummary = compacted.entries[5]!.item;
    if (
      firstSummary.type === "tool_call" &&
      secondSummary.type === "tool_call" &&
      thirdSummary.type === "tool_call"
    ) {
      expect(firstSummary.callId).toBe("mobile-group:2");
      expect(secondSummary.callId).toBe("mobile-group:4");
      expect(thirdSummary.callId).toBe("mobile-group:6");
      expect(firstSummary.detail.type === "plain_text" ? firstSummary.detail.text : "").toContain(
        "$ npm test",
      );
      expect(firstSummary.detail.type === "plain_text" ? firstSummary.detail.text : "").not.toContain(
        "Edit config.ts",
      );
      expect(secondSummary.detail.type === "plain_text" ? secondSummary.detail.text : "").toContain(
        "Edit config.ts",
      );
      expect(thirdSummary.detail.type === "plain_text" ? thirdSummary.detail.text : "").toContain(
        "Read readme.md",
      );
    }
    expect(compacted.tailGroup?.groupId).toBe("mobile-group:6");

    // When a page ends on a non-empty assistant_message, tailGroup is null so subsequent live tools open a new group.
    const endedOnReply = compactMobileTimelineEntriesWithState(compacted.entries.slice(0, 5));
    expect(endedOnReply.tailGroup).toBeNull();
  });

  it("preserves running status on a long-running tool call followed by an assistant message in history", () => {
    const compacted = compactMobileTimelineEntriesWithState([
      makeEntry(1, { type: "user_message", text: "Start backfill" }),
      makeEntry(2, {
        type: "tool_call",
        callId: "bg-shell-1",
        name: "shell",
        status: "running",
        error: null,
        detail: { type: "shell", command: "python backfill.py" },
      }),
      makeEntry(3, { type: "assistant_message", text: "Backfill is running in the background." }),
      makeEntry(4, {
        type: "tool_call",
        callId: "read-2",
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "/repo/status.log" },
      }),
    ]);

    expect(compacted.entries).toHaveLength(4);
    const firstGroup = compacted.entries[1]!.item;
    const secondGroup = compacted.entries[3]!.item;
    expect(firstGroup.type).toBe("tool_call");
    expect(secondGroup.type).toBe("tool_call");
    if (firstGroup.type === "tool_call" && secondGroup.type === "tool_call") {
      expect(firstGroup.status).toBe("running");
      expect(firstGroup.detail.type === "plain_text" ? firstGroup.detail.label : "").toContain(
        "1 running",
      );
      expect(firstGroup.detail.type === "plain_text" ? firstGroup.detail.text : "").toContain(
        "$ python backfill.py (running)",
      );
      expect(secondGroup.status).toBe("completed");
      expect(secondGroup.callId).not.toBe(firstGroup.callId);
    }
  });

  it("cuts off a live group on assistant narration and starts a new group afterwards while preserving running tools", () => {
    const compactor = new MobileLiveStreamCompactor();
    const first = compactor.transformTimelineItem(
      "agent-1",
      {
        type: "tool_call",
        callId: "bg-1",
        name: "shell",
        status: "running",
        error: null,
        detail: { type: "shell", command: "python backfill.py" },
      },
      10,
      "turn-1",
    );
    const narration = compactor.transformTimelineItem(
      "agent-1",
      {
        type: "assistant_message",
        text: "Backfill started; editing config next.",
      },
      11,
      "turn-1",
    );
    const second = compactor.transformTimelineItem(
      "agent-1",
      {
        type: "tool_call",
        callId: "edit-1",
        name: "edit",
        status: "running",
        error: null,
        detail: { type: "edit", filePath: "/repo/config.ts", unifiedDiff: "-old\n+new" },
      },
      12,
      "turn-1",
    );
    const secondDone = compactor.transformTimelineItem(
      "agent-1",
      {
        type: "tool_call",
        callId: "edit-1",
        name: "edit",
        status: "completed",
        error: null,
        detail: { type: "edit", filePath: "/repo/config.ts", unifiedDiff: "-old\n+new" },
      },
      13,
      "turn-1",
    );
    const secondNarration = compactor.transformTimelineItem(
      "agent-1",
      {
        type: "assistant_message",
        text: "Config updated.",
      },
      14,
      "turn-1",
    );

    expect(narration.action).toBe("emit");
    if (narration.action === "emit") {
      // bg-1 is genuinely still running, so cutting off the group does not clobber it to completed.
      expect(narration.settledBefore).toBeUndefined();
    }
    expect(second.action).toBe("emit");
    expect(secondDone.action).toBe("emit");
    if (
      first.action === "emit" &&
      first.item.type === "tool_call" &&
      second.action === "emit" &&
      second.item.type === "tool_call"
    ) {
      expect(second.item.callId).not.toBe(first.item.callId);
      expect(second.item.detail.type === "plain_text" ? second.item.detail.text : "").not.toContain(
        "backfill.py",
      );
    }
    expect(secondNarration.action).toBe("emit");
    if (secondNarration.action === "emit") {
      // edit-1 already finished, so cutting off settles the group from forceRunning -> completed.
      expect(secondNarration.settledBefore?.status).toBe("completed");
    }

    // Explicit turn boundary settles a trailing running group.
    const third = compactor.transformTimelineItem(
      "agent-1",
      {
        type: "tool_call",
        callId: "sh-3",
        name: "shell",
        status: "running",
        error: null,
        detail: { type: "shell", command: "npm test" },
      },
      15,
      "turn-1",
    );
    expect(third.action).toBe("emit");
    const settledAtTurnEnd = compactor.settleAgent("agent-1");
    expect(settledAtTurnEnd?.status).toBe("completed");
    expect(settledAtTurnEnd?.detail.type === "plain_text" ? settledAtTurnEnd.detail.text : "").not.toContain(
      "(running)",
    );
  });
});
