import { expect, test } from "vitest";
import { backgroundWorkText } from "./presentation";

test("shows descriptions and commands once, with useful fallbacks", () => {
  expect(
    backgroundWorkText({ description: "dev server", command: "npm run dev" }, "Command"),
  ).toEqual({
    title: "dev server",
    command: "npm run dev",
  });

  expect(backgroundWorkText({ description: null, command: "npm run dev" }, "Command")).toEqual({
    title: "npm run dev",
    command: null,
  });

  expect(backgroundWorkText({ description: null, command: undefined }, "Monitor")).toEqual({
    title: "Monitor",
    command: null,
  });
});
