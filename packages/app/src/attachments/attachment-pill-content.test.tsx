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
});
