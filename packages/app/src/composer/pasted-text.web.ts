import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";
import { getDesktopHost } from "@/desktop/host";
import { createAssistantMarkdownParser } from "@/utils/assistant-markdown-parser";
import { appendInternalLinkHints } from "./internal-link-hints";

const markdown = new TurndownService({
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
// Heading tables become Markdown; headerless tables retain their HTML structure.
markdown.use(tables);
markdown.addRule("rowlessTable", {
  filter: (node) => node.nodeName === "TABLE" && (node as HTMLTableElement).rows.length === 0,
  replacement: (content) => (content ? `\n\n${content}\n\n` : ""),
});
markdown.addRule("tableCell", {
  filter: ["th", "td"],
  replacement: (content, node) => {
    const prefix = node.previousElementSibling ? " " : "| ";
    const cell = content.trim().replace(/\|/g, "\\|").replace(/ *\n/g, "<br>");
    return `${prefix}${cell} |`;
  },
});
const copiedMarkdown = createAssistantMarkdownParser();

function linkDestinations(fragment: Document): string[] {
  return Array.from(fragment.querySelectorAll("a[href]"), (link) => link.getAttribute("href")!);
}

function containsDestinations(plainText: string, destinations: string[]): boolean {
  if (destinations.every((url) => plainText.includes(url))) return true;

  // Copy normalizes Markdown URLs in HTML (percent encoding, internationalized
  // domains). Compare parsed destinations using that same parser, not URL spelling.
  const rendered = new DOMParser().parseFromString(copiedMarkdown.render(plainText), "text/html");
  const links = new Set(linkDestinations(rendered));
  return destinations.every((url) => plainText.includes(url) || links.has(url));
}

/** Paste linked HTML as Markdown through the browser's undoable editing command. */
export function pasteLinkedClipboardText(
  input: HTMLElement,
  clipboard: Pick<DataTransfer, "getData"> | null,
): boolean {
  const html = clipboard?.getData("text/html");
  if (!html) return false;

  // Parse in a detached document. Clipboard markup is never mounted in the app.
  const fragment = new DOMParser().parseFromString(html, "text/html");
  const destinations = linkDestinations(fragment);
  const plainText = clipboard!.getData("text/plain");
  // Copy actions already put complete Markdown on the clipboard. Keep that
  // representation, including tables and formatting, whenever it carries the URLs.
  if (containsDestinations(plainText, destinations)) return false;
  const text = appendInternalLinkHints(markdown.turndown(fragment.body));
  input.focus();
  // Direct value assignment drops the textarea's undo history. This also emits
  // the normal input event so the editor publishes its new draft as for typing.
  return input.ownerDocument.execCommand("insertText", false, text);
}

/**
 * Paste macOS WeWork messages decoded from `WWKPrivatePBDataReportKey` via the
 * Electron desktop bridge. Returns false when not running on desktop or when
 * the clipboard does not hold valid WeWork message data.
 */
export function pasteWeWorkClipboardText(
  input: HTMLElement,
  clipboard: Pick<DataTransfer, "getData"> | null,
): boolean {
  const reader = getDesktopHost()?.clipboard?.readWeWorkPaste;
  if (!reader) return false;
  let formatted: string | null = null;
  try {
    formatted = reader(clipboard?.getData("text/plain") ?? "");
  } catch {
    return false;
  }
  if (!formatted) return false;
  input.focus();
  return input.ownerDocument.execCommand(
    "insertText",
    false,
    appendInternalLinkHints(formatted),
  );
}

/**
 * Paste plain text with lightweight MCP hints appended for internal dev links
 * (Gongfeng / TAPD / iWiki). Returns false when no new hint applies.
 */
export function pasteInternalLinkHintedText(
  input: HTMLElement,
  clipboard: Pick<DataTransfer, "getData"> | null,
): boolean {
  const plainText = clipboard?.getData("text/plain") ?? "";
  if (!plainText) return false;
  const enhanced = appendInternalLinkHints(plainText);
  if (enhanced === plainText) return false;
  input.focus();
  return input.ownerDocument.execCommand("insertText", false, enhanced);
}
