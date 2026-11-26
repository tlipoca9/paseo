import { describe, expect, test } from "vitest";
import {
  formatAgentSessionReference,
  formatWorkspaceSessionReference,
  isPrimaryWorkspaceSessionAgent,
  selectWorkspacePrimaryAgents,
  type SessionReferenceAgent,
} from "./use-workspace-clipboard-actions";

function makeAgent(overrides: Partial<SessionReferenceAgent> & { id: string }): SessionReferenceAgent {
  return {
    title: null,
    cwd: "/repo/worktree-1",
    workspaceId: "ws-1",
    lastActivityAt: new Date("2026-11-26T00:00:00.000Z"),
    archivedAt: null,
    background: false,
    parentAgentId: null,
    labels: {},
    ...overrides,
  };
}

describe("use-workspace-clipboard-actions session reference helpers", () => {
  test("filters out background, internal, archived, and subagent sessions", () => {
    expect(isPrimaryWorkspaceSessionAgent(makeAgent({ id: "main-1" }))).toBe(true);
    expect(isPrimaryWorkspaceSessionAgent(makeAgent({ id: "bg-1", background: true }))).toBe(false);
    expect(
      isPrimaryWorkspaceSessionAgent(makeAgent({ id: "sub-1", parentAgentId: "main-1" })),
    ).toBe(false);
    expect(
      isPrimaryWorkspaceSessionAgent(
        makeAgent({ id: "arch-1", archivedAt: new Date("2026-11-25T00:00:00.000Z") }),
      ),
    ).toBe(false);
    expect(
      isPrimaryWorkspaceSessionAgent(makeAgent({ id: "int-1", labels: { internal: "true" } })),
    ).toBe(false);
    expect(
      isPrimaryWorkspaceSessionAgent(
        makeAgent({ id: "int-2", labels: { "paseo.internal": "true" } }),
      ),
    ).toBe(false);
  });

  test("prioritizes active agent then most recently active primary agents up to limit", () => {
    const agents: SessionReferenceAgent[] = [
      makeAgent({
        id: "old",
        title: "Older chat",
        lastActivityAt: new Date("2026-11-25T01:00:00.000Z"),
      }),
      makeAgent({
        id: "newest",
        title: "Newest chat",
        lastActivityAt: new Date("2026-11-26T00:10:00.000Z"),
      }),
      makeAgent({
        id: "mid",
        title: "Mid chat",
        lastActivityAt: new Date("2026-11-26T00:05:00.000Z"),
      }),
      makeAgent({
        id: "active-older",
        title: "Currently selected",
        lastActivityAt: new Date("2026-11-25T02:00:00.000Z"),
      }),
      makeAgent({
        id: "bg",
        title: "Background helper",
        background: true,
        lastActivityAt: new Date("2026-11-26T00:20:00.000Z"),
      }),
      makeAgent({
        id: "sub",
        title: "Subagent",
        parentAgentId: "newest",
        lastActivityAt: new Date("2026-11-26T00:20:00.000Z"),
      }),
      makeAgent({
        id: "other-ws",
        workspaceId: "ws-2",
        title: "Other workspace",
        lastActivityAt: new Date("2026-11-26T00:30:00.000Z"),
      }),
    ];

    const selected = selectWorkspacePrimaryAgents({
      agents,
      workspaceId: "ws-1",
      cwd: "/repo/worktree-1",
      activeAgentId: "active-older",
      limit: 3,
    });

    expect(selected.map((agent) => agent.id)).toEqual(["active-older", "newest", "mid"]);
  });

  test("formats workspace session reference with primary agents", () => {
    const text = formatWorkspaceSessionReference({
      workspaceId: "ws-123",
      workspaceTitle: "paseo-fork",
      cwd: "/Users/me/code/paseo",
      agents: [
        { id: "agent-1", title: "Fix mobile timeline" },
        { id: "agent-2", title: null },
      ],
    });

    expect(text).toBe(
      [
        "[Paseo 会话引用] paseo-fork (workspace: ws-123, cwd: /Users/me/code/paseo)",
        "- Fix mobile timeline (agentId: agent-1)",
        "- agent-2 (agentId: agent-2)",
      ].join("\n"),
    );
  });

  test("formats workspace-only reference when no primary agents exist", () => {
    const text = formatWorkspaceSessionReference({
      workspaceId: "ws-empty",
      workspaceTitle: "sandbox",
      cwd: "/tmp/sandbox",
      agents: [],
    });

    expect(text).toBe("[Paseo 会话引用] sandbox (workspace: ws-empty, cwd: /tmp/sandbox)");
  });

  test("formats single agent tab session reference", () => {
    const text = formatAgentSessionReference({
      agentId: "agent-abc",
      agentTitle: "Implement bottom status bar",
      workspaceTitle: "paseo-fork",
      workspaceId: "ws-123",
      cwd: "/Users/me/code/paseo",
    });

    expect(text).toBe(
      "[Paseo 会话引用] Implement bottom status bar (agentId: agent-abc, workspace: paseo-fork, cwd: /Users/me/code/paseo)",
    );
  });
});
