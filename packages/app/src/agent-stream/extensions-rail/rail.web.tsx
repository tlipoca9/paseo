import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronRight, PanelRightClose, PanelRightOpen } from "lucide-react-native";
import type { AgentExtensionSkill, AgentExtensionSkillScope } from "@getpaseo/protocol/messages";
import { useChatExtensionsRailWidth } from "@/chat-rail";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { extractSessionExtensionActivity } from "./activity";
import { EXTENSIONS_RAIL_RIGHT_INSET } from "./geometry";
import type { AgentExtensionsRailProps } from "./rail";
import {
  StatusDot,
  SystemMonitorSection,
  ensureRailMotionStyles,
} from "./system-monitor.web";
import { useAgentExtensionsQuery } from "./use-agent-extensions";
import {
  formatBytesCompact,
  getWorstServiceStatus,
  useSystemHealth,
} from "./use-system-health";

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
  // Default MCP and Skills to collapsed so system status stays primary and uncluttered.
  const [mcpExpanded, setMcpExpanded] = useState(false);
  const [skillsExpanded, setSkillsExpanded] = useState(false);

  useEffect(() => {
    ensureRailMotionStyles();
  }, []);

  const visible = railWidth > 0 && Boolean(serverId) && Boolean(agentId);
  const { data } = useAgentExtensionsQuery({
    serverId,
    agentId,
    enabled: visible,
  });
  const systemHealth = useSystemHealth(visible);

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

  const totalExtensions = data.mcpServers.length + data.skills.length;
  const hasSystemSnapshot = systemHealth.snapshot !== null;
  if (totalExtensions === 0 && !hasSystemSnapshot) return null;

  const overallServiceStatus = hasSystemSnapshot
    ? getWorstServiceStatus(systemHealth.snapshot!.services)
    : "ok";

  const usedMcpCount = activity.usedMcpServers.size;
  const usedSkillCount = activity.usedSkills.size;

  if (collapsed) {
    const pillLabel = hasSystemSnapshot
      ? `CPU ${systemHealth.snapshot!.cpu.percent}%${
          systemHealth.snapshot!.disk
            ? ` · ${formatBytesCompact(systemHealth.snapshot!.disk.freeBytes)}`
            : ""
        }`
      : `MCP ${data.mcpServers.length} · Skills ${data.skills.length}`;

    return (
      <View
        style={styles.collapsedContainer}
        pointerEvents="box-none"
        testID="agent-extensions-rail"
      >
        <div className="paseo-rail-pill" style={{ borderRadius: 9999 }}>
          <Pressable
            style={styles.collapsedPill}
            onPress={handleToggleCollapsed}
            accessibilityRole="button"
            accessibilityLabel="Expand status and extensions panel"
            testID="agent-extensions-rail-expand"
          >
            {hasSystemSnapshot ? (
              <StatusDot status={overallServiceStatus} />
            ) : (
              <PanelRightOpen size={12} color={theme.colors.foregroundExtraMuted} />
            )}
            <Text style={styles.collapsedPillText} numberOfLines={1}>
              <span className="paseo-rail-tabular">{pillLabel}</span>
            </Text>
          </Pressable>
        </div>
      </View>
    );
  }

  return (
    <View
      style={[styles.rail, inlineUnistylesStyle({ width: railWidth })]}
      pointerEvents="box-none"
      testID="agent-extensions-rail"
    >
      <div className="paseo-rail-panel" style={{ maxHeight: "100%", borderRadius: 10 }}>
        <View style={styles.panel}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              {hasSystemSnapshot ? <StatusDot status={overallServiceStatus} /> : null}
              <Text style={styles.headerTitle} numberOfLines={1}>
                {hasSystemSnapshot ? "Status" : "MCP & Skills"}
              </Text>
            </View>
            <Pressable
              style={styles.collapseButton}
              onPress={handleToggleCollapsed}
              accessibilityRole="button"
              accessibilityLabel="Collapse status and extensions panel"
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
            {hasSystemSnapshot ? (
              <SystemMonitorSection
                snapshot={systemHealth.snapshot!}
                cpuHistory={systemHealth.cpuHistory}
              />
            ) : null}

            {hasSystemSnapshot && totalExtensions > 0 ? <View style={styles.divider} /> : null}

            {totalExtensions > 0 ? (
              <View style={styles.extensionsBlock}>
                {data.mcpServers.length > 0 ? (
                  <View style={styles.section} testID="agent-extensions-mcp-section">
                    <div className="paseo-rail-row-hover">
                      <Pressable
                        style={styles.sectionHeader}
                        onPress={handleToggleMcp}
                        accessibilityRole="button"
                        testID="agent-extensions-mcp-toggle"
                      >
                        <View style={styles.sectionHeaderLeft}>
                          <span
                            className="paseo-rail-chevron"
                            data-open={mcpExpanded ? "true" : "false"}
                          >
                            <ChevronRight size={11} color={theme.colors.foregroundExtraMuted} />
                          </span>
                          <Text style={styles.sectionTitle}>MCP</Text>
                        </View>
                        <View style={styles.countGroup}>
                          {usedMcpCount > 0 ? (
                            <Text style={styles.usedCount}>
                              <span className="paseo-rail-tabular">{usedMcpCount}/</span>
                            </Text>
                          ) : null}
                          <Text style={styles.sectionCount}>
                            <span className="paseo-rail-tabular">{data.mcpServers.length}</span>
                          </Text>
                        </View>
                      </Pressable>
                    </div>

                    <div
                      className="paseo-rail-accordion"
                      data-open={mcpExpanded ? "true" : "false"}
                    >
                      <div className="paseo-rail-accordion-inner">
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
                      </div>
                    </div>
                  </View>
                ) : null}

                {skillGroups.length > 0 ? (
                  <View style={styles.section} testID="agent-extensions-skills-section">
                    <div className="paseo-rail-row-hover">
                      <Pressable
                        style={styles.sectionHeader}
                        onPress={handleToggleSkills}
                        accessibilityRole="button"
                        testID="agent-extensions-skills-toggle"
                      >
                        <View style={styles.sectionHeaderLeft}>
                          <span
                            className="paseo-rail-chevron"
                            data-open={skillsExpanded ? "true" : "false"}
                          >
                            <ChevronRight size={11} color={theme.colors.foregroundExtraMuted} />
                          </span>
                          <Text style={styles.sectionTitle}>Skills</Text>
                        </View>
                        <View style={styles.countGroup}>
                          {usedSkillCount > 0 ? (
                            <Text style={styles.usedCount}>
                              <span className="paseo-rail-tabular">{usedSkillCount}/</span>
                            </Text>
                          ) : null}
                          <Text style={styles.sectionCount}>
                            <span className="paseo-rail-tabular">{data.skills.length}</span>
                          </Text>
                        </View>
                      </Pressable>
                    </div>

                    <div
                      className="paseo-rail-accordion"
                      data-open={skillsExpanded ? "true" : "false"}
                    >
                      <div className="paseo-rail-accordion-inner">
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
                      </div>
                    </div>
                  </View>
                ) : null}
              </View>
            ) : null}
          </ScrollView>
        </View>
      </div>
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
    opacity: 0.94,
    shadowColor: "#000000",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
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
    gap: 6,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    opacity: 0.88,
    shadowColor: "#000000",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  collapsedPillText: {
    fontSize: 10.5,
    fontWeight: "500",
    color: theme.colors.foregroundMuted,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[1],
    paddingBottom: theme.spacing[1],
    marginBottom: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
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
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: 2,
    opacity: 0.7,
  },
  extensionsBlock: {
    gap: theme.spacing[1],
  },
  section: {
    gap: 2,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    gap: 5,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 3,
  },
  sectionHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
  countGroup: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: "auto",
  },
  usedCount: {
    fontSize: 10,
    fontWeight: "600",
    color: theme.colors.success,
  },
  sectionCount: {
    fontSize: 10,
    color: theme.colors.foregroundExtraMuted,
  },
  itemList: {
    gap: 2,
    paddingTop: 2,
    paddingBottom: 4,
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
    paddingTop: 2,
    paddingBottom: 4,
  },
  skillGroup: {
    gap: 2,
  },
  groupLabel: {
    fontSize: 9.5,
    fontWeight: "500",
    color: theme.colors.foregroundExtraMuted,
    paddingHorizontal: theme.spacing[1],
    paddingTop: 2,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
}));
