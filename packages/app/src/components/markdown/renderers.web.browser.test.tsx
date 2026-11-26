import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";
import { afterEach, beforeEach, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { WEB_RENDERERS } from "./renderers.web";

const Link = WEB_RENDERERS.link;
const LINK_TEXT = "src/index.ts";
const TEST_MD4C_FLAGS = { latexMath: false };

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function anchorPropsFor(url: string) {
  return { href: url };
}

function renderAnchor(link: { url: string; sourceType?: "markdown" | "text" | "inline-code" }) {
  if (!Link) {
    throw new Error("Expected a web link renderer");
  }
  const anchorProps = anchorPropsFor(link.url);
  const client = new QueryClient();
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Link link={link} anchorProps={anchorProps}>
          {LINK_TEXT}
        </Link>
      </QueryClientProvider>,
    ),
  );
  const anchor = container.querySelector("a");
  if (!anchor) {
    throw new Error("Expected a rendered link");
  }
  return anchor;
}

it("marks a link it recognized from a path for selection copy", () => {
  const anchor = renderAnchor({ url: LINK_TEXT, sourceType: "text" });
  expect(anchor.getAttribute("href")).toBe(LINK_TEXT);
  expect(anchor.getAttribute("data-paseo-markdown-recognized-link")).toBe("true");
});

it("leaves an authored link wrapped", () => {
  const anchor = renderAnchor({ url: "https://example.test/doc", sourceType: "markdown" });
  expect(anchor.hasAttribute("data-paseo-markdown-recognized-link")).toBe(false);
});

it("wraps long unbroken inline code tokens without overflowing a narrow flex column", async () => {
  const longIdentifier = "TestAdmitPendingTasksMySQLLegacyDrainReuseConflictAndDeleteGuard";
  const markdown = [
    `Checking \`${longIdentifier}\` inline in a paragraph.`,
    "",
    `- \`${longIdentifier}\``,
    "- `Test.*Volume|Test.*Precache|Test.*PreCache`",
    "- `internal/lifecycle/imagepreparation/scheduler`",
  ].join("\n");

  container.style.width = "260px";
  container.style.display = "flex";
  container.style.flexDirection = "column";

  act(() => {
    root.render(<EnrichedMarkdownText markdown={markdown} md4cFlags={TEST_MD4C_FLAGS} />);
  });

  await expect
    .poll(() => container.querySelectorAll("code").length, { timeout: 5000 })
    .toBeGreaterThanOrEqual(4);

  const mdRoot = container.querySelector<HTMLElement>(".enrm-text");
  const codeNodes = Array.from(container.querySelectorAll<HTMLElement>("code"));
  expect(mdRoot).not.toBeNull();

  const containerRight = container.getBoundingClientRect().right;
  expect(mdRoot!.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1);
  for (const codeEl of codeNodes) {
    expect(window.getComputedStyle(codeEl).overflowWrap).toBe("anywhere");
    expect(codeEl.getBoundingClientRect().right).toBeLessThanOrEqual(containerRight + 1);
  }
});
