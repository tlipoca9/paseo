import { expect, test } from "vitest";
import { backgroundWorkText, formatActiveWorkPillSummary } from "./presentation";

test("shows descriptions and commands once, with useful fallbacks", () => {
  expect(
    backgroundWorkText({ description: "Watch build", command: "tail -f build.log" }, "Monitor"),
  ).toEqual({ title: "Watch build", command: "tail -f build.log" });
  expect(backgroundWorkText({ description: null, command: "sleep 10" }, "Shell")).toEqual({
    title: "sleep 10",
    command: null,
  });
  expect(backgroundWorkText({ description: "sleep 10", command: "sleep 10" }, "Shell")).toEqual({
    title: "sleep 10",
    command: null,
  });
  expect(backgroundWorkText({ description: null }, "Shell")).toEqual({
    title: "Shell",
    command: null,
  });
});

test("formats compact active work pill summary with count and truncated lead title", () => {
  expect(
    formatActiveWorkPillSummary({
      count: 1,
      leadTitle: "python backfill.py",
      fallbackLabel: "1 background task",
    }),
  ).toBe("1 · python backfill.py");

  expect(
    formatActiveWorkPillSummary({
      count: 2,
      leadTitle: "python scripts/backfill_orders.py --env=prod --batch=500",
      fallbackLabel: "2 background tasks",
    }),
  ).toBe("2 · python scripts/backfill_ord…");

  expect(
    formatActiveWorkPillSummary({
      count: 1,
      leadTitle: null,
      fallbackLabel: "1 background task",
    }),
  ).toBe("1 background task");
});
