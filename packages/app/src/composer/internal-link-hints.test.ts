import { describe, expect, it } from "vitest";
import { extractInternalLinkAttachments } from "./internal-link-hints";

describe("extractInternalLinkAttachments", () => {
  it("extracts Gongfeng MR, issue, and repo links with clean titles and subtitles", () => {
    const input = [
      "请看下这几个链接：",
      "https://git.woa.com/org/sandstorm/-/merge_requests/123",
      "https://git.woa.com/org/sub/paseo/merge_requests/456/diffs",
      "https://git.woa.com/org/sandstorm/issues/45",
      "https://git.woa.com/org/sandstorm",
      "https://git.woa.com",
    ].join("\n");

    expect(extractInternalLinkAttachments(input)).toEqual([
      {
        id: "internal_link:gongfeng:https://git.woa.com/org/sandstorm/-/merge_requests/123",
        provider: "gongfeng",
        providerLabel: "工蜂",
        title: "sandstorm !123",
        subtitle: "org/sandstorm",
        url: "https://git.woa.com/org/sandstorm/-/merge_requests/123",
        text: "https://git.woa.com/org/sandstorm/-/merge_requests/123\n[工蜂链接，请优先使用 gongfeng MCP 读取详情]",
      },
      {
        id: "internal_link:gongfeng:https://git.woa.com/org/sub/paseo/merge_requests/456/diffs",
        provider: "gongfeng",
        providerLabel: "工蜂",
        title: "paseo !456",
        subtitle: "org/sub/paseo",
        url: "https://git.woa.com/org/sub/paseo/merge_requests/456/diffs",
        text: "https://git.woa.com/org/sub/paseo/merge_requests/456/diffs\n[工蜂链接，请优先使用 gongfeng MCP 读取详情]",
      },
      {
        id: "internal_link:gongfeng:https://git.woa.com/org/sandstorm/issues/45",
        provider: "gongfeng",
        providerLabel: "工蜂",
        title: "sandstorm #45",
        subtitle: "org/sandstorm",
        url: "https://git.woa.com/org/sandstorm/issues/45",
        text: "https://git.woa.com/org/sandstorm/issues/45\n[工蜂链接，请优先使用 gongfeng MCP 读取详情]",
      },
      {
        id: "internal_link:gongfeng:https://git.woa.com/org/sandstorm",
        provider: "gongfeng",
        providerLabel: "工蜂",
        title: "sandstorm",
        subtitle: "org/sandstorm",
        url: "https://git.woa.com/org/sandstorm",
        text: "https://git.woa.com/org/sandstorm\n[工蜂链接，请优先使用 gongfeng MCP 读取详情]",
      },
      {
        id: "internal_link:gongfeng:https://git.woa.com",
        provider: "gongfeng",
        providerLabel: "工蜂",
        title: "工蜂链接",
        subtitle: "",
        url: "https://git.woa.com",
        text: "https://git.woa.com\n[工蜂链接，请优先使用 gongfeng MCP 读取详情]",
      },
    ]);
  });

  it("extracts TAPD stories, bugs, tasks, and fallback links from tapd.woa.com and www.tapd.cn", () => {
    const input = [
      "需求 https://tapd.woa.com/123456/prong/stories/view/100001",
      "缺陷 https://www.tapd.cn/123456/bugtrace/bugs/view?bug_id=100002",
      "任务 https://tapd.woa.com/123456/prong/tasks/view/100003",
      "看板 https://tapd.woa.com/my_worktable",
    ].join("\n");

    expect(extractInternalLinkAttachments(input)).toEqual([
      {
        id: "internal_link:tapd:https://tapd.woa.com/123456/prong/stories/view/100001",
        provider: "tapd",
        providerLabel: "TAPD",
        title: "TAPD 需求 #100001",
        subtitle: "项目 123456",
        url: "https://tapd.woa.com/123456/prong/stories/view/100001",
        text: "https://tapd.woa.com/123456/prong/stories/view/100001\n[TAPD 链接，请优先使用 tapd_mcp_http MCP 读取详情]",
      },
      {
        id: "internal_link:tapd:https://www.tapd.cn/123456/bugtrace/bugs/view?bug_id=100002",
        provider: "tapd",
        providerLabel: "TAPD",
        title: "TAPD 缺陷 #100002",
        subtitle: "项目 123456",
        url: "https://www.tapd.cn/123456/bugtrace/bugs/view?bug_id=100002",
        text: "https://www.tapd.cn/123456/bugtrace/bugs/view?bug_id=100002\n[TAPD 链接，请优先使用 tapd_mcp_http MCP 读取详情]",
      },
      {
        id: "internal_link:tapd:https://tapd.woa.com/123456/prong/tasks/view/100003",
        provider: "tapd",
        providerLabel: "TAPD",
        title: "TAPD 任务 #100003",
        subtitle: "项目 123456",
        url: "https://tapd.woa.com/123456/prong/tasks/view/100003",
        text: "https://tapd.woa.com/123456/prong/tasks/view/100003\n[TAPD 链接，请优先使用 tapd_mcp_http MCP 读取详情]",
      },
      {
        id: "internal_link:tapd:https://tapd.woa.com/my_worktable",
        provider: "tapd",
        providerLabel: "TAPD",
        title: "TAPD 单据",
        subtitle: "",
        url: "https://tapd.woa.com/my_worktable",
        text: "https://tapd.woa.com/my_worktable\n[TAPD 链接，请优先使用 tapd_mcp_http MCP 读取详情]",
      },
    ]);
  });

  it("extracts iWiki page, space, and fallback links", () => {
    const input = [
      "https://iwiki.woa.com/p/4012345678",
      "https://iwiki.woa.com/space/agent-runtime",
      "https://iwiki.woa.com/home",
    ].join(" ");

    expect(extractInternalLinkAttachments(input)).toEqual([
      {
        id: "internal_link:iwiki:https://iwiki.woa.com/p/4012345678",
        provider: "iwiki",
        providerLabel: "iWiki",
        title: "iWiki 文档 #4012345678",
        subtitle: "",
        url: "https://iwiki.woa.com/p/4012345678",
        text: "https://iwiki.woa.com/p/4012345678\n[iWiki 链接，请优先使用 iWiki MCP 读取详情]",
      },
      {
        id: "internal_link:iwiki:https://iwiki.woa.com/space/agent-runtime",
        provider: "iwiki",
        providerLabel: "iWiki",
        title: "iWiki 空间 agent-runtime",
        subtitle: "",
        url: "https://iwiki.woa.com/space/agent-runtime",
        text: "https://iwiki.woa.com/space/agent-runtime\n[iWiki 链接，请优先使用 iWiki MCP 读取详情]",
      },
      {
        id: "internal_link:iwiki:https://iwiki.woa.com/home",
        provider: "iwiki",
        providerLabel: "iWiki",
        title: "iWiki 文档",
        subtitle: "",
        url: "https://iwiki.woa.com/home",
        text: "https://iwiki.woa.com/home\n[iWiki 链接，请优先使用 iWiki MCP 读取详情]",
      },
    ]);
  });

  it("trims trailing punctuation and deduplicates normalized URLs", () => {
    const input = [
      "参考 [MR](https://git.woa.com/org/repo/-/merge_requests/12)，",
      "重复链接 https://git.woa.com/org/repo/-/merge_requests/12/。",
      "文档 (https://iwiki.woa.com/p/40123456); 需求 https://tapd.woa.com/1/prong/stories/view/99,",
      "末尾标点 [https://iwiki.woa.com/p/40123456].",
    ].join("\n");

    const extracted = extractInternalLinkAttachments(input);
    expect(extracted.map((item) => item.id)).toEqual([
      "internal_link:gongfeng:https://git.woa.com/org/repo/-/merge_requests/12",
      "internal_link:iwiki:https://iwiki.woa.com/p/40123456",
      "internal_link:tapd:https://tapd.woa.com/1/prong/stories/view/99",
    ]);
  });

  it("ignores empty input, unrelated hosts, and spoofed hostnames", () => {
    expect(extractInternalLinkAttachments("")).toEqual([]);
    expect(
      extractInternalLinkAttachments(
        "https://github.com/getpaseo/paseo https://git.woa.com.evil.com/a/b",
      ),
    ).toEqual([]);
  });

  it("enriches card title from descriptive anchor text while preserving parsed identifier in subtitle", () => {
    const titlesByUrl = new Map([
      ["https://iwiki.woa.com/p/40123456", "镜像预热计费灰度方案"],
      ["https://git.woa.com/org/sandstorm/-/merge_requests/123", "https://git.woa.com/org/sandstorm/-/merge_requests/123"],
    ]);
    const extracted = extractInternalLinkAttachments(
      "https://iwiki.woa.com/p/40123456 https://git.woa.com/org/sandstorm/-/merge_requests/123",
      { titlesByUrl },
    );
    expect(extracted[0]).toMatchObject({
      title: "镜像预热计费灰度方案",
      subtitle: "iWiki 文档 #40123456",
    });
    expect(extracted[1]).toMatchObject({
      title: "sandstorm !123",
      subtitle: "org/sandstorm",
    });
  });
});
