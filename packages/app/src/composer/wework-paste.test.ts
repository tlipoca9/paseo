import { afterEach, describe, expect, it, vi } from "vitest";
import type { WeWorkMessageComposerAttachment } from "@/attachments/types";
import type { DesktopHostBridge, ResolvedWeWorkPaste, WeWorkClipboardData } from "@/desktop/host";
import { openComposerAttachment } from "@/composer/actions";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";
import { handleWeWorkClipboardPaste } from "@/composer/pasted-text.web";
import { isUserComposerAttachment } from "@/stores/draft-store/state";

function setDesktopBridge(bridge: DesktopHostBridge | undefined): void {
  Object.defineProperty(globalThis, "window", {
    value: bridge ? { paseoDesktop: bridge } : {},
    configurable: true,
    writable: true,
  });
}

function makeClipboard(plainText: string): Pick<DataTransfer, "getData"> {
  return {
    getData: (type: string) => (type === "text/plain" ? plainText : ""),
  };
}

describe("WeWork Smart Paste attachment card", () => {
  afterEach(() => {
    setDesktopBridge(undefined);
    vi.restoreAllMocks();
  });

  it("immediately adds a wework_message card for full messages and upgrades it via background wxwork enrichment", async () => {
    let resolvePending: ((value: ResolvedWeWorkPaste | null) => void) | null = null;
    const clipboardData: WeWorkClipboardData = {
      kind: "messages",
      title: "今晚 8 点发布 v0.18",
      subtitle: "R:1970325000123456 · 2024-11-25 16:00",
      text: "> 今晚 8 点发布 v0.18\n\n- conversation_id: R:1970325000123456",
      plainText: "今晚 8 点发布 v0.18",
      messages: [{ conversationId: "R:1970325000123456", sendTime: 1732550400 }],
    };

    setDesktopBridge({
      clipboard: {
        readWeWorkData: () => clipboardData,
        resolveWeWorkPaste: () =>
          new Promise<ResolvedWeWorkPaste | null>((resolve) => {
            resolvePending = resolve;
          }),
      },
    });

    const added: WeWorkMessageComposerAttachment[] = [];
    const updated: Array<{ id: string; update: ResolvedWeWorkPaste }> = [];

    const handled = handleWeWorkClipboardPaste(makeClipboard("今晚 8 点发布 v0.18"), {
      onAddAttachment: (att) => added.push(att),
      onUpdateAttachment: (id, update) => updated.push({ id, update }),
    });

    expect(handled).toBe(true);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      kind: "wework_message",
      title: "今晚 8 点发布 v0.18",
      subtitle: "R:1970325000123456 · 2024-11-25 16:00",
    });
    expect(updated).toHaveLength(0);

    resolvePending!({
      title: "今晚 8 点发布 v0.18",
      subtitle: "发布群 · 张三 · 2024-11-25 16:00",
      text: "> 今晚 8 点发布 v0.18\n\n- conversation: 发布群, ref: wxwork-message:1",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(updated).toHaveLength(1);
    expect(updated[0]).toEqual({
      id: added[0]!.id,
      update: {
        title: "今晚 8 点发布 v0.18",
        subtitle: "发布群 · 张三 · 2024-11-25 16:00",
        text: "> 今晚 8 点发布 v0.18\n\n- conversation: 发布群, ref: wxwork-message:1",
      },
    });
  });

  it("lets partial WeWork selection paste cleanly and attaches a card only if background wxwork resolves", async () => {
    setDesktopBridge({
      clipboard: {
        readWeWorkData: () => ({ kind: "partial", plainText: "部分选中的报错日志" }),
        resolveWeWorkPaste: async () => ({
          title: "刚才出现部分选中的报错日志",
          subtitle: "告警群 · 李四 · 2026-11-26 10:30",
          text: "> 刚才出现部分选中的报错日志\n\n- conversation_id: R:888",
        }),
      },
    });

    const added: WeWorkMessageComposerAttachment[] = [];
    const handled = handleWeWorkClipboardPaste(makeClipboard("部分选中的报错日志"), {
      onAddAttachment: (att) => added.push(att),
      onUpdateAttachment: () => {},
    });

    // Returns false so normal plain-text paste runs without inline bracketed text.
    expect(handled).toBe(false);
    expect(added).toHaveLength(0);

    await Promise.resolve();
    await Promise.resolve();

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      kind: "wework_message",
      title: "刚才出现部分选中的报错日志",
      subtitle: "告警群 · 李四 · 2026-11-26 10:30",
    });
  });

  it("does nothing on partial selection when wxwork enrichment returns null or rejects", async () => {
    setDesktopBridge({
      clipboard: {
        readWeWorkData: () => ({ kind: "partial", plainText: "普通片段" }),
        resolveWeWorkPaste: async () => null,
      },
    });

    const added: WeWorkMessageComposerAttachment[] = [];
    expect(
      handleWeWorkClipboardPaste(makeClipboard("普通片段"), {
        onAddAttachment: (att) => added.push(att),
        onUpdateAttachment: () => {},
      }),
    ).toBe(false);

    await Promise.resolve();
    await Promise.resolve();
    expect(added).toHaveLength(0);
  });

  it("validates draft persistence, opens preview callback, and submits as a text AgentAttachment with externalResource", () => {
    const attachment: WeWorkMessageComposerAttachment = {
      kind: "wework_message",
      id: "wework_test_1",
      title: "今晚 8 点发布 v0.18",
      subtitle: "发布群 · 张三 · 2024-11-25 16:00",
      text: "> 今晚 8 点发布 v0.18\n\n- conversation_id: R:1970325000123456",
    };

    expect(isUserComposerAttachment(attachment)).toBe(true);

    const openWeWorkAttachment = vi.fn();
    openComposerAttachment({
      attachment,
      setLightboxMetadata: vi.fn(),
      openWorkspaceAttachment: vi.fn(() => false),
      openExternalUrl: vi.fn(),
      openWeWorkAttachment,
    });
    expect(openWeWorkAttachment).toHaveBeenCalledWith(attachment);

    const submitted = splitComposerAttachmentsForSubmit([attachment]);
    expect(submitted.images).toEqual([]);
    expect(submitted.attachments).toEqual([
      {
        type: "text",
        mimeType: "text/plain",
        title: "今晚 8 点发布 v0.18",
        text: "> 今晚 8 点发布 v0.18\n\n- conversation_id: R:1970325000123456",
        externalResource: {
          provider: "wework",
          providerLabel: "企业微信",
          resourceType: "message",
          id: "wework_test_1",
          identifier: "发布群 · 张三 · 2024-11-25 16:00",
          title: "今晚 8 点发布 v0.18",
          url: "",
        },
      },
    ]);
  });
});
