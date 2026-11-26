import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import React, { memo, type ComponentType, useMemo } from "react";
import { Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import type { PluginTimelineStreamItem } from "@/types/stream";
import { useInstalledPlugin } from "../registry";
import { PluginInstallationProvider } from "../installation-provider";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import { resolvePluginPlatform } from "../platform";

const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

function TimelineItemUnavailable() {
  return <Text style={styles.unavailable}>Plugin timeline item unavailable.</Text>;
}

function parseRendererData(
  renderer:
    | { schema: { safeParse(value: unknown): { success: boolean; data?: unknown } } }
    | undefined,
  data: unknown,
) {
  if (!renderer) return null;
  try {
    const parsed = renderer.schema.safeParse(data);
    return parsed.success ? parsed : null;
  } catch (error) {
    console.warn("[Plugins] Timeline renderer schema failed", error);
    return null;
  }
}

const PluginTimelineItemBody = memo(function PluginTimelineItemBody({
  agentId,
  item,
  serverId,
  theme,
}: {
  agentId: string;
  item: PluginTimelineStreamItem;
  serverId: string;
  theme: PluginTheme;
}) {
  const plugin = useInstalledPlugin(serverId, item.pluginId);
  const renderer = useMemo(
    () =>
      plugin?.timelineRenderers.find(
        (candidate) => candidate.kind === item.itemKind && candidate.version === item.version,
      ),
    [plugin, item.itemKind, item.version],
  );
  const parsed = useMemo(() => parseRendererData(renderer, item.data), [renderer, item.data]);
  const client = useHostRuntimeClient(serverId);
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [hostLabel, serverId]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const pluginItem = useMemo(
    () =>
      parsed
        ? {
            type: "plugin" as const,
            kind: item.itemKind,
            version: item.version,
            data: parsed.data,
          }
        : null,
    [item.itemKind, item.version, parsed],
  );

  if (!plugin || !renderer || !pluginItem || !client) {
    return <TimelineItemUnavailable />;
  }

  const Component = renderer.Component as ComponentType<PluginTimelineItemProps>;
  const props: PluginTimelineItemProps = {
    agentId,
    theme,
    host,
    layout,
    timestamp: item.timestamp,
    item: pluginItem,
  };
  return (
    <SurfaceErrorBoundary installation={plugin} resetKey={item.data} Surface={Component}>
      <PluginInstallationProvider plugin={plugin}>
        <Component {...props} />
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
});

const ThemedPluginTimelineItemBody = withUnistyles(PluginTimelineItemBody);

export const PluginTimelineItemView = memo(function PluginTimelineItemView(props: {
  agentId: string;
  item: PluginTimelineStreamItem;
  serverId: string;
}) {
  return <ThemedPluginTimelineItemBody {...props} uniProps={pluginThemeMapping} />;
});

const styles = StyleSheet.create((theme) => ({
  unavailable: {
    color: theme.colors.foregroundMuted,
    paddingVertical: theme.spacing[2],
  },
}));
