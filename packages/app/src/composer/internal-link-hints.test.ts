import { describe, expect, it } from "vitest";
import { appendInternalLinkHints } from "./internal-link-hints";

describe("appendInternalLinkHints", () => {
  it("appends a single Gongfeng MCP hint and deduplicates multiple Gongfeng links", () => {
    const input =
      "请看下这两个 MR：\nhttps://git.woa.com/org/repo/merge_requests/1\nhttps://git.woa.com/org/repo/issues/2";
    expect(appendInternalLinkHints(input)).toBe(
      `${input}\n\n[工蜂链接，请优先使用 gongfeng MCP 读取详情]`,
    );
  });

  it("matches both tapd.woa.com and www.tapd.cn for TAPD links", () => {
    const woa = "https://tapd.woa.com/123456/prong/stories/view/100001";
    expect(appendInternalLinkHints(woa)).toBe(
      `${woa}\n\n[TAPD 链接，请优先使用 tapd_mcp_http MCP 读取详情]`,
    );

    const cn = "https://www.tapd.cn/123456/bugtrace/bugs/view?bug_id=100002";
    expect(appendInternalLinkHints(cn)).toBe(
      `${cn}\n\n[TAPD 链接，请优先使用 tapd_mcp_http MCP 读取详情]`,
    );
  });

  it("matches iWiki links", () => {
    const url = "https://iwiki.woa.com/p/4012345678";
    expect(appendInternalLinkHints(url)).toBe(
      `${url}\n\n[iWiki 链接，请优先使用 iWiki MCP 读取详情]`,
    );
  });

  it("appends one line per distinct matched service when multiple link types appear", () => {
    const input =
      "文档 https://iwiki.woa.com/p/1 需求 https://tapd.woa.com/1/s/2 代码 https://git.woa.com/a/b";
    expect(appendInternalLinkHints(input)).toBe(
      [
        input,
        "",
        "[工蜂链接，请优先使用 gongfeng MCP 读取详情]",
        "[TAPD 链接，请优先使用 tapd_mcp_http MCP 读取详情]",
        "[iWiki 链接，请优先使用 iWiki MCP 读取详情]",
      ].join("\n"),
    );
  });

  it("does not duplicate hints on re-paste and leaves unrelated text untouched", () => {
    const alreadyHinted =
      "https://git.woa.com/org/repo\n\n[工蜂链接，请优先使用 gongfeng MCP 读取详情]";
    expect(appendInternalLinkHints(alreadyHinted)).toBe(alreadyHinted);

    const normal = "https://github.com/getpaseo/paseo";
    expect(appendInternalLinkHints(normal)).toBe(normal);
    expect(appendInternalLinkHints("")).toBe("");
  });
});
