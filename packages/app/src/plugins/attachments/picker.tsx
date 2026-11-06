import { AttachmentQueryFeedback, AttachmentResultFooter } from "./query-feedback";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Check, ChevronDown, Circle, Eye } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginAttachmentItem, PluginSerializableIcon } from "@getpaseo/plugin";
import type { PluginAttachmentSourceContribution, InstalledPlugin } from "../types";
import type { UserComposerAttachment } from "@/attachments/types";
import type { AttachmentMenuItem } from "@/composer/input/input";
import { AdaptiveModalSheet, FULL_SHEET_SNAP_POINTS } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { PluginIconView } from "../icons";
import { useInstalledPlugins } from "../registry";
import {
  createPluginResourceAttachment,
  togglePluginResourceAttachment,
  pluginResourceIdentity,
  supportsPluginAttachmentSource,
} from "./model";
import { queryPluginAttachments } from "./query";
import { PluginResourcePreview } from "./preview";
import { ResourceBody } from "./resource-body";
import { openAttachmentPicker } from "./picker-model";
import { AttachmentFilterPicker } from "./filter-picker";

const EMPTY_ITEMS: PluginAttachmentItem[] = [];
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
function SourceIcon({ icon, color = "" }: { icon: PluginSerializableIcon; color?: string }) {
  return <PluginIconView icon={icon} size={ICON_SIZE.md} color={color} />;
}
const ThemedSourceIcon = withUnistyles(SourceIcon);
interface InstalledAttachmentSource {
  plugin: InstalledPlugin;
  source: PluginAttachmentSourceContribution;
  key: string;
}
interface PluginAttachmentPickerInput {
  serverId: string;
  client: DaemonClient | null;
  connected: boolean;
  attachments: UserComposerAttachment[];
  onChangeAttachments: (attachments: UserComposerAttachment[]) => void;
  anchorRef: RefObject<View | null>;
}
interface PluginAttachmentPickerBinding {
  menuItems: AttachmentMenuItem[];
  picker: ReactElement | null;
}

function AttachmentPickerEntry(props: {
  active: InstalledAttachmentSource;
  input: PluginAttachmentPickerInput;
  close: () => void;
}) {
  const { t } = useTranslation();
  const header = useMemo(
    () => ({
      title: props.active.plugin.i18n.resolve(
        props.active.source.pickerTitle,
        props.active.plugin.locale,
      ),
    }),
    [props.active],
  );
  // COMPAT(pluginResourceAttachments): added in the next release; remove after 2027-11-06 once the host floor includes it.
  const supported = supportsPluginAttachmentSource(
    props.active.source,
    props.input.client?.getLastServerInfoMessage()?.features,
  );
  if (!supported)
    return (
      <AdaptiveModalSheet
        visible
        onClose={props.close}
        contextBridge={null}
        header={header}
        testID="plugin-attachment-picker"
      >
        <Text style={styles.secondary}>{t("composer.pluginAttachments.updateHost")}</Text>
      </AdaptiveModalSheet>
    );
  return <AttachmentPicker {...props} />;
}

function AttachmentPicker({
  active,
  input,
  close,
}: {
  active: InstalledAttachmentSource;
  input: PluginAttachmentPickerInput;
  close: () => void;
}) {
  const { t } = useTranslation();
  const [model] = useState(openAttachmentPicker);
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState);
  const query = useDebouncedValue(state.query, 250);
  const invoke = useCallback(
    (method: string, rpcInput: unknown) => {
      if (!input.client) throw new Error("Plugin host is offline");
      return input.client.invokePluginRpc(active.plugin.id, method, rpcInput);
    },
    [input.client, active.plugin.id],
  );
  const search = useFetchQuery(
    {
      queryKey: [
        "plugin-attachment-search",
        input.serverId,
        active.plugin.id,
        active.source.id,
        query,
        state.context?.scope,
        state.filters,
        state.cursor,
      ],
      queryFn: ({ signal }) =>
        queryPluginAttachments({
          serverId: input.serverId,
          pluginId: active.plugin.id,
          source: active.source,
          queryClient: active.plugin.queryClient,
          invoke,
          model,
          input: { ...model.searchInput(), query },
          signal,
        }),
      enabled: input.connected,
      dataShape: "value",
      staleTimeMs: 0,
      retry: false,
    },
    active.plugin.queryClient,
  );
  const pending = search.isFetching || state.query !== query;
  const items = pending || search.error ? EMPTY_ITEMS : (search.data?.result.items ?? EMPTY_ITEMS);
  const select = useCallback(
    (item: PluginAttachmentItem) => {
      const attachment = createPluginResourceAttachment(
        {
          pluginId: active.plugin.id,
          sourceId: active.source.id,
          sourceTitle: active.plugin.i18n.resolve(active.source.title, active.plugin.locale),
          sourceIcon: active.source.icon,
        },
        item,
      );
      input.onChangeAttachments(togglePluginResourceAttachment(input.attachments, attachment));
    },
    [active, input],
  );
  const header = useMemo(
    () => ({
      title: active.plugin.i18n.resolve(active.source.pickerTitle, active.plugin.locale),
      search: {
        placeholder: active.plugin.i18n.resolve(
          active.source.searchPlaceholder,
          active.plugin.locale,
        ),
        onChange: model.setQuery,
        autoFocus: true,
      },
    }),
    [active, model],
  );
  const selectedCount = input.attachments.filter(
    (attachment) =>
      attachment.kind === "plugin_resource" &&
      attachment.pluginId === active.plugin.id &&
      attachment.sourceId === active.source.id,
  ).length;
  const footer = useMemo(
    () => (
      <>
        <Text style={styles.secondary}>
          {t("composer.pluginAttachments.selectedCount", { count: selectedCount })}
        </Text>
        <Button variant="default" onPress={close}>
          {t("composer.pluginAttachments.done")}
        </Button>
      </>
    ),
    [close, t, selectedCount],
  );
  const closePreview = useCallback(() => model.preview(null), [model]);
  const result = search.data?.result;
  const next = result?.coverage?.nextCursor;
  const loadMore = useCallback(() => {
    if (next) model.setCursor(next);
  }, [next, model]);
  const { refetch } = search;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const activeFilter = active.source.filters?.find((filter) => filter.id === state.activeFilter);
  return (
    <>
      <AdaptiveModalSheet
        visible
        onClose={close}
        testID="plugin-attachment-picker"
        contextBridge={null}
        header={header}
        footer={footer}
        desktopMaxWidth={720}
        desktopHeight="85%"
        snapPoints={FULL_SHEET_SNAP_POINTS}
        contentStyle={styles.content}
      >
        <View style={styles.filters}>
          {active.source.filters?.map((filter) => (
            <FilterTrigger
              key={filter.id}
              id={filter.id}
              label={active.plugin.i18n.resolve(filter.label, active.plugin.locale)}
              display={state.filters[filter.id]?.label ?? t("composer.pluginAttachments.any")}
              selected={Boolean(state.filters[filter.id])}
              onOpen={model.openFilter}
            />
          ))}
        </View>
        <AttachmentQueryFeedback
          pending={pending}
          error={search.error}
          result={result}
          empty={items.length === 0}
          connected={input.connected}
          onRetry={retry}
        />
        {items.map((item) => (
          <ResultRow
            key={pluginResourceIdentity(item)}
            item={item}
            selected={input.attachments.some(
              (attachment) =>
                attachment.kind === "plugin_resource" &&
                attachment.pluginId === active.plugin.id &&
                attachment.sourceId === active.source.id &&
                pluginResourceIdentity(attachment.item) === pluginResourceIdentity(item),
            )}
            onSelect={select}
            onPreview={model.preview}
          />
        ))}
        {!pending ? <AttachmentResultFooter result={result} onMore={loadMore} /> : null}
      </AdaptiveModalSheet>
      <PluginResourcePreview item={state.preview} onClose={closePreview} />
      {activeFilter ? (
        <AttachmentFilterPicker
          key={`${activeFilter.id}/${state.context?.scope}`}
          filter={activeFilter}
          source={active.source}
          plugin={active.plugin}
          serverId={input.serverId}
          model={model}
          invoke={invoke}
        />
      ) : null}
    </>
  );
}
function FilterTrigger({
  id,
  label,
  display,
  selected,
  onOpen,
}: {
  id: string;
  label: string;
  display: string;
  selected: boolean;
  onOpen: (id: string) => void;
}) {
  const open = useCallback(() => onOpen(id), [id, onOpen]);
  const chevron = useMemo(
    () => <ThemedChevron uniProps={iconColorMapping} size={ICON_SIZE.xs} />,
    [],
  );
  return (
    <Button
      size="sm"
      variant={selected ? "secondary" : "ghost"}
      onPress={open}
      accessibilityLabel={`${label} (${display})`}
      numberOfLines={1}
      style={styles.filter}
      trailing={chevron}
    >
      {selected ? `${label}: ${display}` : label}
    </Button>
  );
}
function ResultRow({
  item,
  selected,
  onSelect,
  onPreview,
}: {
  item: PluginAttachmentItem;
  selected: boolean;
  onSelect: (item: PluginAttachmentItem) => void;
  onPreview: (item: PluginAttachmentItem) => void;
}) {
  const { t } = useTranslation();
  const select = useCallback(() => onSelect(item), [item, onSelect]);
  const preview = useCallback(() => onPreview(item), [item, onPreview]);
  const selectionState = useMemo(() => ({ selected }), [selected]);
  return (
    <View style={styles.row} testID="plugin-attachment-result">
      <View style={styles.rowHeader}>
        <View style={styles.description}>
          <Text style={styles.title}>{item.title}</Text>
          {item.subtitle ? <Text style={styles.secondary}>{item.subtitle}</Text> : null}
        </View>
        <View style={styles.actions}>
          <Button
            variant="ghost"
            leftIcon={Eye}
            accessibilityLabel={t("composer.pluginAttachments.previewItem", {
              item: item.identifier,
            })}
            onPress={preview}
          />
          <Button
            variant={selected ? "secondary" : "ghost"}
            leftIcon={selected ? Check : Circle}
            accessibilityState={selectionState}
            accessibilityLabel={t(
              selected
                ? "composer.pluginAttachments.removeItem"
                : "composer.pluginAttachments.addItem",
              { item: item.identifier },
            )}
            onPress={select}
          />
        </View>
      </View>
      {item.previewText !== undefined || item.previewBlocks ? (
        <View style={styles.messageBody}>
          <ResourceBody item={item} testID="plugin-attachment-original-text" />
        </View>
      ) : null}
    </View>
  );
}
export function usePluginAttachmentPicker(
  input: PluginAttachmentPickerInput,
): PluginAttachmentPickerBinding {
  const { t } = useTranslation();
  const plugins = useInstalledPlugins();
  const sources = useMemo(
    () =>
      plugins
        .filter((plugin) => plugin.serverId === input.serverId)
        .flatMap((plugin) =>
          plugin.attachmentSources.map((source) => ({
            plugin,
            source,
            key: `${plugin.id}/${source.id}`,
          })),
        ),
    [input.serverId, plugins],
  );
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const active = sources.find((candidate) => candidate.key === activeKey);
  const close = useCallback(() => setActiveKey(null), []);
  const menuItems = useMemo(
    () =>
      sources.map(({ key, source, plugin }) => ({
        id: `plugin:${key}`,
        label: t("composer.pluginAttachments.attach", {
          source: plugin.i18n.resolve(source.title, plugin.locale),
        }),
        icon: <ThemedSourceIcon icon={source.icon} uniProps={iconColorMapping} />,
        onSelect: () => setActiveKey(key),
      })),
    [sources, t],
  );
  return {
    menuItems,
    picker: active ? (
      <AttachmentPickerEntry
        key={`${input.serverId}/${active.key}`}
        active={active}
        input={input}
        close={close}
      />
    ) : null,
  };
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[2], paddingVertical: theme.spacing[3] },
  filters: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  filter: { maxWidth: 240 },
  row: {
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  rowHeader: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[3] },
  description: { gap: theme.spacing[1], flex: 1, minWidth: 0 },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  secondary: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  actions: { flexDirection: "row", gap: theme.spacing[1] },
  messageBody: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.6,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
}));
const ThemedChevron = withUnistyles(ChevronDown);
