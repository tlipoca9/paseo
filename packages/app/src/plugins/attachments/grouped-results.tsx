import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ArrowLeft, ListFilter, MessagesSquare } from "lucide-react-native";
import type { PluginAttachmentSearchPayload } from "@getpaseo/plugin";
import { Button } from "@/components/ui/button";
import { ScrollView } from "@/components/ui/scroll-view";

type Grouping = NonNullable<PluginAttachmentSearchPayload["grouping"]>;

export function GroupedAttachmentResults({
  grouping,
  pending,
  onGroup,
  filters,
  children,
}: {
  grouping?: Grouping;
  pending: boolean;
  onGroup: (id: string) => void;
  filters: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const compact = width < 760;
  const wide = width >= 1100;
  const [panel, setPanel] = useState<"messages" | "groups" | "filters">("messages");
  const showGroups = useCallback(() => setPanel("groups"), []);
  const showFilters = useCallback(() => setPanel("filters"), []);
  const showMessages = useCallback(() => setPanel("messages"), []);
  const selectGroup = useCallback(
    (id: string) => {
      onGroup(id);
      setPanel("messages");
    },
    [onGroup],
  );
  return (
    <View style={styles.root}>
      {!wide ? (
        <View style={styles.mobileToolbar}>
          {panel !== "messages" ? (
            <Button variant="ghost" leftIcon={ArrowLeft} onPress={showMessages}>
              {t("composer.pluginAttachments.backToResults")}
            </Button>
          ) : (
            <>
              {compact ? (
                <Button variant="ghost" leftIcon={MessagesSquare} onPress={showGroups}>
                  {t("composer.pluginAttachments.conversations")}
                </Button>
              ) : null}
              <Button variant="ghost" leftIcon={ListFilter} onPress={showFilters}>
                {t("composer.pluginAttachments.filters")}
              </Button>
            </>
          )}
        </View>
      ) : null}
      <View style={styles.columns}>
        {!compact || panel === "groups" ? (
          <View style={compact ? styles.main : styles.left}>
            <ConversationGroups grouping={grouping} onSelect={selectGroup} />
          </View>
        ) : null}
        {wide || panel === "messages" ? (
          <View style={styles.main}>
            <GroupHeading grouping={grouping} pending={pending} />
            <ScrollView
              key={grouping?.selectedId}
              style={styles.scroll}
              testID="plugin-attachment-message-list"
            >
              <View style={styles.messages}>{children}</View>
            </ScrollView>
          </View>
        ) : null}
        {wide || panel === "filters" ? (
          <View style={wide ? styles.right : styles.main}>
            <ScrollView style={styles.scroll}>
              <View style={styles.filterList}>{filters}</View>
            </ScrollView>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ConversationGroups({
  grouping,
  onSelect,
}: {
  grouping?: Grouping;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.groupList}>
      <Text style={styles.caption}>
        {t("composer.pluginAttachments.matchingTotal", { count: grouping?.total ?? 0 })}
      </Text>
      {grouping?.groups.map((group) => (
        <ConversationRow
          key={group.id}
          group={group}
          selected={group.id === grouping.selectedId}
          onSelect={onSelect}
        />
      ))}
      {grouping?.truncated ? (
        <Text style={styles.caption}>{t("composer.pluginAttachments.groupsLimited")}</Text>
      ) : null}
    </ScrollView>
  );
}
function GroupHeading({ grouping, pending }: { grouping?: Grouping; pending: boolean }) {
  const { t } = useTranslation();
  const selected = grouping?.groups.find((group) => group.id === grouping.selectedId);
  return (
    <View style={styles.resultHeading}>
      <Text numberOfLines={1} style={styles.heading}>
        {selected?.title ?? grouping?.selectedId ?? t("composer.pluginAttachments.conversations")}
      </Text>
      <Text style={styles.caption}>
        {pending
          ? t("composer.pluginAttachments.searching")
          : t("composer.pluginAttachments.matchingCount", { count: grouping?.selectedTotal ?? 0 })}
      </Text>
    </View>
  );
}
function ConversationRow({
  group,
  selected,
  onSelect,
}: {
  group: Grouping["groups"][number];
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const select = useCallback(() => onSelect(group.id), [onSelect, group.id]);
  const selectionState = useMemo(() => ({ selected }), [selected]);
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      onPress={select}
      style={styles.group}
      accessibilityLabel={t("composer.pluginAttachments.groupLabel", {
        title: group.title,
        count: group.count,
      })}
      accessibilityState={selectionState}
    >
      <View style={styles.groupText}>
        <Text numberOfLines={2} style={styles.groupTitle}>
          {group.title}
        </Text>
        <Text style={styles.caption}>
          {t("composer.pluginAttachments.matchingCount", { count: group.count })}
        </Text>
      </View>
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  columns: { flex: 1, minHeight: 0, flexDirection: "row" },
  mobileToolbar: { flexDirection: "row", gap: theme.spacing[2], paddingBottom: theme.spacing[2] },
  left: { width: 220, borderRightWidth: 1, borderRightColor: theme.colors.border },
  main: { flex: 1, minWidth: 0, minHeight: 0 },
  right: { width: 216, flexShrink: 0, borderLeftWidth: 1, borderLeftColor: theme.colors.border },
  scroll: { flex: 1, minHeight: 0 },
  groupList: {
    paddingRight: theme.spacing[3],
    gap: theme.spacing[2],
    paddingTop: theme.spacing[3],
  },
  group: {
    justifyContent: "flex-start",
    height: "auto",
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[3],
  },
  groupText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  groupTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  heading: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  caption: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  resultHeading: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  messages: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[4] },
  filterList: {
    paddingLeft: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[6],
    gap: theme.spacing[4],
  },
}));
