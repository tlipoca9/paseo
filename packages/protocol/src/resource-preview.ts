import { z } from "zod";

export const ResourcePreviewBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("markdown"), text: z.string() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("action"),
    label: z.string(),
    url: z.url({ protocol: /^https?$/ }).optional(),
  }),
]);

export const ResourcePreviewBlocksSchema = z.array(ResourcePreviewBlockSchema).min(1);
