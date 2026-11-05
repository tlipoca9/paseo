import { describe, expect, expectTypeOf, it } from "vitest";
import type { ComponentProps } from "react";
import type {
  StreamedText,
  StreamedTextProps,
  Modal,
  ModalProps,
  SettingsSection,
  SettingsSectionProps,
} from "./ui.js";
import { z } from "zod";
import {
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  defineAttachmentSource,
  defineRpc,
  type RpcInput,
  type RpcOutput,
} from "../index.js";
import {
  callPluginRpc,
  searchPluginAttachments,
  loadPluginAttachmentContext,
  searchPluginAttachmentFilterOptions,
} from "./host.js";

const contract = defineRpc({
  name: "increment",
  input: z.unknown().pipe(z.object({ value: z.number() })),
  output: z.object({ value: z.number() }),
});

describe("plugin RPC contracts", () => {
  it("derives handler input and output types from a contract", () => {
    expectTypeOf<RpcInput<typeof contract>>().toEqualTypeOf<{ value: number }>();
    expectTypeOf<RpcOutput<typeof contract>>().toEqualTypeOf<{ value: number }>();
  });

  it("sends input unchanged for the plugin to parse", async () => {
    let parses = 0;
    const transformed = defineRpc({
      name: "transformed",
      input: z.string().transform((text) => {
        parses += 1;
        return Number(text);
      }),
      output: z.number(),
    });
    const invoke = async (_method: string, input: unknown) => {
      expect(input).toBe("2");
      expect(parses).toBe(0);
      return transformed.input.parseAsync(input);
    };
    await expect(callPluginRpc(transformed, invoke, "2")).resolves.toBe(2);
    expect(parses).toBe(1);
  });

  it("validates output before resolving", async () => {
    const invoke = async () => ({ value: "wrong" });

    await expect(callPluginRpc(contract, invoke, { value: 1 })).rejects.toBeInstanceOf(z.ZodError);
  });

  it("returns parsed output for a valid invocation", async () => {
    const invoke = async (method: string, input: unknown) => ({
      value: method === "increment" && typeof input === "object" ? 2 : 0,
    });

    await expect(callPluginRpc(contract, invoke, { value: 1 })).resolves.toEqual({ value: 2 });
  });
});

describe("plugin attachment sources", () => {
  it("requires account context for local resources and remote filter options", () => {
    const source = {
      id: "messages",
      title: "Messages",
      icon: "CircleDot",
      pickerTitle: "Messages",
      searchPlaceholder: "Search",
      search: contract,
    };
    expect(() => defineAttachmentSource({ ...source, localResources: true })).toThrow("context");
    expect(() => defineAttachmentSource({ ...source, filterOptions: contract })).toThrow("context");
  });
  it("distinguishes ready, preparing and failed results and rejects contradictory states", () => {
    for (const value of [
      { items: [] },
      { items: [], status: "ready", index: { state: "ready", syncing: true } },
      { items: [], status: "preparing", index: { state: "preparing" } },
      { items: [], status: "unavailable", error: { code: "OFFLINE", message: "Service offline" } },
      { items: [], status: "error", error: { code: "QUERY", message: "Query failed" } },
    ])
      expect(PluginAttachmentSearchPayloadSchema.safeParse(value).success).toBe(true);
    for (const value of [
      { items: [], status: "error" },
      { items: [], error: { code: "QUERY", message: "Query failed" } },
      { items: [], status: "ready", index: { state: "preparing" } },
      { items: [], coverage: { truncated: false, nextCursor: "page2" } },
      {
        items: [
          {
            id: "1",
            identifier: "1",
            title: "Title",
            text: "body",
            url: "https://example.com",
            resourceType: "issue",
          },
        ],
        status: "preparing",
      },
    ])
      expect(PluginAttachmentSearchPayloadSchema.safeParse(value).success).toBe(false);
  });
  it("loads scoped labeled candidates through the declared filter RPC and rejects a different account", async () => {
    const source = defineAttachmentSource({
      id: "messages",
      title: "Messages",
      icon: "CircleDot",
      pickerTitle: "Messages",
      searchPlaceholder: "Search",
      search: contract,
      context: defineRpc({ name: "context", input: z.object({}), output: z.unknown() }),
      filterOptions: defineRpc({
        name: "messages.options",
        input: z.unknown(),
        output: z.unknown(),
      }),
    });
    const input = { scope: "account-a", filterId: "sender", query: "Alice", cursor: "page:2" };
    const result = {
      scope: "account-a",
      items: [{ value: "9223372036854775807", label: "Alice" }],
      coverage: { truncated: true, nextCursor: "page:3" },
    };
    await expect(
      searchPluginAttachmentFilterOptions(
        source,
        async (method, received) => {
          expect(method).toBe("messages.options");
          expect(received).toEqual(input);
          return result;
        },
        input,
      ),
    ).resolves.toEqual(result);
    await expect(
      searchPluginAttachmentFilterOptions(
        source,
        async () => ({ ...result, scope: "account-b" }),
        input,
      ),
    ).rejects.toThrow("scope");
  });
  it("rejects resources without a usable URL or complete local source", () => {
    const item = {
      id: "1",
      identifier: "Message",
      title: "Discussion",
      text: "Full body",
      resourceType: "message",
    };
    expect(PluginAttachmentItemSchema.safeParse(item).success).toBe(false);
    expect(
      PluginAttachmentItemSchema.safeParse({
        ...item,
        source: { scope: "a", ref: "ref", label: "Team" },
      }).success,
    ).toBe(true);
    expect(
      PluginAttachmentItemSchema.safeParse({ ...item, url: "https://example.com/1" }).success,
    ).toBe(true);
  });
  it("resolves the account and labeled filter options before a search", async () => {
    const context = {
      scope: "account-9223372036854775807",
      options: { conversation: [{ value: "9223372036854775806", label: "Product" }] },
    };
    const source = defineAttachmentSource({
      id: "messages",
      title: "Messages",
      icon: "MessageCircle",
      pickerTitle: "Attach message",
      searchPlaceholder: "Search",
      localResources: true,
      filters: [
        {
          id: "mode",
          label: "Match",
          kind: "select",
          options: [{ value: "literal", label: "Exact phrase" }],
        },
        { id: "conversation", label: "Conversation", kind: "select" },
        { id: "since", label: "Since", kind: "datetime", boundary: "inclusive" },
      ],
      context: defineRpc({ name: "messages.context", input: z.object({}), output: z.unknown() }),
      search: defineRpc({ name: "messages.search", input: z.unknown(), output: z.unknown() }),
    });
    await expect(
      loadPluginAttachmentContext(source, async (method, input) => {
        expect(method).toBe("messages.context");
        expect(input).toEqual({});
        return context;
      }),
    ).resolves.toEqual(context);
  });

  it("passes scoped filters and pagination unchanged and preserves local snapshots and coverage", async () => {
    const input = {
      query: "原句",
      scope: "account-9223372036854775807",
      filters: {
        mode: "literal",
        conversation: "9223372036854775806",
        since: "2026-11-05T00:00:00+08:00",
      },
      cursor: "page:2",
    };
    const result = {
      items: [
        {
          id: "message-9223372036854775807",
          identifier: "Message",
          title: "Work discussion",
          text: "完整正文\nA second line",
          resourceType: "message",
          source: {
            scope: input.scope,
            ref: "opaque:9223372036854775807",
            label: "Team · Alice · 2026-11-05",
          },
        },
      ],
      coverage: { truncated: true, nextCursor: "page:3" },
      index: { state: "ready", syncing: true, lastSuccessAt: "2026-11-05T10:00:00Z" },
      status: "ready",
    };
    const source = defineAttachmentSource({
      id: "messages",
      title: "Messages",
      icon: "MessageCircle",
      pickerTitle: "Attach message",
      searchPlaceholder: "Search",
      search: defineRpc({ name: "messages.search", input: z.unknown(), output: z.unknown() }),
    });
    await expect(
      searchPluginAttachments(
        source,
        async (_method, received) => {
          expect(received).toEqual(input);
          return result;
        },
        input,
      ),
    ).resolves.toEqual(result);
  });

  const search = defineRpc({
    name: "issues.search",
    input: z.object({ query: z.string() }),
    output: z.object({
      items: z.array(
        z.object({
          id: z.string(),
          identifier: z.string(),
          title: z.string(),
          subtitle: z.string().optional(),
          url: z.string(),
          text: z.string(),
          resourceType: z.string(),
        }),
      ),
    }),
  });

  it("searches through the declared RPC and validates the standard result", async () => {
    const source = defineAttachmentSource({
      id: "issues",
      title: "Issue",
      icon: "CircleDot",
      pickerTitle: "Attach issue",
      searchPlaceholder: "Search",
      search,
    });

    const payload = await searchPluginAttachments(
      source,
      async (method, input) => ({
        items: [
          {
            id: "issue-1",
            identifier: `${method}:${String(Reflect.get(input as object, "query"))}`,
            title: "Plugin attachments",
            url: "https://example.com/issues/1",
            text: "Issue snapshot",
            resourceType: "issue",
          },
        ],
      }),
      "ENG-123",
    );

    expect(payload.items[0]?.identifier).toBe("issues.search:ENG-123");
  });

  it("rejects a malformed standard search result", async () => {
    const source = defineAttachmentSource({
      id: "issues",
      title: "Issue",
      icon: "CircleDot",
      pickerTitle: "Attach issue",
      searchPlaceholder: "Search",
      search,
    });

    await expect(
      searchPluginAttachments(source, async () => ({ items: [{ id: "issue-1" }] }), "issue"),
    ).rejects.toBeInstanceOf(z.ZodError);
  });
});

describe("plugin UI contracts", () => {
  it("exposes presentation capabilities from the UI entry", () => {
    expectTypeOf<ComponentProps<typeof StreamedText>>().toEqualTypeOf<StreamedTextProps>();
    expectTypeOf<ComponentProps<typeof Modal>>().toEqualTypeOf<ModalProps>();
    expectTypeOf<ComponentProps<typeof SettingsSection>>().toEqualTypeOf<SettingsSectionProps>();
    expectTypeOf<StreamedTextProps["phase"]>().toEqualTypeOf<"streaming" | "complete">();
  });
});
