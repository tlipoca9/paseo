import type { AgentExtensionSkill } from "@getpaseo/protocol/messages";
import type { StreamItem } from "@/types/stream";

export interface SessionExtensionActivity {
  usedMcpServers: ReadonlySet<string>;
  usedSkills: ReadonlySet<string>;
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function extractMcpServerCandidatesFromToolName(toolName: string): string[] {
  const trimmed = toolName.trim();
  if (!trimmed) return [];

  const candidates: string[] = [];

  // Format 1: mcp__<server>__<tool> (Claude / Codex / Paseo standard)
  const doubleUnderscore = trimmed.match(/^mcp__([^_]+(?:_[^_]+)*)__/i);
  if (doubleUnderscore?.[1]) {
    candidates.push(doubleUnderscore[1]);
  }

  // Format 2: <server>.<tool> (e.g. paseo.create_agent)
  const dotMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\.[a-zA-Z0-9_-]+$/);
  if (dotMatch?.[1]) {
    candidates.push(dotMatch[1]);
  }

  return candidates;
}

function extractServerFromLazyMcpCall(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["ServerName", "serverName", "server"]) {
    const val = record[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }
  return null;
}

function extractFilePathsFromToolCall(item: Extract<StreamItem, { kind: "tool_call" }>): string[] {
  if (item.payload.source !== "agent") return [];
  const { detail } = item.payload.data;
  if (detail.type === "read" && detail.filePath) {
    return [detail.filePath];
  }
  if (detail.type === "unknown" && typeof detail.input === "object" && detail.input !== null) {
    const record = detail.input as Record<string, unknown>;
    const paths: string[] = [];
    for (const key of ["Path", "path", "filePath", "file_path", "target_file"]) {
      const val = record[key];
      if (typeof val === "string" && val.trim().length > 0) {
        paths.push(val.trim());
      }
    }
    return paths;
  }
  return [];
}

/**
 * Scans the current conversation's stream items to identify which available MCP servers
 * have been called and which available skills have been read or explicitly invoked.
 */
export function extractSessionExtensionActivity(input: {
  items: readonly StreamItem[];
  availableMcpNames: readonly string[];
  availableSkills: readonly AgentExtensionSkill[];
}): SessionExtensionActivity {
  const usedMcpServers = new Set<string>();
  const usedSkills = new Set<string>();

  if (input.items.length === 0) {
    return { usedMcpServers, usedSkills };
  }

  const mcpByNormalized = new Map<string, string>();
  const mcpPrefixMatchers: Array<{ prefix: string; name: string }> = [];
  for (const name of input.availableMcpNames) {
    const normalized = normalizeIdentifier(name);
    if (!normalized) continue;
    mcpByNormalized.set(normalized, name);
    // Antigravity/Gemini flattens MCP tools as `mcp_<server>_<tool>` (with hyphens -> underscores).
    mcpPrefixMatchers.push({ prefix: `mcp_${normalized}_`, name });
    mcpPrefixMatchers.push({ prefix: `mcp__${normalized}__`, name });
  }
  // Match longer prefixes first so `paseo_remote` matches before `paseo`.
  mcpPrefixMatchers.sort((a, b) => b.prefix.length - a.prefix.length);

  const skillByPath = new Map<string, string>();
  const skillByDirSegment = new Map<string, string>();
  const skillByLowerName = new Map<string, string>();
  for (const skill of input.availableSkills) {
    const lowerName = skill.name.toLowerCase();
    skillByLowerName.set(lowerName, skill.name);
    if (skill.path) {
      const normalized = normalizePath(skill.path);
      skillByPath.set(normalized, skill.name);
      const parts = normalized.split("/");
      if (parts.length >= 2 && parts[parts.length - 1]?.toLowerCase() === "skill.md") {
        const dirName = parts[parts.length - 2]?.toLowerCase();
        if (dirName) {
          skillByDirSegment.set(dirName, skill.name);
        }
      }
    }
  }

  for (const item of input.items) {
    if (item.kind === "tool_call" && item.payload.source === "agent") {
      const toolName = item.payload.data.name;
      const lowerToolName = toolName.toLowerCase();

      // 1. Direct MCP tool name matching
      for (const candidate of extractMcpServerCandidatesFromToolName(toolName)) {
        const matched = mcpByNormalized.get(normalizeIdentifier(candidate));
        if (matched) usedMcpServers.add(matched);
      }

      // 2. Prefix matching for `mcp_<server>_<tool>` (e.g. `mcp_paseo_list_agents`)
      const normalizedToolName = lowerToolName.replace(/-/g, "_");
      for (const matcher of mcpPrefixMatchers) {
        if (normalizedToolName.startsWith(matcher.prefix)) {
          usedMcpServers.add(matcher.name);
          break;
        }
      }

      // 3. Lazy MCP call tool (`call_mcp_tool` with `{ ServerName }`)
      if (
        lowerToolName === "call_mcp_tool" &&
        item.payload.data.detail.type === "unknown"
      ) {
        const serverName = extractServerFromLazyMcpCall(item.payload.data.detail.input);
        if (serverName) {
          const matched = mcpByNormalized.get(normalizeIdentifier(serverName));
          if (matched) usedMcpServers.add(matched);
        }
      }

      // 4. Skill file reads (`SKILL.md`)
      for (const rawPath of extractFilePathsFromToolCall(item)) {
        const normalized = normalizePath(rawPath);
        const exactSkill = skillByPath.get(normalized);
        if (exactSkill) {
          usedSkills.add(exactSkill);
          continue;
        }
        if (normalized.toLowerCase().endsWith("/skill.md")) {
          const parts = normalized.split("/");
          const dirName = parts[parts.length - 2]?.toLowerCase();
          if (dirName) {
            const matched = skillByDirSegment.get(dirName) ?? skillByLowerName.get(dirName);
            if (matched) usedSkills.add(matched);
          }
        }
      }
    } else if (item.kind === "user_message" && item.text) {
      // Match explicit `/skill-name` or `$skill-name` invocations in user prompts.
      const mentionRegex = /(?:^|[\s(])[/\$]([a-zA-Z0-9][a-zA-Z0-9._-]*)/g;
      let match: RegExpExecArray | null;
      while ((match = mentionRegex.exec(item.text)) !== null) {
        const token = match[1]?.toLowerCase();
        if (!token) continue;
        const matched = skillByLowerName.get(token);
        if (matched) usedSkills.add(matched);
      }
    }
  }

  return { usedMcpServers, usedSkills };
}
