import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import { normalizeMarkdownHtml } from "./html";

/** External messages expose image links without fetching remote or local image data. */
export function externalMarkdownSource(text: string): string {
  const source = normalizeMarkdownHtml(text);
  const images: number[] = [];
  function visit(node: Nodes) {
    if ((node.type === "image" || node.type === "imageReference") && node.position) {
      images.push(node.position.start.offset!);
    } else if ("children" in node) node.children.forEach(visit);
  }
  visit(fromMarkdown(source));
  let result = source;
  for (const offset of images.toReversed())
    result = result.slice(0, offset) + result.slice(offset + 1);
  return result;
}
