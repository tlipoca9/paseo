import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { getAgentAttachmentPillContent } from "./attachment-pill-content";

describe("agent attachment pill content", () => {
  it("presents external resources with their provider identity", () => {
    const content = getAgentAttachmentPillContent(
      {
        type: "text",
        mimeType: "text/plain",
        title: "ENG-123 Plugin attachments",
        text: "Linear issue ENG-123: Plugin attachments",
        externalResource: {
          provider: "linear",
          providerLabel: "Linear issue",
          resourceType: "issue",
          id: "issue-uuid",
          identifier: "ENG-123",
          title: "Plugin attachments",
          url: "https://linear.app/acme/issue/ENG-123/plugin-attachments",
        },
      },
      i18n.t,
    );

    expect(content.title).toBe("Plugin attachments");
    expect(content.subtitle).toBe("Linear issue ENG-123");
  });

  it("presents WeWork external resources with dot-separated subtitle", () => {
    const content = getAgentAttachmentPillContent(
      {
        type: "text",
        mimeType: "text/plain",
        title: "今晚 8 点发布 v0.18",
        text: "> 今晚 8 点发布 v0.18",
        externalResource: {
          provider: "wework",
          providerLabel: "企业微信",
          resourceType: "message",
          id: "wework_1",
          identifier: "发布群 · 张三 · 2026-11-26 10:30",
          title: "今晚 8 点发布 v0.18",
          url: "",
        },
      },
      i18n.t,
    );

    expect(content.title).toBe("今晚 8 点发布 v0.18");
    expect(content.subtitle).toBe("企业微信 · 发布群 · 张三 · 2026-11-26 10:30");
  });

  it("presents Gongfeng, TAPD, and iWiki external resources with dot-separated subtitles and distinct icons", () => {
    const gongfeng = getAgentAttachmentPillContent(
      {
        type: "text",
        mimeType: "text/plain",
        title: "sandstorm !123",
        text: "https://git.woa.com/org/sandstorm/-/merge_requests/123",
        externalResource: {
          provider: "gongfeng",
          providerLabel: "工蜂",
          resourceType: "link",
          id: "internal_link:gongfeng:https://git.woa.com/org/sandstorm/-/merge_requests/123",
          identifier: "org/sandstorm",
          title: "sandstorm !123",
          url: "https://git.woa.com/org/sandstorm/-/merge_requests/123",
        },
      },
      i18n.t,
    );
    expect(gongfeng.title).toBe("sandstorm !123");
    expect(gongfeng.subtitle).toBe("工蜂 · org/sandstorm");

    const tapd = getAgentAttachmentPillContent(
      {
        type: "text",
        mimeType: "text/plain",
        title: "TAPD 需求 #100001",
        text: "https://tapd.woa.com/123456/prong/stories/view/100001",
        externalResource: {
          provider: "tapd",
          providerLabel: "TAPD",
          resourceType: "link",
          id: "internal_link:tapd:https://tapd.woa.com/123456/prong/stories/view/100001",
          identifier: "项目 123456",
          title: "TAPD 需求 #100001",
          url: "https://tapd.woa.com/123456/prong/stories/view/100001",
        },
      },
      i18n.t,
    );
    expect(tapd.title).toBe("TAPD 需求 #100001");
    expect(tapd.subtitle).toBe("TAPD · 项目 123456");

    const iwiki = getAgentAttachmentPillContent(
      {
        type: "text",
        mimeType: "text/plain",
        title: "iWiki 文档 #40123456",
        text: "https://iwiki.woa.com/p/40123456",
        externalResource: {
          provider: "iwiki",
          providerLabel: "iWiki",
          resourceType: "link",
          id: "internal_link:iwiki:https://iwiki.woa.com/p/40123456",
          identifier: "",
          title: "iWiki 文档 #40123456",
          url: "https://iwiki.woa.com/p/40123456",
        },
      },
      i18n.t,
    );
    expect(iwiki.title).toBe("iWiki 文档 #40123456");
    expect(iwiki.subtitle).toBe("iWiki");

    expect(gongfeng.icon).not.toBe(tapd.icon);
    expect(tapd.icon).not.toBe(iwiki.icon);
    expect(gongfeng.icon).not.toBe(iwiki.icon);
  });
});
