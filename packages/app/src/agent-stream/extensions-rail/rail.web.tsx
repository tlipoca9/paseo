import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, PanelRightClose, PanelRightOpen } from "lucide-react-native";
import type { AgentExtensionSkill, AgentExtensionSkillScope } from "@getpaseo/protocol/messages";
import { useChatExtensionsRailWidth } from "@/chat-rail";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { extractSessionExtensionActivity } from "./activity";
import { EXTENSIONS_RAIL_RIGHT_INSET } from "./geometry";
import type { AgentExtensionsRailProps } from "./rail";
import { useAgentExtensionsQuery } from "./use-agent-extensions";

const STORAGE_KEY_COLLAPSED = "paseo.agentExtensionsRail.collapsed";

const SKILL_GROUP_ORDER: readonly AgentExtensionSkillScope[] = [
  "workspace",
  "global",
  "builtin",
  "provider",
];

const SKILL_GROUP_LABELS: Record<AgentExtensionSkillScope, string> = {
  workspace: "Workspace",
  global: "Global",
  builtin: "Builtin",
  provider: "Provider",
};

function readInitialCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY_COLLAPSED) === "true";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY_COLLAPSED, collapsed ? "true" : "false");
  } catch {
    // Ignore storage errors (private browsing / quota).
  }
}

export const AgentExtensionsRail = memo(function AgentExtensionsRail({
  serverId,
  agentId,
  streamItems,
}: AgentExtensionsRailProps) {
  const railWidth = useChatExtensionsRailWidth();
  const { theme } = useUnistyles();
  const [collapsed, setCollapsed] = useState<boolean>(readInitialCollapsed);
  const [mcpExpanded, setMcpExpanded] = useState(true);
  const [skillsExpanded, setSkillsExpanded] = useState(true);

  const visible = railWidth > 0 && Boolean(serverId) && Boolean(agentId);
  const { data } = useAgentExtensionsQuery({
    serverId,
    agentId,
    enabled: visible,
  });

  const availableMcpNames = useMemo(
    () => data.mcpServers.map((server) => server.name),
    [data.mcpServers],
  );

  const activity = useMemo(
    () =>
      extractSessionExtensionActivity({
        items: streamItems,
        availableMcpNames,
        availableSkills: data.skills,
      }),
    [availableMcpNames, data.skills, streamItems],
  );

  const skillGroups = useMemo(() => {
    const byScope = new Map<AgentExtensionSkillScope, AgentExtensionSkill[]>();
    for (const skill of data.skills) {
      const bucket = byScope.get(skill.scope);
      if (bucket) {
        bucket.push(skill);
      } else {
        byScope.set(skill.scope, [skill]);
      }
    }
    return SKILL_GROUP_ORDER.map((scope) => ({
      scope,
      label: SKILL_GROUP_LABELS[scope],
      items: byScope.get(scope) ?? [],
    })).filter((group) => group.items.length > 0);
  }, [data.skills]);

  const handleToggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(next);
      return next;
    });
  }, []);

  const handleToggleMcp = useCallback(() => setMcpExpanded((v) => !v), []);
  const handleToggleSkills = useCallback(() => setSkillsExpanded((v) => !v), []);

  if (!visible) return null;

  const totalCount = data.mcpServers.length + data.skills.length;
  if (totalCount === 0) return null;

  if (collapsed) {
    return (
      <View style={styles.collapsedContainer} pointerEvents="box-none" testID="agent-extensions-rail">
        <Pressable
          style={styles.collapsedPill}
          onPress={handleToggleCollapsed}
          accessibilityRole="button"
          accessibilityLabel="Expand MCP and Skills panel"
          testID="agent-extensions-rail-expand"
        >
          <PanelRightOpen size={12} color={theme.colors.foregroundExtraMuted} />
          <Text style={styles.collapsedPillText} numberOfLines={1}>
            MCP {data.mcpServers.length} · Skills {data.skills.length}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View
      style={[styles.rail, inlineUnistylesStyle({ width: railWidth })]}
      pointerEvents="box-none"
      testID="agent-extensions-rail"
    >
      <View style={styles.panel}>
        <View style={styles.header}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            MCP & Skills
          </Text>
          <Pressable
            style={styles.collapseButton}
            onPress={handleToggleCollapsed}
            accessibilityRole="button"
            accessibilityLabel="Collapse MCP and Skills panel"
            testID="agent-extensions-rail-collapse"
          >
            <PanelRightClose size={13} color={theme.colors.foregroundExtraMuted} />
          </Pressable>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {data.mcpServers.length > 0 ? (
            <View style={styles.section} testID="agent-extensions-mcp-section">
              <Pressable
                style={styles.sectionHeader}
                onPress={handleToggleMcp}
                accessibilityRole="button"
              >
                {mcpExpanded ? (
                  <ChevronDown size={11} color={theme.colors.foregroundExtraMuted} />
                ) : (
                  <ChevronRight size={11} color={theme.colors.foregroundExtraMuted} />
                )}
                <Text style={styles.sectionTitle}>MCP</Text>
                <Text style={styles.sectionCount}>{data.mcpServers.length}</Text>
              </Pressable>

              {mcpExpanded ? (
                <View style={styles.itemList}>
                  {data.mcpServers.map((server) => {
                    const isUsed = activity.usedMcpServers.has(server.name);
                    const hasBrowserBadge = server.badges?.includes("browser") === true;
                    const tooltip = [
                      server.name,
                      `source: ${server.source}`,
                      server.transport && server.transport !== "unknown"
                        ? `transport: ${server.transport}`
                        : null,
                      server.detail ? server.detail : null,
                      hasBrowserBadge ? "includes browser_* tools" : null,
                      isUsed ? "used in this session" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ");

                    return (
                      <div key={server.name} title={tooltip}>
                        <View
                          style={styles.itemRow}
                          testID={`agent-extensions-mcp-${server.name}`}
                          dataSet={{ used: isUsed ? "true" : "false" }}
                        >
                          <View style={[styles.dot, isUsed && styles.dotUsed]} />
                          <Text
                            style={[styles.itemName, isUsed && styles.itemNameUsed]}
                            numberOfLines={1}
                          >
                            {server.name}
                          </Text>
                          {hasBrowserBadge ? (
                            <View style={styles.badge}>
                              <Text style={styles.badgeText}>browser</Text>
                            </View>
                          ) : null}
                          {server.source === "plugin" || server.source === "workspace" ? (
                            <Text style={styles.sourceTag} numberOfLines={1}>
                              {server.source}
                            </Text>
                          ) : null}
                        </View>
                      </div>
                    );
                  })}
                </View>
              ) : null}
            </View>
          ) : null}

          {skillGroups.length > 0 ? (
            <View style={styles.section} testID="agent-extensions-skills-section">
              <Pressable
                style={styles.sectionHeader}
                onPress={handleToggleSkills}
                accessibilityRole="button"
              >
                {skillsExpanded ? (
                  <ChevronDown size={11} color={theme.colors.foregroundExtraMuted} />
                ) : (
                  <ChevronRight size={11} color={theme.colors.foregroundExtraMuted} />
                )}
                <Text style={styles.sectionTitle}>Skills</Text>
                <Text style={styles.sectionCount}>{data.skills.length}</Text>
              </Pressable>

              {skillsExpanded ? (
                <View style={styles.skillGroups}>
                  {skillGroups.map((group) => (
                    <View
                      key={group.scope}
                      style={styles.skillGroup}
                      testID={`agent-extensions-skills-${group.scope}`}
                    >
                      <Text style={styles.groupLabel}>{group.label}</Text>
                      <View style={styles.itemList}>
                        {group.items.map((skill) => {
                          const isUsed = activity.usedSkills.has(skill.name);
                          const tooltip = skill.description
                            ? `${skill.name}\n${skill.description}`
                            : skill.name;

                          return (
                            <div key={`${group.scope}:${skill.name}`} title={tooltip}>
                              <View
                                style={styles.itemRow}
                                testID={`agent-extensions-skill-${skill.name}`}
                                dataSet={{ used: isUsed ? "true" : "false" }}
                              >
                                <View style={[styles.dot, isUsed && styles.dotUsed]} />
                                <Text
                                  style={[styles.itemName, isUsed && styles.itemNameUsed]}
                                  numberOfLines={1}
                                >
                                  {skill.name}
                                </Text>
                              </View>
                            </div>
                          );
                        })}
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  rail: {
    position: "absolute",
    right: EXTENSIONS_RAIL_RIGHT_INSET,
    top: theme.spacing[4],
    bottom: theme.spacing[4],
    zIndex: 2,
    justifyContent: "flex-start",
  },
  panel: {
    maxHeight: "100%",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    opacity: 0.92,
  },
  collapsedContainer: {
    position: "absolute",
    right: EXTENSIONS_RAIL_RIGHT_INSET,
    top: theme.spacing[4],
    zIndex: 2,
  },
  collapsedPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    opacity: 0.85,
  },
  collapsedPillText: {
    fontSize: 11,
    color: theme.colors.foregroundExtraMuted,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[1],
    paddingBottom: theme.spacing[1],
    marginBottom: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.3,
    color: theme.colors.foregroundMuted,
  },
  collapseButton: {
    padding: 2,
    borderRadius: theme.borderRadius.sm,
  },
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  scrollContent: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  section: {
    gap: theme.spacing[1],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 2,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
  sectionCount: {
    fontSize: 10,
    color: theme.colors.foregroundExtraMuted,
    marginLeft: "auto",
  },
  itemList: {
    gap: 2,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.borderAccent,
    flexShrink: 0,
  },
  dotUsed: {
    backgroundColor: theme.colors.success,
  },
  itemName: {
    fontSize: 11,
    color: theme.colors.foregroundExtraMuted,
    flexShrink: 1,
    flexGrow: 1,
  },
  itemNameUsed: {
    color: theme.colors.foreground,
    fontWeight: "500",
  },
  badge: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    flexShrink: 0,
  },
  badgeText: {
    fontSize: 9,
    color: theme.colors.foregroundMuted,
  },
  sourceTag: {
    fontSize: 9,
    color: theme.colors.foregroundExtraMuted,
    flexShrink: 0,
  },
  skillGroups: {
    gap: theme.spacing[2],
  },
  skillGroup: {
    gap: 2,
  },
  groupLabel: {
    fontSize: 10,
    fontWeight: "500",
    color: theme.colors.foregroundExtraMuted,
    paddingHorizontal: theme.spacing[1],
    paddingTop: 2,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
}));
