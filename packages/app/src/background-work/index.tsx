import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ArrowUpRight } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ComposerTrackMark, ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { LiveElapsed } from "@/components/message";
import { Button } from "@/components/ui/button";
import type { PaseoAgentBackgroundWorkItem } from "@getpaseo/client";
import {
  filterDuplicateActiveTools,
  type ActiveToolWorkItem,
} from "./active-tools";
import { createHostBackgroundWorkModel } from "./host";
import { backgroundWorkText, formatActiveWorkPillSummary } from "./presentation";
export { createHostBackgroundWorkModel } from "./host";
export {
  areActiveToolWorkItemsEqual,
  extractActiveToolCalls,
  type ActiveToolWorkItem,
} from "./active-tools";

const EMPTY_ACTIVE_TOOLS: readonly ActiveToolWorkItem[] = [];

function kindKey(kind: string): "shell" | "monitor" | "heartbeat" | "other" {
  if (kind === "shell" || kind === "monitor" || kind === "heartbeat") return kind;
  return "other";
}

export function BackgroundWorkTrack({
  model,
  count,
  activeTools = EMPTY_ACTIVE_TOOLS,
  onJumpToMessage,
}: {
  model: ReturnType<typeof createHostBackgroundWorkModel>;
  count: number;
  activeTools?: readonly ActiveToolWorkItem[];
  onJumpToMessage?: (messageId: string) => void;
}) {
  const { t } = useTranslation();
  const { items, status, stops } = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  );
  const missing = Object.values(stops ?? {}).filter(
    (entry) => !items?.some((item) => item.stopToken === entry.item.stopToken),
  );
  const rows = [...(items ?? []), ...missing.map((entry) => entry.item)];
  const runningTools = useMemo(
    () => filterDuplicateActiveTools(activeTools, items),
    [activeTools, items],
  );
  const hasNativeBackgroundWork = count > 0 || rows.length > 0;
  const nativeVisibleCount = items?.length || count;
  const totalCount = nativeVisibleCount + runningTools.length;

  if (totalCount === 0 && rows.length === 0) return null;

  const fallbackLabel =
    totalCount === 1
      ? t("message.backgroundWork.pillOne")
      : t("message.backgroundWork.pillMany", { count: totalCount });

  let leadTitle: string | null = null;
  if (items && items.length > 0) {
    const leadItem = items[0]!;
    leadTitle = backgroundWorkText(
      leadItem,
      t(`message.backgroundWork.${kindKey(leadItem.kind)}`),
    ).title;
  } else if (runningTools.length > 0) {
    leadTitle = runningTools[0]!.title;
  }

  const pillText = formatActiveWorkPillSummary({
    count: totalCount,
    leadTitle,
    fallbackLabel,
  });

  return (
    <ComposerTrackPill
      testID="background-work"
      panelTitle={t("message.backgroundWork.title")}
      accessibilityLabel={leadTitle ? `${fallbackLabel}: ${leadTitle}` : fallbackLabel}
      segments={[
        {
          bucket: "running",
          text: pillText,
        },
      ]}
    >
      {hasNativeBackgroundWork && (status === "loading" || status === "stale") ? (
        <ComposerTrackRow>
          <Text style={styles.facts}>{t("message.backgroundWork.waiting")}</Text>
        </ComposerTrackRow>
      ) : null}
      {hasNativeBackgroundWork && status === "error" ? (
        <>
          <ComposerTrackRow>
            <Text style={styles.facts}>{t("message.backgroundWork.error")}</Text>
          </ComposerTrackRow>
          <ComposerTrackRow
            onPress={model.retry}
            closeOnSelect={false}
            accessibilityLabel={t("message.backgroundWork.retry")}
          >
            <Text style={styles.title}>{t("message.backgroundWork.retry")}</Text>
          </ComposerTrackRow>
        </>
      ) : null}
      {rows.map((item) => (
        <BackgroundWorkRow
          key={item.stopToken ?? item.id}
          item={item}
          model={model}
          live={Boolean(items?.some((entry) => entry.stopToken === item.stopToken))}
          ready={status === "ready"}
          stopStatus={stops?.[item.stopToken ?? ""]?.status}
        />
      ))}
      {runningTools.map((tool) => (
        <ActiveToolRow key={tool.id} item={tool} onJumpToMessage={onJumpToMessage} />
      ))}
    </ComposerTrackPill>
  );
}

function ActiveToolRow({
  item,
  onJumpToMessage,
}: {
  item: ActiveToolWorkItem;
  onJumpToMessage?: (messageId: string) => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const kind = t(`message.backgroundWork.${item.kind === "shell" ? "shell" : "other"}`);
  const handlePress = useMemo(
    () => (onJumpToMessage ? () => onJumpToMessage(item.messageId) : undefined),
    [item.messageId, onJumpToMessage],
  );

  return (
    <ComposerTrackRow
      onPress={handlePress}
      closeOnSelect
      accessibilityLabel={item.title}
      testID={`active-tool-row-${item.id}`}
    >
      <ComposerTrackMark bucket="running" />
      <View style={styles.row}>
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
        {item.command ? (
          <Text style={styles.facts} numberOfLines={1}>
            {item.command}
          </Text>
        ) : null}
        <Text style={styles.facts}>
          {kind} · <LiveElapsed startedAt={item.startedAt} active style={styles.facts} />
        </Text>
      </View>
      {handlePress ? (
        <ArrowUpRight size={14} color={theme.colors.foregroundMuted} strokeWidth={2} />
      ) : null}
    </ComposerTrackRow>
  );
}

function BackgroundWorkRow({
  item,
  model,
  live,
  ready,
  stopStatus,
}: {
  item: PaseoAgentBackgroundWorkItem;
  model: ReturnType<typeof createHostBackgroundWorkModel>;
  live: boolean;
  ready: boolean;
  stopStatus?: "pending" | "error";
}) {
  const { t } = useTranslation();
  const kind = t(`message.backgroundWork.${kindKey(item.kind)}`);
  const stop = useCallback(() => {
    void model.stopItem(item);
  }, [model, item]);
  const dismiss = useCallback(
    () => model.dismissStop(item.stopToken ?? ""),
    [model, item.stopToken],
  );
  let detail = t("message.backgroundWork.notRunning");
  if (stopStatus === "pending") detail = t("message.backgroundWork.stopping");
  const { title, command } = backgroundWorkText(item, kind);
  const action = item.canStop && ready && live;
  const label =
    stopStatus === "pending"
      ? t("message.backgroundWork.stopping")
      : t("message.backgroundWork.stop");
  return (
    <ComposerTrackRow>
      <View style={styles.row}>
        <Text style={styles.title}>{title}</Text>
        {command ? <Text style={styles.facts}>{command}</Text> : null}
        <Text style={styles.facts}>
          {kind} ·{" "}
          {live ? (
            <LiveElapsed startedAt={new Date(item.startedAt)} active style={styles.facts} />
          ) : (
            detail
          )}
        </Text>
        {stopStatus === "error" ? (
          <Text style={styles.facts}>{t("message.backgroundWork.stopError")}</Text>
        ) : null}
      </View>
      {action ? (
        <Button
          variant="ghost"
          size="sm"
          accessibilityLabel={`${t("message.backgroundWork.stop")} ${title}`}
          disabled={stopStatus === "pending"}
          onPress={stop}
        >
          {label}
        </Button>
      ) : null}
      {!live && stopStatus === "error" ? (
        <Button variant="ghost" size="sm" onPress={dismiss}>
          {t("message.backgroundWork.dismiss")}
        </Button>
      ) : null}
    </ComposerTrackRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 },
  title: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  facts: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
