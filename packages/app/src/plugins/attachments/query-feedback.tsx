import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { PluginAttachmentSearchPayload } from "@getpaseo/plugin";
import { Button } from "@/components/ui/button";

type ResultMetadata = Pick<
  PluginAttachmentSearchPayload,
  "coverage" | "index" | "status" | "error"
>;
export function AttachmentQueryFeedback({
  pending,
  error,
  result,
  empty,
  connected = true,
  onRetry,
}: {
  pending: boolean;
  error: Error | null;
  result?: ResultMetadata;
  empty: boolean;
  connected?: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (!connected) return <Text style={styles.text}>{t("composer.pluginAttachments.offline")}</Text>;
  if (pending) return <Text style={styles.text}>{t("composer.pluginAttachments.searching")}</Text>;
  const status = result?.status ?? "ready";
  if (error || status !== "ready")
    return (
      <>
        <Text style={styles.text}>
          {status === "ready"
            ? t("composer.pluginAttachments.error")
            : t(`composer.pluginAttachments.${status}`)}
        </Text>
        <Text style={styles.text}>{error?.message ?? result?.error?.message}</Text>
        <Button variant="outline" onPress={onRetry}>
          {t("composer.pluginAttachments.retry")}
        </Button>
      </>
    );
  if (empty) return <Text style={styles.text}>{t("composer.pluginAttachments.empty")}</Text>;
  return null;
}
export function AttachmentResultFooter({
  result,
  onMore,
}: {
  result?: ResultMetadata;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  const [details, setDetails] = useState(false);
  const toggleDetails = useCallback(() => setDetails((value) => !value), []);
  const detailsState = useMemo(() => ({ expanded: details }), [details]);
  return (
    <View style={styles.footer}>
      {result?.coverage?.truncated ? (
        <Text style={styles.text}>{t("composer.pluginAttachments.truncated")}</Text>
      ) : null}
      {result?.coverage?.nextCursor ? (
        <Button variant="ghost" onPress={onMore}>
          {t("composer.pluginAttachments.loadMore")}
        </Button>
      ) : null}
      {result?.index ? (
        <Button
          variant="ghost"
          size="sm"
          style={styles.details}
          onPress={toggleDetails}
          accessibilityState={detailsState}
          leftIcon={details ? ChevronUp : ChevronDown}
        >
          {t("composer.pluginAttachments.searchDetails")}
        </Button>
      ) : null}
      {details && result?.index?.syncing ? (
        <Text style={styles.text}>{t("composer.pluginAttachments.syncing")}</Text>
      ) : null}
      {details && result?.index?.lastSuccessAt ? (
        <Text style={styles.text}>
          {t("composer.pluginAttachments.updatedAt", { time: result.index.lastSuccessAt })}
        </Text>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  footer: { gap: theme.spacing[2], paddingVertical: theme.spacing[3] },
  details: { alignSelf: "flex-start" },
}));
