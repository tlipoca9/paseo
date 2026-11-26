import type { AgentExtensionMcpServer, AgentExtensionSkill } from "@getpaseo/protocol/messages";
import { useShallow } from "zustand/shallow";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export interface AgentExtensionsData {
  mcpServers: AgentExtensionMcpServer[];
  skills: AgentExtensionSkill[];
}

const EMPTY_EXTENSIONS: AgentExtensionsData = Object.freeze({
  mcpServers: [],
  skills: [],
});

interface UseAgentExtensionsQueryOptions {
  serverId: string | null;
  agentId: string | undefined;
  enabled: boolean;
}

export function useAgentExtensionsQuery({
  serverId,
  agentId,
  enabled,
}: UseAgentExtensionsQueryOptions) {
  const retainedPanelActive = useRetainedPanelActive();
  const resolvedServerId = serverId ?? "";
  const client = useHostRuntimeClient(resolvedServerId);
  const isConnected = useHostRuntimeIsConnected(resolvedServerId);

  const { supportsExtensions, provider, cwd } = useSessionStore(
    useShallow((state) => {
      if (!serverId) {
        return { supportsExtensions: false, provider: undefined, cwd: undefined };
      }
      const session = state.sessions[serverId];
      const agent = agentId
        ? (session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId))
        : undefined;
      return {
        supportsExtensions: session?.serverInfo?.features?.agentExtensions === true,
        provider: agent?.provider,
        cwd: agent?.cwd,
      };
    }),
  );

  const queryEnabled =
    enabled &&
    retainedPanelActive &&
    supportsExtensions &&
    Boolean(serverId) &&
    Boolean(agentId) &&
    Boolean(client) &&
    isConnected;

  const query = useFetchQuery<AgentExtensionsData>({
    queryKey: ["agent-extensions", serverId, agentId, provider ?? "", cwd ?? ""],
    queryFn: async () => {
      if (!client || !agentId) {
        return EMPTY_EXTENSIONS;
      }
      const response = await client.listAgentExtensions(agentId);
      if (response.error) {
        throw new Error(response.error);
      }
      return {
        mcpServers: response.mcpServers,
        skills: response.skills,
      };
    },
    enabled: queryEnabled,
    dataShape: "value",
    staleTimeMs: 60_000,
    subscribed: queryEnabled,
    retry: 1,
  });

  return {
    data: query.data ?? EMPTY_EXTENSIONS,
    isLoading: queryEnabled && (query.isPending || query.isLoading),
    isSupported: supportsExtensions,
  };
}
