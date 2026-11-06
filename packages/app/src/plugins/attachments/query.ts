import type { QueryClient } from "@tanstack/react-query";
import type {
  PluginAttachmentSearchInput,
  PluginAttachmentSearchPayload,
  PluginAttachmentSourceContribution,
  PluginAttachmentFilterOptionsInput,
  PluginText,
} from "@getpaseo/plugin";
import {
  loadPluginAttachmentContext,
  searchPluginAttachments,
  searchPluginAttachmentFilterOptions,
} from "@getpaseo/plugin/client/host";
import type { AttachmentPickerModel } from "./picker-model";

interface AttachmentQueryContext {
  serverId: string;
  pluginId: string;
  source: PluginAttachmentSourceContribution<PluginText>;
  queryClient: QueryClient;
  invoke: (method: string, input: unknown) => Promise<unknown>;
  signal?: AbortSignal;
  model?: AttachmentPickerModel;
}

async function resolveContext(request: AttachmentQueryContext) {
  const sequence = request.model?.beginContext();
  const context = await loadPluginAttachmentContext(request.source, request.invoke);
  request.signal?.throwIfAborted();
  if (sequence !== undefined && !request.model?.applyContext(sequence, context)) {
    throw new Error("Attachment account context was superseded");
  }
  const scope = context?.scope ?? null;
  const prefix = ["plugin-attachment-cache", request.serverId, request.pluginId, request.source.id];
  request.queryClient.removeQueries({
    queryKey: prefix,
    predicate: (query) => query.queryKey[4] !== scope,
  });
  return { context, prefix, scope };
}

function checkCurrent(request: AttachmentQueryContext, scope: string | null) {
  request.signal?.throwIfAborted();
  if (request.model && (request.model.getState().context?.scope ?? null) !== scope) {
    throw new Error("Attachment account scope changed");
  }
}

function checkInput(request: AttachmentQueryContext, input: PluginAttachmentSearchInput) {
  if (request.model && JSON.stringify(request.model.searchInput()) !== JSON.stringify(input))
    throw new Error("Attachment query was superseded");
}

export async function queryPluginAttachments(
  request: AttachmentQueryContext & { input: PluginAttachmentSearchInput },
) {
  const { context, prefix, scope } = await resolveContext(request);
  const input = request.model?.searchInput() ?? request.input;
  if (input.query !== request.input.query) throw new Error("Attachment query was superseded");
  const scopedInput = context ? { ...input, scope: context.scope } : input;
  const pages: PluginAttachmentSearchPayload[] = [];
  const previous = request.source.groupedResults
    ? (request.model?.getState().previousCursors ?? [])
    : [];
  for (const [index, cursor] of [...previous, input.cursor].entries()) {
    const pageInput = { ...scopedInput, cursor };
    const queryKey = [...prefix, scope, "results", pageInput];
    const cached = request.queryClient.getQueryData<PluginAttachmentSearchPayload>(queryKey);
    if (index < previous.length && !cached)
      throw new Error("The read view expired; restart the search");
    const result =
      index < previous.length
        ? cached!
        : await request.queryClient.fetchQuery({
            queryKey,
            queryFn: () => searchPluginAttachments(request.source, request.invoke, pageInput),
            staleTime: 30_000,
            retry: false,
          });
    checkCurrent(request, scope);
    checkInput(request, input);
    if (
      result.items.some((item) => item.source && context && item.source.scope !== context.scope)
    ) {
      request.queryClient.removeQueries({ queryKey });
      throw new Error("Attachment result scope changed");
    }
    if (result.status && result.status !== "ready") {
      request.queryClient.removeQueries({ queryKey });
      return { context, result };
    }
    if (index > 0 && pages[index - 1]?.coverage?.nextCursor !== cursor)
      throw new Error("Attachment page belongs to a different read view");
    pages.push(result);
  }
  return {
    context,
    result: { ...pages[pages.length - 1]!, items: pages.flatMap((page) => page.items) },
  };
}

export async function queryPluginAttachmentFilterOptions(
  request: AttachmentQueryContext & {
    input: Omit<PluginAttachmentFilterOptionsInput, "scope">;
    previousCursors?: Array<string | undefined>;
  },
) {
  const previousScope = request.model?.getState().context?.scope;
  const { context, prefix, scope } = await resolveContext(request);
  const changed = previousScope !== undefined && previousScope !== scope;
  if (!context) throw new Error("Attachment filter options require account context");
  const input = {
    ...request.input,
    ...(changed ? { query: "", cursor: undefined } : {}),
    scope: context.scope,
  };
  if (request.model && request.model.getState().candidateQuery !== input.query)
    throw new Error("Attachment candidate query was superseded");
  const pages = [];
  for (const cursor of [...(changed ? [] : (request.previousCursors ?? [])), input.cursor]) {
    checkCurrent(request, scope);
    const pageInput = { ...input, cursor };
    const queryKey = [...prefix, scope, "options", pageInput];
    const page = await request.queryClient.fetchQuery({
      queryKey,
      queryFn: () => searchPluginAttachmentFilterOptions(request.source, request.invoke, pageInput),
      staleTime: 30_000,
      retry: false,
    });
    checkCurrent(request, scope);
    if (page.status && page.status !== "ready") {
      request.queryClient.removeQueries({ queryKey });
      return { context, result: page };
    }
    pages.push(page);
  }
  const last = pages[pages.length - 1]!;
  return { context, result: { ...last, items: pages.flatMap((page) => page.items) } };
}
