import { describe, expect, it } from "vitest";
import { parseSessionRefPaste } from "./session-ref-paste";

describe("parseSessionRefPaste", () => {
  it("parses a workspace session reference with multiple agents as exact match", () => {
    const raw = [
      "[Paseo 会话引用] 镜像预热计费代码优化 (workspace: wks_e52fbb4f84fc41b0, cwd: /Users/me/.paseo/worktrees/2fxs4jdz/hulking-termite)",
      "- 国际站验证 (agentId: 44684349-48a6-4130-90be-89da5b845e82)",
      "- 计费灰度 (agentId: 033e2a7f-8fb6-461b-aa6b-6dd0a7994ef0)",
    ].join("\n");

    const parsed = parseSessionRefPaste(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.isExactMatch).toBe(true);
    expect(parsed?.attachment).toMatchObject({
      kind: "session_ref",
      id: "session_ref:wks_e52fbb4f84fc41b0",
      title: "镜像预热计费代码优化",
      subtitle: "2 个会话 · hulking-termite",
      workspaceId: "wks_e52fbb4f84fc41b0",
      text: raw,
    });
  });

  it("parses a single agent session reference", () => {
    const raw =
      "[Paseo 会话引用] 国际站验证 (agentId: 44684349-48a6-4130-90be-89da5b845e82, workspace: 镜像预热, cwd: /repo/sandstorm)";

    const parsed = parseSessionRefPaste(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.isExactMatch).toBe(true);
    expect(parsed?.attachment).toMatchObject({
      kind: "session_ref",
      id: "session_ref:44684349-48a6-4130-90be-89da5b845e82",
      title: "国际站验证",
      agentId: "44684349-48a6-4130-90be-89da5b845e82",
      workspaceId: "镜像预热",
    });
  });

  it("marks isExactMatch false when surrounded by user notes", () => {
    const raw = [
      "[Paseo 会话引用] 计费灰度 (agentId: 033e2a7f, workspace: wks_1)",
      "",
      "帮我接着查这个会话里的问题",
    ].join("\n");

    const parsed = parseSessionRefPaste(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.isExactMatch).toBe(false);
    expect(parsed?.attachment.title).toBe("计费灰度");
  });

  it("returns null for ordinary text", () => {
    expect(parseSessionRefPaste("普通消息内容")).toBeNull();
  });
});
