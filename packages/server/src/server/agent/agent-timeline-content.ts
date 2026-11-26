import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { PluginIdSchema } from "@getpaseo/protocol/plugin-config";

export const PLUGIN_TIMELINE_DATA_MAX_BYTES = 64 * 1024;

// One timeline fetch sends its entries in one WebSocket message, so every item must stay small.
// Budgets count UTF-16 units plus a fixed cost per node; neither is exact JSON bytes. They bound
// long strings and long arrays, not wide objects (every entry is kept) or multi-byte text.
const TOOL_CALL_BUDGET = 64 * 1024;
const ITEM_BUDGET = 256 * 1024;
const NODE_COST = 8;
const MARKER_COST = 32;
// Ids, names, paths and queries stay whole, so an item keeps its identity across passes.
const SHORT_STRING = 1024;
const MAX_DEPTH = 64;
const EDIT_DIFF_CONTEXT_LINES = 3;
const EDIT_DIFF_MAX_LCS_CELLS = 250_000;

function splitDiffLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface DiffOp {
  type: "equal" | "remove" | "add";
  text: string;
  oldLine?: number;
  newLine?: number;
}

function formatDiffOpLine(op: DiffOp): string {
  if (op.type === "add") return `+${op.text}`;
  if (op.type === "remove") return `-${op.text}`;
  return ` ${op.text}`;
}

function computeLcsDiffOps(middleOld: string[], middleNew: string[], prefix: number): DiffOp[] {
  const n = middleOld.length;
  const m = middleNew.length;
  const cols = m + 1;
  const dp = new Int32Array((n + 1) * cols);

  for (let i = n - 1; i >= 0; i -= 1) {
    const row = i * cols;
    const next = (i + 1) * cols;
    const line = middleOld[i];
    for (let j = m - 1; j >= 0; j -= 1) {
      if (line === middleNew[j]) {
        dp[row + j] = dp[next + j + 1]! + 1;
      } else {
        const down = dp[next + j]!;
        const right = dp[row + j + 1]!;
        dp[row + j] = down >= right ? down : right;
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (middleOld[i] === middleNew[j]) {
      ops.push({
        type: "equal",
        text: middleOld[i]!,
        oldLine: prefix + 1 + i,
        newLine: prefix + 1 + j,
      });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * cols + j]! >= dp[i * cols + (j + 1)]!) {
      ops.push({ type: "remove", text: middleOld[i]!, oldLine: prefix + 1 + i });
      i += 1;
    } else {
      ops.push({ type: "add", text: middleNew[j]!, newLine: prefix + 1 + j });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: "remove", text: middleOld[i]!, oldLine: prefix + 1 + i });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: "add", text: middleNew[j]!, newLine: prefix + 1 + j });
    j += 1;
  }
  return ops;
}

function computeMiddleDiffOps(middleOld: string[], middleNew: string[], prefix: number): DiffOp[] {
  const n = middleOld.length;
  const m = middleNew.length;
  if (n > 0 && m > 0 && n * m <= EDIT_DIFF_MAX_LCS_CELLS) {
    return computeLcsDiffOps(middleOld, middleNew, prefix);
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < n; i += 1) {
    ops.push({ type: "remove", text: middleOld[i]!, oldLine: prefix + 1 + i });
  }
  for (let j = 0; j < m; j += 1) {
    ops.push({ type: "add", text: middleNew[j]!, newLine: prefix + 1 + j });
  }
  return ops;
}

function formatUnifiedDiffHunks(fullOps: DiffOp[]): string {
  const changeIndices: number[] = [];
  for (let idx = 0; idx < fullOps.length; idx += 1) {
    if (fullOps[idx]!.type !== "equal") changeIndices.push(idx);
  }
  if (changeIndices.length === 0) return "";

  const hunks: Array<{ start: number; end: number }> = [];
  for (const idx of changeIndices) {
    const start = Math.max(0, idx - EDIT_DIFF_CONTEXT_LINES);
    const end = Math.min(fullOps.length - 1, idx + EDIT_DIFF_CONTEXT_LINES);
    const prev = hunks[hunks.length - 1];
    if (prev && start <= prev.end + 1) prev.end = Math.max(prev.end, end);
    else hunks.push({ start, end });
  }

  const out: string[] = [];
  for (const hunk of hunks) {
    const slice = fullOps.slice(hunk.start, hunk.end + 1);
    const firstOld = slice.find((op) => op.oldLine !== undefined)?.oldLine ?? 1;
    const firstNew = slice.find((op) => op.newLine !== undefined)?.newLine ?? 1;
    const oldSpan = slice.filter((op) => op.type !== "add").length;
    const newSpan = slice.filter((op) => op.type !== "remove").length;
    out.push(`@@ -${firstOld},${oldSpan} +${firstNew},${newSpan} @@`);
    for (const op of slice) {
      out.push(formatDiffOpLine(op));
    }
  }
  return out.join("\n");
}

/**
 * Compacts an oversized full-file edit (`oldString` + `newString`) into a standard
 * unified diff before generic string truncation runs. Without this, cutting both
 * full-file strings at a fixed character cap destroys edits near the end of large files
 * and introduces phantom diff hunks right at the truncation boundary.
 */
function compactOversizedEditToUnifiedDiff(oldText: string, newText: string): string | null {
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  if (prefix === oldEnd && prefix === newEnd) {
    return "";
  }

  const middleOps = computeMiddleDiffOps(
    oldLines.slice(prefix, oldEnd),
    newLines.slice(prefix, newEnd),
    prefix,
  );

  const fullOps: DiffOp[] = [];
  const leadStart = Math.max(0, prefix - EDIT_DIFF_CONTEXT_LINES);
  for (let i = leadStart; i < prefix; i += 1) {
    fullOps.push({ type: "equal", text: oldLines[i]!, oldLine: i + 1, newLine: i + 1 });
  }
  for (const op of middleOps) fullOps.push(op);
  const trailCount = Math.min(oldLines.length - oldEnd, EDIT_DIFF_CONTEXT_LINES);
  for (let i = 0; i < trailCount; i += 1) {
    fullOps.push({
      type: "equal",
      text: oldLines[oldEnd + i]!,
      oldLine: oldEnd + i + 1,
      newLine: newEnd + i + 1,
    });
  }

  return formatUnifiedDiffHunks(fullOps);
}

function maybeCompactOversizedEditItem(item: AgentTimelineItem): AgentTimelineItem {
  if (item.type !== "tool_call" || item.detail.type !== "edit") return item;
  const { oldString, newString, unifiedDiff } = item.detail;
  if (unifiedDiff || typeof oldString !== "string" || typeof newString !== "string") return item;
  if (!oldString || !newString) return item;
  const diff = compactOversizedEditToUnifiedDiff(oldString, newString);
  if (diff === null) return item;
  // Drop redundant full-file strings now that unifiedDiff captures the exact hunks with line numbers.
  const { oldString: _old, newString: _new, ...restDetail } = item.detail;
  return {
    ...item,
    detail: {
      ...restDetail,
      ...(diff ? { unifiedDiff: diff } : {}),
    },
  };
}

// The app registers renderer kinds under the plugin ID rule, so stored kinds must use that format.
export function assertPluginTimelineKind(kind: string): void {
  if (!PluginIdSchema.safeParse(kind).success) {
    throw new Error(
      `Plugin timeline item kind must start with a lowercase letter and contain only lowercase letters, digits, and dashes: ${JSON.stringify(kind)}`,
    );
  }
}

export function assertPluginTimelineDataSize(data: JsonValue): void {
  const serializedBytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (serializedBytes > PLUGIN_TIMELINE_DATA_MAX_BYTES) {
    throw new Error(`Plugin timeline item data exceeds ${PLUGIN_TIMELINE_DATA_MAX_BYTES} bytes`);
  }
}

/** A sliced string can keep the entire provider output alive. Copy only the retained UTF-16
 * units, including an unmatched surrogate at the existing character limit. */
function retainTextPrefix(text: string, length: number): string {
  return Buffer.from(text.slice(0, length), "utf16le").toString("utf16le");
}

function formatSize(units: number): string {
  if (units < 1024) return `${units} B`;
  if (units < 1024 * 1024) return `${(units / 1024).toFixed(1)} KB`;
  return `${(units / (1024 * 1024)).toFixed(1)} MB`;
}

function truncatedMarker(units: number): string {
  return `…[truncated ${formatSize(units)}]`;
}

interface ItemSize {
  nodeCost: number;
  stringLengths: number[];
  tooDeep: boolean;
}

function measure(value: unknown, depth: number, size: ItemSize): void {
  size.nodeCost += NODE_COST;
  if (depth > MAX_DEPTH) {
    size.tooDeep = true;
  } else if (typeof value === "string") {
    size.stringLengths.push(value.length);
  } else if (Array.isArray(value)) {
    for (const element of value) measure(element, depth + 1, size);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      size.nodeCost += key.length;
      measure(child, depth + 1, size);
    }
  }
}

/** The largest per-string length that keeps all strings, once cut, within `available`. */
function findStringCap(lengths: readonly number[], available: number): number {
  let low = 0;
  let high = 0;
  for (const length of lengths) high = Math.max(high, length);
  while (low < high) {
    const cap = Math.ceil((low + high) / 2);
    let total = 0;
    for (const length of lengths) total += Math.min(length, cap);
    if (total <= available) low = cap;
    else high = cap - 1;
  }
  return low;
}

interface CutState {
  stringCap: number;
  remaining: number;
}

function cutString(text: string, cap: number): string {
  if (text.length <= cap) return text;
  // A partial data URL is useless to every reader, so drop it whole.
  if (text.startsWith("data:")) return truncatedMarker(text.length);
  return retainTextPrefix(text, cap) + truncatedMarker(text.length - cap);
}

function cut(value: unknown, depth: number, state: CutState): unknown {
  state.remaining -= NODE_COST;
  if (depth > MAX_DEPTH) return "…[truncated]";
  if (typeof value === "string") {
    const text = cutString(value, state.stringCap);
    state.remaining -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const output: unknown[] = [];
    for (const element of value) {
      const remainingBefore = state.remaining;
      const next = cut(element, depth + 1, state);
      if (state.remaining < 0) {
        // Drop this and later elements. A marker element would break typed arrays.
        state.remaining = remainingBefore;
        changed = true;
        break;
      }
      changed ||= next !== element;
      output.push(next);
    }
    return changed ? output : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      state.remaining -= key.length;
      const next = cut(child, depth + 1, state);
      changed ||= next !== child;
      output[key] = next;
    }
    return changed ? output : value;
  }
  return value;
}

/** Returns the item itself when it fits its budget; otherwise a copy with its largest strings cut. */
export function limitAgentTimelineItemContent(item: AgentTimelineItem): AgentTimelineItem {
  const budget = item.type === "tool_call" ? TOOL_CALL_BUDGET : ITEM_BUDGET;
  const initialSize: ItemSize = { nodeCost: 0, stringLengths: [], tooDeep: false };
  measure(item, 0, initialSize);
  let initialStringTotal = 0;
  for (const length of initialSize.stringLengths) initialStringTotal += length;
  if (!initialSize.tooDeep && initialSize.nodeCost + initialStringTotal <= budget) return item;

  const candidate = maybeCompactOversizedEditItem(item);
  const size: ItemSize =
    candidate === item ? initialSize : { nodeCost: 0, stringLengths: [], tooDeep: false };
  let stringTotal = initialStringTotal;
  if (candidate !== item) {
    measure(candidate, 0, size);
    stringTotal = 0;
    for (const length of size.stringLengths) stringTotal += length;
    if (!size.tooDeep && size.nodeCost + stringTotal <= budget) return candidate;
  }

  // Strings get what structure leaves, but at least half the budget, less a margin for JSON
  // escaping. Arrays drop the elements that do not fit, which bounds items whose short strings
  // or structure alone are too big.
  const markerCost =
    MARKER_COST * size.stringLengths.filter((length) => length > SHORT_STRING).length;
  const available = (budget * 15) / 16 - Math.min(size.nodeCost, budget / 2) - markerCost;
  const stringCap = Math.max(SHORT_STRING, findStringCap(size.stringLengths, available));
  return cut(candidate, 0, { stringCap, remaining: budget }) as AgentTimelineItem;
}
