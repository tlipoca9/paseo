import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { QueryClient } from "@tanstack/react-query";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { ResourceSnapshotReference } from "@getpaseo/protocol/agent-types";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { AdaptiveModalSheet, FULL_SHEET_SNAP_POINTS } from "@/components/adaptive-modal-sheet";
import { AttachmentFrame, AttachmentLabel } from "@/components/attachment-pill";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { openExternalUrl } from "@/utils/open-external-url";
import { readResourceAttachment } from "./snapshot";
import { ResourcePreviewContent } from "./preview";

type Description = ResourceSnapshotReference["items"][number];
interface SnapshotProps {
  serverId: string;
  agentId: string;
  clientMessageId: string;
  reference: ResourceSnapshotReference;
  client: DaemonClient | null | undefined;
}

export function StoredResourceAttachments(props: Partial<SnapshotProps>) {
  const { serverId, agentId, clientMessageId, reference, client } = props;
  if (!serverId || !agentId || !clientMessageId || !reference) return null;
  return (
    <ResourceReferences
      key={`${serverId}:${agentId}:${clientMessageId}`}
      serverId={serverId}
      agentId={agentId}
      clientMessageId={clientMessageId}
      reference={reference}
      client={client}
    />
  );
}

function ReferenceRow({
  item,
  onSelect,
}: {
  item: Description;
  onSelect: (index: number) => void;
}) {
  const open = useCallback(() => {
    if (item.url) void openExternalUrl(item.url);
    else onSelect(item.index);
  }, [item, onSelect]);
  return (
    <View style={styles.reference}>
      <AttachmentFrame
        testID={item.kind === "local" ? "message-local-resource" : "message-web-resource"}
        accessibilityLabel={item.title}
        onPress={open}
      >
        <AttachmentLabel title={item.title} subtitle={item.sourceLabel} />
      </AttachmentFrame>
    </View>
  );
}

function ResourceReferences(props: SnapshotProps) {
  const { t } = useTranslation();
  const [index, setIndex] = useState<number | null>(null);
  const close = useCallback(() => setIndex(null), []);
  const more = useCallback(
    () => setIndex(props.reference.items.length),
    [props.reference.items.length],
  );
  return (
    <>
      <View style={styles.references}>
        {props.reference.items.map((item) => (
          <ReferenceRow key={item.index} item={item} onSelect={setIndex} />
        ))}
        {props.reference.count > props.reference.items.length ? (
          <Button variant="ghost" onPress={more}>
            {t("composer.pluginAttachments.moreReferences", {
              count: props.reference.count - props.reference.items.length,
            })}
          </Button>
        ) : null}
      </View>
      {index !== null ? (
        <StoredResourcePreview {...props} index={index} onIndex={setIndex} onClose={close} />
      ) : null}
    </>
  );
}

const connectionIds = new WeakMap<DaemonClient, number>();
let nextConnectionId = 1;
function snapshotConnectionId(client: SnapshotProps["client"]) {
  if (!client) return 0;
  const existing = connectionIds.get(client);
  if (existing !== undefined) return existing;
  const id = nextConnectionId++;
  connectionIds.set(client, id);
  return id;
}

function useSnapshotPreview(
  client: SnapshotProps["client"],
  request: { serverId: string; agentId: string; clientMessageId: string; index: number },
) {
  // Connection ownership and cache lifetime are the same as the mounted preview.
  const [cache] = useState(() => new QueryClient());
  const supported =
    client?.getLastServerInfoMessage()?.features?.pluginResourceAttachments === true;
  const query = useFetchQuery(
    {
      queryKey: [
        "resource-snapshot",
        snapshotConnectionId(client),
        request.serverId,
        request.agentId,
        request.clientMessageId,
        request.index,
      ],
      dataShape: "value",
      staleTimeMs: 30000,
      gcTime: 0,
      retry: false,
      enabled: Boolean(client && supported),
      queryFn: ({ signal }) => {
        if (!client) throw new Error("Host connection unavailable");
        const connection = client;
        return readResourceAttachment({
          request,
          read: (input) => connection.readResourceSnapshotChunk(input),
          signal,
          sha256: (text) => digestStringAsync(CryptoDigestAlgorithm.SHA256, text),
        });
      },
    },
    cache,
  );
  return { query, supported };
}

type PreviewState = ReturnType<typeof useSnapshotPreview>;
function SnapshotBody({ client, query, supported }: PreviewState & Pick<SnapshotProps, "client">) {
  const { t } = useTranslation();
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const attachment = query.data;
  const web = attachment?.externalResource;
  const previewItem = useMemo(
    () => ({
      title: attachment?.localResource?.title ?? attachment?.externalResource?.title ?? "",
      text: attachment?.text ?? "",
      previewText: attachment?.localResource?.previewText,
      source: attachment?.localResource?.source,
    }),
    [attachment],
  );
  const openWebsite = useCallback(() => {
    if (web) void openExternalUrl(web.url);
  }, [web]);
  if (!client)
    return <Text style={styles.body}>{t("composer.pluginAttachments.previewOffline")}</Text>;
  if (!supported)
    return <Text style={styles.body}>{t("composer.pluginAttachments.updateHost")}</Text>;
  if (query.isPending)
    return <Text style={styles.body}>{t("composer.pluginAttachments.loadingPreview")}</Text>;
  if (query.error)
    return (
      <>
        <Text style={styles.body}>{t("composer.pluginAttachments.previewFailed")}</Text>
        <Text style={styles.source}>{query.error.message}</Text>
        <Button onPress={retry}>{t("composer.pluginAttachments.retry")}</Button>
      </>
    );
  if (!attachment) return null;
  const local = attachment.localResource;
  return (
    <>
      <ResourcePreviewContent key={local?.source.ref ?? web?.url} item={previewItem} />
      {web ? (
        <Button onPress={openWebsite}>{t("composer.pluginAttachments.openWebsite")}</Button>
      ) : null}
    </>
  );
}

function StoredResourcePreview({
  client,
  serverId,
  agentId,
  clientMessageId,
  reference,
  index,
  onIndex,
  onClose,
}: SnapshotProps & { index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const state = useSnapshotPreview(client, { serverId, agentId, clientMessageId, index });
  const attachment = state.query.data;
  const local = attachment?.localResource;
  const web = attachment?.externalResource;
  const header = useMemo(
    () => ({
      title:
        local?.title ??
        web?.title ??
        reference.items.find((item) => item.index === index)?.title ??
        t("composer.pluginAttachments.referenceNumber", {
          index: index + 1,
          count: reference.count,
        }),
    }),
    [local?.title, web?.title, reference, index, t],
  );
  const previous = useCallback(() => onIndex(index - 1), [onIndex, index]);
  const next = useCallback(() => onIndex(index + 1), [onIndex, index]);
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={onClose}
      testID="plugin-resource-preview"
      contextBridge={null}
      desktopMaxWidth={720}
      snapPoints={FULL_SHEET_SNAP_POINTS}
    >
      {reference.count > 1 ? (
        <View style={styles.navigation} testID="resource-preview-navigation">
          <Button variant="ghost" disabled={index === 0} onPress={previous}>
            {t("composer.pluginAttachments.previousReference")}
          </Button>
          <Text style={styles.source}>
            {t("composer.pluginAttachments.referenceNumber", {
              index: index + 1,
              count: reference.count,
            })}
          </Text>
          <Button variant="ghost" disabled={index + 1 === reference.count} onPress={next}>
            {t("composer.pluginAttachments.nextReference")}
          </Button>
        </View>
      ) : null}
      <SnapshotBody {...state} client={client} />
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  references: { gap: theme.spacing[2] },
  reference: { gap: theme.spacing[1] },
  navigation: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  body: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.5,
  },
  source: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
