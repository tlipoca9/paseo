import { describe, expect, it } from "vitest";
import {
  ProviderEventSchema,
  ProviderInputSchema,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
} from "@getpaseo/plugin/server/provider";
import {
  DEFAULT_RESUME_PROMPT,
  decideQuotaResume,
  detectQuotaSignal,
  parseResetDurationMs,
  wrapQuotaAutoResumeConnection,
} from "./quota-resume.js";
import type { AgyUsageGroup } from "./usage.js";

function createFakeConnection() {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sent: ProviderInput[] = [];
  let closed = false;

  const connection: ProviderConnection = {
    version: 1,
    capabilities: [],
    async send(input) {
      ProviderInputSchema.parse(input);
      sent.push(input);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      closed = true;
    },
  };

  return {
    connection,
    sent,
    get closed() {
      return closed;
    },
    emit(event: ProviderEvent) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

function hasRunningWaitRow(events: readonly ProviderEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === "timeline.item" &&
      e.item.type === "tool_call" &&
      e.item.name === "antigravity_quota_wait" &&
      e.item.status === "running",
  );
}

function hasSentPrompt(sent: readonly ProviderInput[]): boolean {
  return sent.some((input) => input.type === "session.prompt");
}

function hasCompletedTurn(events: readonly ProviderEvent[], turnId: string): boolean {
  return events.some(
    (e) => e.type === "session.turn" && e.turnId === turnId && e.state === "completed",
  );
}

const EXHAUSTED_5H_GROUPS: AgyUsageGroup[] = [
  {
    name: "Gemini Models",
    buckets: [
      { id: "gemini-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.4 },
      {
        id: "gemini-5h",
        name: "Five Hour Limit Remaining",
        window: "5h",
        remaining_fraction: 0,
        reset_time: "2026-11-24T17:00:00.040Z",
      },
    ],
  },
];

describe("quota parsing and decision", () => {
  it("parses compact Antigravity reset durations", () => {
    expect(
      parseResetDurationMs(
        "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 6m52s.",
      ),
    ).toBe((6 * 60 + 52) * 1000);
    expect(parseResetDurationMs("Resets in 1h 23m 45s")).toBe((3600 + 23 * 60 + 45) * 1000);
  });

  it("ignores completed turns when 5h quota still has plenty of capacity", () => {
    const signal = detectQuotaSignal({
      turnState: "completed",
      tailTexts: [
        "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 6m52s.",
      ],
    });
    const decision = decideQuotaResume({
      signal,
      turnState: "completed",
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.8 },
            { id: "gemini-5h", name: "5h", window: "5h", remaining_fraction: 0.45 },
          ],
        },
      ],
      model: "gemini-4-neon",
      nowMs: Date.parse("2026-11-24T17:00:00Z"),
      bufferSeconds: 20,
    });
    expect(decision.action).toBe("ignore");
  });
});

describe("wrapQuotaAutoResumeConnection", () => {
  it("keeps the outer turn running while waiting for 5h reset, blocks idle stop, and resumes seamlessly", async () => {
    const fake = createFakeConnection();
    let nowMs = Date.parse("2026-11-24T17:00:00.000Z");
    let usageCalls = 0;

    const wrapped = wrapQuotaAutoResumeConnection(fake.connection, {
      now: () => nowMs,
      bufferSeconds: 0,
      maxTimerStepMs: 10,
      verifyRetryDelayMs: 10,
      fetchUsage: async () => {
        usageCalls += 1;
        if (usageCalls === 1) return EXHAUSTED_5H_GROUPS;
        return [
          {
            name: "Gemini Models",
            buckets: [
              { id: "gemini-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.4 },
              { id: "gemini-5h", name: "5h", window: "5h", remaining_fraction: 1 },
            ],
          },
        ];
      },
    });

    const events: ProviderEvent[] = [];
    wrapped.onEvent((event) => {
      ProviderEventSchema.parse(event);
      events.push(event);
    });

    fake.emit({
      type: "session.config",
      sessionId: "sess-1",
      config: {
        model: "gemini-4-neon",
        modeId: "full-access",
        models: [],
        modes: [],
        thinkingOptions: [],
        options: {},
      },
    });
    fake.emit({ type: "session.turn", sessionId: "sess-1", turnId: "acp:msg-1", state: "started" });
    fake.emit({
      type: "timeline.item",
      sessionId: "sess-1",
      item: {
        id: "assistant-1",
        type: "assistant_message",
        text: "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 6m52s.",
      },
    });
    fake.emit({
      type: "session.turn",
      sessionId: "sess-1",
      turnId: "acp:msg-1",
      state: "completed",
    });

    await expect.poll(() => hasRunningWaitRow(events)).toBe(true);

    // The outer turn must NOT have completed yet (session stays running).
    expect(
      events.some((e) => e.type === "session.turn" && e.state === "completed"),
    ).toBe(false);

    // Idle runtime cleanup must be blocked while waiting.
    await wrapped.send({
      type: "session.can_stop_runtime",
      requestId: "req-stop-check",
      sessionId: "sess-1",
    });
    expect(
      events.find((e) => e.type === "session.can_stop_runtime" && e.requestId === "req-stop-check"),
    ).toMatchObject({ canStop: false });

    // Advance past reset_time and verify the continuation prompt is dispatched.
    nowMs = Date.parse("2026-11-24T17:00:00.100Z");
    await expect.poll(() => hasSentPrompt(fake.sent)).toBe(true);

    const resumeSend = fake.sent.find(
      (input): input is Extract<ProviderInput, { type: "session.prompt" }> =>
        input.type === "session.prompt",
    )!;
    expect(resumeSend.prompt.input).toEqual({
      type: "message",
      content: [{ type: "text", text: DEFAULT_RESUME_PROMPT }],
    });
    const internalId = resumeSend.prompt.clientMessageId;

    // Simulate inner ACP session running the continuation turn.
    fake.emit({
      type: "timeline.item",
      sessionId: "sess-1",
      item: {
        id: internalId,
        type: "user_message",
        text: DEFAULT_RESUME_PROMPT,
        clientMessageId: internalId,
      },
    });
    fake.emit({
      type: "session.prompt_result",
      sessionId: "sess-1",
      clientMessageId: internalId,
      result: { type: "turn", turnId: `acp:${internalId}` },
    });
    fake.emit({
      type: "session.turn",
      sessionId: "sess-1",
      turnId: `acp:${internalId}`,
      state: "started",
    });
    fake.emit({
      type: "timeline.item",
      sessionId: "sess-1",
      item: { id: "assistant-2", type: "assistant_message", text: "Done!" },
    });
    fake.emit({
      type: "session.turn",
      sessionId: "sess-1",
      turnId: `acp:${internalId}`,
      state: "completed",
    });

    // Synthetic user_message and duplicate started turn must be absorbed.
    expect(
      events.some((e) => e.type === "timeline.item" && e.item.type === "user_message"),
    ).toBe(false);
    expect(
      events.filter((e) => e.type === "session.turn" && e.state === "started"),
    ).toHaveLength(1);

    // Final completion must map back to the original outer turn ID.
    expect(
      events.filter((e) => e.type === "session.turn" && e.state === "completed"),
    ).toEqual([
      {
        type: "session.turn",
        sessionId: "sess-1",
        turnId: "acp:msg-1",
        state: "completed",
      },
    ]);

    await wrapped.close();
  });

  it("cancels waiting cleanly on session.interrupt", async () => {
    const fake = createFakeConnection();
    const nowMs = Date.parse("2026-11-24T17:00:00.000Z");
    const wrapped = wrapQuotaAutoResumeConnection(fake.connection, {
      now: () => nowMs,
      bufferSeconds: 20,
      maxTimerStepMs: 5_000,
      fetchUsage: async () => EXHAUSTED_5H_GROUPS,
    });

    const events: ProviderEvent[] = [];
    wrapped.onEvent((event) => {
      ProviderEventSchema.parse(event);
      events.push(event);
    });

    fake.emit({ type: "session.turn", sessionId: "sess-2", turnId: "acp:msg-2", state: "started" });
    fake.emit({
      type: "timeline.item",
      sessionId: "sess-2",
      item: {
        id: "assistant-1",
        type: "assistant_message",
        text: "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 6m52s.",
      },
    });
    fake.emit({
      type: "session.turn",
      sessionId: "sess-2",
      turnId: "acp:msg-2",
      state: "completed",
    });

    await expect.poll(() => hasRunningWaitRow(events)).toBe(true);

    await wrapped.send({
      type: "session.interrupt",
      requestId: "req-cancel-1",
      sessionId: "sess-2",
    });

    expect(
      events.some(
        (e) =>
          e.type === "session.turn" &&
          e.turnId === "acp:msg-2" &&
          e.state === "canceled",
      ),
    ).toBe(true);
    expect(
      events.some((e) => e.type === "request.completed" && e.requestId === "req-cancel-1"),
    ).toBe(true);
    expect(fake.sent).toEqual([]);

    await wrapped.close();
  });

  it("releases the held turn immediately when weekly quota is exhausted", async () => {
    const fake = createFakeConnection();
    const wrapped = wrapQuotaAutoResumeConnection(fake.connection, {
      now: () => Date.parse("2026-11-24T17:00:00.000Z"),
      fetchUsage: async () => [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0 },
            { id: "gemini-5h", name: "5h", window: "5h", remaining_fraction: 0 },
          ],
        },
      ],
    });

    const events: ProviderEvent[] = [];
    wrapped.onEvent((event) => {
      ProviderEventSchema.parse(event);
      events.push(event);
    });

    fake.emit({ type: "session.turn", sessionId: "sess-3", turnId: "acp:msg-3", state: "started" });
    fake.emit({
      type: "timeline.item",
      sessionId: "sess-3",
      item: {
        id: "assistant-1",
        type: "assistant_message",
        text: "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 6m52s.",
      },
    });
    fake.emit({
      type: "session.turn",
      sessionId: "sess-3",
      turnId: "acp:msg-3",
      state: "completed",
    });

    await expect.poll(() => hasCompletedTurn(events, "acp:msg-3")).toBe(true);

    expect(
      events.some(
        (e) => e.type === "timeline.item" && e.item.type === "notification",
      ),
    ).toBe(true);

    await wrapped.close();
  });
});
