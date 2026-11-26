import { describe, expect, it } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages";

describe("list_agent_extensions message schemas", () => {
  it("parses list_agent_extensions_request", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "list_agent_extensions_request",
      agentId: "agent-1",
      requestId: "req-1",
    });

    expect(parsed).toEqual({
      type: "list_agent_extensions_request",
      agentId: "agent-1",
      requestId: "req-1",
    });
  });

  it("parses list_agent_extensions_response with MCP servers and skills", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "list_agent_extensions_response",
      payload: {
        agentId: "agent-1",
        mcpServers: [
          {
            name: "paseo",
            source: "paseo",
            transport: "http",
            badges: ["browser"],
          },
          {
            name: "firecrawl",
            source: "global",
            transport: "stdio",
          },
        ],
        skills: [
          {
            name: "paseo-plugins-develop",
            description: "Develop Paseo plugins",
            scope: "workspace",
            path: "/repo/.agents/skills/paseo-plugins-develop/SKILL.md",
          },
          {
            name: "run-workflow",
            description: "Run workflow scripts",
            scope: "builtin",
          },
        ],
        error: null,
        requestId: "req-1",
      },
    });

    expect(parsed.type).toBe("list_agent_extensions_response");
    if (parsed.type !== "list_agent_extensions_response") {
      throw new Error("Expected list_agent_extensions_response");
    }
    expect(parsed.payload.mcpServers).toHaveLength(2);
    expect(parsed.payload.skills).toHaveLength(2);
    expect(parsed.payload.error).toBeNull();
  });
});
