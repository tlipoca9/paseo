import type { StreamItem } from "@/types/stream";

export interface AgentExtensionsRailProps {
  serverId: string | null;
  agentId: string | undefined;
  streamItems: readonly StreamItem[];
}

/**
 * Native stub: the right-margin extensions rail is a wide-screen web affordance.
 * Mobile and narrow screens never render it.
 */
export function AgentExtensionsRail(_props: AgentExtensionsRailProps) {
  return null;
}
