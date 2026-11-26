const BPLIST_HEADER = "bplist00";
const BPLIST_TRAILER_SIZE = 32;
const MAX_BPLIST_OBJECTS = 100_000;
const MAX_PREVIEW_CHARS = 400;

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
