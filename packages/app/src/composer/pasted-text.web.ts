import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";
import type {
  InternalLinkComposerAttachment,
  SessionRefComposerAttachment,
  WeWorkMessageComposerAttachment,
} from "@/attachments/types";
import { getDesktopHost, type WeWorkClipboardData } from "@/desktop/host";
import { createAssistantMarkdownParser } from "@/utils/assistant-markdown-parser";
import { extractInternalLinkAttachments } from "./internal-link-hints";
import { parseSessionRefPaste } from "./session-ref-paste";

export interface WeWorkPasteCallbacks {
  onAddAttachment: (attachment: WeWorkMessageComposerAttachment) => void;
  onUpdateAttachment: (
    id: string,
    update: { title: string; subtitle: string; text: string },
  ) => void;
  isDisposed?: () => boolean;
}

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
  const text = markdown.turndown(fragment.body);
  input.focus();
  // Direct value assignment drops the textarea's undo history. This also emits
  // the normal input event so the editor publishes its new draft as for typing.
  return input.ownerDocument.execCommand("insertText", false, text);
}

function createWeWorkAttachmentId(): string {
  return `wework_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Handle macOS WeWork clipboard pastes via the Electron desktop bridge:
 * - Full message paste (`kind: "messages"`): immediately adds a native
 *   `wework_message` attachment card and returns `true` so default text
 *   insertion is prevented, then fires best-effort background `wxwork`
 *   enrichment to upgrade the card's subtitle/text.
 * - Partial drag-selected text (`kind: "partial"`): returns `false` so clean
 *   plain text pastes normally into the textarea (zero bracketed hints), and
 *   fires best-effort background `wxwork` resolution to attach a card if found.
 */
export function handleWeWorkClipboardPaste(
  clipboard: Pick<DataTransfer, "getData"> | null,
  callbacks: WeWorkPasteCallbacks,
): boolean {
  const bridge = getDesktopHost()?.clipboard;
  const reader = bridge?.readWeWorkData;
  if (!reader) return false;

  let data: WeWorkClipboardData | null = null;
  try {
    data = reader(clipboard?.getData("text/plain") ?? "");
  } catch {
    return false;
  }
  if (!data) return false;

  const resolver = bridge?.resolveWeWorkPaste;

  if (data.kind === "messages") {
    const id = createWeWorkAttachmentId();
    callbacks.onAddAttachment({
      kind: "wework_message",
      id,
      title: data.title,
      subtitle: data.subtitle,
      text: data.text,
    });

    if (resolver) {
      void resolver(data)
        .then((resolved) => {
          if (!resolved || callbacks.isDisposed?.()) return;
          callbacks.onUpdateAttachment(id, resolved);
        })
        .catch(() => {
          // Best-effort enrichment; ignore errors.
        });
    }

    return true;
  }

  if (data.kind === "partial") {
    if (resolver) {
      void resolver(data)
        .then((resolved) => {
          if (!resolved || callbacks.isDisposed?.()) return;
          callbacks.onAddAttachment({
            kind: "wework_message",
            id: createWeWorkAttachmentId(),
            title: resolved.title,
            subtitle: resolved.subtitle,
            text: resolved.text,
          });
        })
        .catch(() => {
          // Best-effort enrichment; ignore errors.
        });
    }
    return false;
  }

  return false;
}

/**
 * Handle pasted `[Paseo 会话引用]` text blocks by converting them into a native
 * `session_ref` attachment card. Returns `true` when the entire paste was the
 * session reference block (so default raw text insertion can be prevented).
 */
export function handleSessionRefClipboardPaste(
  clipboard: Pick<DataTransfer, "getData"> | null,
  onAddSessionRef: (attachment: SessionRefComposerAttachment) => void,
): boolean {
  if (!clipboard) return false;
  const plainText = clipboard.getData("text/plain") ?? "";
  if (!plainText) return false;

  const parsed = parseSessionRefPaste(plainText);
  if (!parsed) return false;

  onAddSessionRef(parsed.attachment);
  return parsed.isExactMatch;
}

/**
 * Extract internal dev links (Gongfeng / TAPD / iWiki) from clipboard plain
 * text and HTML link destinations without mutating or blocking the paste.
 * Also captures descriptive `<a href="...">title</a>` anchor text when present.
 */
export function extractInternalLinksFromClipboard(
  clipboard: Pick<DataTransfer, "getData"> | null,
): InternalLinkComposerAttachment[] {
  if (!clipboard) return [];
  const plainText = clipboard.getData("text/plain") ?? "";
  const html = clipboard.getData("text/html") ?? "";

  let combined = plainText;
  const titlesByUrl = new Map<string, string>();
  if (html && typeof DOMParser !== "undefined") {
    const fragment = new DOMParser().parseFromString(html, "text/html");
    const anchors = Array.from(fragment.querySelectorAll("a[href]"));
    const destinations: string[] = [];
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href");
      if (!href) continue;
      destinations.push(href);
      const label = anchor.textContent?.replace(/\s+/g, " ").trim();
      if (label) {
        try {
          const normalized = new URL(href).href.replace(/\/+$/, "");
          if (!titlesByUrl.has(normalized)) {
            titlesByUrl.set(normalized, label);
          }
        } catch {
          // Ignore invalid hrefs.
        }
      }
    }
    if (destinations.length > 0) {
      combined = [plainText, ...destinations].filter(Boolean).join("\n");
    }
  }

  if (!combined) return [];
  return extractInternalLinkAttachments(combined, { titlesByUrl }).map((link) => ({
    kind: "internal_link",
    ...link,
  }));
}
