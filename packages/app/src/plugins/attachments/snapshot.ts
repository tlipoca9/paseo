import { TextAttachmentSchema } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

type SnapshotRequest = Pick<
  Parameters<DaemonClient["readResourceSnapshotChunk"]>[0],
  "agentId" | "clientMessageId" | "index"
>;

export async function readResourceAttachment({
  request,
  read,
  sha256,
  signal,
}: {
  request: SnapshotRequest;
  read: DaemonClient["readResourceSnapshotChunk"];
  sha256: (text: string) => Promise<string>;
  signal: AbortSignal;
}) {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let totalBytes = 0;
  let digest: string | undefined;
  do {
    signal.throwIfAborted();
    const chunk = await read({ ...request, offset, limit: 65536 });
    signal.throwIfAborted();
    const bytes = Uint8Array.from(atob(chunk.data), (character) => character.charCodeAt(0));
    validateChunk(chunk, offset, bytes, totalBytes, digest);
    totalBytes = chunk.totalBytes;
    digest = chunk.sha256;
    chunks.push(bytes);
    offset = chunk.nextOffset;
  } while (offset < totalBytes);
  const bytes = new Uint8Array(totalBytes);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.length;
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  // Hermes' TextDecoder polyfill ignores fatal; round-tripping rejects replacement decoding too.
  const encoded = new TextEncoder().encode(text);
  if (
    encoded.length !== bytes.length ||
    encoded.some((byte, index) => byte !== bytes[index]) ||
    (await sha256(text)) !== digest
  )
    throw new Error("Resource snapshot integrity check failed");
  signal.throwIfAborted();
  const attachment = TextAttachmentSchema.parse(JSON.parse(text));
  if (!attachment.localResource && !attachment.externalResource)
    throw new Error("Resource snapshot source is missing");
  return attachment;
}

function validateChunk(
  chunk: Awaited<ReturnType<DaemonClient["readResourceSnapshotChunk"]>>,
  offset: number,
  bytes: Uint8Array,
  totalBytes: number,
  digest: string | undefined,
) {
  if (
    chunk.encoding !== "base64" ||
    chunk.offset !== offset ||
    !Number.isSafeInteger(chunk.nextOffset) ||
    !Number.isSafeInteger(chunk.totalBytes) ||
    chunk.totalBytes <= 0 ||
    chunk.nextOffset <= offset ||
    chunk.nextOffset > chunk.totalBytes ||
    bytes.length !== chunk.nextOffset - offset ||
    bytes.length > 65536 ||
    (totalBytes !== 0 && totalBytes !== chunk.totalBytes) ||
    (digest !== undefined && digest !== chunk.sha256)
  )
    throw new Error("Invalid resource snapshot chunk");
}
