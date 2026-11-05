import { expect, test } from "../support/fixtures";
import { clickNewChat } from "../support/helpers/launcher";
import { expectComposerVisible } from "../support/helpers/composer";
import { expectAgentIdle } from "../support/helpers/agent-stream";
import {
  openAttachmentMenu,
  expectAttachmentSheetRowsOnTitleRail,
  openGithubPickerFromMenu,
  attachImageFromMenu,
  expectAttachmentPill,
  removeAttachmentPill,
  openImageLightbox,
  closeImageLightbox,
  pressInterruptShortcut,
  expectComposerDraft,
  expectComposerDisabled,
  expectComposerEditable,
  expectAttachButtonDisabled,
  fillComposerDraft,
  dropFileOnComposer,
  sendDraftToQueue,
  expectQueuedMessageButton,
  startRunningMockAgent,
  selectGithubOption,
  expectGithubAttachmentPill,
  openGithubWorkspace,
} from "../support/helpers/composer";
import {
  delayBrowserAgentCreatedStatus,
  openNewWorkspaceComposer,
} from "../support/helpers/new-workspace";
import { gotoAppShell } from "../support/helpers/app";
import {
  waitForSidebarHydration,
  switchWorkspaceViaSidebar,
} from "../support/helpers/workspace-ui";
import { seedWorkspace } from "../support/helpers/seed-client";
import { hasGithubAuth, createTempGithubRepo } from "../support/helpers/github-fixtures";
import { getServerId } from "../support/helpers/server-id";
import { openFileExplorer } from "../support/helpers/file-explorer";
import { attachFileFromMenu, controlFileUploadCompletion } from "../support/helpers/composer";
import {
  hideResourceAttachmentFeature,
  installResourceAttachmentPlugin,
  submitMessage,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.describe("plugin resource attachments", () => {
  test.use({ timezoneId: "Asia/Shanghai" });
  test("loads labeled filter candidates independently and preserves remote matches", async ({
    page,
  }) => {
    const plugin = await installResourceAttachmentPlugin();
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "resource-filter-",
      title: "Resource filters",
    });
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await openAttachmentMenu(page);
      await page.getByText("Attach Messages", { exact: true }).click();
      const picker = page.getByTestId("plugin-attachment-picker");
      await expect(picker.getByText("Indexed discussion 1", { exact: true })).toBeVisible();
      await picker.getByRole("button", { name: "Match (Any)", exact: true }).click();
      await page
        .getByTestId("plugin-attachment-filter-options")
        .getByRole("button", { name: "Exact phrase", exact: true })
        .click();
      await picker.getByRole("button", { name: "Sender (Any)", exact: true }).click();
      const candidates = page.getByTestId("plugin-attachment-filter-options");
      for (const [filter, firstOption] of [
        ["Sender", "Alice"],
        ["Conversation", "Product"],
      ] as const) {
        await candidates.getByRole("textbox").fill("Ali");
        await expect(candidates.getByRole("button", { name: "Alice", exact: true })).toBeVisible();
        await candidates.getByRole("button", { name: "Load more", exact: true }).click();
        await expect(candidates.getByRole("button", { name: "Bob", exact: true })).toBeVisible();
        await candidates.getByRole("button", { name: "Load more", exact: true }).click();
        await expect(candidates.getByRole("button", { name: "Carol", exact: true })).toBeVisible();
        await candidates.getByRole("button", { name: "Close", exact: true }).click();
        await picker.getByRole("button", { name: `${filter} (Any)`, exact: true }).click();
        await expect(candidates.getByRole("textbox")).toHaveValue("");
        await expect(
          candidates.getByRole("button", { name: firstOption, exact: true }),
        ).toBeVisible();
        await expect(candidates.getByRole("button", { name: "Bob", exact: true })).toHaveCount(0);
        await expect(candidates.getByRole("button", { name: "Carol", exact: true })).toHaveCount(0);
        await candidates.getByRole("button", { name: "Close", exact: true }).click();
        await picker.getByRole("button", { name: "Sender (Any)", exact: true }).click();
      }
      await candidates.getByRole("textbox").fill("Ali");
      await expect(candidates.getByRole("button", { name: "Alice", exact: true })).toBeVisible();
      await candidates.getByRole("button", { name: "Load more", exact: true }).click();
      await candidates.getByRole("button", { name: "Bob", exact: true }).click();
      await picker.getByRole("button", { name: "Since (Any)", exact: true }).click();
      const date = page.getByTestId("plugin-attachment-date-filter");
      await expect(date).toContainText("Inclusive");
      await expect(date).toContainText("Asia/Shanghai");
      await date.getByRole("textbox", { name: "Since", exact: true }).fill("2026-11-05 00:00:00");
      await date.getByRole("button", { name: "Apply", exact: true }).click();
      await picker.getByRole("textbox", { name: "Search messages" }).fill("only in hidden body");
      await expect(picker.getByTestId("plugin-attachment-result")).toHaveCount(2);
      const history = (await plugin.control({})) as { requests: Record<string, unknown>[] };
      expect(history.requests).toContainEqual({
        method: "options",
        scope: "account-a",
        filterId: "sender",
        query: "Ali",
        cursor: "sender:Ali:2",
      });
      expect(history.requests).not.toContainEqual(
        expect.objectContaining({ method: "options", query: "", cursor: "sender:Ali:2" }),
      );
      expect(history.requests).not.toContainEqual(
        expect.objectContaining({ method: "options", filterId: "in", cursor: "sender:Ali:2" }),
      );
      expect(history.requests).toContainEqual({
        method: "search",
        scope: "account-a",
        query: "only in hidden body",
        filters: { mode: "literal", sender: "9223372036854775804", since: "2026-11-04T16:00:00Z" },
      });
    } finally {
      await agent.cleanup();
      await plugin.cleanup();
    }
  });
  test("keeps candidate errors local and distinguishes empty, preparing and failed searches", async ({
    page,
  }) => {
    const plugin = await installResourceAttachmentPlugin();
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "resource-status-",
      title: "Resource states",
    });
    try {
      await plugin.control({ optionError: true });
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await openAttachmentMenu(page);
      await page.getByText("Attach Messages", { exact: true }).click();
      const picker = page.getByTestId("plugin-attachment-picker");
      await expect(picker.getByTestId("plugin-attachment-result")).toHaveCount(2);
      await picker.getByRole("button", { name: "Sender (Any)", exact: true }).click();
      const candidates = page.getByTestId("plugin-attachment-filter-options");
      await expect(candidates).toContainText("Upgrade sender candidates explicitly");
      await expect(candidates.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      await candidates.getByRole("button", { name: "Close", exact: true }).click();
      await picker.getByRole("button", { name: "Conversation (Any)", exact: true }).click();
      await expect(candidates.getByRole("button", { name: "Product", exact: true })).toBeVisible();
      await candidates.getByRole("button", { name: "Close", exact: true }).click();
      const query = picker.getByRole("textbox", { name: "Search messages" });
      for (const [value, label] of [
        ["preparing", "Index is preparing"],
        ["unavailable", "Service unavailable"],
        ["error", "Query failed"],
        ["empty", "No results"],
      ]) {
        await query.fill(value!);
        await expect(picker.getByText(label!, { exact: true })).toBeVisible();
        await expect(picker.getByTestId("plugin-attachment-result")).toHaveCount(0);
      }
      await query.fill("body search");
      await expect(picker.getByTestId("plugin-attachment-result")).toHaveCount(2);
      await picker.getByRole("button", { name: "Add MSG-2", exact: true }).click();
      await picker.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByTestId("composer-plugin-resource-attachment-pill").click();
      await expect(page.getByTestId("plugin-resource-preview")).toContainText(
        "original complete body",
      );
    } finally {
      await agent.cleanup();
      await plugin.cleanup();
    }
  });

  test("discards stale body, candidate and context responses across account changes", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    let staleCandidateResponses = 0;
    const recordCandidateResponse = ({ payload }: { payload: string | Buffer }) => {
      if (payload.toString().includes("Stale candidate")) staleCandidateResponses++;
    };
    page.on("websocket", (socket) => {
      socket.on("framereceived", recordCandidateResponse);
    });
    const plugin = await installResourceAttachmentPlugin();
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "resource-races-",
      title: "Resource races",
    });
    const requested = async (method: string, query?: string) => {
      const result = (await plugin.control({})) as { requests: Record<string, unknown>[] };
      return result.requests.some(
        (entry) => entry.method === method && (query === undefined || entry.query === query),
      );
    };
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await openAttachmentMenu(page);
      await page.getByText("Attach Messages", { exact: true }).click();
      const picker = page.getByTestId("plugin-attachment-picker");
      const query = picker.getByRole("textbox", { name: "Search messages" });
      await expect(picker.getByTestId("plugin-attachment-result")).toHaveCount(2);
      await query.fill("slow");
      await expect.poll(() => requested("search", "slow")).toBe(true);
      await query.fill("new query");
      await expect(picker.getByTestId("plugin-attachment-result")).toHaveCount(2);
      await plugin.control({ release: true });
      await expect(picker.getByText("Stale result")).toHaveCount(0);
      await picker.getByRole("button", { name: "Sender (Any)", exact: true }).click();
      const candidates = page.getByTestId("plugin-attachment-filter-options");
      await candidates.getByRole("textbox").fill("slow");
      await expect.poll(() => requested("options", "slow")).toBe(true);
      await candidates.getByRole("textbox").fill("Ali");
      await expect(candidates.getByRole("button", { name: "Alice", exact: true })).toBeVisible();
      await plugin.control({ releaseOptions: true });
      await expect.poll(() => staleCandidateResponses).toBe(1);
      await expect(candidates.getByText("Stale candidate")).toHaveCount(0);
      await candidates.getByRole("textbox").fill("slow close");
      await expect.poll(() => requested("options", "slow close")).toBe(true);
      await candidates.getByRole("button", { name: "Close", exact: true }).click();
      await picker.getByRole("button", { name: "Conversation (Any)", exact: true }).click();
      await expect(candidates.getByRole("button", { name: "Product", exact: true })).toBeVisible();
      await plugin.control({ releaseOptions: true });
      await expect.poll(() => staleCandidateResponses).toBe(2);
      await expect(candidates.getByText("Stale candidate")).toHaveCount(0);
      await expect(candidates.getByRole("button", { name: "Product", exact: true })).toBeVisible();
      await candidates.getByRole("button", { name: "Close", exact: true }).click();
      await picker.getByRole("button", { name: "Sender (Any)", exact: true }).click();
      await candidates.getByRole("button", { name: "Alice", exact: true }).click();
      await plugin.control({ holdContext: true });
      await query.fill("old context");
      await expect.poll(() => requested("context-held")).toBe(true);
      await plugin.control({ scope: "account-b" });
      await query.fill("new account");
      await expect(picker.getByRole("button", { name: "Sender (Any)", exact: true })).toBeVisible();
      await expect(picker.getByTestId("plugin-attachment-result")).toHaveCount(2);
      await plugin.control({ releaseContext: true });
      await picker.getByRole("button", { name: "Preview MSG-2", exact: true }).click();
      await expect(page.getByTestId("plugin-resource-preview")).toContainText(
        "opaque:account-b:9223372036854775807",
      );
    } finally {
      await plugin.control({ release: true, releaseContext: true, releaseOptions: true });
      await agent.cleanup();
      await plugin.cleanup();
    }
  });

  test("gates local sources on an old host while web attachments still restore, open and send", async ({
    page,
    context,
  }) => {
    await hideResourceAttachmentFeature(page);
    await context.route("https://example.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "Web issue" }),
    );
    const plugin = await installResourceAttachmentPlugin();
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "resource-legacy-",
      title: "Legacy attachments",
    });
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await openAttachmentMenu(page);
      await page.getByText("Attach Messages", { exact: true }).click();
      await expect(
        page.getByText("Update this host to use resource attachment filters and local previews.", {
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByTestId("plugin-attachment-picker")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      expect(((await plugin.control({})) as { requests: unknown[] }).requests).toEqual([]);
      await openAttachmentMenu(page);
      await page.getByText("Attach Web issue", { exact: true }).click();
      const picker = page.getByTestId("plugin-attachment-picker");
      await picker.getByRole("button", { name: "Add WEB-1", exact: true }).click();
      await picker.getByRole("button", { name: "Done", exact: true }).click();
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("composer-plugin-resource-attachment-pill")).toHaveCount(1);
      const opened = page.waitForEvent("popup");
      await page.getByTestId("composer-plugin-resource-attachment-pill").click();
      const popup = await opened;
      await expect(popup).toHaveURL("https://example.com/issues/1");
      await popup.close();
      await submitMessage(page, "Explain web reference");
      await expect(page.getByTestId("composer-plugin-resource-attachment-pill")).toHaveCount(0);
      await expect
        .poll(async () => JSON.stringify(await plugin.timeline(agent.agentId)))
        .toContain("Web snapshot");
      await expect
        .poll(async () => JSON.stringify(await plugin.timeline(agent.agentId)))
        .toContain("https://example.com/issues/1");
    } finally {
      await agent.cleanup();
      await plugin.cleanup();
    }
  });

  test("previews full local snapshots, restores drafts and previews the sent reference", async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    const snapshotReads: number[] = [];
    const observeSnapshotRead = ({ payload }: { payload: string | Buffer }) => {
      if (!payload.toString().startsWith("{")) return;
      const envelope = JSON.parse(payload.toString());
      const message = envelope.message ?? envelope;
      if (message.type === "agent.resource_snapshot.read.request") {
        snapshotReads.push(message.index);
      }
    };
    page.on("websocket", (socket) => {
      socket.on("framesent", observeSnapshotRead);
    });
    const plugin = await installResourceAttachmentPlugin();
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "resource-attachment-",
      title: "Resource attachments",
    });
    try {
      await plugin.control({ longBody: true, itemCount: 10 });
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await openAttachmentMenu(page);
      await page.getByText("Attach Messages", { exact: true }).click();
      const picker = page.getByTestId("plugin-attachment-picker");
      await expect(picker.getByText("Indexed discussion 1", { exact: true })).toBeVisible();
      await picker.getByRole("button", { name: "Preview MSG-2", exact: true }).click();
      await expect(page.getByTestId("plugin-resource-preview")).toContainText(
        "A hidden detail outside the displayed excerpt",
      );
      await page
        .getByTestId("plugin-resource-preview")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await picker.getByRole("button", { name: "Add MSG-2", exact: true }).click();
      await picker.getByRole("button", { name: "Add MSG-1", exact: true }).click();
      for (let index = 3; index <= 10; index++) {
        await picker.getByRole("button", { name: `Add MSG-${index}`, exact: true }).click();
      }
      await picker.getByRole("button", { name: "Done", exact: true }).click();
      await expect(page.getByTestId("composer-plugin-resource-attachment-pill")).toHaveCount(10);
      await plugin.control({ revision: "updated" });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("composer-plugin-resource-attachment-pill")).toHaveCount(10);
      await page.getByTestId("composer-plugin-resource-attachment-pill").first().click();
      await expect(page.getByTestId("plugin-resource-preview")).toContainText(
        "original complete body 9223372036854775807",
      );
      await page
        .getByTestId("plugin-resource-preview")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await submitMessage(page, "Explain these references");
      await expect(page.getByTestId("composer-plugin-resource-attachment-pill")).toHaveCount(0);
      await expect(page.getByTestId("message-local-resource")).toHaveCount(8);
      await expect(
        page.getByRole("button", { name: "2 more references", exact: true }),
      ).toBeVisible();
      expect(snapshotReads).toEqual([]);
      await page.getByTestId("message-local-resource").first().click();
      await expect(page.getByTestId("plugin-resource-preview")).toContainText(
        "original complete body 9223372036854775807",
      );
      await expect(page.getByTestId("plugin-resource-preview")).toContainText(
        "opaque:account-a:9223372036854775807",
      );
      await page.screenshot({ path: info.outputPath("local-resource-preview.png") });
      const timeline = JSON.stringify(await plugin.timeline(agent.agentId));
      expect(timeline).toContain('"resourceSnapshot":{"count":10');
      expect(timeline).toContain("original complete body 9223372036854775807");
      expect(timeline).not.toContain("Complete snapshot ending");
      expect(timeline).not.toContain("updated complete body");
      await page
        .getByTestId("plugin-resource-preview")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      snapshotReads.length = 0;
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("message-local-resource")).toHaveCount(8);
      expect(snapshotReads).toEqual([]);
      await page.getByRole("button", { name: "2 more references", exact: true }).click();
      const preview = page.getByTestId("resource-preview-text");
      await expect(preview).toContainText("Complete snapshot ending 9223372036854775815");
      await page
        .getByTestId("resource-preview-navigation")
        .getByRole("button", { name: "Next", exact: true })
        .click();
      await expect(preview).toContainText("Complete snapshot ending 9223372036854775816");
      expect(new Set(snapshotReads)).toEqual(new Set([8, 9]));
      await page
        .getByTestId("plugin-resource-preview")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByTestId("message-local-resource").first().click();
      await expect(preview).toContainText("original complete body");
      await expect(preview).toContainText("Complete snapshot ending 9223372036854775807");
      await page
        .getByTestId("resource-preview-navigation")
        .getByRole("button", { name: "Next", exact: true })
        .click();
      await expect(preview).toContainText("Complete snapshot ending 9223372036854775808");
      await expect(preview).toContainText("opaque:account-a:9223372036854775808");
      await page.screenshot({ path: info.outputPath("local-resource-preview-compact.png") });
    } finally {
      await agent.cleanup();
      await plugin.cleanup();
    }
  });
});

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const TEST_IMAGE = { name: "test.png", mimeType: "image/png", buffer: MINIMAL_PNG };
const TEST_JSON = {
  name: "config.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify({ composer: "drop" })),
};

test.describe("Composer attachments", () => {
  test("selected file shows a loading attachment until upload is acknowledged", async ({
    page,
    withWorkspace,
  }) => {
    const upload = await controlFileUploadCompletion(page);
    const workspace = await withWorkspace({ prefix: "attach-upload-pending-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await expectComposerVisible(page);

    upload.hold();
    await attachFileFromMenu(page, TEST_JSON);
    await upload.waitForUpload();

    const pending = page.getByTestId("composer-pending-file-attachment");
    await expect(pending).toContainText(TEST_JSON.name);
    await expect(pending.getByRole("progressbar")).toBeVisible();
    await expect(page.getByTestId("composer-file-attachment-pill")).toHaveCount(0);

    upload.complete();
    await expect(pending).toHaveCount(0);
    await expect(page.getByTestId("composer-file-attachment-pill")).toContainText(TEST_JSON.name);
    await expectComposerEditable(page);
  });

  test("compact Plus menu aligns attachment rows with its sheet title", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(60_000);
    const workspace = await withWorkspace({ prefix: "attach-sheet-rails-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await expectComposerVisible(page);
    await page.setViewportSize({ width: 390, height: 844 });

    await openAttachmentMenu(page);

    await expectAttachmentSheetRowsOnTitleRail(page);
  });

  test("GitHub combobox does not render until the picker is opened", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(60_000);
    const workspace = await withWorkspace({ prefix: "attach-gh-lazy-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await expectComposerVisible(page);

    await expect(page.getByTestId("combobox-desktop-container")).not.toBeVisible();

    await openGithubPickerFromMenu(page);

    await expect(page.getByPlaceholder("Search issues and PRs...")).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByTestId("combobox-empty-text").or(page.getByText("Searching...")),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("attaches an issue and a pull request from the repository picker", async ({ page }) => {
    test.setTimeout(120_000);
    if (!hasGithubAuth()) {
      test.skip(true, "GitHub auth not available in this environment");
    }
    const ghRepo = await createTempGithubRepo({
      category: "attachments",
      issues: [{ title: "fix: attachment issue" }],
      prs: [{ title: "feat: attachment pull request", state: "open" }],
    });
    const handle = await openGithubWorkspace(page, ghRepo.prs[0].localPath);
    try {
      await clickNewChat(page);
      await expectComposerVisible(page);
      // Choose from the repository list. Newly created repositories are not
      // necessarily available in GitHub's separate text-search index yet.
      await selectGithubOption(page, "", `issue:${ghRepo.issues[0].number}`);
      await expectGithubAttachmentPill(page, ghRepo.issues[0]);
      await selectGithubOption(page, "", `change_request:${ghRepo.prs[0].number}`);
      await expectGithubAttachmentPill(page, ghRepo.prs[0]);
      await expectGithubAttachmentPill(page, ghRepo.issues[0]);
    } finally {
      await handle.cleanup();
      await ghRepo.cleanup();
    }
  });

  test.fixme("workspace-review pill suppresses on X-click and reappears after send", async () => {
    // The review attachment is created via InlineReviewEditor in surface.tsx (addComment action).
    // Automating this requires: a workspace with staged changes, navigating to the diff panel,
    // hovering the gutter "+" button, typing a comment, and submitting. A dedicated
    // helpers/review.ts with addInlineReviewComment(page, filePath, lineNumber, comment) is
    // needed before this can be exercised end-to-end.
  });

  test("attaches, previews, and removes an image before dropping a file", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(60_000);
    const workspace = await withWorkspace({ prefix: "attach-lightbox-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await expectComposerVisible(page);

    await test.step("open the available attachment choices", async () => {
      await openAttachmentMenu(page);
      await expect(page.getByTestId("message-input-attachment-menu-item-image")).toBeVisible();
      await expect(page.getByTestId("message-input-attachment-menu-item-github")).toBeVisible();
      await page.keyboard.press("Escape");
    });

    await attachImageFromMenu(page, TEST_IMAGE);
    await expectAttachmentPill(page, "composer-image-attachment-pill");

    await openImageLightbox(page);
    await closeImageLightbox(page);

    await test.step("remove the image and attach a dropped file", async () => {
      await removeAttachmentPill(page, "composer-image-attachment-pill", "Remove image attachment");
      await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(0);
      await dropFileOnComposer(page, TEST_JSON);
      await expectAttachmentPill(page, "composer-file-attachment-pill");
    });
  });

  test("dropped JSON file renders as a file attachment in New Workspace", async ({ page }) => {
    test.setTimeout(120_000);
    const workspace = await seedWorkspace({ repoPrefix: "attach-drop-new-workspace-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: workspace.workspaceId,
      });

      await openNewWorkspaceComposer(page, {
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectDisplayName,
      });

      await dropFileOnComposer(page, TEST_JSON);

      await expectAttachmentPill(page, "composer-file-attachment-pill");
    } finally {
      await workspace.cleanup();
    }
  });

  test("submitting while agent is running queues the message and clears the draft", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const agent = await startRunningMockAgent(page, {
      prefix: "attach-queue-",
      model: "one-minute-stream",
      prompt: "Stay running for queue test.",
    });
    try {
      await fillComposerDraft(page, "queued draft text");
      await sendDraftToQueue(page);

      await expectQueuedMessageButton(page);
      await expectComposerDraft(page, "");
    } finally {
      await agent.cleanup();
    }
  });

  test("Escape interrupt cancels the running agent and preserves composer draft", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const agent = await startRunningMockAgent(page, {
      prefix: "attach-interrupt-",
      model: "ten-second-stream",
      prompt: "Stay running for interrupt test.",
    });
    try {
      await fillComposerDraft(page, "preserve me");
      await pressInterruptShortcut(page);

      await expectAgentIdle(page, 15_000);
      await expectComposerDraft(page, "preserve me");
    } finally {
      await agent.cleanup();
    }
  });

  test("Escape cancels file creation without interrupting the running agent", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await startRunningMockAgent(page, {
      prefix: "file-create-escape-",
      model: "one-minute-stream",
      prompt: "Stay running while a file draft is cancelled.",
    });
    try {
      await openFileExplorer(page);
      await page.getByTestId("files-new-file").click();
      const nameInput = page.getByTestId("file-explorer-name-input");
      await expect(nameInput).toBeVisible();

      await nameInput.press("Escape");

      await expect(nameInput).toBeHidden();
      await expect(page.getByRole("button", { name: /stop|cancel/i }).first()).toBeVisible();
    } finally {
      await agent.cleanup();
    }
  });

  test("composer is locked while new workspace agent is being created", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();

    const agentCreatedDelay = await delayBrowserAgentCreatedStatus(page);
    const workspace = await seedWorkspace({ repoPrefix: "attach-lock-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: workspace.workspaceId,
      });

      await openNewWorkspaceComposer(page, {
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectDisplayName,
      });
      await fillComposerDraft(page, "lock test prompt");
      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      await agentCreatedDelay.waitForCreateRequest();
      await agentCreatedDelay.waitForDelayedCreatedStatus();

      await expectComposerDisabled(page);
      await expectAttachButtonDisabled(page);

      agentCreatedDelay.release();

      await expectComposerEditable(page);
    } finally {
      agentCreatedDelay.release();
      await workspace.cleanup();
    }
  });
});
