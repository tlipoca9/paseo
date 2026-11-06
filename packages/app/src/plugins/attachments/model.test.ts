import { openAttachmentPicker, serializeAttachmentDateTime } from "./picker-model";
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  defineAttachmentSource,
  defineRpc,
  PluginAttachmentFilterOptionsInputSchema,
} from "@getpaseo/plugin";
import { z } from "zod";
import { queryPluginAttachments, queryPluginAttachmentFilterOptions } from "./query";
import {
  supportsPluginAttachmentSource,
  createPluginResourceAttachment,
  PluginResourceComposerAttachmentSchema,
  pluginResourceAttachmentToAgentAttachment,
  togglePluginResourceAttachment,
} from "./model";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";
import { readResourceAttachment } from "./snapshot";
import { createHash } from "node:crypto";

const source = {
  pluginId: "linear",
  sourceId: "issues",
  sourceTitle: "Linear issue",
  sourceIcon: "CircleDot",
};

const item = {
  id: "issue-uuid",
  identifier: "ENG-123",
  title: "Plugin attachments",
  subtitle: "In progress · Mohamed",
  url: "https://linear.app/acme/issue/ENG-123/plugin-attachments",
  text: "Linear issue ENG-123: Plugin attachments\nStatus: In progress",
  resourceType: "issue",
};

describe("plugin resource attachments", () => {
  it("preserves verbatim preview text through draft, submission and saved snapshot decoding", async () => {
    const previewText = "  原文🙂 e\u0301\n\t第二行\n" + "完整正文".repeat(500);
    const previewBlocks = [
      { type: "markdown" as const, text: "**原消息**\n逐字正文🙂" },
      { type: "action" as const, label: "详情", url: "https://example.com/details" },
    ];
    const draft = createPluginResourceAttachment(source, {
      ...item,
      url: undefined,
      previewText,
      previewBlocks,
      text: `Technical metadata\n\n${previewText}`,
      source: { scope: "account", ref: "opaque-ref", label: "Alice · Project" },
    });
    const restored = PluginResourceComposerAttachmentSchema.parse(
      JSON.parse(JSON.stringify(draft)),
    );
    expect(restored.item.previewText).toBe(previewText);
    expect(restored.item.previewBlocks).toEqual(previewBlocks);
    const attachment = pluginResourceAttachmentToAgentAttachment(restored);
    const text = JSON.stringify(attachment);
    const bytes = Buffer.from(text);
    const sha256 = async (value: string) => createHash("sha256").update(value).digest("hex");
    const saved = await readResourceAttachment({
      request: { agentId: "agent", clientMessageId: "message", index: 0 },
      signal: new AbortController().signal,
      sha256,
      read: async () => ({
        offset: 0,
        nextOffset: bytes.length,
        totalBytes: bytes.length,
        encoding: "base64",
        data: bytes.toString("base64"),
        sha256: await sha256(text),
      }),
    });
    expect(saved.localResource?.previewText).toBe(previewText);
    expect(saved.localResource?.previewBlocks).toEqual(previewBlocks);
    expect(saved.text).toContain(`Technical metadata\n\n${previewText}`);
    expect(saved.text).toContain("Reference: opaque-ref");
  });
  it("reconstructs resource snapshot UTF-8 across chunks and rejects missing, stale or corrupt data", async () => {
    const attachment = pluginResourceAttachmentToAgentAttachment(
      createPluginResourceAttachment(source, item),
    );
    const bytes = Buffer.from(JSON.stringify({ ...attachment, text: "正文🙂".repeat(12000) }));
    const sha256 = async (text: string) => createHash("sha256").update(text).digest("hex");
    const digest = await sha256(bytes.toString());
    const calls: number[] = [];
    const read = async ({ offset }: { offset: number }) => {
      calls.push(offset);
      const nextOffset = Math.min(offset + 997, bytes.length);
      return {
        offset,
        nextOffset,
        totalBytes: bytes.length,
        encoding: "base64" as const,
        data: bytes.subarray(offset, nextOffset).toString("base64"),
        sha256: digest,
      };
    };
    const request = { agentId: "agent", clientMessageId: "submission", index: 1 };
    expect(
      (
        await readResourceAttachment({
          request,
          read,
          sha256,
          signal: new AbortController().signal,
        })
      ).text,
    ).toBe("正文🙂".repeat(12000));
    expect(calls.length).toBeGreaterThan(1);
    for (const mutate of [
      (chunk: Awaited<ReturnType<typeof read>>) => ({ ...chunk, nextOffset: chunk.offset }),
      (chunk: Awaited<ReturnType<typeof read>>) => ({ ...chunk, offset: chunk.offset + 1 }),
      (chunk: Awaited<ReturnType<typeof read>>) => ({ ...chunk, sha256: "wrong" }),
      (chunk: Awaited<ReturnType<typeof read>>) => ({
        ...chunk,
        totalBytes: chunk.totalBytes + chunk.offset,
      }),
    ]) {
      await expect(
        readResourceAttachment({
          request,
          read: async (input) => mutate(await read(input)),
          sha256,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow();
    }
    const aborted = new AbortController();
    await expect(
      readResourceAttachment({
        request,
        sha256,
        signal: aborted.signal,
        read: async (input) => {
          aborted.abort();
          return read(input);
        },
      }),
    ).rejects.toThrow();
  });
  it("expires result and candidate caches after thirty seconds while refreshing context on cache hits", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const queryClient = new QueryClient();
    let contexts = 0;
    let searches = 0;
    let candidates = 0;
    const cachedSource = defineAttachmentSource({
      id: "messages",
      title: "Messages",
      icon: "CircleDot",
      pickerTitle: "Messages",
      searchPlaceholder: "Search",
      search: defineRpc({ name: "search", input: z.unknown(), output: z.unknown() }),
      context: defineRpc({ name: "context", input: z.unknown(), output: z.unknown() }),
      filterOptions: defineRpc({ name: "options", input: z.unknown(), output: z.unknown() }),
    });
    const shared = {
      serverId: "host",
      pluginId: "plugin",
      source: cachedSource,
      queryClient,
      invoke: async (method: string) => {
        if (method === "context") {
          contexts++;
          return { scope: "a" };
        }
        if (method === "search") {
          searches++;
          return { items: [item] };
        }
        candidates++;
        return {
          scope: "a",
          items: [{ value: "1", label: "Alice" }],
          coverage: { truncated: false },
        };
      },
    };
    const read = async () => {
      await queryPluginAttachments({ ...shared, input: { query: "" } });
      await queryPluginAttachmentFilterOptions({
        ...shared,
        input: { filterId: "sender", query: "" },
      });
    };
    try {
      await read();
      clock.mockReturnValue(now + 29_999);
      await read();
      expect([contexts, searches, candidates]).toEqual([4, 1, 1]);
      clock.mockReturnValue(now + 30_001);
      await read();
      expect([contexts, searches, candidates]).toEqual([6, 2, 2]);
    } finally {
      clock.mockRestore();
      queryClient.clear();
    }
  });
  it("drops candidate pagination and selected values before querying a newly resolved account", async () => {
    const model = openAttachmentPicker();
    model.applyContext(model.beginContext(), { scope: "a" });
    model.openFilter("sender");
    model.setCandidateQuery("Alice");
    model.setCandidateCursor("old-page");
    const queryClient = new QueryClient();
    const accountSource = defineAttachmentSource({
      id: "messages",
      title: "Messages",
      icon: "CircleDot",
      pickerTitle: "Messages",
      searchPlaceholder: "Search",
      search: defineRpc({ name: "search", input: z.unknown(), output: z.unknown() }),
      context: defineRpc({ name: "context", input: z.unknown(), output: z.unknown() }),
      filterOptions: defineRpc({ name: "options", input: z.unknown(), output: z.unknown() }),
    });
    const requests: unknown[] = [];
    await queryPluginAttachmentFilterOptions({
      serverId: "host",
      pluginId: "plugin",
      source: accountSource,
      queryClient,
      model,
      input: { filterId: "sender", query: "Alice", cursor: "old-page" },
      previousCursors: [undefined],
      invoke: async (method, input) => {
        if (method === "context") return { scope: "b" };
        requests.push(input);
        return { scope: "b", items: [], coverage: { truncated: false } };
      },
    });
    expect(requests).toEqual([{ scope: "b", filterId: "sender", query: "", cursor: undefined }]);
    expect(model.getState().previousCandidateCursors).toEqual([]);
    model.close();
    queryClient.clear();
  });
  it.each(["reopen", "switch"] as const)(
    "starts a fresh candidate search after %s without replaying earlier pages",
    async (transition) => {
      const model = openAttachmentPicker();
      const queryClient = new QueryClient();
      const candidateSource = defineAttachmentSource({
        id: "messages",
        title: "Messages",
        icon: "CircleDot",
        pickerTitle: "Messages",
        searchPlaceholder: "Search",
        search: defineRpc({ name: "search", input: z.unknown(), output: z.unknown() }),
        context: defineRpc({ name: "context", input: z.unknown(), output: z.unknown() }),
        filterOptions: defineRpc({ name: "options", input: z.unknown(), output: z.unknown() }),
      });
      const requests: unknown[] = [];
      const invoke = async (method: string, input: unknown) => {
        if (method === "context") return { scope: "account-a" };
        const parsed = PluginAttachmentFilterOptionsInputSchema.parse(input);
        requests.push(parsed);
        if (parsed.cursor && (parsed.filterId !== "sender" || parsed.query !== "Alice")) {
          return {
            scope: "account-a",
            items: [],
            coverage: { truncated: false },
            status: "error",
            error: { code: "cursor_query_mismatch", message: "Cursor belongs to another search" },
          };
        }
        return {
          scope: "account-a",
          items: [{ value: parsed.cursor ?? "first", label: parsed.query || "Recent option" }],
          coverage: { truncated: false },
        };
      };
      const read = () => {
        const state = model.getState();
        return queryPluginAttachmentFilterOptions({
          serverId: "host",
          pluginId: "plugin",
          source: candidateSource,
          queryClient,
          model,
          invoke,
          input: {
            filterId: state.activeFilter!,
            query: state.candidateQuery,
            cursor: state.candidateCursor,
          },
          previousCursors: state.previousCandidateCursors,
        });
      };
      try {
        model.openFilter("sender");
        model.setCandidateQuery("Alice");
        await read();
        model.setCandidateCursor("alice-page-2");
        await read();
        model.setCandidateCursor("alice-page-3");
        expect((await read()).result.items).toHaveLength(3);
        requests.length = 0;
        if (transition === "reopen") model.openFilter(null);
        const filterId = transition === "reopen" ? "sender" : "in";
        model.openFilter(filterId);
        const response = await read();
        expect(requests).toEqual([{ scope: "account-a", filterId, query: "", cursor: undefined }]);
        expect(response.result.items).toEqual([{ value: "first", label: "Recent option" }]);
        expect(response.result.error).toBeUndefined();
      } finally {
        model.close();
        queryClient.clear();
      }
    },
  );
  it("gates extended sources once while retaining query-only web sources on old hosts", () => {
    const web = defineAttachmentSource({
      id: "web",
      title: "Web",
      icon: "CircleDot",
      pickerTitle: "Web",
      searchPlaceholder: "Search",
      search: defineRpc({ name: "web", input: z.unknown(), output: z.unknown() }),
    });
    expect(supportsPluginAttachmentSource(web, undefined)).toBe(true);
    for (const extension of [
      { localResources: true },
      { context: web.search },
      { filterOptions: web.search },
      { filters: [{ id: "mode", label: "Mode", kind: "select" as const }] },
    ]) {
      expect(supportsPluginAttachmentSource({ ...web, ...extension }, undefined)).toBe(false);
      expect(
        supportsPluginAttachmentSource(
          { ...web, ...extension },
          { pluginResourceAttachments: true },
        ),
      ).toBe(true);
    }
  });
  it("serializes local date boundaries as explicit whole-second RFC3339 instants", () => {
    vi.stubEnv("TZ", "Asia/Shanghai");
    try {
      expect(serializeAttachmentDateTime("2026-11-05 00:00:00")).toBe("2026-11-04T16:00:00Z");
      expect(serializeAttachmentDateTime("2026-02-30 00:00:00")).toBeNull();
      expect(serializeAttachmentDateTime("2026-11-05")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("isolates candidate caching from body searches, accounts, filters and pages", async () => {
    const queryClient = new QueryClient();
    let scope = "a";
    let calls = 0;
    const candidateSource = defineAttachmentSource({
      id: "messages",
      title: "Messages",
      icon: "CircleDot",
      pickerTitle: "Messages",
      searchPlaceholder: "Search",
      search: defineRpc({ name: "search", input: z.unknown(), output: z.unknown() }),
      context: defineRpc({ name: "context", input: z.object({}), output: z.unknown() }),
      filterOptions: defineRpc({ name: "options", input: z.unknown(), output: z.unknown() }),
    });
    const request = {
      serverId: "host",
      pluginId: "plugin",
      source: candidateSource,
      queryClient,
      invoke: async (method: string) =>
        method === "context"
          ? { scope }
          : {
              scope,
              items: [{ value: String(++calls), label: "Alice" }],
              coverage: { truncated: false },
            },
      input: { filterId: "sender", query: "Ali" },
    };
    expect((await queryPluginAttachmentFilterOptions(request)).result.items[0]?.value).toBe("1");
    expect((await queryPluginAttachmentFilterOptions(request)).result.items[0]?.value).toBe("1");
    for (const input of [
      { filterId: "sender", query: "Bob" },
      { filterId: "in", query: "Ali" },
      { filterId: "sender", query: "Ali", cursor: "next" },
    ])
      await queryPluginAttachmentFilterOptions({ ...request, input });
    expect(calls).toBe(4);
    scope = "b";
    await queryPluginAttachmentFilterOptions(request);
    scope = "a";
    await queryPluginAttachmentFilterOptions(request);
    expect(calls).toBe(6);
    const controller = new AbortController();
    controller.abort();
    await expect(
      queryPluginAttachmentFilterOptions({ ...request, signal: controller.signal }),
    ).rejects.toThrow();
    expect(calls).toBe(6);
    queryClient.clear();
  });
  it("resets account-owned filter state and ignores superseded context responses", () => {
    const picker = openAttachmentPicker();
    const first = picker.beginContext();
    picker.applyContext(first, {
      scope: "a",
      options: { sender: [{ value: "1", label: "Alice" }] },
    });
    picker.setQuery("body query");
    picker.selectFilter("sender", { value: "1", label: "Alice" });
    picker.setCursor("page2");
    picker.openFilter("sender");
    picker.setCandidateQuery("Ali");
    picker.setCandidateCursor("c2");
    const slow = picker.beginContext();
    const current = picker.beginContext();
    expect(picker.applyContext(current, { scope: "b" })).toBe(true);
    expect(picker.applyContext(slow, { scope: "a" })).toBe(false);
    expect(picker.getState()).toMatchObject({
      query: "body query",
      context: { scope: "b" },
      filters: {},
      cursor: undefined,
      candidateQuery: "",
      candidateCursor: undefined,
    });
    expect(picker.searchInput()).toEqual({ query: "body query" });
    picker.close();
  });
  it("deduplicates local resources by scope and opaque ref instead of display ids", () => {
    const first = createPluginResourceAttachment(source, {
      ...item,
      url: undefined,
      source: { scope: "a", ref: "record:1", label: "Team" },
    });
    const renamed = createPluginResourceAttachment(source, {
      ...first.item,
      id: "changed-display-id",
    });
    const otherAccount = createPluginResourceAttachment(source, {
      ...first.item,
      source: { scope: "b", ref: "record:1", label: "Other team" },
    });
    expect(togglePluginResourceAttachment([first], renamed)).toEqual([]);
    expect(togglePluginResourceAttachment([first], otherAccount)).toEqual([first, otherAccount]);
  });
  it("resolves account scope before consulting the cache and isolates every search input", async () => {
    const queryClient = new QueryClient();
    let scope = "account-a";
    let searches = 0;
    const scopedSource = defineAttachmentSource({
      id: "messages",
      title: "Messages",
      icon: "MessageCircle",
      pickerTitle: "Messages",
      searchPlaceholder: "Search",
      context: defineRpc({ name: "context", input: z.object({}), output: z.unknown() }),
      search: defineRpc({ name: "search", input: z.unknown(), output: z.unknown() }),
    });
    const invoke = async (method: string) => {
      if (method === "context") return { scope };
      searches += 1;
      return { items: [{ ...item, id: `${scope}:${searches}` }] };
    };
    const request = {
      serverId: "host-a",
      pluginId: "plugin-a",
      source: scopedSource,
      queryClient,
      invoke,
      input: { query: "" },
    };
    expect((await queryPluginAttachments(request)).result.items[0]?.id).toBe("account-a:1");
    expect((await queryPluginAttachments(request)).result.items[0]?.id).toBe("account-a:1");
    scope = "account-b";
    expect((await queryPluginAttachments(request)).result.items[0]?.id).toBe("account-b:2");
    scope = "account-a";
    expect((await queryPluginAttachments(request)).result.items[0]?.id).toBe("account-a:3");
    expect(
      (
        await queryPluginAttachments({
          ...request,
          input: { query: "", filters: { mode: "literal" } },
        })
      ).result.items[0]?.id,
    ).toBe("account-a:4");
    expect(
      (
        await queryPluginAttachments({
          ...request,
          input: { query: "", filters: { mode: "literal", sender: "9223372036854775807" } },
        })
      ).result.items[0]?.id,
    ).toBe("account-a:5");
    expect(
      (await queryPluginAttachments({ ...request, input: { query: "", cursor: "page-2" } })).result
        .items[0]?.id,
    ).toBe("account-a:6");
    expect(
      (await queryPluginAttachments({ ...request, serverId: "host-b" })).result.items[0]?.id,
    ).toBe("account-a:7");
    expect(
      (await queryPluginAttachments({ ...request, pluginId: "plugin-b" })).result.items[0]?.id,
    ).toBe("account-a:8");
    expect(
      (await queryPluginAttachments({ ...request, source: { ...scopedSource, id: "other" } }))
        .result.items[0]?.id,
    ).toBe("account-a:9");
    queryClient.clear();
  });

  it("restores and submits the selected local snapshot and its lossless source after the result changes", () => {
    const local = {
      id: "9223372036854775807",
      identifier: "Message",
      title: "Discussion",
      text: "Selected body\nSecond line",
      resourceType: "message",
      source: { scope: "account-1", ref: "opaque:9223372036854775807", label: "Team · Alice" },
    };
    const selected = createPluginResourceAttachment(source, local);
    local.text = "Updated body";
    local.source.label = "Renamed team";
    const restored = PluginResourceComposerAttachmentSchema.parse(
      JSON.parse(JSON.stringify(selected)),
    );
    const submitted = splitComposerAttachmentsForSubmit([restored]);
    expect(submitted.attachments).toEqual([
      {
        type: "text",
        mimeType: "text/plain",
        title: "Message Discussion",
        text: "Selected body\nSecond line\n\nSource: Team · Alice\nAccount: account-1\nReference: opaque:9223372036854775807",
        localResource: {
          provider: "linear",
          providerLabel: "Linear issue",
          sourceId: "issues",
          resourceType: "message",
          id: "9223372036854775807",
          identifier: "Message",
          title: "Discussion",
          source: { scope: "account-1", ref: "opaque:9223372036854775807", label: "Team · Alice" },
        },
      },
    ]);
  });

  it("creates a draft-safe composer attachment", () => {
    const attachment = createPluginResourceAttachment(source, item);

    expect(PluginResourceComposerAttachmentSchema.parse(attachment)).toEqual({
      kind: "plugin_resource",
      ...source,
      item,
    });
  });

  it("toggles one resource by plugin, source, and stable item id", () => {
    const attachment = createPluginResourceAttachment(source, item);

    expect(togglePluginResourceAttachment([], attachment)).toEqual([attachment]);
    expect(togglePluginResourceAttachment([attachment], attachment)).toEqual([]);
  });

  it("submits through the backward-compatible text attachment", () => {
    const attachment = createPluginResourceAttachment(source, item);

    const agentAttachment = pluginResourceAttachmentToAgentAttachment(attachment);
    expect(agentAttachment).toEqual({
      type: "text",
      mimeType: "text/plain",
      title: "ENG-123 Plugin attachments",
      text: item.text,
      externalResource: {
        provider: "linear",
        providerLabel: "Linear issue",
        resourceType: "issue",
        id: "issue-uuid",
        identifier: "ENG-123",
        title: "Plugin attachments",
        url: item.url,
      },
    });
    expect(splitComposerAttachmentsForSubmit([attachment])).toEqual({
      images: [],
      attachments: [agentAttachment],
    });
  });
});
