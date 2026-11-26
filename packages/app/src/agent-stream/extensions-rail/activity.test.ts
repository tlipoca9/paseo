import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem } from "@/types/stream";
import { extractSessionExtensionActivity } from "./activity";

function makeToolCall(id: string, name: string, detail: ToolCallDetail): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: id,
        name,
        status: "completed",
        error: null,
        detail,
      },
    },
  };
}

describe("extractSessionExtensionActivity", () => {
  const availableMcpNames = ["paseo", "zhiyan-log", "firecrawl", "iWiki", "unused-mcp"];
  const availableSkills = [
    {
      name: "paseo-plugins-develop",
      description: "Develop plugins",
      scope: "workspace" as const,
      path: "/repo/.agents/skills/paseo-plugins-develop/SKILL.md",
    },
    {
      name: "git-skills",
      description: "Git workflow",
      scope: "global" as const,
      path: "/home/.agents/skills/git-skills/SKILL.md",
    },
    {
      name: "run-workflow",
      description: "Workflows",
      scope: "builtin" as const,
      path: "/home/.gemini/antigravity-cli/builtin/skills/run-workflow/SKILL.md",
    },
  ];

  it("detects MCP calls across naming conventions and lazy call_mcp_tool", () => {
    const items: StreamItem[] = [
      makeToolCall("1", "mcp__paseo__list_agents", { type: "unknown", input: {}, output: {} }),
      makeToolCall("2", "mcp_zhiyan_log_SearchLog", { type: "unknown", input: {}, output: {} }),
      makeToolCall("3", "call_mcp_tool", {
        type: "unknown",
        input: { ServerName: "iWiki", ToolName: "getDocument" },
        output: {},
      }),
    ];

    const activity = extractSessionExtensionActivity({
      items,
      availableMcpNames,
      availableSkills,
    });

    expect([...activity.usedMcpServers].sort()).toEqual(["iWiki", "paseo", "zhiyan-log"]);
    expect([...activity.usedSkills]).toEqual([]);
  });

  it("detects read SKILL.md files and explicit /skill or $skill user mentions", () => {
    const items: StreamItem[] = [
      makeToolCall("1", "read_file", {
        type: "read",
        filePath: "/repo/.agents/skills/paseo-plugins-develop/SKILL.md",
      }),
      {
        kind: "user_message",
        id: "u1",
        text: "Please follow $git-skills to create this commit",
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ];

    const activity = extractSessionExtensionActivity({
      items,
      availableMcpNames,
      availableSkills,
    });

    expect([...activity.usedMcpServers]).toEqual([]);
    expect([...activity.usedSkills].sort()).toEqual(["git-skills", "paseo-plugins-develop"]);
  });
});
