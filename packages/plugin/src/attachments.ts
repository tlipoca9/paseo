import type { PluginText } from "./text.js";
import { z } from "zod";
import { ResourcePreviewBlocksSchema } from "@getpaseo/protocol/resource-preview";
import type { PluginAttachmentSourceContribution } from "./contracts.js";

export function defineAttachmentSource<
  Definition extends PluginAttachmentSourceContribution<PluginText>,
>(definition: Definition): Definition {
  if ((definition.localResources || definition.filterOptions) && !definition.context) {
    throw new Error("Local resources and filter options require account context");
  }
  return definition;
}

export const PluginAttachmentItemSchema = z
  .object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    subtitle: z.string().optional(),
    url: z.url().optional(),
    text: z.string(),
    previewText: z.string().optional(),
    previewBlocks: ResourcePreviewBlocksSchema.optional(),
    resourceType: z.string(),
    source: z
      .object({
        scope: z.string().min(1),
        ref: z.string().min(1),
        label: z.string(),
      })
      .optional(),
  })
  .refine((item) => Boolean(item.url || item.source), {
    message: "Attachments require a URL or local source",
  });

export const PluginAttachmentSearchInputSchema = z.object({
  query: z.string(),
  scope: z.string().optional(),
  filters: z.record(z.string(), z.string()).optional(),
  cursor: z.string().optional(),
  group: z.string().optional(),
});

export const PluginAttachmentContextSchema = z.object({
  scope: z.string().min(1),
  options: z
    .record(z.string(), z.array(z.object({ value: z.string(), label: z.string() })))
    .optional(),
});

function validateResultState(
  value: {
    items: unknown[];
    status?: string;
    error?: { code: string; message: string };
    index?: { state: string };
    coverage?: { truncated: boolean; nextCursor?: string };
  },
  ctx: z.RefinementCtx,
) {
  const failed = value.status === "error" || value.status === "unavailable";
  if (failed !== Boolean(value.error))
    ctx.addIssue({ code: "custom", message: "Only failed results require an error" });
  if (value.status && value.status !== "ready" && value.items.length)
    ctx.addIssue({ code: "custom", message: "Non-ready results cannot contain selectable items" });
  if (value.index?.state === "preparing" && value.status !== "preparing")
    ctx.addIssue({ code: "custom", message: "Preparing index requires preparing status" });
  if (value.coverage?.nextCursor && !value.coverage.truncated)
    ctx.addIssue({ code: "custom", message: "A next cursor requires truncated coverage" });
}

export const PluginAttachmentSearchPayloadSchema = z
  .object({
    items: z.array(PluginAttachmentItemSchema),
    grouping: z
      .object({
        groups: z.array(
          z.object({
            id: z.string().min(1),
            title: z.string(),
            count: z.number().int().nonnegative(),
          }),
        ),
        total: z.number().int().nonnegative(),
        selectedId: z.string(),
        selectedTotal: z.number().int().nonnegative(),
        truncated: z.boolean(),
      })
      .optional(),
    coverage: z
      .object({
        truncated: z.boolean(),
        nextCursor: z.string().optional(),
      })
      .optional(),
    index: z
      .object({
        state: z.enum(["ready", "preparing"]),
        syncing: z.boolean().optional(),
        lastSuccessAt: z.string().optional(),
      })
      .optional(),
    status: z.enum(["ready", "preparing", "unavailable", "error"]).optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .superRefine(validateResultState);

export type PluginAttachmentSearchInput = z.infer<typeof PluginAttachmentSearchInputSchema>;
export type PluginAttachmentContext = z.infer<typeof PluginAttachmentContextSchema>;
export type PluginAttachmentItem = z.infer<typeof PluginAttachmentItemSchema>;
export type PluginAttachmentSearchPayload = z.infer<typeof PluginAttachmentSearchPayloadSchema>;

export const PluginAttachmentFilterOptionsInputSchema = z.object({
  scope: z.string().min(1),
  filterId: z.string().min(1),
  query: z.string(),
  cursor: z.string().optional(),
});
export const PluginAttachmentFilterOptionsPayloadSchema = z
  .object({
    scope: z.string().min(1),
    items: z.array(z.object({ value: z.string(), label: z.string() })),
    coverage: z.object({ truncated: z.boolean(), nextCursor: z.string().optional() }),
    status: z.enum(["ready", "preparing", "unavailable", "error"]).optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .superRefine(validateResultState);
export type PluginAttachmentFilterOptionsInput = z.infer<
  typeof PluginAttachmentFilterOptionsInputSchema
>;
export type PluginAttachmentFilterOptionsPayload = z.infer<
  typeof PluginAttachmentFilterOptionsPayloadSchema
>;
