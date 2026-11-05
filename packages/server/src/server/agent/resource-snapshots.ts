import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ResourceSnapshotReferenceSchema, TextAttachmentSchema } from "../messages.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
import {
  boundResourceSnapshotReference,
  limitAgentTimelineItemContent,
} from "./agent-timeline-content.js";
import type { AgentPromptInput } from "./agent-sdk-types.js";

const ResourceTextSchema = TextAttachmentSchema.refine(
  (item) => Boolean(item.localResource || item.externalResource),
  "A resource attachment needs its source",
);
const SnapshotSchema = z.object({
  agentId: z.string(),
  clientMessageId: z.string(),
  text: z.string(),
  attachments: z.array(ResourceTextSchema).min(1),
});
const ManifestSchema = z.object({
  agentId: z.string(),
  clientMessageId: z.string(),
  text: z.string(),
  sha256: z.string(),
  resourceSnapshot: ResourceSnapshotReferenceSchema,
  attachments: z.array(z.object({ totalBytes: z.number().int().positive(), sha256: z.string() })),
});
export type ResourceSnapshotInput = Pick<z.infer<typeof SnapshotSchema>, "text" | "attachments">;

export function resourceSnapshotFromPrompt(prompt: AgentPromptInput): ResourceSnapshotInput | null {
  if (typeof prompt === "string") return null;
  const attachments = prompt.flatMap((block) =>
    block.type === "text" && "mimeType" in block && (block.localResource || block.externalResource)
      ? [block]
      : [],
  );
  if (!attachments.length) return null;
  const text = prompt
    .flatMap((block) => (block.type === "text" && !("mimeType" in block) ? [block.text] : []))
    .join("\n")
    .trim();
  return { text, attachments };
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Immutable submission files keep state updates independent of transcript size. */
export class ResourceSnapshots {
  constructor(private readonly root: string) {}

  private directory(agentId: string): string {
    return path.join(this.root, hash(agentId));
  }

  private file(agentId: string, clientMessageId: string): string {
    return path.join(this.directory(agentId), hash(clientMessageId), "manifest.json");
  }

  private async read(agentId: string, clientMessageId: string) {
    try {
      const snapshot = ManifestSchema.parse(
        JSON.parse(await fs.readFile(this.file(agentId, clientMessageId), "utf8")),
      );
      if (snapshot.agentId !== agentId || snapshot.clientMessageId !== clientMessageId)
        throw new Error("Resource snapshot identity mismatch");
      return snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(
    agentId: string,
    clientMessageId: string,
    input: ResourceSnapshotInput,
  ): Promise<void> {
    const snapshot = SnapshotSchema.parse({ agentId, clientMessageId, ...input });
    const existing = await this.read(agentId, clientMessageId);
    if (existing) {
      if (existing.sha256 !== hash(JSON.stringify(snapshot)))
        throw new Error("Resource snapshot conflict for clientMessageId");
      return;
    }
    const manifestPath = this.file(agentId, clientMessageId);
    const attachments: Array<{ totalBytes: number; sha256: string }> = [];
    for (const [index, attachment] of snapshot.attachments.entries()) {
      const bytes = Buffer.from(JSON.stringify(attachment, null, 2), "utf8");
      await writeJsonFileAtomic(path.join(path.dirname(manifestPath), index + ".json"), attachment);
      attachments.push({ totalBytes: bytes.length, sha256: hash(bytes) });
    }
    const resourceSnapshot = boundResourceSnapshotReference({
      count: attachments.length,
      items: snapshot.attachments.slice(0, 8).map((attachment, index) => ({
        index,
        title: attachment.localResource?.title ?? attachment.externalResource!.title,
        sourceLabel:
          attachment.localResource?.source.label ?? attachment.externalResource!.providerLabel,
        excerpt: attachment.text,
        kind: attachment.localResource ? "local" : "external",
        url: attachment.externalResource?.url,
      })),
    });
    const projection = limitAgentTimelineItemContent({
      type: "user_message",
      text: snapshot.text,
      resourceSnapshot,
    });
    if (projection.type !== "user_message") throw new Error("Invalid resource snapshot projection");
    // The manifest is the commit marker. Partial writes cannot become readable snapshots.
    await writeJsonFileAtomic(manifestPath, {
      agentId,
      clientMessageId,
      text: projection.text,
      resourceSnapshot,
      sha256: hash(JSON.stringify(snapshot)),
      attachments,
    });
  }

  async projection(agentId: string, clientMessageId: string) {
    const snapshot = await this.read(agentId, clientMessageId);
    if (!snapshot) return null;
    return { text: snapshot.text, resourceSnapshot: snapshot.resourceSnapshot };
  }

  async chunk(
    agentId: string,
    clientMessageId: string,
    index: number,
    offset: number,
    limit: number,
  ) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 65536
    )
      throw new Error("Invalid resource snapshot range");
    const snapshot = await this.read(agentId, clientMessageId);
    const attachment = snapshot?.attachments[index];
    if (!attachment) throw new Error("Resource snapshot not found");
    if (offset >= attachment.totalBytes) throw new Error("Resource snapshot offset out of range");
    const nextOffset = Math.min(offset + limit, attachment.totalBytes);
    const file = await fs.open(
      path.join(path.dirname(this.file(agentId, clientMessageId)), index + ".json"),
      "r",
    );
    try {
      const bytes = Buffer.alloc(nextOffset - offset);
      let read = 0;
      while (read < bytes.length) {
        const result = await file.read(bytes, read, bytes.length - read, offset + read);
        if (result.bytesRead === 0) throw new Error("Incomplete resource snapshot file");
        read += result.bytesRead;
      }
      return {
        offset,
        nextOffset,
        totalBytes: attachment.totalBytes,
        sha256: attachment.sha256,
        encoding: "base64" as const,
        data: bytes.toString("base64"),
      };
    } finally {
      await file.close();
    }
  }

  async remove(agentId: string): Promise<void> {
    await fs.rm(this.directory(agentId), { recursive: true, force: true });
  }
}
