import type { InternalLinkProvider } from "@/attachments/types";

export type { InternalLinkProvider };

export interface ExtractedInternalLink {
  id: string;
  provider: InternalLinkProvider;
  providerLabel: string;
  title: string;
  subtitle: string;
  url: string;
  text: string;
}

const INTERNAL_LINK_URL_REGEX =
  /https?:\/\/(?:git\.woa\.com|tapd\.woa\.com|www\.tapd\.cn|iwiki\.woa\.com)(?:[^\s<>'"`，。；！？：（）【】《》]*)?/gi;

const TRAILING_PUNCTUATION_REGEX = /[)\],.;:!?。，；！？：）】》]+$/;

function trimTrailingPunctuation(rawUrl: string): string {
  let url = rawUrl;
  while (url.length > 0) {
    const trimmed = url.replace(TRAILING_PUNCTUATION_REGEX, "");
    if (trimmed === url) break;
    url = trimmed;
  }
  return url;
}

function normalizeUrl(parsed: URL): string {
  const href = parsed.href;
  if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
    return href.replace(/\/+$/, "");
  }
  return href.replace(/\/+$/, "");
}

function resolveProvider(hostname: string): InternalLinkProvider | null {
  const host = hostname.toLowerCase();
  if (host === "git.woa.com") return "gongfeng";
  if (host === "tapd.woa.com" || host === "www.tapd.cn") return "tapd";
  if (host === "iwiki.woa.com") return "iwiki";
  return null;
}

function parseGongfengLink(parsed: URL, url: string): ExtractedInternalLink {
  const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
  let title = "工蜂链接";
  let subtitle = "";

  const mrMatch = path.match(/^(.+?)(?:\/-)?\/merge_requests\/(\d+)(?:\/.*)?$/);
  const issueMatch = mrMatch ? null : path.match(/^(.+?)(?:\/-)?\/issues\/(\d+)(?:\/.*)?$/);

  if (mrMatch) {
    const repoPath = mrMatch[1]!;
    const repoName = repoPath.split("/").pop() ?? repoPath;
    title = `${repoName} !${mrMatch[2]}`;
    subtitle = repoPath;
  } else if (issueMatch) {
    const repoPath = issueMatch[1]!;
    const repoName = repoPath.split("/").pop() ?? repoPath;
    title = `${repoName} #${issueMatch[2]}`;
    subtitle = repoPath;
  } else if (path) {
    const dashIndex = path.indexOf("/-/");
    const repoPath = dashIndex !== -1 ? path.slice(0, dashIndex) : path;
    const segments = repoPath.split("/").filter(Boolean);
    if (segments.length >= 2) {
      title = segments[segments.length - 1]!;
      subtitle = segments.join("/");
    } else if (segments.length === 1) {
      title = segments[0]!;
    }
  }

  return {
    id: `internal_link:gongfeng:${url}`,
    provider: "gongfeng",
    providerLabel: "工蜂",
    title,
    subtitle,
    url,
    text: `${url}\n[工蜂链接，请优先使用 gongfeng MCP 读取详情]`,
  };
}

function parseTapdLink(parsed: URL, url: string): ExtractedInternalLink {
  const path = parsed.pathname;
  const workspaceMatch = path.match(/^\/(\d+)(?:\/|$)/);
  const subtitle = workspaceMatch ? `项目 ${workspaceMatch[1]}` : "";

  const storyMatch =
    path.match(/\/stories\/view\/(\d+)/i) ??
    (parsed.searchParams.get("story_id") ? [null, parsed.searchParams.get("story_id")] : null);
  const bugMatch =
    path.match(/\/bugs\/view\/(\d+)/i) ??
    (/\/bugtrace\/bugs\/view/i.test(path) && parsed.searchParams.get("bug_id")
      ? [null, parsed.searchParams.get("bug_id")]
      : null);
  const taskMatch =
    path.match(/\/tasks\/view\/(\d+)/i) ??
    (parsed.searchParams.get("task_id") ? [null, parsed.searchParams.get("task_id")] : null);

  let title = "TAPD 单据";
  if (storyMatch?.[1]) {
    title = `TAPD 需求 #${storyMatch[1]}`;
  } else if (bugMatch?.[1]) {
    title = `TAPD 缺陷 #${bugMatch[1]}`;
  } else if (taskMatch?.[1]) {
    title = `TAPD 任务 #${taskMatch[1]}`;
  }

  return {
    id: `internal_link:tapd:${url}`,
    provider: "tapd",
    providerLabel: "TAPD",
    title,
    subtitle,
    url,
    text: `${url}\n[TAPD 链接，请优先使用 tapd_mcp_http MCP 读取详情]`,
  };
}

function parseIwikiLink(parsed: URL, url: string): ExtractedInternalLink {
  const path = parsed.pathname;
  const pageMatch = path.match(/^\/p\/([^/?#]+)/i);
  const spaceMatch = pageMatch ? null : path.match(/^\/space\/([^/?#]+)/i);

  let title = "iWiki 文档";
  if (pageMatch?.[1]) {
    title = `iWiki 文档 #${pageMatch[1]}`;
  } else if (spaceMatch?.[1]) {
    let spaceName = spaceMatch[1];
    try {
      spaceName = decodeURIComponent(spaceName);
    } catch {
      // Keep raw segment if malformed percent-encoding.
    }
    title = `iWiki 空间 ${spaceName}`;
  }

  return {
    id: `internal_link:iwiki:${url}`,
    provider: "iwiki",
    providerLabel: "iWiki",
    title,
    subtitle: "",
    url,
    text: `${url}\n[iWiki 链接，请优先使用 iWiki MCP 读取详情]`,
  };
}

/**
 * Pure 0ms local extractor for internal dev links (Gongfeng, TAPD, iWiki).
 * Deduplicates by normalized URL and produces deterministic IDs so pasting
 * the same link multiple times does not create duplicate attachment cards.
 */
export function extractInternalLinkAttachments(text: string): ExtractedInternalLink[] {
  if (!text) return [];

  const matches = text.match(INTERNAL_LINK_URL_REGEX);
  if (!matches) return [];

  const seen = new Set<string>();
  const results: ExtractedInternalLink[] = [];

  for (const raw of matches) {
    const trimmed = trimTrailingPunctuation(raw);
    if (!trimmed) continue;

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }

    const provider = resolveProvider(parsed.hostname);
    if (!provider) continue;

    const url = normalizeUrl(parsed);
    if (seen.has(url)) continue;
    seen.add(url);

    if (provider === "gongfeng") {
      results.push(parseGongfengLink(parsed, url));
    } else if (provider === "tapd") {
      results.push(parseTapdLink(parsed, url));
    } else {
      results.push(parseIwikiLink(parsed, url));
    }
  }

  return results;
}
