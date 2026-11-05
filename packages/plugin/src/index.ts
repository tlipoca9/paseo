// Shared SDK entry. Keep runtime-specific imports and re-exports on /client or /server.
export type {
  PluginTheme,
  PluginWorkspaceSnapshot,
  PluginAgentSnapshot,
  PluginThemeColors,
  PluginThemeContribution,
  PluginAttachmentSourceContribution,
  PluginAttachmentFilter,
  PluginAttachmentFilterOption,
  PluginTimelineData,
  PluginTimelineItem,
  PluginTimelineTransformResult,
  PluginCleanup,
} from "./contracts.js";
export { defineSettings, settingsRpc, type SettingsDefinition } from "./settings.js";
export {
  defineAttachmentSource,
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  PluginAttachmentSearchInputSchema,
  PluginAttachmentContextSchema,
  PluginAttachmentFilterOptionsInputSchema,
  PluginAttachmentFilterOptionsPayloadSchema,
  type PluginAttachmentFilterOptionsInput,
  type PluginAttachmentFilterOptionsPayload,
  type PluginAttachmentContext,
  type PluginAttachmentSearchInput,
  type PluginAttachmentItem,
  type PluginAttachmentSearchPayload,
} from "./attachments.js";
export {
  defineRpc,
  defineSubscription,
  type PluginRpcContract,
  type PluginSubscriptionContract,
  type RpcInput,
  type RpcOutput,
  type SubscriptionEvent,
  type SubscriptionInput,
} from "./rpc.js";

export type { PluginText, PluginMessage } from "./text.js";
export {
  findSvgIconProblem,
  PLUGIN_SVG_ICON_MAX_BYTES,
  type PluginIconProps,
  type PluginSerializableIcon,
  type PluginSvgIcon,
} from "./icons.js";
