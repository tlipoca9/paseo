import { SPACING } from "@/styles/theme";

/** Minimum right-margin width (in CSS px) required before the extensions rail appears. */
export const EXTENSIONS_RAIL_MIN_MARGIN_WIDTH = 220;

/** Distance from the right edge of the chat pane to the rail. */
export const EXTENSIONS_RAIL_RIGHT_INSET = SPACING[3];

/** Minimum breathing room between the centered conversation column and the rail. */
const EXTENSIONS_RAIL_CONTENT_GAP = SPACING[3];

const EXTENSIONS_RAIL_COMPACT_WIDTH = 196;
const EXTENSIONS_RAIL_COMFORTABLE_WIDTH = 228;
const EXTENSIONS_RAIL_COMFORTABLE_MIN_MARGIN =
  EXTENSIONS_RAIL_COMFORTABLE_WIDTH + EXTENSIONS_RAIL_RIGHT_INSET + EXTENSIONS_RAIL_CONTENT_GAP;

/**
 * Computes the available whitespace on the right side of the centered chat column.
 * Returns `0` when the column is uncapped (`Full` width) or wider than the pane.
 */
export function resolveChatRightMarginWidth(input: {
  paneWidth: number;
  contentMaxWidth: number | undefined;
}): number {
  if (input.contentMaxWidth === undefined || input.paneWidth <= input.contentMaxWidth) {
    return 0;
  }
  return Math.floor((input.paneWidth - input.contentMaxWidth) / 2);
}

/**
 * Maps the available right-margin width into a discrete rail width (`0`, `196`, or `228`).
 * Using discrete buckets keeps React state stable during continuous window resizing and
 * guarantees the rail never encroaches on the centered conversation column.
 */
export function resolveExtensionsRailWidth(rightMarginWidth: number): number {
  if (rightMarginWidth < EXTENSIONS_RAIL_MIN_MARGIN_WIDTH) {
    return 0;
  }
  if (rightMarginWidth >= EXTENSIONS_RAIL_COMFORTABLE_MIN_MARGIN) {
    return EXTENSIONS_RAIL_COMFORTABLE_WIDTH;
  }
  return EXTENSIONS_RAIL_COMPACT_WIDTH;
}
