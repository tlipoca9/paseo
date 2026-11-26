import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { findPaneById, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { requireWorkspaceDirectory } from "@/utils/workspace-directory";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

const DEFAULT_MAX_WORKSPACE_SESSION_REFS = 3;

// Everything the copy actions actually need. Kept narrower than SidebarWorkspaceEntry so the
// command center can build one from the active route selection without a sidebar row.
export interface CopyableWorkspace {
  serverId?: string;
  workspaceId: string;
  workspaceDirectory: string | null | undefined;
  currentBranch: string | null | undefined;
  name?: string | null;
  title?: string | null;
}

export interface SessionReferenceAgent {
  id: string;
  title?: string | null;
  cwd?: string | null;
  workspaceId?: string;
  lastActivityAt?: Date | string | number | null;
  updatedAt?: Date | string | number | null;
  createdAt?: Date | string | number | null;
  archivedAt?: Date | string | null;
  background?: boolean;
  parentAgentId?: string | null;
  labels?: Record<string, string>;
}

function toTimestampMs(value: Date | string | number | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function isInternalAgent(agent: SessionReferenceAgent): boolean {
  const labels = agent.labels;
  if (!labels) return false;
  return (
    labels.internal === "true" ||
    labels["paseo.internal"] === "true" ||
    labels.visibility === "internal" ||
    labels.role === "internal"
  );
}

/**
 * Returns true for primary user sessions in a workspace (excluding archived,
 * background, internal, and subagent sessions).
 */
export function isPrimaryWorkspaceSessionAgent(agent: SessionReferenceAgent): boolean {
  if (agent.archivedAt != null) return false;
  if (agent.background === true) return false;
  if (agent.parentAgentId != null && agent.parentAgentId.trim().length > 0) return false;
  if (isInternalAgent(agent)) return false;
  return true;
}

export function selectWorkspacePrimaryAgents(input: {
  agents: Iterable<SessionReferenceAgent>;
  workspaceId: string;
  cwd?: string | null;
  activeAgentId?: string | null;
  limit?: number;
}): SessionReferenceAgent[] {
  const limit = input.limit ?? DEFAULT_MAX_WORKSPACE_SESSION_REFS;
  const normalizedCwd = input.cwd?.trim() || null;
  const matched: SessionReferenceAgent[] = [];

  for (const agent of input.agents) {
    if (!isPrimaryWorkspaceSessionAgent(agent)) continue;
    const matchesWorkspace =
      agent.workspaceId === input.workspaceId ||
      (!agent.workspaceId && normalizedCwd !== null && agent.cwd?.trim() === normalizedCwd);
    if (!matchesWorkspace) continue;
    matched.push(agent);
  }

  matched.sort((a, b) => {
    if (input.activeAgentId) {
      if (a.id === input.activeAgentId && b.id !== input.activeAgentId) return -1;
      if (b.id === input.activeAgentId && a.id !== input.activeAgentId) return 1;
    }
    const aTime = Math.max(
      toTimestampMs(a.lastActivityAt),
      toTimestampMs(a.updatedAt),
      toTimestampMs(a.createdAt),
    );
    const bTime = Math.max(
      toTimestampMs(b.lastActivityAt),
      toTimestampMs(b.updatedAt),
      toTimestampMs(b.createdAt),
    );
    return bTime - aTime;
  });

  return matched.slice(0, Math.max(0, limit));
}

export function formatWorkspaceSessionReference(input: {
  workspaceId: string;
  workspaceTitle?: string | null;
  cwd?: string | null;
  agents?: readonly Pick<SessionReferenceAgent, "id" | "title">[];
}): string {
  const title = input.workspaceTitle?.trim() || input.workspaceId;
  const meta = [`workspace: ${input.workspaceId}`];
  const cwd = input.cwd?.trim();
  if (cwd) {
    meta.push(`cwd: ${cwd}`);
  }
  const header = `[Paseo 会话引用] ${title} (${meta.join(", ")})`;
  if (!input.agents || input.agents.length === 0) {
    return header;
  }
  const lines = input.agents.map((agent) => {
    const agentTitle = agent.title?.trim() || agent.id;
    return `- ${agentTitle} (agentId: ${agent.id})`;
  });
  return [header, ...lines].join("\n");
}

export function formatAgentSessionReference(input: {
  agentId: string;
  agentTitle?: string | null;
  workspaceTitle?: string | null;
  workspaceId?: string | null;
  cwd?: string | null;
}): string {
  const title = input.agentTitle?.trim() || input.agentId;
  const meta = [`agentId: ${input.agentId}`];
  const workspace = input.workspaceTitle?.trim() || input.workspaceId?.trim();
  if (workspace) {
    meta.push(`workspace: ${workspace}`);
  }
  const cwd = input.cwd?.trim();
  if (cwd) {
    meta.push(`cwd: ${cwd}`);
  }
  return `[Paseo 会话引用] ${title} (${meta.join(", ")})`;
}

function resolveActiveAgentIdForWorkspace(
  serverId: string | undefined,
  workspaceId: string,
): string | null {
  if (!serverId) return null;
  const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (!key) return null;
  const state = useWorkspaceLayoutStore.getState();
  const layout = state.layoutByWorkspace[key];
  if (!layout) return null;
  const focusedPane = findPaneById(layout.root, layout.focusedPaneId);
  const activeTabId = focusedPane?.focusedTabId ?? null;
  if (!activeTabId) return null;
  const activeTab = state.getWorkspaceTabs(key).find((tab) => tab.tabId === activeTabId);
  return activeTab?.target.kind === "agent" ? activeTab.target.agentId : null;
}

export interface WorkspaceClipboardActions {
  copyPath: (workspace: CopyableWorkspace) => void;
  copyBranchName: (workspace: CopyableWorkspace) => void;
  copySessionReference: (
    workspace: CopyableWorkspace,
    options?: { activeAgentId?: string | null },
  ) => void;
}

export function useWorkspaceClipboardActions(): WorkspaceClipboardActions {
  const { t } = useTranslation();
  const toast = useToast();

  const copyPath = useCallback(
    (workspace: CopyableWorkspace) => {
      let copyTargetDirectory: string;
      try {
        copyTargetDirectory = requireWorkspaceDirectory({
          workspaceId: workspace.workspaceId,
          workspaceDirectory: workspace.workspaceDirectory,
        });
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t("sidebar.workspace.toasts.workspacePathUnavailable"),
        );
        return;
      }
      void Clipboard.setStringAsync(copyTargetDirectory);
      toast.copied(t("sidebar.workspace.toasts.pathCopied"));
    },
    [t, toast],
  );

  const copyBranchName = useCallback(
    (workspace: CopyableWorkspace) => {
      if (!workspace.currentBranch) {
        return;
      }
      void Clipboard.setStringAsync(workspace.currentBranch);
      toast.copied(t("sidebar.workspace.toasts.branchNameCopied"));
    },
    [t, toast],
  );

  const copySessionReference = useCallback(
    (workspace: CopyableWorkspace, options?: { activeAgentId?: string | null }) => {
      const session = workspace.serverId
        ? useSessionStore.getState().sessions[workspace.serverId]
        : undefined;
      const descriptor = session?.workspaces.get(workspace.workspaceId);
      const workspaceTitle =
        workspace.title?.trim() ||
        workspace.name?.trim() ||
        descriptor?.title?.trim() ||
        descriptor?.name?.trim() ||
        workspace.workspaceId;
      const cwd = workspace.workspaceDirectory?.trim() || descriptor?.workspaceDirectory?.trim();
      const activeAgentId =
        options?.activeAgentId ??
        resolveActiveAgentIdForWorkspace(workspace.serverId, workspace.workspaceId);
      const agents = session
        ? selectWorkspacePrimaryAgents({
            agents: session.agents.values(),
            workspaceId: workspace.workspaceId,
            cwd,
            activeAgentId,
          })
        : [];
      const text = formatWorkspaceSessionReference({
        workspaceId: workspace.workspaceId,
        workspaceTitle,
        cwd,
        agents,
      });
      void Clipboard.setStringAsync(text);
      toast.copied(t("sidebar.workspace.toasts.sessionReferenceCopied"));
    },
    [t, toast],
  );

  return useMemo(
    () => ({ copyPath, copyBranchName, copySessionReference }),
    [copyBranchName, copyPath, copySessionReference],
  );
}
