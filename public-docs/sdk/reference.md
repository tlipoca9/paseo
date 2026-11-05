---
title: SDK API reference
description: Public configuration, methods, handles, results, defaults, and lifecycle behavior for @getpaseo/client.
nav: API reference
order: 58
category: TypeScript SDK
---

# SDK API reference

Import every supported runtime value and TypeScript type from `@getpaseo/client`.

## `createPaseoClient(config)`

Creates a client without opening the connection.

Required configuration:

| Field | Type     | Meaning                                     |
| ----- | -------- | ------------------------------------------- |
| `url` | `string` | Daemon WebSocket endpoint, including `/ws`. |

Common optional configuration:

| Field                   | Type          | Default        | Meaning                                          |
| ----------------------- | ------------- | -------------- | ------------------------------------------------ |
| `clientId`              | `string`      | Generated      | Stable identifier for logs and subscriptions.    |
| `password`              | `string`      | Unset          | Daemon password.                                 |
| `authHeader`            | `string`      | Unset          | Complete authorization-header value for a proxy. |
| `connectTimeoutMs`      | `number`      | Client default | Connection deadline.                             |
| `reconnect.enabled`     | `boolean`     | Client default | Reconnect after an unexpected disconnect.        |
| `reconnect.baseDelayMs` | `number`      | Client default | Initial reconnect delay.                         |
| `reconnect.maxDelayMs`  | `number`      | Client default | Maximum reconnect delay.                         |
| `logger`                | `PaseoLogger` | Unset          | Debug, info, warning, and error sink.            |

Relay E2EE clients can also pass `e2ee.enabled` and `e2ee.daemonPublicKeyB64`. `appVersion`, `runtimeGeneration`, and runtime-metrics options exist for Paseo client surfaces; ordinary integrations can omit them.

## Client lifecycle

| Method                 | Result            | Behavior                                                                  |
| ---------------------- | ----------------- | ------------------------------------------------------------------------- |
| `connect()`            | `Promise<void>`   | Resolves after the daemon sends its server information.                   |
| `close()`              | `Promise<void>`   | Closes the connection and disposes this client.                           |
| `ensureConnected()`    | `void`            | Throws unless the client is connected.                                    |
| `getConnectionState()` | `ConnectionState` | Returns `idle`, `connecting`, `connected`, `disconnected`, or `disposed`. |

Create a new client after `close()`.

## `client.agents`

| Method               | Result                 | Behavior                                                                                                     |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `list(options?)`     | `PaseoAgentListResult` | Lists a page of agents. `scope`, `filter`, `sort`, `page`, and `subscribe` match the daemon directory query. |
| `create(options)`    | `PaseoAgentHandle`     | Creates an agent and a fresh workspace for `cwd`. Requires `config`.                                         |
| `ref(agentOrId)`     | `PaseoAgentHandle`     | Creates a local handle without fetching.                                                                     |
| `subscribe(handler)` | Unsubscribe function   | Local listener for this API instance. Requires an owned `list({ subscribe: {} })` observation.               |

`list({ subscribe: {} })` also returns a `subscriptionId` and an owned `subscription`. Its `subscribe({ snapshot, update, error? })` callbacks receive the snapshot before scoped wire updates; `release()` ends that observation. Capable daemons assign the ID and keep observations independent. Older daemons use local IDs and their established shared delivery behavior. Plain lists create no observation. The same contract applies to workspace lists. See [events](./events.md).

Creation options include `config`, `cwd`, `parent`, `title`, `prompt`, `env`, `outputSchema`, `images`, `attachments`, `git`, `worktree`, `autoArchive`, `background`, and `labels`.

`parent` accepts a host-local agent ID, an `AgentAddress` (`{ serverId, agentId }`), or an agent handle. A handle’s `address` keeps its host identity after disconnect. When creating through `hosts.client(serverId)`, pass the parent handle or complete address; the SDK carries parent metadata to the destination.

`background` creates a [background agent](./agents.md#run-a-helper-as-a-background-agent). A
workspace the call creates is background too. With a `parent` and no value, the parent's own
`background` applies. See [background workspaces](./workspaces.md) for inclusive discovery.

`config` accepts:

| Field              | Type                      | Meaning                                                                                           |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `provider`         | `string`                  | Required `provider/model` selection.                                                              |
| `modeId`           | `string`                  | Provider operating or permission mode.                                                            |
| `thinkingOptionId` | `string`                  | Provider reasoning level.                                                                         |
| `featureValues`    | `Record<string, unknown>` | Values for features discovered through `providers.listFeatures`.                                  |
| `options`          | JSON object               | Provider-native settings, strictly validated. See [Provider options](/docs/sdk/provider-options). |
| `systemPrompt`     | `string`                  | Additional system or developer instructions.                                                      |
| `mcpServers`       | MCP server map            | Session-scoped MCP servers.                                                                       |
| `toolPolicy`       | MCP tool policy           | Exact preapproval rules for MCP tools.                                                            |

### Agent handle

| Member                                           | Result                            | Behavior                                                                                                |
| ------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`                                             | `string`                          | Stable daemon agent ID.                                                                                 |
| `address`                                        | `AgentAddress`                    | Complete `{ serverId, agentId }` identity; requires a connected host to establish it.                   |
| `workspaceId`                                    | `string \| null`                  | Current workspace placement.                                                                            |
| `cwd`                                            | `string \| null`                  | Current working directory.                                                                              |
| `status`                                         | Agent status or `null`            | Current lifecycle status.                                                                               |
| `capabilities`                                   | Capability flags or `null`        | What the provider session supports.                                                                     |
| `availableModes`                                 | Agent modes or `null`             | Modes the session can switch to.                                                                        |
| `pendingPermissions`                             | Permission requests or `null`     | Requests waiting on an answer.                                                                          |
| `activeTurn`                                     | Active turn or `null`             | The turn in flight, with `turnId` and `startedAt`.                                                      |
| `lastUsage`                                      | Usage or `null`                   | Token counts, cost, and context-window use from the last turn.                                          |
| `lastError`                                      | `string \| null`                  | Last error the daemon recorded for the agent.                                                           |
| `features`                                       | Agent features or `null`          | Provider feature toggles and selects with their current values.                                         |
| `runtimeInfo`                                    | Runtime info or `null`            | Live provider, session ID, model, thinking option, and mode.                                            |
| `archivedAt`                                     | `string \| null`                  | Archive timestamp; `null` while the agent is active.                                                    |
| `current()`                                      | `PaseoAgent \| null`              | Current detailed value observed by this handle; never fetches.                                          |
| `refresh(requestId?)`                            | `PaseoAgentRefetchResult \| null` | Fetches the current agent and project placement.                                                        |
| `captureExecution({ messageId }?)`               | `AgentExecution \| null`          | Captures a submitted message's execution, or current runtime ownership when options are omitted.        |
| `stopExecution(execution)`                       | `AgentExecutionStopResult`        | Stops only the captured execution and confirms its tools have stopped.                                  |
| `guideExecution(execution, text, { messageId })` | `AgentExecutionGuideResult`       | Steers, or confirms stopping before continuing in the same session.                                     |
| `send(text, options?)`                           | `Promise<void>`                   | Resolves when the daemon accepts the prompt.                                                            |
| `sendWithReceipt(text, options?)`                | `{ deliveryStatus?: "queued" }`   | Returns the native admission stage; agent-originated messages enter the batching queue.                 |
| `messageReceipt(messageId)`                      | `AgentMessageReceipt`             | Reads the durable outcome of a message submitted with that ID.                                          |
| `respondToPermission(options)`                   | `Promise<void>`                   | Answers a pending permission by `requestId` with an allow or deny `response`.                           |
| `run(text, options?)`                            | `PaseoAgentRunResult`             | Sends a prompt and waits for that turn. `timeoutMs` controls the wait; it defaults to 10 minutes.       |
| `waitForFinish(timeoutMs?)`                      | `PaseoAgentRunResult`             | Waits for the active turn, including an initial prompt. Default timeout: 10 minutes.                    |
| `commands(options?)`                             | `PaseoAgentCommandsResult`        | Asks the live session for its slash commands and skills, including built-in ones. Options: `requestId`. |
| `subscribe(handler)`                             | Unsubscribe function              | Filters agent-directory updates to this ID and refreshes the handle properties.                         |
| `archive()`                                      | `{ archivedAt }`                  | Soft-deletes the agent and closes its runtime.                                                          |
| `detach()`                                       | `Promise<void>`                   | Removes the parent relationship without stopping the agent.                                             |

`workspaceId` through `archivedAt` mirror the last snapshot the handle observed. A handle from `ref()` reads `null` for all of them until `refresh()`, `run()`, `waitForFinish()`, a timeline refetch, or `subscribe()` delivers a snapshot. Optional values in an observed snapshot also read as `null`. Call `current()` when you need the whole snapshot or need to distinguish those states.

`PaseoAgentRunResult` contains `status`, `final`, `error`, and `lastMessage`. `final` refreshes the handle when present.

`PaseoAgentCommandsResult` contains `agentId`, `commands`, and `error`. Each command has `name`, `description`, `argumentHint`, and an optional `kind` of `"command"` or `"skill"`. A provider that cannot answer reports it in `error` rather than rejecting; providers that expose no command list at all return an empty array.

### Agent message delivery

Use `sendWithReceipt(text, { messageId, sourceAgentId })` for peer messages. Save `messageId` before sending, then query `messageReceipt(messageId)` after reconnecting. `queued` confirms queue admission; `delivered` confirms native dispatch, not model readership. `unknown` means the provider outcome cannot be established, including a daemon restart between admission and receipt persistence. Retrying an unknown native receipt does not resend. `not_found` means this host has no receipt for that recipient and ID. A `failed` receipt permits resubmission only when `retryable` is true; preserve the original text, source and execution identity.

Pass `expectedExecution` to bind peer delivery to a captured run. The native queue uses confirmed execution control at dispatch, and the receipt includes the resulting `execution` and `guidanceStatus`. Messages for different captured runs dispatch separately. For automatic notifications, `sourceNotification` selects the native notification envelope and `sourceAgentId` identifies its subject; the subject need not have an online session. The caller remains responsible for the notification's business meaning. Receipt queries, execution-bound peer delivery and notification envelopes require `server_info.features.agentMessageReceipts`.

### Revocable plugin delivery scopes

Trusted plugin connections can call `paseo.deliveryScopes.create()`, `get(id)`, and `revoke(id)`. These methods and the send option `deliveryScopeId` require `server_info.features.deliveryScopes`. Scope snapshots contain `id` and `status`: `active`, `revoking`, `revoked`, or `not_found`.

Save the scope ID with automatic work and pass it to every assignment, peer message, retry and notification. A scope belongs to the plugin connection that created it; clients cannot supply a plugin identity. A replacement connection from the same plugin can inspect or revoke previous scopes, but cannot send through them. Disconnect, reload and daemon shutdown close their scopes. Scope IDs are never restored after a daemon restart.

Revocation immediately closes admission, then waits for admitted operations and provider calls to settle. It cancels queued messages, including messages waiting behind another dispatch or loading a session. No new provider delivery can begin after successful revocation. Cancelled receipts have `status: "revoked"` and `retryable: false`. An operation whose provider outcome is uncertain keeps an `unknown` receipt even after the delivery barrier completes. `not_found` confirms that this daemon has no active scope with that ID; it does not confirm that a previous execution stopped.

Scoped sends without `expectedExecution` only start idle sessions. Bind guidance for a running session to a captured execution; this prevents an assignment or delayed message from replacing a newer human run. Keep native `sourceAgentId` and `sourceNotification` provenance alongside the scope. Stop executions already accepted by the provider separately with `stopExecution`.

Plugin agent tools receive an optional `context.execution`, captured synchronously at the host tool entrance before input parsing. It identifies the admitted run and stays unchanged across asynchronous work; `null` means no live execution was observed. Use this snapshot and the tool's cancellation signal when saving ownership. Older hosts omit it.

Use `paseo.deliveryScopes.bindExecution(scopeId, context.execution)` before saving plugin ownership of an existing human-started execution. This requires `server_info.features.deliveryScopeRecovery` and a scope owned by the current trusted plugin connection. The host rejects stale execution identities and conflicting scope ownership. Scoped new turns save this recovery ownership before entering the provider. Native startup recovery skips these executions; a later unscoped turn retains normal native recovery. Bindings control recovery admission and do not confirm execution termination.

### Confirmed execution control

These methods require `server_info.features.agentExecutionControl`. The SDK reports a host-update error when the capability is absent. Save the captured `{ agentId, runtimeId, runId, turnId }` with your operation; provider turn IDs alone can repeat after reload. Capture rejects when this runtime has no execution ownership evidence. A completed turn remains capturable until its tools are confirmed stopped; `null` means the last observed execution was confirmed stopped.

To bind work to its submitted prompt, pass a unique `messageId` to `send(text, { messageId })`, then call `captureExecution({ messageId })`. This captures that message's execution even if another prompt has since started. It rejects when the message has no unique execution record in the current runtime. Without options, capture returns the current or last observed execution.

Only `stopExecution` returning `stopped` authorizes dependent work. `superseded`, `unknown`, `refused` and `timed_out` include a reason and retain the need for reconciliation. Retry with the same identity. Daemon restart loses live ownership evidence, so an old identity returns `unknown`.

Guidance returns `steered` or `continued` with its resulting execution identity. Reuse `messageId` and the original identity when retrying an uncertain delivery. Native steering errors propagate as errors; only unsupported steering or an explicit `unavailable` response enters the stop-and-continue path. Provider acceptance confirms delivery, not model readership.

Codex supports confirmed stopping of captured turns and their command processes. Other providers can still accept native steering; a provider without the stronger stop contract returns `unknown` instead of starting a replacement. Ordinary cancellation retains its existing behavior.

### Timeline handle

`agent.timeline.refetch(options?)` fetches a page. Options are `direction`, `cursor`, `limit`, `projection`, and `requestId`.

`agent.timeline.subscribe(handler)` establishes network demand for this agent and restores it after reconnect. Its unsubscribe function releases that demand; await `unsubscribe.ready` for initial daemon acknowledgement before starting work. Delivery is live-only. Reconnect emits a local `subscription_restored` event; request missed history explicitly with `refetch()`. A live replacement invalidates the previous epoch. See the callback shapes, paging and failure behavior in [timeline events](./events.md#follow-timeline-events).

## `client.projects`

| Method               | Result                   | Behavior                                                                                       |
| -------------------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| `list(options?)`     | `PaseoProjectListResult` | Lists every registered project, including projects with no active workspaces.                  |
| `subscribe(handler)` | Unsubscribe function     | Requests future project updates; unsubscribe releases demand. `list()` supplies initial state. |

See [events](./events.md#follow-provider-catalog-changes) for explicit event observation and cleanup.

## `client.workspaces`

| Method                   | Result                        | Behavior                                                                                                                 |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `list(options?)`         | `PaseoWorkspaceListResult`    | Lists, filters, pages, or subscribes to the workspace directory.                                                         |
| `open(cwd)`              | `PaseoWorkspaceHandle`        | Reuses the active workspace for a directory or creates one.                                                              |
| `create(options)`        | `PaseoWorkspaceHandle`        | Always creates a fresh directory-backed or Paseo-worktree workspace. `background: true` hides it from default discovery. |
| `ref(workspaceOrId)`     | `PaseoWorkspaceHandle`        | Creates a local handle.                                                                                                  |
| `archive(workspaceOrId)` | `PaseoWorkspaceArchiveResult` | Archives without first creating a handle.                                                                                |
| `subscribe(handler)`     | Unsubscribe function          | Local listener for this API instance. Requires an owned `list({ subscribe: {} })` observation.                           |

`create({ source, agent, background })` creates a workspace and its initial agent together.
`agent` accepts agent creation options except `worktree`, `git`, `onEvent`, `idempotencyKey`,
and `requestId`. Set `background` on the workspace options; `agent.background` is rejected.
See the [combined creation example](./agents.md#run-work-in-a-background-workspace).

A workspace handle exposes `id`, `projectId`, `directory`, `name`, `status`, `current()`, `refresh()`, `setTitle(title)`, `archive()`, and `subscribe()`. Pass `null` to `setTitle` to restore the derived workspace name. Use `workspace.agents.create(options)` to create an agent without repeating the workspace ID or directory.

## `client.terminals`

Terminal operations require a host that supports workspace terminals. An older host receives no terminal request; the SDK throws an update-host error.

| Method              | Result                             | Behavior                                                                           |
| ------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| `create(options)`   | `Promise<PaseoTerminalHandle>`     | Creates a terminal owned by the required `workspaceId`.                            |
| `list(options?)`    | `Promise<PaseoTerminalListResult>` | Returns `{ entries, requestId }`. Omit filters to list all terminals on this host. |
| `ref(terminalOrId)` | `PaseoTerminalHandle`              | Creates a local handle without fetching or attaching a terminal stream.            |

Creation options:

| Field             | Meaning                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `workspaceId`     | Required active workspace ID. Unknown and archived IDs fail.                                                             |
| `cwd`             | Optional absolute process working directory. Defaults to the workspace directory; changing it does not change ownership. |
| `name`            | Optional terminal name.                                                                                                  |
| `command`, `args` | Optional executable and argument array. Omit them to start the default shell.                                            |
| `size`            | Optional initial viewport: `{ rows, cols }`.                                                                             |
| `requestId`       | Optional request correlation ID.                                                                                         |

List options are `workspaceId`, `cwd`, and `requestId`. `workspaceId` selects ownership, including terminals started outside the workspace directory. When it is present, `cwd` does not restrict the results. Without an ID, `cwd` filters by workspace root directory. Each entry contains `id`, `workspaceId`, `cwd`, and `name`; `cwd` is the terminal's actual starting directory.

Terminal handles expose:

| Method              | Result                                | Behavior                                                                                         |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `current()`         | `PaseoTerminal \| null`               | Last snapshot from creation, `ref(snapshot)`, or refresh. A handle made from an ID starts empty. |
| `refresh(options?)` | `Promise<PaseoTerminal \| null>`      | Fetches the terminal snapshot, or `null` when it no longer exists. Accepts `requestId`.          |
| `write(data)`       | `number`                              | Sends literal text without interpreting key names. Returns the input's UTF-16 length.            |
| `sendKeys(keys)`    | `number`                              | Expands key tokens and sends the combined input. Returns its UTF-16 length.                      |
| `capture(options?)` | `Promise<PaseoTerminalCaptureResult>` | Returns `{ terminalId, lines, totalLines, requestId }`.                                          |
| `kill(requestId?)`  | `Promise<void>`                       | Waits for terminal teardown. Killing an already-removed terminal succeeds.                       |

`sendKeys()` recognizes `Enter`, `Tab`, `Escape`, `Space`, `BSpace`, `C-c`, `C-d`, `C-z`, `C-l`, `C-a`, and `C-e`. Other strings pass through literally. Input methods send without waiting for command execution or acknowledging that the terminal consumed the input.

Capture accepts optional `start`, `end`, `stripAnsi`, and `requestId`. Line bounds are zero-based and inclusive across scrollback and the viewport. Negative bounds count from the end; omitted bounds capture all lines. `stripAnsi` defaults to `true`. A missing terminal returns empty lines.

Use `workspace.terminals.create(options?)` and `workspace.terminals.list(options?)` to supply the workspace ID from a handle. Creation accepts the same options except `workspaceId`; listing accepts only `requestId`. Plugins get these methods through `usePaseo()` and the handler's `paseo` context.

## `client.providers`

| Method                           | Result                        | Behavior                                                                                                                                                 |
| -------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waitForReady(options?)`         | `PaseoProviderSnapshotResult` | Waits until no provider is loading. Default timeout: 60 seconds. Rejects with an update-host error when the daemon cannot correlate workspace snapshots. |
| `snapshot(options?)`             | `PaseoProviderSnapshotResult` | Returns the current catalog immediately.                                                                                                                 |
| `refresh(options?)`              | Acknowledgement               | Forces catalog refresh for all or selected providers.                                                                                                    |
| `listAvailable()`                | Availability result           | Reports installed provider availability.                                                                                                                 |
| `listModels(provider, options?)` | Models result                 | Discovers models for one provider and directory.                                                                                                         |
| `listModes(provider, options?)`  | Modes result                  | Discovers permission or operating modes.                                                                                                                 |
| `listFeatures(draftConfig)`      | Features result               | Discovers features for the current draft provider configuration.                                                                                         |
| `diagnostic(provider)`           | Diagnostic result             | Returns human-readable setup diagnostics.                                                                                                                |
| `listUsage(options?)`            | `PaseoProviderUsageResult`    | Returns normalized subscription windows, balances, and provider details. Rejects with an update-host error when unsupported. Options: `requestId`.       |
| `subscribe(handler)`             | Unsubscribe function          | Requests future catalog updates; unsubscribe releases demand.                                                                                            |

## `client.config`

`config.get(requestId?)` returns the daemon's mutable configuration.

`config.patch(patch, requestId?)` validates, persists, and returns an updated configuration. Use this administrative surface for host configuration, not per-agent choices. A patch affects every client and future agent using that daemon.

## `client.hosts`

Manage hosts connected to the selected daemon. Both the managing daemon and destination must support connected hosts.

```ts
const directory = await client.hosts.list();
const registration = await client.hosts.add({
  connection: "ssh://deploy@build-box",
  label: "Build box",
  metadata: { team: "infra" },
  sourceKey: "build-box",
});
await client.hosts.update(registration.registrationId, { enabled: false });
await client.hosts.remove(registration.registrationId);
```

`list()` returns `{ self: { serverId, label }, hosts }`. Each host includes its registration and server
IDs, label, authenticated source, string metadata, enabled state, connection status, safe target
description, last-online/retry timestamps, and an actionable error. Credentials are never returned.
A valid but unreachable connection is saved and retried. Invalid syntax fails without saving.

`update(registrationId, patch)` accepts `label`, `metadata`, `enabled`, `connection`, and
`replaceIdentity`. Metadata replaces the whole map. Replacing a connection preserves the expected
server ID unless `replaceIdentity: true` explicitly accepts a new destination.

`observe()` returns an owned subscription. Await `ready`, subscribe for snapshots and `hosts.changed`
updates, then call `release()`. Observations restore a current snapshot after reconnect.

```ts
const remote = await client.hosts.client("srv_build_box");
try {
  const workspaces = await remote.workspaces.list();
  const providers = await remote.providers.listAvailable();
  await remote.agents.ref("agent_on_build_box").send("Continue the investigation");
} finally {
  await remote.dispose();
}
```

`client(serverId)` returns a caller-owned `PaseoApi` bound to that destination through the selected
daemon. The ordinary APIs keep their signatures. Paths and IDs belong to the destination. Selecting
the local server ID returns a local scope. Routing supports one hop.

Disposing one scope releases its observations without closing siblings or deleting the saved host.
Origin disposal cascades. Observations recover through the ordinary client lifecycle. While connecting,
new requests use the existing bounded send queue; disconnected requests fail. Connection loss clears
old waiters and queued sends. Ordinary non-recoverable requests are not replayed; existing
acknowledged/idempotent creation recovery retains its request identity. A submitted request whose response
is lost rejects with `DaemonConnectionError` (`code: "DAEMON_CONNECTION_LOST"`), optional
`outcome: "unknown"` and known `serverId`. Inspect before retrying a mutation.

Registration and host acquisition failures expose a stable `code`: `host_unknown`, `host_disabled`, `host_offline`,
`permission_denied`, `unsupported_capability`, `authentication_failed`, `server_id_mismatch`,
`self_host`, or `duplicate_host`. Ordinary RPC permission codes, including `access_denied`, pass through
unchanged. Multiplexing is a transport; consumers use the same client/API operations and lifecycle.
Discovery does not grant execution authority.

## Errors and cleanup

Connection, validation, rejection, and timeout failures reject their promise. Turn outcomes are returned through `PaseoAgentRunResult.status` because permission and provider errors are expected agent states.

Always close the client in `finally`. Closing a client removes its local listeners and network connection; it does not stop agents or archive workspaces.
