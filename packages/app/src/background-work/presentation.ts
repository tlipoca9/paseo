const MAX_PILL_TITLE_CHARS = 28;

export function backgroundWorkText(
  item: { description: string | null; command?: string },
  kind: string,
): { title: string; command: string | null } {
  const title = item.description ?? item.command ?? kind;
  return { title, command: item.command && item.command !== title ? item.command : null };
}

export function formatActiveWorkPillSummary(input: {
  count: number;
  leadTitle: string | null;
  fallbackLabel: string;
}): string {
  const normalized = input.leadTitle?.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized) {
    return input.fallbackLabel;
  }
  const truncated =
    normalized.length <= MAX_PILL_TITLE_CHARS
      ? normalized
      : `${normalized.slice(0, MAX_PILL_TITLE_CHARS - 1)}…`;
  return `${input.count} · ${truncated}`;
}
