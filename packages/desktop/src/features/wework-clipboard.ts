import { execFile } from "node:child_process";

const BPLIST_HEADER = "bplist00";
const BPLIST_TRAILER_SIZE = 32;
const MAX_BPLIST_OBJECTS = 100_000;
const MAX_PREVIEW_CHARS = 400;
const MAX_CARD_TITLE_CHARS = 60;
const WXWORK_RESOLVE_TIMEOUT_MS = 1500;
const WXWORK_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_QUERY_SNIPPET_CHARS = 80;

export const WEWORK_PASTEBOARD_REPORT_KEY = "WWKPrivatePBDataReportKey";
export const WEWORK_PASTEBOARD_RICH_KEY = "WWKPrivatePBDataKey_Rich";

export function osClipboardMimeType(format: string): string {
  return `electron application/osclipboard;format="${format}"`;
}

export interface WeWorkClipboardMessage {
  serverId?: string;
  conversationType?: number;
  conversationId: string;
  sequence?: string;
  senderId?: string;
  contentType?: number;
  sendTime?: number;
  payload?: Uint8Array;
  previewText?: string;
}

export type WeWorkClipboardMessageSummary = Omit<WeWorkClipboardMessage, "payload">;

export interface WeWorkClipboardMessagesData {
  kind: "messages";
  title: string;
  subtitle: string;
  text: string;
  messages: WeWorkClipboardMessageSummary[];
  plainText: string;
}

export interface WeWorkClipboardPartialData {
  kind: "partial";
  plainText: string;
}

export type WeWorkClipboardData = WeWorkClipboardMessagesData | WeWorkClipboardPartialData;

export interface ResolvedWeWorkPaste {
  title: string;
  subtitle: string;
  text: string;
}

export type WxWorkCliRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<string | null>;

export interface DesktopWeWorkClipboardReader {
  readBuffer(format: string): Buffer;
  readText?(): string;
}

export interface ElectronAsyncClipboardItemLike {
  readonly types: readonly string[];
  getType(type: string): Promise<Blob | unknown>;
}

export interface ElectronAsyncClipboardLike {
  has(mimetype: string): Promise<boolean>;
  read(): Promise<ElectronAsyncClipboardItemLike[]>;
  readText(): Promise<string>;
}

function readUIntBE(buf: Uint8Array, offset: number, byteLength: number): number | null {
  if (offset < 0 || offset + byteLength > buf.length) return null;
  if (byteLength === 1) return buf[offset]!;
  if (byteLength === 2) return (buf[offset]! << 8) | buf[offset + 1]!;
  if (byteLength === 4) {
    return (
      ((buf[offset]! * 0x1000000) >>> 0) +
      ((buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!)
    );
  }
  if (byteLength === 8) {
    let val = 0n;
    for (let i = 0; i < 8; i += 1) {
      val = (val << 8n) | BigInt(buf[offset + i]!);
    }
    if (val > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(val);
  }
  return null;
}

/**
 * Minimal zero-dependency parser for Apple binary property lists (`bplist00`).
 * Supports the types used by WeWork pasteboard payloads (Array, Data, String, Int, Dict, Bool/Null).
 */
export function parseBinaryPlist(input: Uint8Array): unknown {
  if (input.length < BPLIST_HEADER.length + BPLIST_TRAILER_SIZE) {
    return null;
  }
  for (let i = 0; i < BPLIST_HEADER.length; i += 1) {
    if (input[i] !== BPLIST_HEADER.charCodeAt(i)) {
      return null;
    }
  }

  const trailerOffset = input.length - BPLIST_TRAILER_SIZE;
  const offsetIntSize = input[trailerOffset + 6]!;
  const objectRefSize = input[trailerOffset + 7]!;
  if (![1, 2, 4, 8].includes(offsetIntSize) || ![1, 2, 4, 8].includes(objectRefSize)) {
    return null;
  }

  const numObjects = readUIntBE(input, trailerOffset + 8, 8);
  const topObject = readUIntBE(input, trailerOffset + 16, 8);
  const offsetTableOffset = readUIntBE(input, trailerOffset + 24, 8);
  if (
    numObjects === null ||
    topObject === null ||
    offsetTableOffset === null ||
    numObjects <= 0 ||
    numObjects > MAX_BPLIST_OBJECTS ||
    topObject >= numObjects ||
    offsetTableOffset < BPLIST_HEADER.length ||
    offsetTableOffset + numObjects * offsetIntSize > trailerOffset
  ) {
    return null;
  }

  const objectOffsets = new Array<number>(numObjects);
  for (let i = 0; i < numObjects; i += 1) {
    const objOffset = readUIntBE(input, offsetTableOffset + i * offsetIntSize, offsetIntSize);
    if (objOffset === null || objOffset < BPLIST_HEADER.length || objOffset >= offsetTableOffset) {
      return null;
    }
    objectOffsets[i] = objOffset;
  }

  const readObjectLength = (
    offset: number,
    info: number,
  ): { length: number; dataOffset: number } | null => {
    if (info !== 0x0f) {
      return { length: info, dataOffset: offset + 1 };
    }
    if (offset + 1 >= offsetTableOffset) return null;
    const intMarker = input[offset + 1]!;
    if ((intMarker & 0xf0) !== 0x10) return null;
    const intByteLength = 1 << (intMarker & 0x0f);
    if (![1, 2, 4, 8].includes(intByteLength)) return null;
    const length = readUIntBE(input, offset + 2, intByteLength);
    if (length === null) return null;
    return { length, dataOffset: offset + 2 + intByteLength };
  };

  const visiting = new Set<number>();

  const decodeObject = (index: number): unknown => {
    if (index < 0 || index >= numObjects || visiting.has(index)) {
      return undefined;
    }
    visiting.add(index);
    try {
      const offset = objectOffsets[index]!;
      const marker = input[offset]!;
      const type = marker >> 4;
      const info = marker & 0x0f;

      switch (type) {
        case 0x0: {
          if (info === 0x00) return null;
          if (info === 0x08) return false;
          if (info === 0x09) return true;
          return undefined;
        }
        case 0x1: {
          const intByteLength = 1 << info;
          if (![1, 2, 4, 8].includes(intByteLength)) return undefined;
          return readUIntBE(input, offset + 1, intByteLength) ?? undefined;
        }
        case 0x4: {
          const lenInfo = readObjectLength(offset, info);
          if (!lenInfo || lenInfo.dataOffset + lenInfo.length > offsetTableOffset) {
            return undefined;
          }
          return input.slice(lenInfo.dataOffset, lenInfo.dataOffset + lenInfo.length);
        }
        case 0x5: {
          const lenInfo = readObjectLength(offset, info);
          if (!lenInfo || lenInfo.dataOffset + lenInfo.length > offsetTableOffset) {
            return undefined;
          }
          return new TextDecoder("ascii").decode(
            input.subarray(lenInfo.dataOffset, lenInfo.dataOffset + lenInfo.length),
          );
        }
        case 0x6: {
          const lenInfo = readObjectLength(offset, info);
          const byteLen = lenInfo ? lenInfo.length * 2 : 0;
          if (!lenInfo || lenInfo.dataOffset + byteLen > offsetTableOffset) {
            return undefined;
          }
          return new TextDecoder("utf-16be").decode(
            input.subarray(lenInfo.dataOffset, lenInfo.dataOffset + byteLen),
          );
        }
        case 0xa: {
          const lenInfo = readObjectLength(offset, info);
          if (
            !lenInfo ||
            lenInfo.dataOffset + lenInfo.length * objectRefSize > offsetTableOffset
          ) {
            return undefined;
          }
          const result: unknown[] = [];
          for (let i = 0; i < lenInfo.length; i += 1) {
            const ref = readUIntBE(
              input,
              lenInfo.dataOffset + i * objectRefSize,
              objectRefSize,
            );
            if (ref === null) return undefined;
            result.push(decodeObject(ref));
          }
          return result;
        }
        case 0xd: {
          const lenInfo = readObjectLength(offset, info);
          if (
            !lenInfo ||
            lenInfo.dataOffset + lenInfo.length * 2 * objectRefSize > offsetTableOffset
          ) {
            return undefined;
          }
          const dict: Record<string, unknown> = {};
          const valuesStart = lenInfo.dataOffset + lenInfo.length * objectRefSize;
          for (let i = 0; i < lenInfo.length; i += 1) {
            const keyRef = readUIntBE(
              input,
              lenInfo.dataOffset + i * objectRefSize,
              objectRefSize,
            );
            const valRef = readUIntBE(input, valuesStart + i * objectRefSize, objectRefSize);
            if (keyRef === null || valRef === null) return undefined;
            const key = decodeObject(keyRef);
            if (typeof key === "string") {
              dict[key] = decodeObject(valRef);
            }
          }
          return dict;
        }
        default:
          return undefined;
      }
    } finally {
      visiting.delete(index);
    }
  };

  return decodeObject(topObject) ?? null;
}

function readVarint(
  buf: Uint8Array,
  startOffset: number,
): { value: bigint; nextOffset: number } | null {
  let result = 0n;
  let shift = 0n;
  let offset = startOffset;
  while (offset < buf.length && shift <= 63n) {
    const byte = buf[offset]!;
    result |= BigInt(byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: offset };
    }
    shift += 7n;
  }
  return null;
}

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isReadablePreviewCandidate(text: string): boolean {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length < 2) return false;
  // Reject strings containing control characters or replacement chars.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd]/.test(cleaned)) return false;
  // Require at least two readable word/CJK characters.
  const meaningful = cleaned.match(/[\p{L}\p{N}]/gu);
  return (meaningful?.length ?? 0) >= 2;
}

function collectProtobufUtf8Strings(
  buf: Uint8Array,
  depth: number,
  out: string[],
  seen: Set<string>,
): boolean {
  if (depth > 4 || buf.length === 0) return false;
  let offset = 0;
  let fieldCount = 0;

  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    if (!tag) return false;
    offset = tag.nextOffset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNumber <= 0 || fieldNumber > 10_000) return false;
    fieldCount += 1;

    if (wireType === 0) {
      const val = readVarint(buf, offset);
      if (!val) return false;
      offset = val.nextOffset;
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) return false;
      offset += 8;
    } else if (wireType === 2) {
      const len = readVarint(buf, offset);
      if (!len || len.value > BigInt(buf.length - len.nextOffset)) return false;
      const byteLen = Number(len.value);
      const slice = buf.subarray(len.nextOffset, len.nextOffset + byteLen);
      offset = len.nextOffset + byteLen;
      if (slice.length === 0) continue;

      // Try nested protobuf first; if it does not parse cleanly as nested fields, treat as UTF-8 text.
      const nestedStrings: string[] = [];
      const parsedAsNested =
        slice.length >= 2 &&
        collectProtobufUtf8Strings(slice, depth + 1, nestedStrings, new Set(seen));
      if (parsedAsNested && nestedStrings.length > 0) {
        for (const str of nestedStrings) {
          if (!seen.has(str)) {
            seen.add(str);
            out.push(str);
          }
        }
        continue;
      }

      try {
        const decoded = strictUtf8Decoder.decode(slice).replace(/\s+/g, " ").trim();
        if (isReadablePreviewCandidate(decoded) && !seen.has(decoded)) {
          seen.add(decoded);
          out.push(decoded);
        }
      } catch {
        // Binary field, skip.
      }
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) return false;
      offset += 4;
    } else {
      return false;
    }
  }

  return fieldCount > 0 && offset === buf.length;
}

export function extractReadableTextFromPayload(payload: Uint8Array | undefined): string | null {
  if (!payload || payload.length === 0) return null;

  const collected: string[] = [];
  const seen = new Set<string>();
  const parsed = collectProtobufUtf8Strings(payload, 0, collected, seen);

  if (!parsed || collected.length === 0) {
    try {
      const direct = strictUtf8Decoder.decode(payload).replace(/\s+/g, " ").trim();
      if (isReadablePreviewCandidate(direct)) {
        collected.push(direct);
      }
    } catch {
      // Not direct UTF-8.
    }
  }

  if (collected.length === 0) return null;
  const joined = collected.join(" · ").trim();
  if (joined.length <= MAX_PREVIEW_CHARS) return joined;
  return `${joined.slice(0, MAX_PREVIEW_CHARS - 1)}…`;
}

/**
 * Decode a single protobuf-encoded WeWork clipboard message from `WWKPrivatePBDataReportKey`.
 */
export function decodeWeWorkProtobufMessage(buf: Uint8Array): WeWorkClipboardMessage | null {
  if (buf.length === 0) return null;

  let offset = 0;
  let serverId: string | undefined;
  let conversationType: number | undefined;
  let conversationIdNum: string | undefined;
  let sequence: string | undefined;
  let senderId: string | undefined;
  let contentType: number | undefined;
  let sendTime: number | undefined;
  let payload: Uint8Array | undefined;

  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    if (!tag) return null;
    offset = tag.nextOffset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNumber <= 0) return null;

    if (wireType === 0) {
      const val = readVarint(buf, offset);
      if (!val) return null;
      offset = val.nextOffset;
      switch (fieldNumber) {
        case 2:
          serverId = val.value.toString();
          break;
        case 3:
          conversationType = Number(val.value);
          break;
        case 4:
          conversationIdNum = val.value.toString();
          break;
        case 5:
          sequence = val.value.toString();
          break;
        case 6:
          senderId = val.value.toString();
          break;
        case 7:
          contentType = Number(val.value);
          break;
        case 8:
          sendTime = Number(val.value);
          break;
        default:
          break;
      }
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) return null;
      offset += 8;
    } else if (wireType === 2) {
      const len = readVarint(buf, offset);
      if (!len || len.value > BigInt(buf.length - len.nextOffset)) return null;
      const byteLen = Number(len.value);
      const slice = buf.subarray(len.nextOffset, len.nextOffset + byteLen);
      offset = len.nextOffset + byteLen;
      if (fieldNumber === 10) {
        payload = slice;
      }
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) return null;
      offset += 4;
    } else {
      return null;
    }
  }

  if (!conversationIdNum || (!serverId && sendTime === undefined && !senderId)) {
    return null;
  }

  const prefix = conversationType === 1 ? "R:" : conversationType === 0 ? "S:" : "";
  const previewText = extractReadableTextFromPayload(payload) ?? undefined;

  return {
    ...(serverId ? { serverId } : {}),
    ...(conversationType !== undefined ? { conversationType } : {}),
    conversationId: `${prefix}${conversationIdNum}`,
    ...(sequence ? { sequence } : {}),
    ...(senderId ? { senderId } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
    ...(sendTime !== undefined ? { sendTime } : {}),
    ...(payload ? { payload } : {}),
    ...(previewText ? { previewText } : {}),
  };
}

export function decodeWeWorkClipboardBuffer(buffer: Uint8Array): WeWorkClipboardMessage[] {
  const parsed = parseBinaryPlist(buffer);
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed instanceof Uint8Array
      ? [parsed]
      : [];
  const messages: WeWorkClipboardMessage[] = [];
  for (const entry of entries) {
    if (!(entry instanceof Uint8Array)) continue;
    const decoded = decodeWeWorkProtobufMessage(entry);
    if (decoded) {
      messages.push(decoded);
    }
  }
  return messages;
}

function formatSendTime(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return String(unixSeconds);
  }
  const iso = new Date(unixSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
  return `${unixSeconds} (${iso})`;
}

function formatMessageMeta(message: WeWorkClipboardMessage): string {
  const parts = [`conversation_id: ${message.conversationId}`];
  if (message.serverId) parts.push(`server_id: ${message.serverId}`);
  if (message.sequence) parts.push(`sequence: ${message.sequence}`);
  if (message.senderId) parts.push(`sender_id: ${message.senderId}`);
  if (message.sendTime !== undefined) parts.push(`send_time: ${formatSendTime(message.sendTime)}`);
  return parts.join(", ");
}

function quoteLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

const WEWORK_HINT =
  "[企业微信消息，如需上下文可用 wxwork 按 conversation_id/send_time 查询，未命中先同步]";
const WEWORK_PARTIAL_SELECTION_HINT =
  "[来自企业微信，如需上下文可用 wxwork 按原句反查，未命中先同步]";

export function formatWeWorkPartialSelectionPaste(plainText?: string | null): string | null {
  const trimmed = plainText?.trim() ?? "";
  if (!trimmed) return null;
  return `${trimmed}\n\n${WEWORK_PARTIAL_SELECTION_HINT}`;
}

export function formatWeWorkClipboardPaste(
  messages: readonly WeWorkClipboardMessage[],
  plainText?: string | null,
): string | null {
  if (messages.length === 0) return null;
  const trimmedPlainText = plainText?.trim() ?? "";

  if (messages.length === 1) {
    const msg = messages[0]!;
    const body = trimmedPlainText || msg.previewText || "[富文本/卡片消息]";
    return [quoteLines(body), `- ${formatMessageMeta(msg)}`, WEWORK_HINT].join("\n");
  }

  const lines: string[] = [];
  if (trimmedPlainText) {
    lines.push(quoteLines(trimmedPlainText));
    for (const msg of messages) {
      lines.push(`- ${formatMessageMeta(msg)}`);
    }
  } else {
    for (const msg of messages) {
      const preview = msg.previewText || "[富文本/卡片消息]";
      lines.push(`- ${preview} (${formatMessageMeta(msg)})`);
    }
  }
  lines.push(WEWORK_HINT);
  return lines.join("\n");
}

export function readWeWorkClipboardPaste(
  clipboardReader: DesktopWeWorkClipboardReader,
  platform: string,
  plainText?: string,
): string | null {
  if (platform !== "darwin") return null;
  try {
    const rawReport = clipboardReader.readBuffer(WEWORK_PASTEBOARD_REPORT_KEY);
    const hasReport = Boolean(rawReport && rawReport.length > 0);
    const parsedReport = hasReport ? parseBinaryPlist(rawReport) : null;
    const messages = hasReport ? decodeWeWorkClipboardBuffer(rawReport) : [];

    const effectivePlainText =
      plainText !== undefined && plainText.length > 0
        ? plainText
        : (clipboardReader.readText?.() ?? "");

    if (messages.length > 0) {
      return formatWeWorkClipboardPaste(messages, effectivePlainText);
    }

    // Drag-selected partial text in WeWork writes an empty bplist array in
    // WWKPrivatePBDataReportKey and/or WWKPrivatePBDataKey_Rich alongside plain text.
    const rawRich = clipboardReader.readBuffer(WEWORK_PASTEBOARD_RICH_KEY);
    const hasRich = Boolean(rawRich && rawRich.length > 0);
    const hasValidEmptyReport = Array.isArray(parsedReport) && parsedReport.length === 0;
    if (hasValidEmptyReport || hasRich) {
      return formatWeWorkPartialSelectionPaste(effectivePlainText);
    }

    return null;
  } catch {
    return null;
  }
}

async function readOsClipboardFormatBytes(
  items: readonly ElectronAsyncClipboardItemLike[],
  format: string,
): Promise<Uint8Array | null> {
  const mime = osClipboardMimeType(format);
  for (const item of items) {
    if (!item.types.includes(mime)) continue;
    try {
      const value = await item.getType(mime);
      if (value instanceof Blob) {
        const bytes = new Uint8Array(await value.arrayBuffer());
        if (bytes.length > 0) return bytes;
      }
    } catch {
      // Ignore unreadable clipboard entries.
    }
  }
  return null;
}

function isSyncClipboardReader(
  clipboard: ElectronAsyncClipboardLike | DesktopWeWorkClipboardReader,
): clipboard is DesktopWeWorkClipboardReader {
  return "readBuffer" in clipboard && typeof clipboard.readBuffer === "function";
}

/**
 * Async reader compatible with Electron 44's W3C-style `clipboard` API (`has`/`read`/`readText`)
 * as well as legacy `readBuffer` mocks.
 */
export async function readWeWorkClipboardPasteAsync(
  clipboard: ElectronAsyncClipboardLike | DesktopWeWorkClipboardReader,
  platform: string,
  plainText?: string,
): Promise<string | null> {
  if (platform !== "darwin") return null;
  if (isSyncClipboardReader(clipboard)) {
    return readWeWorkClipboardPaste(clipboard, platform, plainText);
  }
  try {
    const reportMime = osClipboardMimeType(WEWORK_PASTEBOARD_REPORT_KEY);
    const richMime = osClipboardMimeType(WEWORK_PASTEBOARD_RICH_KEY);
    const [hasReport, hasRich] = await Promise.all([
      clipboard.has(reportMime),
      clipboard.has(richMime),
    ]);
    if (!hasReport && !hasRich) return null;

    const items = await clipboard.read();
    const rawReport = hasReport
      ? await readOsClipboardFormatBytes(items, WEWORK_PASTEBOARD_REPORT_KEY)
      : null;
    const parsedReport = rawReport ? parseBinaryPlist(rawReport) : null;
    const messages = rawReport ? decodeWeWorkClipboardBuffer(rawReport) : [];

    const effectivePlainText =
      plainText !== undefined && plainText.length > 0
        ? plainText
        : await clipboard.readText().catch(() => "");

    if (messages.length > 0) {
      return formatWeWorkClipboardPaste(messages, effectivePlainText);
    }

    const hasValidEmptyReport = Array.isArray(parsedReport) && parsedReport.length === 0;
    if (hasValidEmptyReport || hasRich) {
      return formatWeWorkPartialSelectionPaste(effectivePlainText);
    }
    return null;
  } catch {
    return null;
  }
}

function toMessageSummary(message: WeWorkClipboardMessage): WeWorkClipboardMessageSummary {
  const { payload: _payload, ...summary } = message;
  return summary;
}

function truncateCardTitle(raw: string, fallback = "企业微信消息"): string {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find((line) => line.length > 0) ?? "";
  if (!firstLine) return fallback;
  if (firstLine.length <= MAX_CARD_TITLE_CHARS) return firstLine;
  return `${firstLine.slice(0, MAX_CARD_TITLE_CHARS - 1)}…`;
}

function formatShortTime(value: number | string | undefined): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const iso = new Date(value * 1000).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    if (match) return `${match[1]} ${match[2]}`;
    const parsedNum = Number(trimmed);
    if (Number.isFinite(parsedNum) && parsedNum > 0) {
      return formatShortTime(parsedNum);
    }
    return trimmed;
  }
  return null;
}

function buildWeWorkMessagesData(
  messages: readonly WeWorkClipboardMessage[],
  plainText: string,
): WeWorkClipboardMessagesData {
  const trimmedPlainText = plainText.trim();
  const primary = messages[0]!;
  const title =
    messages.length === 1
      ? truncateCardTitle(trimmedPlainText || primary.previewText || "")
      : `${messages.length} 条企业微信消息`;

  const shortTime = formatShortTime(primary.sendTime);
  const subtitle = [primary.conversationId, shortTime].filter(Boolean).join(" · ");

  const lines: string[] = [];
  if (messages.length === 1) {
    const body = trimmedPlainText || primary.previewText || "[富文本/卡片消息]";
    lines.push(quoteLines(body));
    lines.push("");
    lines.push(`- ${formatMessageMeta(primary)}`);
  } else if (trimmedPlainText) {
    lines.push(quoteLines(trimmedPlainText));
    lines.push("");
    for (const msg of messages) {
      lines.push(`- ${formatMessageMeta(msg)}`);
    }
  } else {
    for (const msg of messages) {
      const preview = msg.previewText || "[富文本/卡片消息]";
      lines.push(`- ${preview} (${formatMessageMeta(msg)})`);
    }
  }
  lines.push("");
  lines.push("如需上下文，可用 `wxwork` 按 `conversation_id` 和 `send_time` 查询。");

  return {
    kind: "messages",
    title,
    subtitle,
    text: lines.join("\n"),
    messages: messages.map(toMessageSummary),
    plainText,
  };
}

export function readWeWorkClipboardData(
  clipboardReader: DesktopWeWorkClipboardReader,
  platform: string,
  plainText?: string,
): WeWorkClipboardData | null {
  if (platform !== "darwin") return null;
  try {
    const rawReport = clipboardReader.readBuffer(WEWORK_PASTEBOARD_REPORT_KEY);
    const hasReport = Boolean(rawReport && rawReport.length > 0);
    const parsedReport = hasReport ? parseBinaryPlist(rawReport) : null;
    const messages = hasReport ? decodeWeWorkClipboardBuffer(rawReport) : [];

    const effectivePlainText =
      plainText !== undefined && plainText.length > 0
        ? plainText
        : (clipboardReader.readText?.() ?? "");

    if (messages.length > 0) {
      return buildWeWorkMessagesData(messages, effectivePlainText);
    }

    const rawRich = clipboardReader.readBuffer(WEWORK_PASTEBOARD_RICH_KEY);
    const hasRich = Boolean(rawRich && rawRich.length > 0);
    const hasValidEmptyReport = Array.isArray(parsedReport) && parsedReport.length === 0;
    if ((hasValidEmptyReport || hasRich) && effectivePlainText.trim().length > 0) {
      return { kind: "partial", plainText: effectivePlainText };
    }

    return null;
  } catch {
    return null;
  }
}

export async function readWeWorkClipboardDataAsync(
  clipboard: ElectronAsyncClipboardLike | DesktopWeWorkClipboardReader,
  platform: string,
  plainText?: string,
): Promise<WeWorkClipboardData | null> {
  if (platform !== "darwin") return null;
  if (isSyncClipboardReader(clipboard)) {
    return readWeWorkClipboardData(clipboard, platform, plainText);
  }
  try {
    const reportMime = osClipboardMimeType(WEWORK_PASTEBOARD_REPORT_KEY);
    const richMime = osClipboardMimeType(WEWORK_PASTEBOARD_RICH_KEY);
    const [hasReport, hasRich] = await Promise.all([
      clipboard.has(reportMime),
      clipboard.has(richMime),
    ]);
    if (!hasReport && !hasRich) return null;

    const items = await clipboard.read();
    const rawReport = hasReport
      ? await readOsClipboardFormatBytes(items, WEWORK_PASTEBOARD_REPORT_KEY)
      : null;
    const parsedReport = rawReport ? parseBinaryPlist(rawReport) : null;
    const messages = rawReport ? decodeWeWorkClipboardBuffer(rawReport) : [];

    const effectivePlainText =
      plainText !== undefined && plainText.length > 0
        ? plainText
        : await clipboard.readText().catch(() => "");

    if (messages.length > 0) {
      return buildWeWorkMessagesData(messages, effectivePlainText);
    }

    const hasValidEmptyReport = Array.isArray(parsedReport) && parsedReport.length === 0;
    if ((hasValidEmptyReport || hasRich) && effectivePlainText.trim().length > 0) {
      return { kind: "partial", plainText: effectivePlainText };
    }
    return null;
  } catch {
    return null;
  }
}

export function buildWxWorkQuerySnippet(plainText: string): string | null {
  const trimmed = plainText.trim();
  if (!trimmed) return null;

  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    const cleanedUrl = trimmed.replace(/[),.;!?]+$/, "");
    if (cleanedUrl.length <= MAX_QUERY_SNIPPET_CHARS) {
      return cleanedUrl.length >= 2 ? cleanedUrl : null;
    }
    try {
      const parsed = new URL(cleanedUrl);
      const compact = `${parsed.host}${parsed.pathname}`.replace(/\/+$/, "");
      const candidate = compact.length >= 2 ? compact : cleanedUrl;
      return candidate.slice(0, MAX_QUERY_SNIPPET_CHARS);
    } catch {
      return cleanedUrl.slice(0, MAX_QUERY_SNIPPET_CHARS);
    }
  }

  const firstLine =
    trimmed
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find((line) => line.length > 0) ?? "";
  if (firstLine.length < 2) return null;
  return firstLine.slice(0, MAX_QUERY_SNIPPET_CHARS).trim();
}

interface WxWorkRecord {
  text?: string;
  ref?: string;
  conversationId?: string;
  conversationName?: string;
  senderName?: string;
  senderId?: string;
  sendTime?: string | number;
  serverId?: string;
  sequence?: string;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function parseWxWorkRecord(raw: unknown): WxWorkRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const text = asNonEmptyString(obj.text) ?? asNonEmptyString(obj.content);
  const ref = asNonEmptyString(obj.ref);
  const conversationId =
    asNonEmptyString(obj.conversation_id) ??
    asNonEmptyString(obj.chat_id) ??
    asNonEmptyString(obj.session_id);
  const conversationName =
    asNonEmptyString(obj.conversation_name) ??
    asNonEmptyString(obj.chat_name) ??
    asNonEmptyString(obj.session_name) ??
    asNonEmptyString(obj.conversation) ??
    asNonEmptyString(obj.chat);
  const senderName =
    asNonEmptyString(obj.sender_name) ?? asNonEmptyString(obj.sender);
  const senderId = asNonEmptyString(obj.sender_id);
  const rawSendTime = obj.send_time ?? obj.timestamp ?? obj.created_at;
  const sendTime =
    typeof rawSendTime === "number" || typeof rawSendTime === "string"
      ? rawSendTime
      : undefined;
  const serverId = asNonEmptyString(obj.server_id);
  const sequence = asNonEmptyString(obj.sequence);
  return {
    ...(text ? { text } : {}),
    ...(ref ? { ref } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(conversationName ? { conversationName } : {}),
    ...(senderName ? { senderName } : {}),
    ...(senderId ? { senderId } : {}),
    ...(sendTime !== undefined ? { sendTime } : {}),
    ...(serverId ? { serverId } : {}),
    ...(sequence ? { sequence } : {}),
  };
}

function parseWxWorkQueryItems(stdout: string): WxWorkRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const envelope = parsed as { ok?: unknown; data?: Record<string, unknown> };
  if (envelope.ok !== true || !envelope.data || typeof envelope.data !== "object") {
    return [];
  }
  const rawItems = Array.isArray(envelope.data.messages)
    ? envelope.data.messages
    : Array.isArray(envelope.data.items)
      ? envelope.data.items
      : [];
  const records: WxWorkRecord[] = [];
  for (const item of rawItems) {
    const rec = parseWxWorkRecord(item);
    if (rec) records.push(rec);
  }
  return records;
}

function parseWxWorkSessionName(stdout: string, conversationId: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const envelope = parsed as { ok?: unknown; data?: Record<string, unknown> };
  if (envelope.ok !== true || !envelope.data || typeof envelope.data !== "object") {
    return null;
  }
  const rawSessions = Array.isArray(envelope.data.sessions)
    ? envelope.data.sessions
    : Array.isArray(envelope.data.items)
      ? envelope.data.items
      : [];
  for (const entry of rawSessions) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const id =
      asNonEmptyString(obj.conversation_id) ??
      asNonEmptyString(obj.chat_id) ??
      asNonEmptyString(obj.id);
    if (id !== conversationId) continue;
    const name =
      asNonEmptyString(obj.name) ??
      asNonEmptyString(obj.conversation_name) ??
      asNonEmptyString(obj.title);
    if (name) return name;
  }
  return null;
}

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function sendTimeEpoch(value: number | string | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return 0;
}

function buildResolvedCardFromRecord(
  record: WxWorkRecord,
  fallbackBody: string,
  fallbackMeta?: WeWorkClipboardMessageSummary,
): ResolvedWeWorkPaste {
  const body = record.text || fallbackBody || "[富文本/卡片消息]";
  const title = truncateCardTitle(body);
  const convLabel = record.conversationName || record.conversationId || fallbackMeta?.conversationId;
  const senderLabel = record.senderName || record.senderId || fallbackMeta?.senderId;
  const shortTime = formatShortTime(record.sendTime ?? fallbackMeta?.sendTime);
  const subtitle = [convLabel, senderLabel, shortTime].filter(Boolean).join(" · ");

  const metaParts: string[] = [];
  if (record.conversationName) metaParts.push(`conversation: ${record.conversationName}`);
  const convId = record.conversationId ?? fallbackMeta?.conversationId;
  if (convId) metaParts.push(`conversation_id: ${convId}`);
  if (record.ref) metaParts.push(`ref: ${record.ref}`);
  if (record.senderName) {
    const sId = record.senderId ?? fallbackMeta?.senderId;
    metaParts.push(
      sId && sId !== record.senderName
        ? `sender: ${record.senderName} (${sId})`
        : `sender: ${record.senderName}`,
    );
  } else if (record.senderId ?? fallbackMeta?.senderId) {
    metaParts.push(`sender_id: ${record.senderId ?? fallbackMeta?.senderId}`);
  }
  const serverId = record.serverId ?? fallbackMeta?.serverId;
  if (serverId) metaParts.push(`server_id: ${serverId}`);
  const sequence = record.sequence ?? fallbackMeta?.sequence;
  if (sequence) metaParts.push(`sequence: ${sequence}`);
  if (record.sendTime !== undefined) {
    metaParts.push(
      `send_time: ${typeof record.sendTime === "number" ? formatSendTime(record.sendTime) : record.sendTime}`,
    );
  } else if (fallbackMeta?.sendTime !== undefined) {
    metaParts.push(`send_time: ${formatSendTime(fallbackMeta.sendTime)}`);
  }

  const lines = [
    quoteLines(body),
    "",
    `- ${metaParts.join(", ")}`,
    "",
    "如需上下文，可用 `wxwork` 按 `conversation_id` / `ref` 查询。",
  ];

  return {
    title,
    subtitle,
    text: lines.join("\n"),
  };
}

const defaultWxWorkRunner: WxWorkCliRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const child = execFile(
      "wxwork",
      [...args],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: WXWORK_MAX_BUFFER_BYTES,
      },
      (error, stdout) => {
        if (error || !stdout) {
          finish(null);
          return;
        }
        finish(stdout);
      },
    );

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Ignore kill failures.
      }
      finish(null);
    }, timeoutMs);
  });

/**
 * Best-effort local `wxwork` enrichment for pasted WeWork messages/selections.
 * Never throws and enforces a strict timeout so pasting is never blocked.
 */
export async function resolveWeWorkPaste(
  input: WeWorkClipboardData,
  runner: WxWorkCliRunner = defaultWxWorkRunner,
  timeoutMs = WXWORK_RESOLVE_TIMEOUT_MS,
): Promise<ResolvedWeWorkPaste | null> {
  const deadline = Date.now() + timeoutMs;
  const remainingMs = () => Math.max(0, deadline - Date.now());

  try {
    if (input.kind === "partial") {
      const snippet = buildWxWorkQuerySnippet(input.plainText);
      if (!snippet) return null;
      const stdout = await runner(
        ["--format", "json", "messages", "query", snippet, "-n", "5"],
        remainingMs(),
      );
      if (!stdout) return null;

      const items = parseWxWorkQueryItems(stdout);
      if (items.length === 0) return null;

      const normalizedPlain = normalizeForMatch(input.plainText);
      const normalizedSnippet = normalizeForMatch(snippet);
      const matching = items.filter((item) => {
        if (!item.text) return false;
        const normalizedText = normalizeForMatch(item.text);
        return (
          normalizedText.includes(normalizedPlain) || normalizedText.includes(normalizedSnippet)
        );
      });
      if (matching.length === 0) return null;

      matching.sort((a, b) => sendTimeEpoch(b.sendTime) - sendTimeEpoch(a.sendTime));
      return buildResolvedCardFromRecord(matching[0]!, input.plainText);
    }

    if (input.kind === "messages") {
      const primary = input.messages[0];
      if (!primary) return null;

      const snippet = buildWxWorkQuerySnippet(input.plainText || primary.previewText || "");
      const queryArgs = ["--format", "json", "messages", "query"];
      if (snippet) queryArgs.push(snippet);
      queryArgs.push("--in", primary.conversationId, "-n", "5");

      const stdout = await runner(queryArgs, remainingMs());
      const items = stdout ? parseWxWorkQueryItems(stdout) : [];

      const exactMatch =
        items.find(
          (item) =>
            (primary.serverId && item.serverId === primary.serverId) ||
            (primary.sequence && item.sequence === primary.sequence),
        ) ??
        items.find((item) => {
          if (!snippet || !item.text) return false;
          return normalizeForMatch(item.text).includes(normalizeForMatch(snippet));
        }) ??
        null;

      let conversationName =
        exactMatch?.conversationName ??
        items.find((item) => item.conversationName)?.conversationName ??
        null;

      if (!conversationName && remainingMs() >= 300) {
        const sessionsStdout = await runner(
          ["--format", "json", "sessions", "-n", "50"],
          remainingMs(),
        );
        if (sessionsStdout) {
          conversationName = parseWxWorkSessionName(sessionsStdout, primary.conversationId);
        }
      }

      if (input.messages.length === 1 && exactMatch) {
        const enriched: WxWorkRecord = {
          ...exactMatch,
          ...(conversationName && !exactMatch.conversationName ? { conversationName } : {}),
        };
        if (enriched.conversationName || enriched.senderName || enriched.ref) {
          return buildResolvedCardFromRecord(
            enriched,
            input.plainText || primary.previewText || "",
            primary,
          );
        }
      }

      if (conversationName) {
        const shortTime = formatShortTime(primary.sendTime);
        const senderLabel =
          input.messages.length === 1
            ? (exactMatch?.senderName ?? undefined)
            : undefined;
        const subtitle = [conversationName, senderLabel, shortTime].filter(Boolean).join(" · ");
        const text = `会话: ${conversationName}\n\n${input.text}`;
        return {
          title: input.title,
          subtitle,
          text,
        };
      }

      return null;
    }

    return null;
  } catch {
    return null;
  }
}
