import type {
  PluginAttachmentContext,
  PluginAttachmentFilterOption,
  PluginAttachmentItem,
  PluginAttachmentSearchInput,
} from "@getpaseo/plugin";

interface PickerState {
  query: string;
  context: PluginAttachmentContext | null;
  filters: Record<string, PluginAttachmentFilterOption>;
  cursor?: string;
  activeFilter: string | null;
  candidateQuery: string;
  candidateCursor?: string;
  previousCandidateCursors: Array<string | undefined>;
  preview: PluginAttachmentItem | null;
}

export function openAttachmentPicker() {
  let state: PickerState = {
    query: "",
    context: null,
    filters: {},
    activeFilter: null,
    previousCandidateCursors: [],
    candidateQuery: "",
    preview: null,
  };
  const listeners = new Set<() => void>();
  let contextSequence = 0;
  let appliedContextSequence = 0;
  let closed = false;
  function publish(next: PickerState) {
    if (closed) return;
    state = next;
    listeners.forEach((listener) => listener());
  }
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      closed = true;
      listeners.clear();
    },
    beginContext: () => ++contextSequence,
    applyContext: (sequence: number, context: PluginAttachmentContext | null) => {
      if (closed || sequence < appliedContextSequence) return false;
      appliedContextSequence = sequence;
      const changed = state.context !== null && state.context.scope !== context?.scope;
      publish({
        ...state,
        context,
        ...(changed
          ? {
              filters: {},
              cursor: undefined,
              candidateQuery: "",
              candidateCursor: undefined,
              previousCandidateCursors: [],
            }
          : {}),
      });
      return true;
    },
    setQuery: (query: string) => publish({ ...state, query, cursor: undefined }),
    selectFilter: (id: string, option: PluginAttachmentFilterOption | null) => {
      const filters = { ...state.filters };
      if (option) filters[id] = option;
      else delete filters[id];
      publish({
        ...state,
        filters,
        cursor: undefined,
        activeFilter: null,
        candidateQuery: "",
        candidateCursor: undefined,
        previousCandidateCursors: [],
      });
    },
    setCursor: (cursor: string) => publish({ ...state, cursor }),
    openFilter: (activeFilter: string | null) =>
      publish({ ...state, activeFilter, candidateQuery: "", candidateCursor: undefined }),
    setCandidateQuery: (candidateQuery: string) =>
      publish({
        ...state,
        candidateQuery,
        candidateCursor: undefined,
        previousCandidateCursors: [],
      }),
    setCandidateCursor: (candidateCursor: string) =>
      publish({
        ...state,
        candidateCursor,
        previousCandidateCursors: [...state.previousCandidateCursors, state.candidateCursor],
      }),
    preview: (preview: PluginAttachmentItem | null) => publish({ ...state, preview }),
    searchInput: (): PluginAttachmentSearchInput => ({
      query: state.query,
      ...(Object.keys(state.filters).length
        ? {
            filters: Object.fromEntries(
              Object.entries(state.filters).map(([key, option]) => [key, option.value]),
            ),
          }
        : {}),
      ...(state.cursor ? { cursor: state.cursor } : {}),
    }),
  };
}
export type AttachmentPickerModel = ReturnType<typeof openAttachmentPicker>;

export function serializeAttachmentDateTime(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value.replace(" ", "T"));
  if (!Number.isFinite(date.getTime())) return null;
  const pad = (part: number) => String(part).padStart(2, "0");
  const roundTrip = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return roundTrip === value ? date.toISOString().replace(".000Z", "Z") : null;
}
