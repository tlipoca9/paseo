import path from "node:path";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";

const MAX_COMMAND_CHARS = 100;
const MAX_ERROR_CHARS = 80;
const MAX_SUMMARY_LINES = 40;
const MAX_SUMMARY_TEXT_CHARS = 3500;

const LIVE_STATUS_BANNER_TOOLS = new Set(["codex_retry", "antigravity_quota_wait"]);

export interface MobileTimelineEntryShape<TRange = { startSeq: number; endSeq: number }> {
  item: AgentTimelineItem;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges: TRange[];
  turnId?: string;
}

interface MobileStepRecord {
  key: string;
  category: string;
  status: "running" | "completed" | "failed" | "canceled";
  line: string;
}

const CATEGORY_LABELS: Record<string, [string, string]> = {
  reasoning: ["thought", "thoughts"],
  shell: ["command", "commands"],
  read: ["file read", "files read"],
  write: ["file written", "files written"],
  edit: ["edit", "edits"],
  search: ["search", "searches"],
  mcp: ["MCP call", "MCP calls"],
  tool: ["tool", "tools"],
};

function truncate(value: string, maxChars: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

function shortFileName(filePath: string | undefined): string {
  if (!filePath) return "file";
  const base = path.basename(filePath);
  return base || filePath;
}

function formatErrorBrief(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return truncate(error, MAX_ERROR_CHARS);
  if (typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return truncate((error as { message: string }).message, MAX_ERROR_CHARS);
  }
  return "";
}

function statusSuffix(status: MobileStepRecord["status"], error?: unknown): string {
  if (status === "running") return " (running)";
  if (status === "canceled") return " (canceled)";
  if (status === "failed") {
    const brief = formatErrorBrief(error);
    return brief ? ` (failed: ${brief})` : " (failed)";
  }
  return "";
}

/**
 * Returns true for process items (reasoning and regular tool_calls) that should be
 * compacted into a single lightweight summary row for mobile clients.
 * Active retry/quota wait banners stay visible outside the group.
 */
export function isMobileCompactableItem(item: AgentTimelineItem): boolean {
  if (item.type === "reasoning") return true;
  if (item.type === "assistant_message" && item.text.trim().length === 0) return true;
  if (item.type !== "tool_call") return false;
  if (item.status === "running" && LIVE_STATUS_BANNER_TOOLS.has(item.name)) {
    return false;
  }
  return true;
}

function summarizeToolDetail(item: Extract<AgentTimelineItem, { type: "tool_call" }>): {
  category: string;
  headline: string;
} {
  const detail = item.detail;
  switch (detail.type) {
    case "shell": {
      const cmd = truncate(detail.command || item.name, MAX_COMMAND_CHARS);
      const exitSuffix =
        typeof detail.exitCode === "number" && item.status !== "running"
          ? ` (exit ${detail.exitCode})`
          : "";
      return { category: "shell", headline: `$ ${cmd}${exitSuffix}` };
    }
    case "read":
      return { category: "read", headline: `Read ${shortFileName(detail.filePath)}` };
    case "write":
      return { category: "write", headline: `Write ${shortFileName(detail.filePath)}` };
    case "edit":
      return { category: "edit", headline: `Edit ${shortFileName(detail.filePath)}` };
    case "search":
      return { category: "search", headline: `Search ${truncate(detail.query || item.name, 80)}` };
    case "plain_text": {
      const combined = [detail.label, detail.text ? truncate(detail.text, 80) : ""]
        .filter(Boolean)
        .join(" · ");
      return { category: "tool", headline: combined || item.name };
    }
    default: {
      const isMcp = item.name.startsWith("mcp__") || item.name.startsWith("mcp_");
      return {
        category: isMcp ? "mcp" : "tool",
        headline: isMcp ? item.name.replace(/^mcp_+/, "").replace(/__+/g, " / ") : item.name,
      };
    }
  }
}

function toStepRecord(item: AgentTimelineItem, fallbackKey: string): MobileStepRecord {
  if (item.type === "reasoning") {
    const firstLine = item.text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    const snippet = firstLine ? truncate(firstLine, 60) : "";
    return {
      key: `reasoning:${fallbackKey}`,
      category: "reasoning",
      status: "completed",
      line: snippet ? `[thought] ${snippet}` : "[thought]",
    };
  }

  if (item.type === "tool_call") {
    const { category, headline } = summarizeToolDetail(item);
    const status =
      item.status === "running" || item.status === "failed" || item.status === "canceled"
        ? item.status
        : "completed";
    return {
      key: `tool:${item.callId || fallbackKey}`,
      category,
      status,
      line: `${headline}${statusSuffix(status, item.error)}`,
    };
  }

  return {
    key: fallbackKey,
    category: "tool",
    status: "completed",
    line: item.type,
  };
}

function formatCategorySummary(steps: readonly MobileStepRecord[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) {
    counts.set(step.category, (counts.get(step.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => {
      const [singular, plural] = CATEGORY_LABELS[category] ?? [category, `${category}s`];
      return `${count} ${count === 1 ? singular : plural}`;
    })
    .join(" · ");
}

function buildCompactGroupToolCall(
  groupId: string,
  steps: readonly MobileStepRecord[],
  forceRunning = false,
): Extract<AgentTimelineItem, { type: "tool_call" }> {
  const runningCount = steps.filter((s) => s.status === "running").length;
  const total = steps.length;
  const unit = total === 1 ? "step" : "steps";
  const categoryText = formatCategorySummary(steps);

  const labelParts = [`${total} ${unit}`];
  if (categoryText) labelParts.push(categoryText);
  if (runningCount > 0) labelParts.push(`${runningCount} running`);

  const visibleSteps =
    steps.length > MAX_SUMMARY_LINES ? steps.slice(steps.length - MAX_SUMMARY_LINES) : steps;
  const lines = visibleSteps.map((step) => `• ${step.line}`);
  if (steps.length > MAX_SUMMARY_LINES) {
    lines.unshift(`… ${steps.length - MAX_SUMMARY_LINES} earlier steps omitted`);
  }
  let text = lines.join("\n");
  if (text.length > MAX_SUMMARY_TEXT_CHARS) {
    text = `${text.slice(0, MAX_SUMMARY_TEXT_CHARS - 1)}…`;
  }

  const base = {
    type: "tool_call" as const,
    callId: groupId,
    name: "mobile_steps",
    detail: {
      type: "plain_text" as const,
      label: labelParts.join(" · "),
      text,
      icon: "wrench" as const,
    },
  };

  if (forceRunning || runningCount > 0) {
    return { ...base, status: "running", error: null };
  }
  return { ...base, status: "completed", error: null };
}

export interface CompactedMobileTimelineResult<T> {
  entries: T[];
  tailGroup: {
    groupId: string;
    turnId?: string;
    steps: MobileStepRecord[];
    lastSignature: string;
  } | null;
}

function buildSignature(item: Extract<AgentTimelineItem, { type: "tool_call" }>): string {
  return `${item.status}|${item.detail.type === "plain_text" ? `${item.detail.label ?? ""}|${item.detail.text ?? ""}` : ""}`;
}

/**
 * Compact a historical timeline page for mobile clients by collapsing consecutive
 * reasoning and tool_call items into a single lightweight plain_text tool_call entry.
 * Also returns the trailing group state so live stream updates continue updating it in place.
 */
export function compactMobileTimelineEntriesWithState<
  TRange,
  T extends MobileTimelineEntryShape<TRange>,
>(entries: readonly T[]): CompactedMobileTimelineResult<T> {
  const result: T[] = [];
  let pending: T[] = [];
  let tailGroup: CompactedMobileTimelineResult<T>["tailGroup"] = null;
  let continuationGroupId: string | null = null;
  let continuationTurnId: string | undefined;
  let continuationSteps: MobileStepRecord[] = [];

  const flush = (isEnd: boolean) => {
    if (pending.length === 0) return;
    const first = pending[0]!;
    const last = pending[pending.length - 1]!;
    const stepMap = new Map<string, MobileStepRecord>();
    for (let i = 0; i < pending.length; i += 1) {
      const entry = pending[i]!;
      if (entry.item.type === "assistant_message" && entry.item.text.trim().length === 0) {
        continue;
      }
      const step = toStepRecord(entry.item, `${entry.seqStart}:${i}`);
      // Older groups followed by a reply or turn boundary cannot still be running.
      if (!isEnd && step.status === "running") {
        step.status = "completed";
        step.line = step.line.replace(/ \(running\)$/, "");
      }
      stepMap.set(step.key, step);
    }
    if (stepMap.size === 0) {
      pending = [];
      return;
    }
    const continuingGroupId =
      continuationGroupId &&
      continuationTurnId !== undefined &&
      first.turnId !== undefined &&
      continuationTurnId === first.turnId
        ? continuationGroupId
        : null;
    const groupId = continuingGroupId ?? `mobile-group:${first.seqStart}`;
    const steps = continuingGroupId
      ? [
          ...new Map(
            [...continuationSteps, ...stepMap.values()].map((step) => [step.key, step]),
          ).values(),
        ]
      : [...stepMap.values()];
    const item = buildCompactGroupToolCall(groupId, steps);
    const mergedRanges = pending.flatMap((entry) => entry.sourceSeqRanges);
    result.push({
      ...first,
      item,
      seqStart: first.seqStart,
      seqEnd: last.seqEnd,
      sourceSeqRanges: mergedRanges,
    });
    continuationGroupId = groupId;
    continuationTurnId = first.turnId;
    continuationSteps = steps;
    if (isEnd) {
      tailGroup = {
        groupId,
        ...(first.turnId ? { turnId: first.turnId } : {}),
        steps,
        lastSignature: buildSignature(item),
      };
    }
    pending = [];
  };

  for (const entry of entries) {
    if (isMobileCompactableItem(entry.item)) {
      pending.push(entry);
    } else {
      flush(false);
      if (entry.item.type !== "assistant_message" || entry.item.text.trim().length === 0) {
        continuationGroupId = null;
        continuationTurnId = undefined;
        continuationSteps = [];
        tailGroup = null;
      }
      result.push(entry);
    }
  }
  flush(true);

  // A page can end with the assistant's interstitial text after a process
  // group. Keep that group's state for a live continuation in the same turn.
  if (!tailGroup && continuationGroupId && continuationSteps.length > 0) {
    const summary = buildCompactGroupToolCall(continuationGroupId, continuationSteps);
    tailGroup = {
      groupId: continuationGroupId,
      ...(continuationTurnId ? { turnId: continuationTurnId } : {}),
      steps: continuationSteps,
      lastSignature: buildSignature(summary),
    };
  }

  return { entries: result, tailGroup };
}

export function compactMobileTimelineEntries<
  TRange,
  T extends MobileTimelineEntryShape<TRange>,
>(entries: readonly T[]): T[] {
  return compactMobileTimelineEntriesWithState(entries).entries;
}

interface LiveMobileGroupState {
  groupId: string;
  turnId?: string;
  steps: Map<string, MobileStepRecord>;
  lastSignature: string;
}

/**
 * Per-client live stream compactor that collapses consecutive reasoning and tool_call
 * stream updates into one lightweight in-place tool_call update per group, suppressing
 * redundant deltas that do not change the compact summary.
 */
export class MobileLiveStreamCompactor {
  private readonly activeGroups = new Map<string, LiveMobileGroupState>();
  private seqCounter = 0;

  seedTailGroup(
    agentId: string,
    tailGroup: CompactedMobileTimelineResult<unknown>["tailGroup"],
  ): void {
    if (!tailGroup) {
      this.activeGroups.delete(agentId);
      return;
    }
    const steps = new Map<string, MobileStepRecord>();
    for (const step of tailGroup.steps) {
      steps.set(step.key, { ...step });
    }
    this.activeGroups.set(agentId, {
      groupId: tailGroup.groupId,
      ...(tailGroup.turnId ? { turnId: tailGroup.turnId } : {}),
      steps,
      lastSignature: tailGroup.lastSignature,
    });
  }

  activeGroup(agentId: string): { groupId: string; turnId?: string } | null {
    const group = this.activeGroups.get(agentId);
    return group ? { groupId: group.groupId, ...(group.turnId ? { turnId: group.turnId } : {}) } : null;
  }

  /**
   * Settle any active running group into a completed summary before closing the group
   * (for example on turn_completed / turn_failed / turn_canceled or before a new reply).
   */
  settleAgent(agentId: string): Extract<AgentTimelineItem, { type: "tool_call" }> | null {
    const group = this.activeGroups.get(agentId);
    this.activeGroups.delete(agentId);
    if (!group || group.steps.size === 0) return null;

    let hadRunning = false;
    for (const step of group.steps.values()) {
      if (step.status === "running") {
        hadRunning = true;
        step.status = "completed";
        step.line = step.line.replace(/ \(running\)$/, "");
      }
    }
    if (!hadRunning) return null;
    return buildCompactGroupToolCall(group.groupId, [...group.steps.values()]);
  }

  resetAgent(agentId: string): void {
    this.activeGroups.delete(agentId);
  }

  clear(): void {
    this.activeGroups.clear();
  }

  /**
   * Transform a timeline item for mobile live delivery.
   * Returns:
   * - `{ action: "drop" }` when a redundant delta produces the same compact summary
   * - `{ action: "emit", item, settledBefore? }` with either the original item or the compacted group item
   */
  transformTimelineItem(
    agentId: string,
    item: AgentTimelineItem,
    seq?: number,
    turnId?: string,
  ):
    | { action: "drop" }
    | {
        action: "emit";
        item: AgentTimelineItem;
        settledBefore?: Extract<AgentTimelineItem, { type: "tool_call" }>;
      } {
    if (item.type === "assistant_message" && item.text.trim().length === 0) {
      return { action: "drop" };
    }

    // Assistant narration between tools belongs to the same turn. Let it pass
    // through without settling the compact process group, so the next tool
    // updates the existing mobile summary card.
    if (item.type === "assistant_message" && item.text.trim().length > 0) {
      return { action: "emit", item };
    }

    if (!isMobileCompactableItem(item)) {
      const settledBefore = this.settleAgent(agentId) ?? undefined;
      return { action: "emit", item, ...(settledBefore ? { settledBefore } : {}) };
    }

    let group = this.activeGroups.get(agentId);
    if (!group) {
      this.seqCounter += 1;
      group = {
        groupId: `mobile-live:${seq ?? this.seqCounter}`,
        ...(turnId ? { turnId } : {}),
        steps: new Map(),
        lastSignature: "",
      };
      this.activeGroups.set(agentId, group);
    }
    if (!group.turnId && turnId) group.turnId = turnId;

    // Group reasoning chunks within the same live group under one reasoning step unless
    // a tool call has occurred since the last reasoning step.
    const fallbackKey =
      item.type === "reasoning"
        ? `live-r-${group.steps.size === 0 ? 0 : [...group.steps.keys()].filter((k) => k.startsWith("tool:")).length}`
        : `${seq ?? this.seqCounter}`;
    const step = toStepRecord(item, fallbackKey);
    group.steps.set(step.key, step);

    // Keep the group visibly active for the whole model/tool phase. Individual
    // tool completions can arrive between the next reasoning or tool event, and
    // exposing those tiny gaps makes the mobile status flicker.
    const compacted = buildCompactGroupToolCall(group.groupId, [...group.steps.values()], true);
    const signature = buildSignature(compacted);
    if (signature === group.lastSignature) {
      return { action: "drop" };
    }
    group.lastSignature = signature;
    return { action: "emit", item: compacted };
  }
}
