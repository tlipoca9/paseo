import { DeliveryRevokedError, type DeliveryScope } from "../delivery-scopes.js";
import type { AgentInputOrigin } from "@getpaseo/protocol/agent-types";
import type { AgentExecution, AgentExecutionGuideResult } from "@getpaseo/protocol/messages";
import type { PromptDispatchDisposition } from "../agent-prompt.js";
import { randomUUID } from "node:crypto";
import type { AgentPromptInput, AgentPromptContentBlock } from "../agent-sdk-types.js";
import { prepareAgentMessage, type AgentPromptSource } from "./envelope.js";

interface Message {
  deliveryScope?: DeliveryScope;
  inputOrigin?: AgentInputOrigin;
  recipientId: string;
  expectedExecution?: AgentExecution;
  onExecutionGuided?: (result: AgentExecutionGuideResult) => void;
  messageId?: string;
  source: AgentPromptSource;
  prompt: AgentPromptInput;
  sessionMode?: string;
  unarchive?: boolean;
  clearPendingPermissions?: boolean;
  activeTurnBehavior?: "steer" | "interrupt";
  beforeDispatch?: () => void;
  onDispatch?: (disposition: PromptDispatchDisposition) => void;
}
interface Receipt {
  status: "queued";
  messageId: string;
  dispatched: Promise<PromptDispatchDisposition>;
}
interface Admitted extends Message {
  started?: boolean;
  revoked?: boolean;
  receipt: Receipt;
  resolve(disposition: PromptDispatchDisposition): void;
  reject(error: unknown): void;
}
interface DispatchRequest {
  deliveryScope?: DeliveryScope;
  inputOrigin?: AgentInputOrigin;
  recipientId: string;
  expectedExecution?: AgentExecution;
  onExecutionGuided?: (result: AgentExecutionGuideResult) => void;
  messageIds: readonly string[];
  prompt: AgentPromptInput;
  activeTurnBehavior: "steer" | "interrupt";
  sessionMode?: string;
  clearPendingPermissions: boolean;
  unarchive: boolean;
  onDispatch(disposition: PromptDispatchDisposition): void;
}
interface Dependencies {
  dispatch(request: DispatchRequest): Promise<PromptDispatchDisposition>;
  onError(error: unknown, request: DispatchRequest): void;
  /** Return a cancellation function. Production uses the daemon's event loop. */
  schedule?: (delayMs: number, callback: () => void) => () => void;
}
export interface AgentMessageDelivery {
  enqueue(message: Message): Receipt;
  /** Queued messages and provider dispatches still owned by this recipient. */
  hasPending(recipientId: string): boolean;
  /** Stop admission, flush pending messages, and await provider dispatch acknowledgments. */
  close(): Promise<void>;
  /** Existing completion waits include agent messages admitted before the wait. */
  waitForDispatch(recipientId: string, signal: AbortSignal): Promise<void>;
}

/** Recipient-owned agent delivery. Human prompts never enter this module. */
export function createAgentMessageDelivery(dependencies: Dependencies): AgentMessageDelivery {
  const schedule =
    dependencies.schedule ??
    ((delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  const pending = new Map<string, { messages: Admitted[]; cancel(): void }>();
  const dispatching = new Map<string, Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function dispatch(recipientId: string, messages: Admitted[]): void {
    const previous = dispatching.get(recipientId) ?? Promise.resolve();
    const dispatched = previous
      .catch(() => undefined)
      .then(async () => {
        messages = messages.filter((message) => !message.revoked);
        if (!messages.length) return undefined;
        for (const message of messages) message.started = true;
        const prompts = messages.map(
          (message) =>
            prepareAgentMessage(message.prompt, message.source, message.receipt.messageId).prompt,
        );
        const prompt: AgentPromptInput = prompts.every((entry) => typeof entry === "string")
          ? prompts.join("\n\n")
          : prompts.flatMap((entry): AgentPromptContentBlock[] =>
              typeof entry === "string" ? [{ type: "text", text: entry }] : entry,
            );
        const request: DispatchRequest = {
          recipientId,
          deliveryScope: messages[0]!.deliveryScope,
          inputOrigin: messages[0]!.inputOrigin,
          expectedExecution: messages[0]!.expectedExecution,
          onExecutionGuided: (result) => {
            for (const message of messages) message.onExecutionGuided?.(result);
          },
          messageIds: messages.map((message) => message.receipt.messageId),
          prompt,
          activeTurnBehavior: messages[0]!.activeTurnBehavior ?? "steer",
          sessionMode: messages.find((message) => message.sessionMode)?.sessionMode,
          clearPendingPermissions: messages.some((message) => message.clearPendingPermissions),
          unarchive: messages.some((message) => message.unarchive !== false),
          onDispatch: (disposition) => {
            for (const message of messages) {
              try {
                message.onDispatch?.(disposition);
              } catch (error) {
                dependencies.onError(error, request);
              }
            }
          },
        };

        try {
          for (const message of messages) {
            message.deliveryScope?.assertActive();
            message.beforeDispatch?.();
          }
          const disposition = await dependencies.dispatch(request);
          for (const message of messages) message.resolve(disposition);
          return undefined;
        } catch (error) {
          for (const message of messages) message.reject(error);
          dependencies.onError(error, request);
          throw error;
        }
      });
    dispatching.set(recipientId, dispatched);
    void dispatched
      .finally(() => {
        if (dispatching.get(recipientId) === dispatched) dispatching.delete(recipientId);
      })
      .catch(() => undefined);
  }

  function flush(recipientId: string): void {
    const entry = pending.get(recipientId);
    if (!entry) return;
    pending.delete(recipientId);
    entry.cancel();
    let group: Admitted[] = [];
    let mode: string | undefined;
    for (const message of entry.messages) {
      // Explicitly conflicting send options require separate, ordered dispatches.
      if (
        group.length &&
        (Boolean(message.deliveryScope) ||
          Boolean(group[0]!.deliveryScope) ||
          (message.activeTurnBehavior ?? "steer") !== (group[0]!.activeTurnBehavior ?? "steer") ||
          (mode && message.sessionMode && mode !== message.sessionMode) ||
          JSON.stringify(message.expectedExecution) !== JSON.stringify(group[0]!.expectedExecution))
      ) {
        dispatch(recipientId, group);
        group = [];
        mode = undefined;
      }
      group.push(message);
      mode ??= message.sessionMode;
    }
    if (group.length) dispatch(recipientId, group);
  }

  return {
    hasPending: (recipientId) => pending.has(recipientId) || dispatching.has(recipientId),
    enqueue(message) {
      if (closed) throw new Error("Agent message delivery is closed");
      let resolve!: Admitted["resolve"];
      let reject!: Admitted["reject"];
      const dispatched = new Promise<PromptDispatchDisposition>((accepted, failed) => {
        resolve = accepted;
        reject = failed;
      });
      void dispatched.catch(() => undefined);
      const receipt: Receipt = {
        status: "queued",
        messageId: message.messageId ?? randomUUID(),
        dispatched,
      };
      const entry = pending.get(message.recipientId) ?? { messages: [], cancel: () => {} };
      entry.cancel();
      const admitted: Admitted = { ...message, receipt, resolve, reject };
      const revoked = () => {
        if (admitted.started) return;
        admitted.revoked = true;
        reject(new DeliveryRevokedError());
      };
      if (message.deliveryScope) {
        message.deliveryScope.signal.addEventListener("abort", revoked, { once: true });
        void dispatched
          .finally(() => message.deliveryScope!.signal.removeEventListener("abort", revoked))
          .catch(() => undefined);
        if (message.deliveryScope.signal.aborted) revoked();
      }
      entry.messages.push(admitted);
      entry.cancel = schedule(2000, () => flush(message.recipientId));
      pending.set(message.recipientId, entry);
      return receipt;
    },
    async waitForDispatch(recipientId, signal) {
      signal.throwIfAborted();
      const admitted =
        pending.get(recipientId)?.messages.map((message) => message.receipt.dispatched) ?? [];
      let aborted!: () => void;
      const cancellation = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(new DOMException("Wait aborted", "AbortError"));
        signal.addEventListener("abort", aborted, { once: true });
      });
      try {
        await Promise.race([
          Promise.all([dispatching.get(recipientId), ...admitted]),
          cancellation,
        ]);
      } finally {
        signal.removeEventListener("abort", aborted);
      }
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const recipientId of pending.keys()) flush(recipientId);
      // Each failure is reported and rejects its receipts; shutdown still drains other recipients.
      closing = Promise.allSettled(dispatching.values()).then(() => undefined);
      return closing;
    },
  };
}
