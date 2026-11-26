interface InternalLinkHintRule {
  pattern: RegExp;
  hint: string;
}

const INTERNAL_LINK_HINT_RULES: readonly InternalLinkHintRule[] = [
  {
    pattern: /https?:\/\/git\.woa\.com(?:\/[^\s]*)?/i,
    hint: "[工蜂链接，请优先使用 gongfeng MCP 读取详情]",
  },
  {
    pattern: /https?:\/\/(?:tapd\.woa\.com|www\.tapd\.cn)(?:\/[^\s]*)?/i,
    hint: "[TAPD 链接，请优先使用 tapd_mcp_http MCP 读取详情]",
  },
  {
    pattern: /https?:\/\/iwiki\.woa\.com(?:\/[^\s]*)?/i,
    hint: "[iWiki 链接，请优先使用 iWiki MCP 读取详情]",
  },
];

/**
 * Pure 0ms local detector for internal dev links (Gongfeng, TAPD, iWiki).
 * Preserves the original pasted text untouched and appends at most one concise
 * MCP hint line per matched service, skipping any hint already present in the text.
 */
export function appendInternalLinkHints(text: string): string {
  if (!text) return text;
  const hints: string[] = [];
  for (const rule of INTERNAL_LINK_HINT_RULES) {
    if (rule.pattern.test(text) && !text.includes(rule.hint)) {
      hints.push(rule.hint);
    }
  }
  if (hints.length === 0) return text;
  const separator = text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${separator}${hints.join("\n")}`;
}
