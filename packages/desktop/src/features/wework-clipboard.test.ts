import { describe, expect, it } from "vitest";
import {
  buildWxWorkQuerySnippet,
  decodeWeWorkClipboardBuffer,
  decodeWeWorkProtobufMessage,
  osClipboardMimeType,
  parseBinaryPlist,
  readWeWorkClipboardData,
  readWeWorkClipboardDataAsync,
  readWeWorkClipboardPaste,
  readWeWorkClipboardPasteAsync,
  resolveWeWorkPaste,
  WEWORK_PASTEBOARD_REPORT_KEY,
  WEWORK_PASTEBOARD_RICH_KEY,
  type DesktopWeWorkClipboardReader,
  type WxWorkCliRunner,
} from "./wework-clipboard.js";

function encodeVarint(value: bigint | number): Uint8Array {
  let n = BigInt(value);
  const bytes: number[] = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0n);
  return Uint8Array.from(bytes);
}

function encodeVarintField(fieldNumber: number, value: bigint | number): Uint8Array {
  const tag = encodeVarint((BigInt(fieldNumber) << 3n) | 0n);
  const val = encodeVarint(value);
  return Buffer.concat([tag, val]);
}

function encodeBytesField(fieldNumber: number, payload: Uint8Array | string): Uint8Array {
  const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const tag = encodeVarint((BigInt(fieldNumber) << 3n) | 2n);
  const len = encodeVarint(bytes.length);
  return Buffer.concat([tag, len, bytes]);
}

/**
 * Build a spec-compliant Apple `bplist00` buffer whose root object is an array of `Data` buffers.
 */
function buildBinaryPlistDataArray(items: readonly Uint8Array[]): Buffer {
  const header = Buffer.from("bplist00", "ascii");
  const objects: Buffer[] = [];

  // Object 0: top-level array (type 0xa) referencing objects 1..items.length.
  const arrayCount = items.length;
  const arrayHeader =
    arrayCount < 15
      ? Buffer.from([0xa0 | arrayCount])
      : Buffer.from([0xaf, 0x10, arrayCount & 0xff]);
  const refs = Buffer.from(items.map((_, index) => index + 1));
  objects.push(Buffer.concat([arrayHeader, refs]));

  // Objects 1..N: Data buffers (type 0x4).
  for (const item of items) {
    let dataHeader: Buffer;
    if (item.length < 15) {
      dataHeader = Buffer.from([0x40 | item.length]);
    } else if (item.length <= 0xff) {
      dataHeader = Buffer.from([0x4f, 0x10, item.length]);
    } else {
      dataHeader = Buffer.from([0x4f, 0x11, (item.length >> 8) & 0xff, item.length & 0xff]);
    }
    objects.push(Buffer.concat([dataHeader, item]));
  }

  const offsets: number[] = [];
  let cursor = header.length;
  for (const obj of objects) {
    offsets.push(cursor);
    cursor += obj.length;
  }

  const offsetTableOffset = cursor;
  const offsetIntSize = offsetTableOffset > 0xff ? 2 : 1;
  const offsetTable = Buffer.alloc(offsets.length * offsetIntSize);
  for (let i = 0; i < offsets.length; i += 1) {
    if (offsetIntSize === 1) {
      offsetTable.writeUInt8(offsets[i]!, i);
    } else {
      offsetTable.writeUInt16BE(offsets[i]!, i * 2);
    }
  }

  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(offsetIntSize, 6);
  trailer.writeUInt8(1, 7); // objectRefSize = 1 byte
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16); // topObject = 0
  trailer.writeBigUInt64BE(BigInt(offsetTableOffset), 24);

  return Buffer.concat([header, ...objects, offsetTable, trailer]);
}

function makeClipboardReader(
  buffers: Record<string, Buffer>,
  plainText = "",
): DesktopWeWorkClipboardReader {
  return {
    readBuffer(format: string) {
      return buffers[format] ?? Buffer.alloc(0);
    },
    readText() {
      return plainText;
    },
  };
}

describe("wework-clipboard", () => {
  it("decodes a single group message from bplist00 + protobuf and formats a structured reference", () => {
    const pb = Buffer.concat([
      encodeVarintField(2, 900012345n),
      encodeVarintField(3, 1), // group chat -> R:
      encodeVarintField(4, 1970325000123456n),
      encodeVarintField(5, 42),
      encodeVarintField(6, 1688850001234567n),
      encodeVarintField(7, 2),
      encodeVarintField(8, 1732550400),
      encodeBytesField(10, encodeBytesField(1, "今晚 8 点发布 v0.18")),
    ]);
    const bplist = buildBinaryPlistDataArray([pb]);

    const parsed = parseBinaryPlist(bplist);
    expect(Array.isArray(parsed)).toBe(true);

    const decoded = decodeWeWorkClipboardBuffer(bplist);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({
      serverId: "900012345",
      conversationType: 1,
      conversationId: "R:1970325000123456",
      sequence: "42",
      senderId: "1688850001234567",
      contentType: 2,
      sendTime: 1732550400,
      previewText: "今晚 8 点发布 v0.18",
    });

    const formatted = readWeWorkClipboardPaste(
      makeClipboardReader({ [WEWORK_PASTEBOARD_REPORT_KEY]: bplist }),
      "darwin",
      "今晚 8 点发布 v0.18",
    );
    expect(formatted).toContain("> 今晚 8 点发布 v0.18");
    expect(formatted).toContain(
      "- conversation_id: R:1970325000123456, server_id: 900012345, sequence: 42, sender_id: 1688850001234567, send_time: 1732550400 (2024-11-25 16:00:00Z)",
    );
    expect(formatted).toContain(
      "[企业微信消息，如需上下文可用 wxwork 按 conversation_id/send_time 查询，未命中先同步]",
    );
  });

  it("decodes multiple messages (including DM S: prefix) in one pasteboard array", () => {
    const msg1 = Buffer.concat([
      encodeVarintField(2, 1001),
      encodeVarintField(3, 0), // DM -> S:
      encodeVarintField(4, 16888500999n),
      encodeVarintField(5, 10),
      encodeVarintField(6, 16888500111n),
      encodeVarintField(8, 1732550400),
      encodeBytesField(10, encodeBytesField(1, "第一条消息")),
    ]);
    const msg2 = Buffer.concat([
      encodeVarintField(2, 1002),
      encodeVarintField(3, 0),
      encodeVarintField(4, 16888500999n),
      encodeVarintField(5, 11),
      encodeVarintField(6, 16888500222n),
      encodeVarintField(8, 1732550460),
      encodeBytesField(10, encodeBytesField(1, "第二条消息")),
    ]);
    const bplist = buildBinaryPlistDataArray([msg1, msg2]);

    const formatted = readWeWorkClipboardPaste(
      makeClipboardReader({ [WEWORK_PASTEBOARD_REPORT_KEY]: bplist }),
      "darwin",
      "",
    );
    expect(formatted).toContain("- 第一条消息 (conversation_id: S:16888500999, server_id: 1001");
    expect(formatted).toContain("- 第二条消息 (conversation_id: S:16888500999, server_id: 1002");
  });

  it("extracts readable UTF-8 preview from rich card payload when plain text is empty, and falls back to [富文本/卡片消息] for opaque payloads", () => {
    const cardWithText = Buffer.concat([
      encodeVarintField(2, 555),
      encodeVarintField(3, 1),
      encodeVarintField(4, 88888),
      encodeVarintField(8, 1732550400),
      encodeBytesField(
        10,
        Buffer.concat([
          encodeBytesField(1, "审批通知：生产发布申请"),
          encodeBytesField(2, "点击查看详情"),
        ]),
      ),
    ]);
    const formattedCard = readWeWorkClipboardPaste(
      makeClipboardReader({
        [WEWORK_PASTEBOARD_REPORT_KEY]: buildBinaryPlistDataArray([cardWithText]),
      }),
      "darwin",
      "",
    );
    expect(formattedCard).toContain("> 审批通知：生产发布申请 · 点击查看详情");
    expect(formattedCard).toContain("conversation_id: R:88888");

    const opaqueCard = Buffer.concat([
      encodeVarintField(2, 556),
      encodeVarintField(3, 1),
      encodeVarintField(4, 88888),
      encodeVarintField(8, 1732550401),
      encodeBytesField(10, Uint8Array.from([0xff, 0xfe, 0x00, 0x01])),
    ]);
    const formattedOpaque = readWeWorkClipboardPaste(
      makeClipboardReader({
        [WEWORK_PASTEBOARD_REPORT_KEY]: buildBinaryPlistDataArray([opaqueCard]),
      }),
      "darwin",
      "",
    );
    expect(formattedOpaque).toContain("> [富文本/卡片消息]");
    expect(formattedOpaque).toContain("conversation_id: R:88888");
  });

  it("handles drag-selected partial text (empty bplist array + WWKPrivatePBDataKey_Rich) with lightweight source hint", () => {
    const emptyBplist = buildBinaryPlistDataArray([]);
    const formatted = readWeWorkClipboardPaste(
      makeClipboardReader({
        [WEWORK_PASTEBOARD_REPORT_KEY]: emptyBplist,
        [WEWORK_PASTEBOARD_RICH_KEY]: Buffer.from("rich-fingerprint"),
      }),
      "darwin",
      "部分选中的报错日志片段",
    );

    expect(formatted).toBe(
      "部分选中的报错日志片段\n\n[来自企业微信，如需上下文可用 wxwork 按原句反查，未命中先同步]",
    );
  });

  it("silently falls back to null on corrupt data, non-WeWork clipboards, or non-darwin platforms", () => {
    expect(parseBinaryPlist(Buffer.from("not-a-bplist"))).toBeNull();
    expect(decodeWeWorkProtobufMessage(Uint8Array.from([0xff, 0xff, 0xff]))).toBeNull();
    expect(
      readWeWorkClipboardPaste(
        makeClipboardReader({ [WEWORK_PASTEBOARD_REPORT_KEY]: Buffer.from("corrupt-bytes") }),
        "darwin",
        "normal text",
      ),
    ).toBeNull();
    expect(
      readWeWorkClipboardPaste(makeClipboardReader({}), "darwin", "normal text"),
    ).toBeNull();

    const validPb = Buffer.concat([
      encodeVarintField(2, 1),
      encodeVarintField(3, 1),
      encodeVarintField(4, 2),
    ]);
    expect(
      readWeWorkClipboardPaste(
        makeClipboardReader({
          [WEWORK_PASTEBOARD_REPORT_KEY]: buildBinaryPlistDataArray([validPb]),
        }),
        "win32",
        "text",
      ),
    ).toBeNull();
  });

  it("reads WeWork pasteboard entries via Electron 44 async W3C clipboard API", async () => {
    const pb = Buffer.concat([
      encodeVarintField(2, 777),
      encodeVarintField(3, 1),
      encodeVarintField(4, 123456),
      encodeVarintField(8, 1732550400),
      encodeBytesField(10, encodeBytesField(1, "异步剪贴板测试")),
    ]);
    const bplist = buildBinaryPlistDataArray([pb]);
    const reportMime = osClipboardMimeType(WEWORK_PASTEBOARD_REPORT_KEY);

    const asyncClipboard = {
      has: async (mime: string) => mime === reportMime,
      read: async () => [
        {
          types: [reportMime],
          getType: async () => new Blob([new Uint8Array(bplist)]),
        },
      ],
      readText: async () => "",
    };

    const result = await readWeWorkClipboardPasteAsync(asyncClipboard, "darwin");
    expect(result).toContain("> 异步剪贴板测试");
    expect(result).toContain("conversation_id: R:123456");
  });

  it("reads structured WeWork clipboard data for single/multiple messages and partial selections", async () => {
    const pb1 = Buffer.concat([
      encodeVarintField(2, 900012345n),
      encodeVarintField(3, 1),
      encodeVarintField(4, 1970325000123456n),
      encodeVarintField(5, 42),
      encodeVarintField(6, 1688850001234567n),
      encodeVarintField(8, 1732550400),
      encodeBytesField(10, encodeBytesField(1, "今晚 8 点发布 v0.18")),
    ]);
    const singleData = readWeWorkClipboardData(
      makeClipboardReader({ [WEWORK_PASTEBOARD_REPORT_KEY]: buildBinaryPlistDataArray([pb1]) }),
      "darwin",
      "今晚 8 点发布 v0.18",
    );
    expect(singleData).toMatchObject({
      kind: "messages",
      title: "今晚 8 点发布 v0.18",
      subtitle: "R:1970325000123456 · 2024-11-25 16:00",
      plainText: "今晚 8 点发布 v0.18",
    });
    if (singleData?.kind === "messages") {
      expect(singleData.text).toContain("conversation_id: R:1970325000123456");
      expect(singleData.text).toContain("server_id: 900012345");
      expect(singleData.text).not.toContain("[来自企业微信");
      expect(singleData.messages).toHaveLength(1);
      expect("payload" in singleData.messages[0]!).toBe(false);
    }

    const pb2 = Buffer.concat([
      encodeVarintField(2, 900012346n),
      encodeVarintField(3, 1),
      encodeVarintField(4, 1970325000123456n),
      encodeVarintField(8, 1732550460),
      encodeBytesField(10, encodeBytesField(1, "收到")),
    ]);
    const multiData = readWeWorkClipboardData(
      makeClipboardReader({
        [WEWORK_PASTEBOARD_REPORT_KEY]: buildBinaryPlistDataArray([pb1, pb2]),
      }),
      "darwin",
      "",
    );
    expect(multiData).toMatchObject({
      kind: "messages",
      title: "2 条企业微信消息",
    });

    const partialData = readWeWorkClipboardData(
      makeClipboardReader({
        [WEWORK_PASTEBOARD_REPORT_KEY]: buildBinaryPlistDataArray([]),
        [WEWORK_PASTEBOARD_RICH_KEY]: Buffer.from("rich"),
      }),
      "darwin",
      "部分选中的报错日志片段",
    );
    expect(partialData).toEqual({
      kind: "partial",
      plainText: "部分选中的报错日志片段",
    });

    const richMime = osClipboardMimeType(WEWORK_PASTEBOARD_RICH_KEY);
    const asyncPartial = await readWeWorkClipboardDataAsync(
      {
        has: async (mime: string) => mime === richMime,
        read: async () => [],
        readText: async () => "异步选中文本",
      },
      "darwin",
    );
    expect(asyncPartial).toEqual({
      kind: "partial",
      plainText: "异步选中文本",
    });
  });

  it("builds clean wxwork query snippets from plain text and URLs", () => {
    expect(buildWxWorkQuerySnippet("  hello   world \n second line ")).toBe("hello world");
    expect(buildWxWorkQuerySnippet("https://git.woa.com/team/repo/merge_requests/123")).toBe(
      "https://git.woa.com/team/repo/merge_requests/123",
    );
    expect(buildWxWorkQuerySnippet("a")).toBeNull();
    expect(buildWxWorkQuerySnippet("   ")).toBeNull();
  });

  it("resolves partial WeWork paste via best-effort wxwork query and returns null on failure", async () => {
    const mockRunner: WxWorkCliRunner = async (args) => {
      expect(args).toEqual(["--format", "json", "messages", "query", "报错日志片段", "-n", "5"]);
      return JSON.stringify({
        ok: true,
        data: {
          messages: [
            {
              text: "刚才线上出现报错日志片段，请排查",
              ref: "wxwork-message:abc123",
              conversation_id: "R:10001",
              conversation_name: "发布值班群",
              sender: "张三",
              sender_id: "168885001",
              send_time: "2026-11-26T10:30:00+08:00",
            },
          ],
        },
      });
    };

    const resolved = await resolveWeWorkPaste(
      { kind: "partial", plainText: "报错日志片段" },
      mockRunner,
    );
    expect(resolved).toMatchObject({
      title: "刚才线上出现报错日志片段，请排查",
      subtitle: "发布值班群 · 张三 · 2026-11-26 10:30",
    });
    expect(resolved?.text).toContain("conversation_id: R:10001");
    expect(resolved?.text).toContain("ref: wxwork-message:abc123");

    // Offline / ES error / throwing runner must return null silently.
    const offlineRunner: WxWorkCliRunner = async () =>
      JSON.stringify({ ok: false, error: { code: "index_unavailable" } });
    expect(
      await resolveWeWorkPaste({ kind: "partial", plainText: "报错日志片段" }, offlineRunner),
    ).toBeNull();

    const throwingRunner: WxWorkCliRunner = async () => {
      throw new Error("ENOENT");
    };
    expect(
      await resolveWeWorkPaste({ kind: "partial", plainText: "报错日志片段" }, throwingRunner),
    ).toBeNull();
  });

  it("enriches structured WeWork messages via wxwork query and falls back to sessions", async () => {
    const queryRunner: WxWorkCliRunner = async (args) => {
      if (args[2] === "messages") {
        return JSON.stringify({
          ok: true,
          data: {
            messages: [
              {
                text: "今晚 8 点发布 v0.18",
                ref: "wxwork-message:m42",
                conversation_id: "R:1970325000123456",
                conversation_name: "AgentRuntime 研发群",
                sender: "李四",
                sender_id: "1688850001234567",
                server_id: "900012345",
                sequence: "42",
                send_time: "2024-11-25T24:00:00+08:00",
              },
            ],
          },
        });
      }
      return null;
    };

    const enriched = await resolveWeWorkPaste(
      {
        kind: "messages",
        title: "今晚 8 点发布 v0.18",
        subtitle: "R:1970325000123456 · 2024-11-25 16:00",
        text: "> 今晚 8 点发布 v0.18",
        plainText: "今晚 8 点发布 v0.18",
        messages: [
          {
            conversationId: "R:1970325000123456",
            serverId: "900012345",
            sequence: "42",
            senderId: "1688850001234567",
            sendTime: 1732550400,
          },
        ],
      },
      queryRunner,
    );
    expect(enriched?.subtitle).toContain("AgentRuntime 研发群");
    expect(enriched?.subtitle).toContain("李四");
    expect(enriched?.text).toContain("ref: wxwork-message:m42");

    // Fallback to sessions when messages query returns empty.
    const sessionsFallbackRunner: WxWorkCliRunner = async (args) => {
      if (args[2] === "messages") {
        return JSON.stringify({ ok: true, data: { messages: [] } });
      }
      if (args[2] === "sessions") {
        return JSON.stringify({
          ok: true,
          data: {
            sessions: [{ conversation_id: "R:1970325000123456", name: "核心群" }],
          },
        });
      }
      return null;
    };

    const sessionEnriched = await resolveWeWorkPaste(
      {
        kind: "messages",
        title: "2 条企业微信消息",
        subtitle: "R:1970325000123456 · 2024-11-25 16:00",
        text: "- msg1\n- msg2",
        plainText: "",
        messages: [
          { conversationId: "R:1970325000123456", sendTime: 1732550400 },
          { conversationId: "R:1970325000123456", sendTime: 1732550460 },
        ],
      },
      sessionsFallbackRunner,
    );
    expect(sessionEnriched?.subtitle).toBe("核心群 · 2024-11-25 16:00");
    expect(sessionEnriched?.text).toContain("会话: 核心群");
  });
});
