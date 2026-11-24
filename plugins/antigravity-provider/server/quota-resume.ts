import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderLaunch,
} from "@getpaseo/plugin/server/provider";
import { fetchAgyUsageGroups, type AgyUsageGroup } from "./usage.js";

export const MAX_5H_WAIT_MS = 6 * 60 * 60 * 1000;
const EXHAUSTED_THRESHOLD = 0.02;
const CLEARLY_AVAILABLE_THRESHOLD = 0.05;
const DEFAULT_BUFFER_SECONDS = 20;
const DEFAULT_MAX_CONSECUTIVE_RESUMES = 6;
const DEFAULT_MAX_TIMER_STEP_MS = 30_000;
const DEFAULT_VERIFY_RETRY_DELAY_MS = 30_000;
const MAX_VERIFY_RETRIES = 6;
const MAX_VERIFY_EXTENSION_MS = 10 * 60 * 1000;

export const DEFAULT_RESUME_PROMPT =
  "Antigravity 5 小时配额已恢复，请从刚才中断的地方继续完成未完成的任务。";

export interface QuotaSignal {
  matched: boolean;
  strict: boolean;
  resetsInMs: number | null;
  summary: string;
}

export type QuotaDecision =
  | {
      action: "schedule";
      resumeAtMs: number;
      groupName: string | null;
      reason: string;
    }
  | {
      action: "skip_weekly";
      groupName: string | null;
      reason: string;
    }
  | {
      action: "ignore";
      reason: string;
    };

export interface QuotaAutoResumeOptions {
  launch?: ProviderLaunch;
  fetchUsage?: () => Promise<AgyUsageGroup[] | null>;
  now?: () => number;
  bufferSeconds?: number;
  maxConsecutiveResumes?: number;
  resumePrompt?: string;
  maxTimerStepMs?: number;
  verifyRetryDelayMs?: number;
}

/**
 * Parse a relative reset duration such as "6m52s", "1h 23m 45s", "45s", "2h", or "1d 2h".
 */
export function parseResetDurationMs(text: string): number | null {
  const resetsMatch = /resets?\s+in\s+([^\n.!?,;]+)/i.exec(text);
  if (!resetsMatch) return null;
  const expr = resetsMatch[1]!.trim();

  const tokenRegex =
    /(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)(?![a-z])/gi;
  let totalMs = 0;
  let matchedAny = false;

  for (const match of expr.matchAll(tokenRegex)) {
    const value = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    if (!Number.isFinite(value) || value < 0) continue;
    matchedAny = true;
    if (unit.startsWith("d")) totalMs += value * 86_400_000;
    else if (unit.startsWith("h")) totalMs += value * 3_600_000;
    else if (unit.startsWith("m")) totalMs += value * 60_000;
    else if (unit.startsWith("s")) totalMs += value * 1_000;
  }

  return matchedAny && totalMs > 0 ? totalMs : null;
}

const STRICT_QUOTA_PATTERNS = [
  /individual quota reached/i,
  /⚠\s*.*quota reached.*resets?\s+in/i,
  /five[- ]hour\s+limit\s+(?:reached|exceeded|exhausted)/i,
];

const LOOSE_FAILED_QUOTA_PATTERNS = [
  /quota\s+(?:reached|exceeded|exhausted|limit)/i,
  /rate\s*limit/i,
  /resource_exhausted/i,
  /\b429\b/,
];

export function detectQuotaSignal(input: {
  turnState: "completed" | "failed" | "canceled";
  errorMessage?: string | null;
  errorCode?: string | null;
  tailTexts: readonly string[];
}): QuotaSignal {
  if (input.turnState === "canceled") {
    return { matched: false, strict: false, resetsInMs: null, summary: "" };
  }

  const candidates: { text: string; fromError: boolean }[] = [];
  if (input.errorMessage && input.errorMessage.trim().length > 0) {
    candidates.push({ text: input.errorMessage.trim(), fromError: true });
  }
  for (let i = input.tailTexts.length - 1; i >= 0; i -= 1) {
    const text = input.tailTexts[i]!.trim();
    if (text.length > 0) {
      candidates.push({ text, fromError: false });
    }
  }

  for (const candidate of candidates) {
    const isStrict = STRICT_QUOTA_PATTERNS.some((pattern) => pattern.test(candidate.text));
    if (isStrict) {
      const isTerminalNotice =
        candidate.fromError ||
        candidate.text.length <= 400 ||
        STRICT_QUOTA_PATTERNS.some((pattern) => pattern.test(candidate.text.slice(-300)));
      if (isTerminalNotice) {
        return {
          matched: true,
          strict: true,
          resetsInMs: parseResetDurationMs(candidate.text),
          summary: candidate.text.slice(0, 240),
        };
      }
    }
  }

  if (input.turnState === "failed") {
    const errorBlob = [input.errorCode ?? "", input.errorMessage ?? ""].join(" ").trim();
    if (LOOSE_FAILED_QUOTA_PATTERNS.some((pattern) => pattern.test(errorBlob))) {
      return {
        matched: true,
        strict: false,
        resetsInMs: parseResetDurationMs(errorBlob),
        summary: errorBlob.slice(0, 240),
      };
    }
  }

  return { matched: false, strict: false, resetsInMs: null, summary: "" };
}

export function selectUsageGroup(
  groups: readonly AgyUsageGroup[],
  model: string | null | undefined,
): AgyUsageGroup | null {
  if (groups.length === 0) return null;
  const normalizedModel = (model ?? "").toLowerCase();

  if (normalizedModel) {
    if (
      normalizedModel.includes("claude") ||
      normalizedModel.includes("gpt") ||
      normalizedModel.includes("opus") ||
      normalizedModel.includes("sonnet")
    ) {
      const thirdParty = groups.find(
        (group) => /claude|gpt/i.test(group.name) || group.buckets.some((b) => b.id.startsWith("3p-")),
      );
      if (thirdParty) return thirdParty;
    }
    if (normalizedModel.includes("gemini") || normalizedModel.includes("orchestrator")) {
      const gemini = groups.find(
        (group) =>
          /gemini/i.test(group.name) || group.buckets.some((b) => b.id.startsWith("gemini-")),
      );
      if (gemini) return gemini;
    }
  }

  const exhausted5h = groups.find((group) => {
    const bucket5h = group.buckets.find((b) => b.window.trim().toLowerCase() === "5h");
    return (
      bucket5h &&
      !bucket5h.disabled &&
      bucket5h.remaining_fraction != null &&
      bucket5h.remaining_fraction <= EXHAUSTED_THRESHOLD
    );
  });
  return exhausted5h ?? groups[0] ?? null;
}

function parseIsoTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isGroup5hAvailable(
  groups: readonly AgyUsageGroup[],
  model: string | null | undefined,
  groupName?: string | null,
): { available: boolean; resetTimeMs: number | null } {
  const group =
    (groupName ? groups.find((g) => g.name === groupName) : undefined) ??
    selectUsageGroup(groups, model);
  if (!group) return { available: true, resetTimeMs: null };
  const bucket5h = group.buckets.find((b) => b.window.trim().toLowerCase() === "5h");
  if (!bucket5h || bucket5h.disabled || bucket5h.remaining_fraction == null) {
    return { available: true, resetTimeMs: null };
  }
  return {
    available: bucket5h.remaining_fraction > EXHAUSTED_THRESHOLD,
    resetTimeMs: parseIsoTimestampMs(bucket5h.reset_time),
  };
}

function bucketRemaining(bucket: AgyUsageGroup["buckets"][number] | undefined): number | null {
  if (!bucket || bucket.disabled || bucket.remaining_fraction == null) return null;
  return bucket.remaining_fraction;
}

function valid5hResetMs(
  bucket: AgyUsageGroup["buckets"][number] | undefined,
  nowMs: number,
): number | null {
  const resetMs = parseIsoTimestampMs(bucket?.reset_time);
  if (resetMs === null || resetMs <= nowMs || resetMs - nowMs > MAX_5H_WAIT_MS) return null;
  return resetMs;
}

function resolveResumeAtMs(params: {
  fiveHourRemaining: number | null;
  usageResetMs: number | null;
  resetsInMs: number | null;
  turnState: "completed" | "failed" | "canceled";
  nowMs: number;
  bufferMs: number;
}): number | null {
  const exhausted =
    params.fiveHourRemaining !== null && params.fiveHourRemaining <= EXHAUSTED_THRESHOLD;
  if (exhausted && params.usageResetMs !== null) {
    return params.usageResetMs + params.bufferMs;
  }
  if (params.resetsInMs !== null) {
    return params.nowMs + params.resetsInMs + params.bufferMs;
  }
  if (params.turnState === "failed" && params.usageResetMs !== null) {
    return params.usageResetMs + params.bufferMs;
  }
  return null;
}

export function decideQuotaResume(input: {
  signal: QuotaSignal;
  turnState: "completed" | "failed" | "canceled";
  groups: readonly AgyUsageGroup[] | null;
  model: string | null | undefined;
  nowMs: number;
  bufferSeconds: number;
}): QuotaDecision {
  if (!input.signal.matched) {
    return { action: "ignore", reason: "No quota exhaustion signal detected." };
  }

  const group = input.groups ? selectUsageGroup(input.groups, input.model) : null;
  const groupName = group?.name ?? null;
  const bucket5h = group?.buckets.find((b) => b.window.trim().toLowerCase() === "5h");
  const bucketWeekly = group?.buckets.find((b) => b.window.trim().toLowerCase() === "weekly");
  const weeklyRemaining = bucketRemaining(bucketWeekly);
  const fiveHourRemaining = bucketRemaining(bucket5h);

  if (weeklyRemaining !== null && weeklyRemaining <= 0.005) {
    return { action: "skip_weekly", groupName, reason: "检测到 Weekly 配额已耗尽，跳过自动等待。" };
  }

  if (
    input.turnState === "completed" &&
    fiveHourRemaining !== null &&
    fiveHourRemaining > CLEARLY_AVAILABLE_THRESHOLD
  ) {
    return {
      action: "ignore",
      reason: "5h quota still has remaining capacity; treating text match as non-fatal.",
    };
  }

  if (input.signal.resetsInMs !== null && input.signal.resetsInMs > MAX_5H_WAIT_MS) {
    return {
      action: "skip_weekly",
      groupName,
      reason: "提示的恢复时间超过 6 小时（非 5h 窗口），跳过自动等待。",
    };
  }

  const resumeAtMs = resolveResumeAtMs({
    fiveHourRemaining,
    usageResetMs: valid5hResetMs(bucket5h, input.nowMs),
    resetsInMs: input.signal.resetsInMs,
    turnState: input.turnState,
    nowMs: input.nowMs,
    bufferMs: Math.max(0, input.bufferSeconds) * 1000,
  });
  if (resumeAtMs === null) {
    return { action: "ignore", reason: "Could not determine a valid 5h quota reset time." };
  }
  return {
    action: "schedule",
    resumeAtMs,
    groupName,
    reason: input.signal.summary || "Antigravity 5h 配额已耗尽",
  };
}

function formatRemaining(resumeAtMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.ceil((resumeAtMs - nowMs) / 1000));
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const seconds = diffSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

type TurnEvent = Extract<ProviderEvent, { type: "session.turn" }>;

interface ActiveQuotaWait {
  outerTurnId: string;
  waitCallId: string;
  resumeAtMs: number;
  groupName: string | null;
  attempt: number;
  verifyRetries: number;
  timer: ReturnType<typeof setTimeout> | null;
  checking: boolean;
  aborted: boolean;
  heldEvent: TurnEvent;
}

interface SessionState {
  model: string | null;
  activeOuterTurnId: string | null;
  activeInnerTurnId: string | null;
  internalClientMessageId: string | null;
  resumeAttempts: number;
  /** Ordered map of timeline item id -> text for the current inner turn. */
  tailTextById: Map<string, string>;
  wait: ActiveQuotaWait | null;
}

/**
 * Wrap an Antigravity ProviderConnection so that hitting the 5-hour quota keeps the Paseo turn
 * running, displays a live waiting tool row, waits until reset + buffer, and automatically sends
 * a continuation prompt on the same ACP session without emitting an intermediate turn completion.
 */
export function wrapQuotaAutoResumeConnection(
  inner: ProviderConnection,
  options: QuotaAutoResumeOptions = {},
): ProviderConnection {
  const now = options.now ?? (() => Date.now());
  const bufferSeconds = options.bufferSeconds ?? DEFAULT_BUFFER_SECONDS;
  const maxConsecutiveResumes = options.maxConsecutiveResumes ?? DEFAULT_MAX_CONSECUTIVE_RESUMES;
  const resumePrompt = options.resumePrompt ?? DEFAULT_RESUME_PROMPT;
  const maxTimerStepMs = options.maxTimerStepMs ?? DEFAULT_MAX_TIMER_STEP_MS;
  const verifyRetryDelayMs = options.verifyRetryDelayMs ?? DEFAULT_VERIFY_RETRY_DELAY_MS;

  const fetchUsage =
    options.fetchUsage ??
    (async (): Promise<AgyUsageGroup[] | null> => {
      if (!options.launch) return null;
      try {
        return await fetchAgyUsageGroups(options.launch);
      } catch {
        return null;
      }
    });

  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, SessionState>();
  let closed = false;
  let resumeSeq = 0;

  function emit(event: ProviderEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function getSession(sessionId: string): SessionState {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        model: null,
        activeOuterTurnId: null,
        activeInnerTurnId: null,
        internalClientMessageId: null,
        resumeAttempts: 0,
        tailTextById: new Map(),
        wait: null,
      };
      sessions.set(sessionId, state);
    }
    return state;
  }

  function emitWaitRow(
    sessionId: string,
    waitCallId: string,
    status: "running" | "completed" | "canceled" | "failed",
    text: string,
    error: string | null = null,
  ): void {
    const base = {
      id: waitCallId,
      type: "tool_call" as const,
      callId: waitCallId,
      name: "antigravity_quota_wait",
      detail: {
        type: "plain_text" as const,
        label: "等待 Antigravity 5h 配额恢复",
        text,
        icon: "sparkles" as const,
      },
    };
    const item =
      status === "failed"
        ? { ...base, status, error: error ?? text }
        : { ...base, status, error: null };
    emit({ type: "timeline.item", sessionId, item });
  }

  function clearWaitTimer(wait: ActiveQuotaWait): void {
    if (wait.timer) {
      clearTimeout(wait.timer);
      wait.timer = null;
    }
  }

  function resetTurnState(state: SessionState): void {
    state.activeOuterTurnId = null;
    state.activeInnerTurnId = null;
    state.internalClientMessageId = null;
    state.resumeAttempts = 0;
    state.tailTextById.clear();
  }

  function formatWaitText(wait: ActiveQuotaWait): string {
    const groupSuffix = wait.groupName ? ` · ${wait.groupName}` : "";
    return `预计 ${formatClock(wait.resumeAtMs)} 自动继续（剩余 ${formatRemaining(wait.resumeAtMs, now())}，第 ${wait.attempt}/${maxConsecutiveResumes} 次${groupSuffix}）`;
  }

  function armWaitTimer(sessionId: string, state: SessionState, wait: ActiveQuotaWait): void {
    clearWaitTimer(wait);
    if (closed || wait.aborted || state.wait !== wait) return;

    const remainingMs = Math.max(0, wait.resumeAtMs - now());
    const delayMs = Math.min(remainingMs, maxTimerStepMs);

    const timer = setTimeout(() => {
      wait.timer = null;
      if (closed || wait.aborted || state.wait !== wait) return;

      if (now() < wait.resumeAtMs) {
        emitWaitRow(sessionId, wait.waitCallId, "running", formatWaitText(wait));
        armWaitTimer(sessionId, state, wait);
        return;
      }

      void executeResume(sessionId, state, wait);
    }, delayMs);

    timer.unref?.();
    wait.timer = timer;
  }

  async function executeResume(
    sessionId: string,
    state: SessionState,
    wait: ActiveQuotaWait,
  ): Promise<void> {
    if (closed || wait.aborted || state.wait !== wait || wait.checking) return;
    wait.checking = true;

    try {
      const groups = await fetchUsage();
      if (closed || wait.aborted || state.wait !== wait) return;

      if (groups) {
        const availability = isGroup5hAvailable(groups, state.model, wait.groupName);
        if (!availability.available && wait.verifyRetries < MAX_VERIFY_RETRIES) {
          const nowMs = now();
          let nextMs = nowMs + verifyRetryDelayMs;
          if (
            availability.resetTimeMs !== null &&
            availability.resetTimeMs > nowMs &&
            availability.resetTimeMs - nowMs <= MAX_VERIFY_EXTENSION_MS
          ) {
            nextMs = availability.resetTimeMs + Math.max(15_000, bufferSeconds * 1000);
          }
          wait.verifyRetries += 1;
          wait.resumeAtMs = nextMs;
          wait.checking = false;
          emitWaitRow(
            sessionId,
            wait.waitCallId,
            "running",
            `配额尚未刷新，延后至 ${formatClock(nextMs)}（第 ${wait.verifyRetries}/${MAX_VERIFY_RETRIES} 次确认）`,
          );
          armWaitTimer(sessionId, state, wait);
          return;
        }
      }

      // Quota is ready: clear wait state and send a continuation prompt inside the same outer turn.
      state.wait = null;
      clearWaitTimer(wait);
      emitWaitRow(
        sessionId,
        wait.waitCallId,
        "completed",
        `5 小时配额已恢复（第 ${wait.attempt}/${maxConsecutiveResumes} 次），正在自动继续执行。`,
      );

      resumeSeq += 1;
      const clientMessageId = `quota_resume_${now()}_${resumeSeq}`;
      state.internalClientMessageId = clientMessageId;
      state.activeInnerTurnId = `acp:${clientMessageId}`;
      state.tailTextById.clear();

      try {
        await inner.send({
          type: "session.prompt",
          sessionId,
          prompt: {
            clientMessageId,
            delivery: "auto",
            input: {
              type: "message",
              content: [{ type: "text", text: resumePrompt }],
            },
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitWaitRow(
          sessionId,
          wait.waitCallId,
          "failed",
          `自动续跑失败：${message}`,
          message,
        );
        const outerTurnId = wait.outerTurnId;
        resetTurnState(state);
        emit({
          type: "session.turn",
          sessionId,
          turnId: outerTurnId,
          state: "failed",
          error: { message },
        });
      }
    } finally {
      wait.checking = false;
    }
  }

  async function handleQuotaHit(
    sessionId: string,
    state: SessionState,
    event: TurnEvent,
    signal: QuotaSignal,
  ): Promise<void> {
    const outerTurnId = state.activeOuterTurnId ?? event.turnId;
    const waitCallId = `quota_wait:${outerTurnId}:${state.resumeAttempts + 1}`;
    const provisionalWait: ActiveQuotaWait = {
      outerTurnId,
      waitCallId,
      resumeAtMs: now(),
      groupName: null,
      attempt: state.resumeAttempts + 1,
      verifyRetries: 0,
      timer: null,
      checking: true,
      aborted: false,
      heldEvent: event,
    };
    state.wait = provisionalWait;

    const groups = await fetchUsage();
    if (closed || provisionalWait.aborted || state.wait !== provisionalWait) {
      return;
    }

    const decision = decideQuotaResume({
      signal,
      turnState: event.state === "failed" ? "failed" : "completed",
      groups,
      model: state.model,
      nowMs: now(),
      bufferSeconds,
    });

    if (decision.action !== "schedule") {
      state.wait = null;
      if (decision.action === "skip_weekly") {
        emit({
          type: "timeline.item",
          sessionId,
          item: {
            id: `${waitCallId}:skip`,
            type: "notification",
            level: "warning",
            message: decision.reason,
          },
        });
      }
      resetTurnState(state);
      emit({ ...event, turnId: outerTurnId });
      return;
    }

    const nextAttempt = state.resumeAttempts + 1;
    if (nextAttempt > maxConsecutiveResumes) {
      state.wait = null;
      emit({
        type: "timeline.item",
        sessionId,
        item: {
          id: `${waitCallId}:limit`,
          type: "notification",
          level: "warning",
          message: `已连续自动续跑 ${state.resumeAttempts} 次达到上限（${maxConsecutiveResumes}），停止继续等待。`,
        },
      });
      resetTurnState(state);
      emit({ ...event, turnId: outerTurnId });
      return;
    }

    state.resumeAttempts = nextAttempt;
    provisionalWait.attempt = nextAttempt;
    provisionalWait.resumeAtMs = decision.resumeAtMs;
    provisionalWait.groupName = decision.groupName;
    provisionalWait.checking = false;

    emitWaitRow(sessionId, waitCallId, "running", formatWaitText(provisionalWait));
    armWaitTimer(sessionId, state, provisionalWait);
  }

  function handlePromptResultEvent(
    event: Extract<ProviderEvent, { type: "session.prompt_result" }>,
  ): void {
    const state = sessions.get(event.sessionId);
    if (!state?.internalClientMessageId || event.clientMessageId !== state.internalClientMessageId) {
      emit(event);
      return;
    }
    if (event.result.type === "turn") {
      state.activeInnerTurnId = event.result.turnId;
      return;
    }
    if (event.result.type === "failed") {
      const outerTurnId = state.activeOuterTurnId;
      resetTurnState(state);
      if (outerTurnId) {
        emit({
          type: "session.turn",
          sessionId: event.sessionId,
          turnId: outerTurnId,
          state: "failed",
          error: event.result.error,
        });
      }
    }
  }

  function handleTimelineEvent(
    event: Extract<ProviderEvent, { type: "timeline.item" }>,
  ): void {
    const state = getSession(event.sessionId);
    if (
      event.item.type === "user_message" &&
      state.internalClientMessageId &&
      event.item.clientMessageId === state.internalClientMessageId
    ) {
      return;
    }
    if (event.item.type === "assistant_message") {
      state.tailTextById.set(event.item.id, event.item.text);
    } else if (event.item.type === "error" || event.item.type === "notification") {
      state.tailTextById.set(event.item.id, event.item.message);
    }
    emit(event);
  }

  function handleTurnEvent(event: TurnEvent): void {
    const state = getSession(event.sessionId);

    if (event.state === "started") {
      if (
        state.internalClientMessageId &&
        state.activeOuterTurnId &&
        event.turnId === `acp:${state.internalClientMessageId}`
      ) {
        state.activeInnerTurnId = event.turnId;
        state.tailTextById.clear();
        return;
      }
      state.activeOuterTurnId = event.turnId;
      state.activeInnerTurnId = event.turnId;
      state.internalClientMessageId = null;
      state.resumeAttempts = 0;
      state.tailTextById.clear();
      emit(event);
      return;
    }

    if (event.state === "canceled") {
      const outerTurnId =
        state.activeOuterTurnId && event.turnId === state.activeInnerTurnId
          ? state.activeOuterTurnId
          : event.turnId;
      if (state.wait) {
        state.wait.aborted = true;
        clearWaitTimer(state.wait);
        emitWaitRow(event.sessionId, state.wait.waitCallId, "canceled", "已取消自动等待。");
        state.wait = null;
      }
      resetTurnState(state);
      emit({ ...event, turnId: outerTurnId });
      return;
    }

    if (state.activeInnerTurnId !== event.turnId && state.activeOuterTurnId !== event.turnId) {
      emit(event);
      return;
    }

    const signal = detectQuotaSignal({
      turnState: event.state,
      errorMessage: event.error?.message ?? null,
      errorCode: event.error?.code ?? null,
      tailTexts: [...state.tailTextById.values()],
    });
    if (signal.matched) {
      void handleQuotaHit(event.sessionId, state, event, signal);
      return;
    }
    const outerTurnId = state.activeOuterTurnId ?? event.turnId;
    resetTurnState(state);
    emit({ ...event, turnId: outerTurnId });
  }

  inner.onEvent((event) => {
    if (closed) return;

    switch (event.type) {
      case "session.config": {
        const state = getSession(event.sessionId);
        state.model = event.config.model ?? state.model;
        emit(event);
        return;
      }
      case "session.closed":
      case "session.runtime_failed": {
        const state = sessions.get(event.sessionId);
        if (state?.wait) {
          state.wait.aborted = true;
          clearWaitTimer(state.wait);
          state.wait = null;
        }
        sessions.delete(event.sessionId);
        emit(event);
        return;
      }
      case "session.prompt_result":
        handlePromptResultEvent(event);
        return;
      case "timeline.item":
        handleTimelineEvent(event);
        return;
      case "session.usage": {
        const state = sessions.get(event.sessionId);
        if (
          state?.activeOuterTurnId &&
          event.turnId === state.activeInnerTurnId &&
          event.turnId !== state.activeOuterTurnId
        ) {
          emit({ ...event, turnId: state.activeOuterTurnId });
          return;
        }
        emit(event);
        return;
      }
      case "session.turn":
        handleTurnEvent(event);
        return;
      default:
        emit(event);
    }
  });

  return {
    version: inner.version,
    capabilities: inner.capabilities,
    async send(input: ProviderInput): Promise<void> {
      if (input.type === "session.can_stop_runtime") {
        const state = sessions.get(input.sessionId);
        if (state?.wait) {
          emit({
            type: "session.can_stop_runtime",
            requestId: input.requestId,
            sessionId: input.sessionId,
            canStop: false,
          });
          return;
        }
      }

      if (input.type === "session.interrupt") {
        const state = sessions.get(input.sessionId);
        if (state?.wait) {
          const wait = state.wait;
          wait.aborted = true;
          clearWaitTimer(wait);
          state.wait = null;
          emitWaitRow(input.sessionId, wait.waitCallId, "canceled", "已手动停止等待配额恢复。");
          const outerTurnId = wait.outerTurnId;
          resetTurnState(state);
          emit({
            type: "session.turn",
            sessionId: input.sessionId,
            turnId: outerTurnId,
            state: "canceled",
          });
          emit({ type: "request.completed", requestId: input.requestId });
          return;
        }
      }

      if (input.type === "session.prompt") {
        const state = sessions.get(input.sessionId);
        if (state?.wait) {
          const wait = state.wait;
          wait.aborted = true;
          clearWaitTimer(wait);
          state.wait = null;
          emitWaitRow(
            input.sessionId,
            wait.waitCallId,
            "canceled",
            "检测到新消息，已取消自动等待。",
          );
          const outerTurnId = wait.outerTurnId;
          const heldEvent = wait.heldEvent;
          resetTurnState(state);
          emit({ ...heldEvent, turnId: outerTurnId });
        }
      }

      if (input.type === "session.close") {
        const state = sessions.get(input.sessionId);
        if (state?.wait) {
          state.wait.aborted = true;
          clearWaitTimer(state.wait);
          state.wait = null;
        }
        sessions.delete(input.sessionId);
      }

      await inner.send(input);
    },

    onEvent(listener: (event: ProviderEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async close(): Promise<void> {
      closed = true;
      for (const state of sessions.values()) {
        if (state.wait) {
          state.wait.aborted = true;
          clearWaitTimer(state.wait);
          state.wait = null;
        }
      }
      sessions.clear();
      await inner.close();
    },
  };
}
