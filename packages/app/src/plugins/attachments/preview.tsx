import { useMemo } from "react";
import type { PluginAttachmentItem } from "@getpaseo/plugin";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";

export type ResourcePreview = Pick<PluginAttachmentItem, "title" | "text" | "source">;

export function PluginResourcePreview({
  item,
  onClose,
}: {
  item: ResourcePreview | null;
  onClose: () => void;
}) {
  const header = useMemo(() => ({ title: item?.title ?? "" }), [item?.title]);
  if (!item) return null;
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      testID="plugin-resource-preview"
      contextBridge={null}
    >
      <Text selectable style={styles.body}>
        {item.text}
      </Text>
      {item.source ? (
        <Text
          selectable
          style={styles.source}
        >{`${item.source.label}\n${item.source.scope}\n${item.source.ref}`}</Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.5,
  },
  source: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
