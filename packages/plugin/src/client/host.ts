import type { PluginText } from "../text.js";
import {
  PluginAttachmentSearchPayloadSchema,
  PluginAttachmentContextSchema,
  PluginAttachmentFilterOptionsPayloadSchema,
  type PluginAttachmentFilterOptionsInput,
  type PluginAttachmentSearchInput,
} from "../attachments.js";
export { PluginClientStateProvider, type PluginClientStateSource } from "./client-state.js";
export {
  usePluginRuntimeContextBridge,
  type PluginRuntimeContextBridge,
} from "./runtime-context-bridge.js";
import type { PluginAttachmentSourceContribution } from "../contracts.js";
import { PluginRpcProvider } from "./rpc-context.js";
import { PaseoApiProvider } from "./paseo-context.js";
import { callPluginRpc, subscribePluginRpc, type PluginSubscriptionObserver } from "../rpc.js";

export async function loadPluginAttachmentContext(
  source: PluginAttachmentSourceContribution<PluginText>,
  invoke: (method: string, input: unknown) => Promise<unknown>,
) {
  if (!source.context) return null;
  const output = await callPluginRpc(source.context, invoke, {});
  return PluginAttachmentContextSchema.parseAsync(output);
}

export async function searchPluginAttachmentFilterOptions(
  source: PluginAttachmentSourceContribution<PluginText>,
  invoke: (method: string, input: unknown) => Promise<unknown>,
  input: PluginAttachmentFilterOptionsInput,
) {
  if (!source.filterOptions) throw new Error("Attachment source has no filter options RPC");
  const output = await callPluginRpc(source.filterOptions, invoke, input);
  const result = await PluginAttachmentFilterOptionsPayloadSchema.parseAsync(output);
  if (result.scope !== input.scope) throw new Error("Attachment filter options scope changed");
  return result;
}

export async function searchPluginAttachments(
  source: PluginAttachmentSourceContribution<PluginText>,
  invoke: (method: string, input: unknown) => Promise<unknown>,
  query: string | PluginAttachmentSearchInput,
) {
  const input = typeof query === "string" ? { query } : query;
  const output = await callPluginRpc(source.search, invoke, input);
  return PluginAttachmentSearchPayloadSchema.parseAsync(output);
}

export { callPluginRpc, subscribePluginRpc, PaseoApiProvider, PluginRpcProvider };
export type { PluginSubscriptionObserver };
export type { PluginSubscribe } from "./rpc-context.js";

export {
  PluginTranslationRuntime,
  PluginTranslationProvider,
  usePluginTranslationRuntime,
  requirePluginText,
  isPluginMessage,
} from "./translations.js";
export type { PluginLocaleSource } from "./translations.js";
