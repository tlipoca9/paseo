import type { PaseoAgentBackgroundWorkItem } from "@getpaseo/client";
import {
  getStreamItemMessageId,
  isAgentToolCallItem,
  type AgentToolCallData,
  type StreamItem,
} from "@/types/stream";

const EXCLUDED_STATUS_BANNER_TOOLS = new Set(["codex_retry", "antigravity_quota_wait"]);

export interface ActiveToolWorkItem {
  id: string;
  messageId: string;
  kind: "shell" | "tool";
  title: string;
  command: string | null;
  startedAt: Date;
}

function normalizeSingleLine(value: string | undefined): string {
  return value ? value.replace(/\s+/g, " ").trim() : "";
}

function shortFileName(filePath: string | undefined): string {
  if (!filePath) return "file";
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

function formatToolName(name: string): string {
  if (name.startsWith("mcp__") || name.startsWith("mcp_")) {
    return name.replace(/^mcp_+/, "").replace(/__+/g, " / ");
  }
  return name;
}

function summarizeRunningToolCall(data: AgentToolCallData): {
  kind: "shell" | "tool";
  title: string;
  command: string | null;
} {
  const detail = data.detail;
  switch (detail.type) {
    case "shell": {
      const cmd = normalizeSingleLine(detail.command);
      return {
        kind: "shell",
        title: cmd || formatToolName(data.name),
        command: null,
      };
    }
    case "read":
      return {
        kind: "tool",
        title: `Read ${shortFileName(detail.filePath)}`,
        command: detail.filePath || null,
      };
    case "write":
      return {
        kind: "tool",
        title: `Write ${shortFileName(detail.filePath)}`,
        command: detail.filePath || null,
      };
    case "edit":
      return {
        kind: "tool",
        title: `Edit ${shortFileName(detail.filePath)}`,
        command: detail.filePath || null,
      };
    case "search": {
      const query = normalizeSingleLine(detail.query);
      return {
        kind: "tool",
        title: query ? `Search ${query}` : formatToolName(data.name),
        command: null,
      };
    }
    case "plain_text": {
      const label = normalizeSingleLine(detail.label);
      const text = normalizeSingleLine(detail.text);
      const title = label || text || formatToolName(data.name);
      return {
        kind: "tool",
        title,
        command: label && text && text !== label ? text : null,
      };
    }
    default:
      return {
        kind: "tool",
        title: formatToolName(data.name),
        command: null,
      };
  }
}

function extractMobileRunningSteps(
  callId: string,
  messageId: string,
  text: string | undefined,
  startedAt: Date,
): ActiveToolWorkItem[] {
  if (!text) return [];
  const extracted: ActiveToolWorkItem[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]?.trim() ?? "";
    if (!raw.endsWith(" (running)")) continue;
    const body = raw.replace(/^•\s*/, "").replace(/\s*\(running\)$/, "").trim();
    if (!body) continue;
    if (body.startsWith("$ ")) {
      extracted.push({
        id: `${callId}:step:${i}`,
        messageId,
        kind: "shell",
        title: body.slice(2).trim() || "shell",
        command: null,
        startedAt,
      });
    } else {
      extracted.push({
        id: `${callId}:step:${i}`,
        messageId,
        kind: "tool",
        title: body,
        command: null,
        startedAt,
      });
    }
  }
  return extracted;
}

/**
 * Extract still-running tool calls from the current session's timeline (tail + head),
 * excluding pure status banners (retry / quota wait). Supports both full desktop tool_call
 * items and compacted mobile_steps items.
 */
export function extractActiveToolCalls(
  tail: readonly StreamItem[] | undefined,
  head: readonly StreamItem[] | undefined,
): ActiveToolWorkItem[] {
  const byId = new Map<string, ActiveToolWorkItem>();

  const visit = (items: readonly StreamItem[] | undefined) => {
    if (!items || items.length === 0) return;
    for (const item of items) {
      if (!isAgentToolCallItem(item)) continue;
      const data = item.payload.data;
      if (data.status !== "running") continue;
      if (EXCLUDED_STATUS_BANNER_TOOLS.has(data.name)) continue;

      const messageId = getStreamItemMessageId(item);
      if (data.name === "mobile_steps") {
        const text = data.detail.type === "plain_text" ? data.detail.text : undefined;
        for (const step of extractMobileRunningSteps(data.callId, messageId, text, item.timestamp)) {
          const existing = byId.get(step.id);
          byId.set(step.id, existing ? { ...step, startedAt: existing.startedAt } : step);
        }
        continue;
      }

      const id = data.callId || item.id;
      const summary = summarizeRunningToolCall(data);
      const existing = byId.get(id);
      byId.set(id, {
        id,
        messageId,
        kind: summary.kind,
        title: summary.title,
        command: summary.command,
        startedAt: existing?.startedAt ?? item.timestamp,
      });
    }
  };

  visit(tail);
  visit(head);
  return [...byId.values()];
}

export function areActiveToolWorkItemsEqual(
  a: readonly ActiveToolWorkItem[],
  b: readonly ActiveToolWorkItem[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.id !== right.id ||
      left.messageId !== right.messageId ||
      left.kind !== right.kind ||
      left.title !== right.title ||
      left.command !== right.command ||
      left.startedAt.getTime() !== right.startedAt.getTime()
    ) {
      return false;
    }
  }
  return true;
}

export function filterDuplicateActiveTools(
  tools: readonly ActiveToolWorkItem[],
  backgroundItems: readonly PaseoAgentBackgroundWorkItem[] | null | undefined,
): ActiveToolWorkItem[] {
  if (tools.length === 0 || !backgroundItems || backgroundItems.length === 0) {
    return [...tools];
  }
  const backgroundIds = new Set(backgroundItems.map((item) => item.id));
  const backgroundCommands = new Set(
    backgroundItems
      .flatMap((item) => [item.command, item.description])
      .map((value) => normalizeSingleLine(value ?? undefined))
      .filter(Boolean),
  );
  return tools.filter((tool) => {
    if (backgroundIds.has(tool.id)) return false;
    if (tool.kind === "shell" && backgroundCommands.has(normalizeSingleLine(tool.title))) {
      return false;
    }
    return true;
  });
}
