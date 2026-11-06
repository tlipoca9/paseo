import { useCallback, useMemo, useState } from "react";
import type { PluginAttachmentItem } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, FULL_SHEET_SNAP_POINTS } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { ResourceBody } from "./resource-body";

export type ResourcePreview = Pick<
  PluginAttachmentItem,
  "title" | "text" | "source" | "previewText" | "previewBlocks" | "subtitle"
>;

export function ResourcePreviewContent({ item }: { item: ResourcePreview }) {
  const { t } = useTranslation();
  const [details, setDetails] = useState(false);
  const toggle = useCallback(() => setDetails((value) => !value), []);
  const detailsState = useMemo(() => ({ expanded: details }), [details]);
  return (
    <>
      <ResourceBody item={item} testID="resource-preview-text" />
      {item.source ? (
        <View style={styles.details}>
          <Button
            variant="ghost"
            onPress={toggle}
            accessibilityState={detailsState}
            leftIcon={details ? ChevronUp : ChevronDown}
            style={styles.detailsButton}
          >
            {t("composer.pluginAttachments.referenceDetails")}
          </Button>
          {details ? (
            <View style={styles.detailsContent}>
              <Text selectable style={styles.source}>
                {item.source.label}
              </Text>
              <Text selectable style={styles.source}>
                {t("composer.pluginAttachments.referenceAccount", { account: item.source.scope })}
              </Text>
              <Text selectable style={styles.source}>
                {item.source.ref}
              </Text>
              {item.previewText !== undefined ? (
                <Text selectable style={styles.source}>
                  {item.text}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

export function PluginResourcePreview({
  item,
  onClose,
}: {
  item: ResourcePreview | null;
  onClose: () => void;
}) {
  const header = useMemo(
    () => ({
      title: item?.title ?? "",
      subtitle: item?.subtitle ? <Text style={styles.source}>{item.subtitle}</Text> : undefined,
    }),
    [item?.title, item?.subtitle],
  );
  if (!item) return null;
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      testID="plugin-resource-preview"
      contextBridge={null}
      desktopMaxWidth={720}
      snapPoints={FULL_SHEET_SNAP_POINTS}
    >
      <ResourcePreviewContent key={item.source?.ref ?? item.title} item={item} />
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  details: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.surface2,
    paddingTop: theme.spacing[3],
    gap: theme.spacing[3],
  },
  detailsButton: { alignSelf: "flex-start" },
  detailsContent: { gap: theme.spacing[2] },
  source: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
