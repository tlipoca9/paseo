import { AttachmentQueryFeedback, AttachmentResultFooter } from "./query-feedback";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useFetchQuery } from "@/data/query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type {
  PluginAttachmentFilter,
  PluginAttachmentFilterOption,
  PluginText,
} from "@getpaseo/plugin";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { InstalledPlugin, PluginAttachmentSourceContribution } from "../types";
import { queryPluginAttachmentFilterOptions } from "./query";
import { serializeAttachmentDateTime, type AttachmentPickerModel } from "./picker-model";

interface FilterPickerProps {
  filter: PluginAttachmentFilter<PluginText>;
  source: PluginAttachmentSourceContribution;
  plugin: InstalledPlugin;
  serverId: string;
  model: AttachmentPickerModel;
  invoke: (method: string, input: unknown) => Promise<unknown>;
}

export function AttachmentFilterPicker(props: FilterPickerProps) {
  return props.filter.kind === "datetime" ? (
    <DateFilterPicker {...props} />
  ) : (
    <OptionFilterPicker {...props} />
  );
}

function OptionRow({
  option,
  onSelect,
}: {
  option: PluginAttachmentFilterOption;
  onSelect: (option: PluginAttachmentFilterOption) => void;
}) {
  const select = useCallback(() => onSelect(option), [option, onSelect]);
  return (
    <Button variant="ghost" onPress={select}>
      {option.label}
    </Button>
  );
}

function OptionFilterPicker({
  filter,
  source,
  plugin,
  serverId,
  model,
  invoke,
}: FilterPickerProps) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(model.subscribe, model.getState);
  const query = useDebouncedValue(state.candidateQuery, 250);
  const staticOptions = filter.kind === "select" ? filter.options : undefined;
  const remote = Boolean(source.filterOptions && !staticOptions);
  const close = useCallback(() => model.openFilter(null), [model]);
  const clear = useCallback(() => model.selectFilter(filter.id, null), [model, filter.id]);
  const select = useCallback(
    (option: PluginAttachmentFilterOption) => model.selectFilter(filter.id, option),
    [model, filter.id],
  );
  const options = useFetchQuery(
    {
      queryKey: [
        "plugin-attachment-options",
        serverId,
        plugin.id,
        source.id,
        state.context?.scope,
        filter.id,
        query,
        state.candidateCursor,
        state.previousCandidateCursors,
      ],
      queryFn: ({ signal }) =>
        queryPluginAttachmentFilterOptions({
          serverId,
          pluginId: plugin.id,
          source,
          queryClient: plugin.queryClient,
          invoke,
          signal,
          model,
          input: { filterId: filter.id, query, cursor: state.candidateCursor },
          previousCursors: state.previousCandidateCursors,
        }),
      enabled: remote,
      staleTimeMs: 0,
      dataShape: "value",
      retry: false,
      refetchOnWindowFocus: false,
    },
    plugin.queryClient,
  );
  const pending = query !== state.candidateQuery || (remote && options.isFetching);
  const candidates = useMemo(() => {
    if (pending) return [];
    const local =
      staticOptions?.map((option) => ({
        ...option,
        label: plugin.i18n.resolve(option.label, plugin.locale),
      })) ??
      state.context?.options?.[filter.id] ??
      [];
    const rows = remote
      ? (options.data?.result.items ?? [])
      : local.filter((option) =>
          option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        );
    return [...new Map(rows.map((option) => [option.value, option])).values()];
  }, [pending, staticOptions, plugin, filter.id, state.context, remote, options.data, query]);
  const header = useMemo(
    () => ({
      title: plugin.i18n.resolve(filter.label, plugin.locale),
      search: {
        placeholder: t("composer.pluginAttachments.searchOptions"),
        onChange: model.setCandidateQuery,
        resetKey: state.context?.scope,
      },
    }),
    [plugin, filter, model, state.context?.scope, t],
  );
  const { refetch } = options;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const last = options.data?.result;
  const next = last?.coverage.nextCursor;
  const loadMore = useCallback(() => {
    if (next) model.setCandidateCursor(next);
  }, [next, model]);
  const footer = useMemo(
    () => (
      <Button variant="ghost" onPress={clear}>
        {t("composer.pluginAttachments.clear")}
      </Button>
    ),
    [clear, t],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={close}
      contextBridge={null}
      header={header}
      footer={footer}
      testID="plugin-attachment-filter-options"
    >
      <AttachmentQueryFeedback
        pending={pending}
        error={options.error}
        result={last}
        empty={candidates.length === 0}
        onRetry={retry}
      />
      {candidates.map((option) => (
        <OptionRow key={option.value} option={option} onSelect={select} />
      ))}
      {!pending ? <AttachmentResultFooter result={last} onMore={loadMore} /> : null}
    </AdaptiveModalSheet>
  );
}

function DateFilterPicker({ filter, plugin, model }: FilterPickerProps) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const selected = model.getState().filters[filter.id];
  const [value, setValue] = useState(selected?.label ?? "");
  const serialized = serializeAttachmentDateTime(value);
  const close = useCallback(() => model.openFilter(null), [model]);
  const clear = useCallback(() => model.selectFilter(filter.id, null), [model, filter.id]);
  const apply = useCallback(() => {
    if (serialized) model.selectFilter(filter.id, { value: serialized, label: value });
  }, [model, filter.id, serialized, value]);
  const header = useMemo(
    () => ({ title: plugin.i18n.resolve(filter.label, plugin.locale) }),
    [plugin, filter],
  );
  const boundary = filter.kind === "datetime" ? filter.boundary : "inclusive";
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const error = value && !serialized ? t("composer.pluginAttachments.invalidDate") : null;
  return (
    <AdaptiveModalSheet
      visible
      onClose={close}
      contextBridge={null}
      header={header}
      testID="plugin-attachment-date-filter"
    >
      <Field label={t(`composer.pluginAttachments.${boundary}`)} error={error}>
        <FormTextInput
          initialValue={value}
          onChangeText={setValue}
          accessibilityLabel={header.title}
          placeholder={t("composer.pluginAttachments.datePlaceholder")}
          size={compact ? "md" : "sm"}
        />
      </Field>
      <Text style={styles.secondary}>{t("composer.pluginAttachments.timezone", { zone })}</Text>
      <View style={styles.actions}>
        <Button variant="ghost" onPress={clear}>
          {t("composer.pluginAttachments.clear")}
        </Button>
        <Button onPress={apply} disabled={!serialized}>
          {t("composer.pluginAttachments.apply")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  secondary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", gap: theme.spacing[2], justifyContent: "flex-end" },
}));
