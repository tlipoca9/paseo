import type { AgentTimelineItem, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginTimelineData } from "@getpaseo/plugin";
import type { AgentToolCallData, PluginTimelineStreamItem, StreamItem } from "@/types/stream";
import { cloneAndFreeze } from "../freeze";
import type { TimelineItemTransform } from "./model";

export interface PluginGroupDescriptor {
  kind: string;
  version: number;
  key: string;
}

export interface PluginGroupEntryPayload {
  id: string;
  sourceId: string;
  kind: string;
  timestamp: number;
  data: PluginTimelineData;
}

const GROUP_FIELD = "__paseoGroup";

function readPluginGroupDescriptor(item: StreamItem): PluginGroupDescriptor | null {
  if (item.kind !== "plugin") return null;
  const data = item.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const raw = (data as Record<string, unknown>)[GROUP_FIELD];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.kind !== "string" ||
    record.kind.length === 0 ||
    typeof record.key !== "string" ||
    record.key.length === 0 ||
    typeof record.version !== "number" ||
    !Number.isInteger(record.version) ||
    record.version < 1
  ) {
    return null;
  }
  return { kind: record.kind, version: record.version, key: record.key };
}

function stripGroupDescriptor(data: PluginTimelineData): PluginTimelineData {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const record = data as Record<string, PluginTimelineData>;
  if (!(GROUP_FIELD in record)) return data;
  const copy: Record<string, PluginTimelineData> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== GROUP_FIELD) copy[k] = v;
  }
  return copy;
}

function isSameGroup(
  aPluginId: string,
  a: PluginGroupDescriptor,
  bPluginId: string,
  b: PluginGroupDescriptor,
): boolean {
  return (
    aPluginId === bPluginId &&
    a.kind === b.kind &&
    a.version === b.version &&
    a.key === b.key
  );
}

function buildGroupedPluginItem(
  members: readonly PluginTimelineStreamItem[],
  descriptor: PluginGroupDescriptor,
  isTail: boolean,
): PluginTimelineStreamItem {
  const first = members[0]!;
  const last = members[members.length - 1]!;
  const firstAnchor = first.sourceId ?? first.id;
  const entries: PluginGroupEntryPayload[] = members.map((member) => ({
    id: member.id,
    sourceId: member.sourceId ?? member.id,
    kind: member.itemKind,
    timestamp: member.timestamp.getTime(),
    data: stripGroupDescriptor(member.data),
  }));
  const groupId = `${first.pluginId}/group:${firstAnchor}`;
  const grouped: PluginTimelineStreamItem = {
    kind: "plugin",
    id: groupId,
    sourceId: first.sourceId,
    sourceKind: first.sourceKind,
    timestamp: last.timestamp,
    pluginId: first.pluginId,
    pluginItemId: `group:${firstAnchor}`,
    itemKind: descriptor.kind,
    version: descriptor.version,
    data: {
      groupKey: descriptor.key,
      isTail,
      entries: entries as unknown as PluginTimelineData,
    },
  };
  if (first.timelineCursor) grouped.timelineCursor = first.timelineCursor;
  if (first.turnId) grouped.turnId = first.turnId;
  return grouped;
}

export interface GroupedPluginTimelineResult {
  items: StreamItem[];
  hostIdByMemberId: ReadonlyMap<string, string>;
}

/**
 * Merges consecutive plugin timeline items that declare matching `__paseoGroup`
 * descriptors into a single virtualized stream row anchored to the first member's
 * stable `sourceId`.
 */
export function groupAdjacentPluginItems(
  items: StreamItem[],
  options?: { trailingIsLiveTail?: boolean },
): GroupedPluginTimelineResult {
  let hasGroupable = false;
  for (const item of items) {
    if (readPluginGroupDescriptor(item) !== null) {
      hasGroupable = true;
      break;
    }
  }
  if (!hasGroupable) {
    return { items, hostIdByMemberId: new Map() };
  }

  const out: StreamItem[] = [];
  const hostIdByMemberId = new Map<string, string>();
  let run: PluginTimelineStreamItem[] = [];
  let runDescriptor: PluginGroupDescriptor | null = null;

  const flush = (isAtEnd: boolean) => {
    if (run.length === 0 || !runDescriptor) return;
    const isTail = isAtEnd && (options?.trailingIsLiveTail ?? true);
    const grouped = buildGroupedPluginItem(run, runDescriptor, isTail);
    out.push(grouped);
    for (const member of run) {
      hostIdByMemberId.set(member.id, grouped.id);
      if (member.sourceId && member.sourceId !== grouped.id) {
        hostIdByMemberId.set(member.sourceId, grouped.id);
      }
    }
    run = [];
    runDescriptor = null;
  };

  for (const item of items) {
    const desc = readPluginGroupDescriptor(item);
    if (!desc || item.kind !== "plugin") {
      flush(false);
      out.push(item);
      continue;
    }
    if (run.length > 0 && runDescriptor && isSameGroup(run[0]!.pluginId, runDescriptor, item.pluginId, desc)) {
      run.push(item);
    } else {
      flush(false);
      run = [item];
      runDescriptor = desc;
    }
  }
  flush(true);

  return { items: out, hostIdByMemberId };
}

/**
 * Merges leading groupable items in `head` into a matching trailing grouped item
 * in `tail`, and groups any remaining groupable items inside `head`.
 */
export function mergeGroupedPluginTailAndHead(input: {
  tail: StreamItem[];
  head: StreamItem[];
}): {
  tail: StreamItem[];
  head: StreamItem[];
  hostIdByMemberId: ReadonlyMap<string, string>;
} {
  const { tail, head } = input;
  if (head.length === 0) {
    return { tail, head, hostIdByMemberId: new Map() };
  }

  const groupedHead = groupAdjacentPluginItems(head, { trailingIsLiveTail: true });
  const tailLast = tail.at(-1);
  const headFirst = groupedHead.items[0];

  if (
    tailLast?.kind === "plugin" &&
    headFirst?.kind === "plugin" &&
    tailLast.pluginId === headFirst.pluginId &&
    tailLast.itemKind === headFirst.itemKind &&
    tailLast.version === headFirst.version &&
    tailLast.pluginItemId.startsWith("group:") &&
    headFirst.pluginItemId.startsWith("group:")
  ) {
    const tailData = tailLast.data as Record<string, unknown>;
    const headData = headFirst.data as Record<string, unknown>;
    if (
      typeof tailData.groupKey === "string" &&
      tailData.groupKey === headData.groupKey &&
      Array.isArray(tailData.entries) &&
      Array.isArray(headData.entries)
    ) {
      const mergedEntries = [...tailData.entries, ...headData.entries];
      const mergedIsTail = groupedHead.items.length === 1;
      const mergedItem: PluginTimelineStreamItem = {
        ...tailLast,
        timestamp: headFirst.timestamp,
        data: {
          groupKey: tailData.groupKey,
          isTail: mergedIsTail,
          entries: mergedEntries as PluginTimelineData,
        },
      };
      const nextTail = [...tail.slice(0, -1), mergedItem];
      const nextHead = groupedHead.items.slice(1);
      const hostMap = new Map(groupedHead.hostIdByMemberId);
      for (const [k, v] of hostMap) {
        if (v === headFirst.id) hostMap.set(k, mergedItem.id);
      }
      hostMap.set(headFirst.id, mergedItem.id);
      return { tail: nextTail, head: nextHead, hostIdByMemberId: hostMap };
    }
  }

  // If tail ended with a group but head starts with a non-matching item (e.g.
  // streaming assistant reply), mark the trailing tail group as no longer tail.
  if (
    tailLast?.kind === "plugin" &&
    tailLast.pluginItemId.startsWith("group:") &&
    tailLast.data &&
    typeof tailLast.data === "object" &&
    !Array.isArray(tailLast.data) &&
    (tailLast.data as Record<string, unknown>).isTail === true
  ) {
    const updatedTailLast: PluginTimelineStreamItem = {
      ...tailLast,
      data: {
        ...(tailLast.data as Record<string, PluginTimelineData>),
        isTail: false,
      },
    };
    return {
      tail: [...tail.slice(0, -1), updatedTailLast],
      head: groupedHead.items,
      hostIdByMemberId: groupedHead.hostIdByMemberId,
    };
  }

  return { tail, head: groupedHead.items, hostIdByMemberId: groupedHead.hostIdByMemberId };
}

type AssistantPhase = "streaming" | "complete";

const projectionCache = new WeakMap<
  TimelineItemTransform,
  WeakMap<StreamItem, Partial<Record<AssistantPhase, StreamItem[]>>>
>();

function sourceToolCallTimelineItem(data: AgentToolCallData): ToolCallTimelineItem {
  const { callId, name, status, error, detail, metadata, agentMessage } = data;
  const base = {
    type: "tool_call" as const,
    callId,
    name,
    detail,
    ...(metadata ? { metadata } : {}),
    ...(agentMessage ? { agentMessage } : {}),
  };
  switch (status) {
    case "running":
    case "completed":
    case "canceled":
      return { ...base, status, error: null };
    case "failed":
      return { ...base, status, error };
  }
}

function sourceTimelineItem(item: StreamItem): AgentTimelineItem | null {
  switch (item.kind) {
    case "user_message":
      return {
        type: "user_message",
        text: item.text,
        ...(item.messageId ? { messageId: item.messageId } : {}),
        ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
      };
    case "assistant_message":
      return {
        type: "assistant_message",
        text: item.text,
        ...(item.messageId ? { messageId: item.messageId } : {}),
      };
    case "thought":
      return { type: "reasoning", text: item.text };
    case "tool_call": {
      if (item.payload.source !== "agent") return null;
      return sourceToolCallTimelineItem(item.payload.data);
    }
    case "todo_list":
      return { type: "todo", items: item.items };
    case "notification":
      return item.sourceType === "error"
        ? { type: "error", message: item.message }
        : { type: "notification", level: item.level, message: item.message };
    case "compaction":
      return {
        type: "compaction",
        status: item.status,
        ...(item.trigger ? { trigger: item.trigger } : {}),
        ...(item.preTokens !== undefined ? { preTokens: item.preTokens } : {}),
      };
    case "plugin":
    case "turn_summary":
      return null;
  }
}

function transformSourceItem(
  item: StreamItem,
  transformTimelineItem: TimelineItemTransform,
  assistantPhase: AssistantPhase,
): StreamItem[] {
  const source = sourceTimelineItem(item);
  if (!source) return [item];
  const isStreamingThought = item.kind === "thought" && item.status === "loading";
  const isStreamingToolCall =
    item.kind === "tool_call" &&
    item.payload.source === "agent" &&
    item.payload.data.status === "running";
  const isStreamingAssistant = item.kind === "assistant_message" && assistantPhase === "streaming";
  const phase =
    isStreamingAssistant || isStreamingThought || isStreamingToolCall ? "streaming" : "complete";
  const transformed = transformTimelineItem({
    item: cloneAndFreeze(source),
    phase,
    sourceId: item.id,
  });
  if (transformed === undefined) return [item];
  return transformed.map((pluginItem) => {
    const projected: PluginTimelineStreamItem = {
      kind: "plugin",
      id: `${pluginItem.pluginId}/${pluginItem.id}`,
      sourceId: item.id,
      sourceKind: item.kind,
      timestamp: item.timestamp,
      pluginId: pluginItem.pluginId,
      pluginItemId: pluginItem.id,
      itemKind: pluginItem.kind,
      version: pluginItem.version,
      data: pluginItem.data,
    };
    if (item.timelineCursor) projected.timelineCursor = item.timelineCursor;
    if (item.turnId) projected.turnId = item.turnId;
    return projected;
  });
}

export function projectPluginTimelineItems(
  items: StreamItem[],
  transformTimelineItem: TimelineItemTransform | undefined,
  assistantPhase: AssistantPhase = "complete",
): StreamItem[] {
  if (!transformTimelineItem) return items;
  let bySource = projectionCache.get(transformTimelineItem);
  if (!bySource) {
    bySource = new WeakMap();
    projectionCache.set(transformTimelineItem, bySource);
  }
  let changed = false;
  const projected = items.flatMap((item) => {
    const cached = bySource.get(item)?.[assistantPhase];
    if (cached) {
      changed = changed || cached.length !== 1 || cached[0] !== item;
      return cached;
    }
    const output = transformSourceItem(item, transformTimelineItem, assistantPhase);
    bySource.set(item, { ...bySource.get(item), [assistantPhase]: output });
    changed = changed || output.length !== 1 || output[0] !== item;
    return output;
  });
  return changed ? projected : items;
}
