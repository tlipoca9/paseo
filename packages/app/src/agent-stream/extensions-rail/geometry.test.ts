import { describe, expect, it } from "vitest";
import {
  EXTENSIONS_RAIL_MIN_MARGIN_WIDTH,
  resolveChatRightMarginWidth,
  resolveExtensionsRailWidth,
} from "./geometry";

describe("extensions-rail geometry", () => {
  it("returns 0 right margin when content width is uncapped (Full) or fills the pane", () => {
    expect(resolveChatRightMarginWidth({ paneWidth: 1600, contentMaxWidth: undefined })).toBe(0);
    expect(resolveChatRightMarginWidth({ paneWidth: 768, contentMaxWidth: 768 })).toBe(0);
    expect(resolveChatRightMarginWidth({ paneWidth: 600, contentMaxWidth: 768 })).toBe(0);
  });

  it("computes symmetric right margin width for capped content columns", () => {
    expect(resolveChatRightMarginWidth({ paneWidth: 1208, contentMaxWidth: 768 })).toBe(220);
    expect(resolveChatRightMarginWidth({ paneWidth: 1400, contentMaxWidth: 768 })).toBe(316);
  });

  it("hides the rail below the 220px threshold and snaps to stable widths above it", () => {
    expect(resolveExtensionsRailWidth(0)).toBe(0);
    expect(resolveExtensionsRailWidth(EXTENSIONS_RAIL_MIN_MARGIN_WIDTH - 1)).toBe(0);
    expect(resolveExtensionsRailWidth(EXTENSIONS_RAIL_MIN_MARGIN_WIDTH)).toBe(196);
    expect(resolveExtensionsRailWidth(240)).toBe(196);
    expect(resolveExtensionsRailWidth(280)).toBe(228);
  });
});
