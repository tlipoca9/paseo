import type { SessionRefComposerAttachment } from "@/attachments/types";

const SESSION_REF_HEADER_REGEX = /^\[Paseo 会话引用\]\s+(.+?)\s*\(([^)]+)\)\s*$/;
const AGENT_LINE_REGEX = /^-\s+(.+?)\s*\(agentId:\s*([^)]+)\)\s*$/;

function parseMetaPairs(metaText: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of metaText.split(",")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const key = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Parses a pasted `[Paseo 会话引用]` block (produced by "Copy session reference")
 * into a structured `session_ref` composer attachment card.
 *
 * Returns `null` if the clipboard text does not contain a recognized Paseo session reference.
 */
export function parseSessionRefPaste(
  rawText: string,
): { attachment: SessionRefComposerAttachment; isExactMatch: boolean } | null {
  const trimmed = rawText.trim();
  if (!trimmed.includes("[Paseo 会话引用]")) return null;

  const lines = trimmed.split(/\r?\n/);
  const headerIdx = lines.findIndex((line) => SESSION_REF_HEADER_REGEX.test(line.trim()));
  if (headerIdx === -1) return null;

  const headerLine = lines[headerIdx]!.trim();
  const headerMatch = headerLine.match(SESSION_REF_HEADER_REGEX);
  if (!headerMatch) return null;

  const title = headerMatch[1]!.trim();
  const meta = parseMetaPairs(headerMatch[2]!);

  const agentLines: string[] = [];
  let endIdx = headerIdx;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const candidate = lines[i]!.trim();
    if (AGENT_LINE_REGEX.test(candidate)) {
      agentLines.push(candidate);
      endIdx = i;
    } else {
      break;
    }
  }

  const blockText = [headerLine, ...agentLines].join("\n");
  const isExactMatch = headerIdx === 0 && endIdx === lines.length - 1;

  const workspaceId = meta.workspace;
  const agentId = meta.agentId;
  const subtitleParts: string[] = [];
  if (agentLines.length > 0) {
    subtitleParts.push(`${agentLines.length} 个会话`);
  } else if (agentId) {
    subtitleParts.push(workspaceId ? workspaceId : `agent ${agentId.slice(0, 8)}`);
  } else if (workspaceId) {
    subtitleParts.push(workspaceId);
  }
  if (meta.cwd) {
    const dirName = meta.cwd.split("/").filter(Boolean).pop();
    if (dirName && dirName !== title) {
      subtitleParts.push(dirName);
    }
  }

  const idSeed = agentId ?? workspaceId ?? title;
  const id = `session_ref:${idSeed}`;

  return {
    attachment: {
      kind: "session_ref",
      id,
      title,
      subtitle: subtitleParts.join(" · ") || "Paseo 会话引用",
      ...(workspaceId ? { workspaceId } : {}),
      ...(agentId ? { agentId } : {}),
      text: blockText,
    },
    isExactMatch,
  };
}
