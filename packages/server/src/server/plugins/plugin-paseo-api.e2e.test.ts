import { measureMainThreadWork } from "../../test-utils/main-thread-work.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pino from "pino";
import { createPaseoDaemon } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { EventEmitter, once } from "node:events";
import { resolveDaemonVersion } from "../daemon-version.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { DeliveryScopeSchema } from "@getpaseo/protocol/messages";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient, createTestAgentClients } from "../test-utils/fake-agent-client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each(["React Native", "native"])(
  "provider readiness works with %s AbortController",
  async (runtime) => {
    const require = createRequire(import.meta.url);
    const reactNativeRequire = createRequire(require.resolve("react-native/package.json"));
    const { AbortController: ReactNativeAbortController } = reactNativeRequire(
      "abort-controller/dist/abort-controller",
    );
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("../../../../client/src/index.ts", import.meta.url))],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "paseoSdk",
      platform: "browser",
    });
    // A separate runtime starts with React Native's real abort implementation.
    // Node's globals and the daemon's runtime remain unchanged.
    const sdk: typeof import("@getpaseo/client") = runInNewContext(
      `${bundle.outputFiles[0]!.text}\npaseoSdk`,
      {
        AbortController: runtime === "React Native" ? ReactNativeAbortController : AbortController,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        TextEncoder,
        TextDecoder,
      },
    );
    const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const api = sdk.createPaseoApi(client);
    try {
      await client.connect();
      const snapshot = await api.providers.waitForReady({ cwd: daemon.staticDir });
      expect(snapshot.entries.length).toBeGreaterThan(0);
      expect(snapshot.entries.every((entry) => entry.status !== "loading")).toBe(true);
      const waiting = api.providers.waitForReady({ cwd: daemon.staticDir });
      const canceled = expect(waiting).rejects.toThrow(/disposed|released/);
      await api.dispose();
      await canceled;
      const { diagnostic } = await client.collectDiagnostics();
      expect(diagnostic).toContain("Source registrations: 0");
      expect(diagnostic).toContain("Producer listeners: 0");
      expect(() => api.providers.waitForReady()).toThrow("disposed");
    } finally {
      await api.dispose();
      await client.close();
      await daemon.close();
    }
  },
);

test("plugin handlers create workspaces and agents through their Paseo API", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-api-plugin-"));
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "paseo-api-workspace-"));
  roots.push(pluginDirectory, workspaceDirectory);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: "paseo-api",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `import { defineRpc } from "@getpaseo/plugin";
import { type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const create = defineRpc({
  name: "create",
  input: z.object({ path: z.string() }),
  output: z.object({ workspaceId: z.string(), agentId: z.string() }),
});

const list = defineRpc({
  name: "list",
  input: z.object({}),
  output: z.object({ agentIds: z.array(z.string()) }),
});

const append = defineRpc({
  name: "append",
  input: z.object({ agentId: z.string(), status: z.string() }),
  output: z.object({ seq: z.number(), epoch: z.string() }),
});

export default function contribute(server: PluginServerContext) {
  server.handle(create, async ({ path }, { paseo }) => {
    const workspace = await paseo.workspaces.create({
      source: { kind: "directory", path },
      title: "Plugin workspace",
    });
    const agent = await workspace.agents.create({
      config: { provider: "pi/test" },
      prompt: "Created by a plugin handler",
    });
    return { workspaceId: workspace.id, agentId: agent.id };
  });
  server.handle(list, async (_input, { paseo }) => {
    const result = await paseo.agents.list({ page: { limit: 100 } });
    return { agentIds: result.entries.map((entry) => entry.agent.id) };
  });
  server.handle(append, ({ agentId, status }, { paseo }) =>
    paseo.agents.ref(agentId).timeline.append({
      type: "plugin",
      id: "review-1",
      kind: "review",
      version: 1,
      data: { status },
    }),
  );
  return () => undefined;
}`,
  );

  const daemon = await createTestPaseoDaemon({
    agentClients: { ...createTestAgentClients(), pi: createTestAgentClient("pi") },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });

  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await expect(client.installDirectoryPlugin(pluginDirectory)).resolves.toMatchObject({
      id: "paseo-api",
      status: "running",
    });

    const created = await client.invokePluginRpc("paseo-api", "create", {
      path: workspaceDirectory,
    });

    expect(created).toEqual({
      workspaceId: expect.stringMatching(/^wks_/),
      agentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    if (typeof created !== "object" || created === null) {
      throw new Error("Plugin returned an invalid creation result");
    }
    const listed = await client.invokePluginRpc("paseo-api", "list", {});
    expect(listed).toEqual({
      agentIds: expect.arrayContaining([Reflect.get(created, "agentId")]),
    });
    const agentId = Reflect.get(created, "agentId");
    await expect(
      client.invokePluginRpc("paseo-api", "append", { agentId, status: "running" }),
    ).resolves.toEqual({ seq: expect.any(Number), epoch: expect.any(String) });
    await client.invokePluginRpc("paseo-api", "append", { agentId, status: "complete" });
    await client.sendAgentMessage(agentId, "User approves the plan", {
      messageId: "human-approval",
    });
    const timeline = await client.fetchAgentTimeline(agentId, { projection: "projected" });
    expect(timeline.entries.map((entry) => entry.item)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "Created by a plugin handler",
          origin: { kind: "plugin", pluginId: "paseo-api" },
        }),
      ]),
    );
    expect(
      timeline.entries.find(
        (entry) =>
          entry.item.type === "user_message" && entry.item.text === "User approves the plan",
      )?.item,
    ).toMatchObject({
      origin: { kind: "human" },
    });
    expect(timeline.entries.filter((entry) => entry.item.type === "plugin")).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          type: "plugin",
          id: "review-1",
          pluginId: "paseo-api",
          data: { status: "complete" },
        }),
      }),
    ]);
    await client.removePlugin("paseo-api");
    const workspaces = await client.fetchWorkspaces();
    const agents = await client.fetchAgents();
    expect(workspaces.entries.map((workspace) => workspace.id)).toContain(
      Reflect.get(created, "workspaceId"),
    );
    expect(agents.entries.map((entry) => entry.agent.id)).toContain(
      Reflect.get(created, "agentId"),
    );
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);

test("password-protected config reload preserves startup auth and session construction does not read config", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-protected-config-reload-"));
  roots.push(home);
  const password = "synthetic-audit-password";
  const config = loadConfig(home, { env: { PASEO_PASSWORD: password, PASEO_RELAY_ENABLED: "0" } });
  const daemon = await createPaseoDaemon(
    {
      ...config,
      listen: "127.0.0.1:0",
      mcpEnabled: false,
      agentClients: createTestAgentClients(),
      staticDir: home,
    },
    pino({ level: "silent" }),
  );
  await daemon.start();
  const target = daemon.getListenTarget();
  if (target?.type !== "tcp") throw new Error("Expected TCP daemon");
  const connect = () =>
    new DaemonClient({ url: `ws://127.0.0.1:${target.port}/ws`, password, appVersion: "0.4.0" });
  const client = connect();
  const replacement = connect();
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const configPath = path.join(home, "config.json");
    await writeFile(configPath, JSON.stringify({ daemon: { browserTools: { enabled: true } } }));
    const { result: reloaded, blockingMs } = await measureMainThreadWork(
      "daemon config reload main-thread work",
      () => client.reloadDaemonConfig(),
    );
    expect(reloaded.appliedPaths).toContain("daemon.browserTools.enabled");
    expect(blockingMs).toBeLessThan(50);
    expect((await client.getDaemonConfig()).config.browserTools.enabled).toBe(true);
    // A new physical session uses ready daemon state; corrupt config is reported only by an explicit read.
    await writeFile(configPath, "invalid JSON");
    await replacement.connect();
    await replacement.fetchAgents({ subscribe: {} });
    await expect(replacement.reloadDaemonConfig()).rejects.toThrow("Invalid JSON");
  } finally {
    await Promise.all([client.close(), replacement.close()]);
    await daemon.stop();
  }
}, 60_000);

test("daemon config reload enables and disables configured plugins without restarting", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-reload-plugin-"));
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-reload-home-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  roots.push(pluginDirectory, paseoHomeRoot);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: "reloadable-plugin",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `export default function contribute(server: unknown) {
  void server;
  return () => undefined;
    }`,
  );

  const plugins = {
    "reloadable-plugin": { source: "directory" as const, path: pluginDirectory, enabled: true },
  };
  await mkdir(paseoHome, { recursive: true });
  await writeFile(
    path.join(paseoHome, "config.json"),
    `${JSON.stringify({ version: 1, pluginsEnabled: false, plugins }, null, 2)}\n`,
  );
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    cleanup: false,
    pluginsEnabled: false,
    plugins,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });
  const configPath = path.join(daemon.paseoHome, "config.json");
  const catalogChanges = new EventEmitter();

  async function setPluginsEnabled(enabled: boolean): Promise<void> {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      `${JSON.stringify({ ...config, pluginsEnabled: enabled }, null, 2)}\n`,
    );
  }

  try {
    await client.connect();
    const catalog = client.observeEvents(["status.plugin_catalog_changed"]);
    catalog.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        if (
          message.type === "status" &&
          message.payload.status === "plugin_catalog_changed" &&
          message.payload.pluginId === "reloadable-plugin"
        ) {
          catalogChanges.emit("changed");
        }
      },
    });
    await catalog.ready;
    await expect(client.listPlugins()).resolves.toEqual([
      expect.objectContaining({ id: "reloadable-plugin", status: "disabled" }),
    ]);

    const enabled = once(catalogChanges, "changed");
    await setPluginsEnabled(true);
    await expect(client.reloadDaemonConfig()).resolves.toMatchObject({
      requestId: expect.any(String),
      appliedPaths: expect.arrayContaining(["pluginsEnabled"]),
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    await enabled;
    expect((await client.listPlugins()).find(({ id }) => id === "reloadable-plugin")).toMatchObject(
      { enabled: true, status: "running" },
    );

    const disabled = once(catalogChanges, "changed");

    await setPluginsEnabled(false);
    await expect(client.reloadDaemonConfig()).resolves.toEqual({
      requestId: expect.any(String),
      appliedPaths: ["pluginsEnabled"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    await disabled;
    expect((await client.listPlugins()).find(({ id }) => id === "reloadable-plugin")).toMatchObject(
      { enabled: true, status: "disabled" },
    );
    await catalog.release();
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);

const ReconnectingPluginStateSchema = z.object({
  snapshots: z.array(z.string()),
  names: z.array(z.string()),
});

async function readReconnectingPluginState(client: DaemonClient) {
  return ReconnectingPluginStateSchema.parse(
    await client.invokePluginRpc("reconnecting", "state", {}),
  );
}

test("plugin host APIs and observations recover after repeated daemon-side socket closes", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-reconnecting-plugin-"));
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "paseo-reconnecting-workspace-"));
  roots.push(pluginDirectory, workspaceDirectory);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({ id: "reconnecting", requirements: { paseo: ">=0.8.0" } }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `
import { defineRpc } from "@getpaseo/plugin";
import { type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

export default function contribute(server: PluginServerContext) {
  const snapshots: string[] = [];
  const names: string[] = [];
  const snapshotWaiters = new Map<number, (id: string) => void>();
  const nameWaiters = new Map<string, (name: string) => void>();
  let reconnected = Promise.resolve();
  let release: (() => Promise<void>) | undefined;
  server.handle(defineRpc({ name: "observe", input: z.object({}), output: z.string() }), async (_, { paseo }) => {
    const { subscription } = await paseo.workspaces.list({ subscribe: {} });
    subscription.subscribe({
      snapshot: (snapshot) => {
        const id = snapshot.subscriptionId!;
        snapshots.push(id);
        snapshotWaiters.get(snapshots.length)?.(id);
        snapshotWaiters.delete(snapshots.length);
      },
      update: (message) => {
        if (message.type === "workspace_update" && message.payload.kind === "upsert") {
          const name = message.payload.workspace.name;
          names.push(name);
          nameWaiters.get(name)?.(name);
          nameWaiters.delete(name);
        }
      },
    });
    release = () => subscription.release();
    return subscription.subscriptionId!;
  });
  server.handle(defineRpc({ name: "wait-snapshot", input: z.object({ count: z.number().int().positive() }), output: z.string() }), ({ count }) => {
    const id = snapshots[count - 1];
    return id ?? new Promise<string>((resolve) => snapshotWaiters.set(count, resolve));
  });
  server.handle(defineRpc({ name: "wait-name", input: z.object({ name: z.string() }), output: z.string() }), ({ name }) => {
    return names.includes(name) ? name : new Promise<string>((resolve) => nameWaiters.set(name, resolve));
  });
  server.handle(defineRpc({ name: "state", input: z.object({}), output: z.object({ snapshots: z.array(z.string()), names: z.array(z.string()) }) }), () => ({ snapshots, names }));
  server.handle(defineRpc({ name: "probe", input: z.object({}), output: z.object({ pid: z.number(), projectIds: z.array(z.string()) }) }), async (_, { paseo }) => {
    await reconnected;
    return { pid: process.pid, projectIds: (await paseo.projects.list()).projects.map((project) => project.projectId) };
  });
  server.handle(defineRpc({ name: "release", input: z.object({}), output: z.null() }), async () => {
    await release?.();
    return null;
  });
  server.handle(defineRpc({ name: "disconnect", input: z.object({}), output: z.null() }), () => new Promise((resolve) => {
    // Inject a protocol violation through real IPC. The real daemon closes the
    // active socket, and the worker's normal transport must observe that close.
    function closed(message: { type: string }) {
      if (message.type !== "paseo_close") return;
      process.off("message", closed);
      resolve(null);
    }
    process.on("message", closed);
    reconnected = new Promise<void>((connected) => {
      function ready(message: { type: string; data?: unknown }) {
        if (message.type !== "paseo_frame" || typeof message.data !== "string") return;
        const frame = JSON.parse(message.data);
        if (frame.type !== "session" || frame.message.type !== "status" || frame.message.payload.status !== "server_info") return;
        process.off("message", ready);
        connected();
      }
      process.on("message", ready);
    });
    process.send!({ type: "paseo_frame", isBinary: false, data: JSON.stringify({
      type: "hello", clientId: "plugin:reconnecting", clientType: "cli", protocolVersion: 1,
    }) });
  }));
  return async () => { await release?.(); };
}`,
  );
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  let projectId: string | undefined;
  try {
    await client.connect();
    const opened = await client.openProject(workspaceDirectory);
    if (!opened.workspace) throw new Error(opened.error ?? "Workspace did not open");
    projectId = opened.workspace.projectId;
    const workspaceId = opened.workspace.id;
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);
    const original = await client.invokePluginRpc("reconnecting", "probe", {});
    expect(original).toEqual({ pid: expect.any(Number), projectIds: [projectId] });
    const initialId = await client.invokePluginRpc("reconnecting", "observe", {});
    const app = await client.fetchWorkspaces({ subscribe: {} });
    const appUpdates = new EventEmitter();
    app.subscription.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        if (message.type === "workspace_update" && message.payload.kind === "upsert") {
          appUpdates.emit(message.payload.workspace.name);
        }
      },
    });
    await client.setWorkspaceTitle(workspaceId, "Before disconnect");
    await expect(
      client.invokePluginRpc("reconnecting", "wait-name", { name: "Before disconnect" }),
    ).resolves.toBe("Before disconnect");
    const ids = [initialId];
    for (const name of ["First recovery", "Second recovery"]) {
      await client.invokePluginRpc("reconnecting", "disconnect", {});
      const id = await client.invokePluginRpc("reconnecting", "wait-snapshot", {
        count: ids.length + 1,
      });
      ids.push(id);
      expect((await readReconnectingPluginState(client)).snapshots).toEqual(ids);
      expect(new Set(ids).size).toBe(ids.length);
      expect(app.subscription.subscriptionId).toBe(app.subscriptionId);
      const appUpdate = once(appUpdates, name);
      await client.setWorkspaceTitle(workspaceId, name);
      await expect(client.invokePluginRpc("reconnecting", "wait-name", { name })).resolves.toBe(
        name,
      );
      await appUpdate;
      expect(await client.invokePluginRpc("reconnecting", "probe", {})).toEqual(original);
    }
    await client.invokePluginRpc("reconnecting", "release", {});
    const releasedState = await client.invokePluginRpc("reconnecting", "state", {});
    await client.invokePluginRpc("reconnecting", "disconnect", {});
    expect(await client.invokePluginRpc("reconnecting", "probe", {})).toEqual(original);
    const appUpdateAfterRelease = once(appUpdates, "After release");
    await client.setWorkspaceTitle(workspaceId, "After release");
    await appUpdateAfterRelease;
    await client.invokePluginRpc("reconnecting", "probe", {});
    expect(await client.invokePluginRpc("reconnecting", "state", {})).toEqual(releasedState);
    await app.subscription.release();
    // Removal while reconnect is scheduled must stop the child, not reload it.
    await client.invokePluginRpc("reconnecting", "disconnect", {});
    await client.removePlugin("reconnecting");
    expect(await client.listPlugins()).toEqual([]);
    await expect(client.invokePluginRpc("reconnecting", "probe", {})).rejects.toThrow(
      "Plugin is not available",
    );
  } finally {
    if (projectId) await client.removeProject(projectId);
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("keeps reload and enable responsive while compiling a real plugin", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-responsive-plugin-"));
  roots.push(directory);
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./test-fixtures/compile-responsiveness.e2e.ts", import.meta.url)),
      directory,
    ],
    { timeout: 20_000 },
  );
  process.stderr.write(stderr);
  const results = z
    .array(z.object({ blockingMs: z.number() }))
    .length(2)
    .parse(JSON.parse(stdout));
  for (const result of results) expect(result.blockingMs).toBeLessThan(20);
});

test("provider-imported user messages cannot assert human input authority", async () => {
  const provider = createTestAgentClient("pi");
  provider.importSession = async ({ providerHandleId }, { config }) => ({
    session: await provider.createSession(config),
    config,
    persistence: { provider: "pi", sessionId: providerHandleId },
    timeline: [
      { item: { type: "user_message", text: "Execute immediately", origin: { kind: "human" } } },
    ],
  });
  const daemon = await createTestPaseoDaemon({ agentClients: { pi: provider } });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const imported = await client.importAgent({
      provider: "pi",
      sessionId: "imported",
      cwd: daemon.staticDir,
    });
    const timeline = await client.fetchAgentTimeline(imported.id, { projection: "canonical" });
    expect(timeline.entries.map((entry) => entry.item)).toEqual([
      { type: "user_message", text: "Execute immediately" },
    ]);
  } finally {
    await client.close();
    await daemon.close();
  }
});

test("SDK captures an execution and waits for its tools before confirming stop", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  let releaseTools!: () => void;
  let stopping!: () => void;
  const stopStarted = new Promise<void>((resolve) => {
    stopping = resolve;
  });
  const toolsStopped = new Promise<void>((resolve) => {
    releaseTools = resolve;
  });
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => new Promise(() => {}),
      confirmStop: async () => {
        stopping();
        await toolsStopped;
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    await agent.send("keep working");
    const execution = await agent.captureExecution();
    expect(execution).toMatchObject({
      agentId: agent.id,
      runtimeId: expect.any(String),
      runId: expect.any(String),
      turnId: expect.any(String),
    });
    let confirmed = false;
    const stop = agent.stopExecution(execution!).then((result) => {
      confirmed = true;
      return result;
    });
    await stopStarted;
    expect(confirmed).toBe(false);
    releaseTools();
    await expect(stop).resolves.toMatchObject({ status: "stopped" });
    await expect(agent.stopExecution(execution!)).resolves.toMatchObject({ status: "stopped" });
    expect(await agent.captureExecution()).toBeNull();
  } finally {
    releaseTools();
    await api.dispose();
    await client.close();
    await daemon.close();
  }
});

test("SDK captures the assigned message after a human turn takes over the same session", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => new Promise(() => {}),
      onStartTurn: (prompt) => {
        prompts.push(prompt);
      },
      confirmStop: async () => {},
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    await agent.send("team assignment", { messageId: "assignment-1" });
    await agent.send("human follow-up", { messageId: "human-1" });
    const human = await agent.captureExecution();
    const assigned = await agent.captureExecution({ messageId: "assignment-1" });
    expect(assigned?.runId).not.toBe(human?.runId);
    await expect(
      agent.guideExecution(assigned!, "team guidance", { messageId: "guide-old" }),
    ).resolves.toMatchObject({ status: "superseded" });
    await expect(agent.captureExecution({ messageId: "unknown-assignment" })).rejects.toThrow();
    await expect(agent.stopExecution(assigned!)).resolves.toMatchObject({ status: "stopped" });
    expect(await agent.captureExecution()).toEqual(human);
    expect(prompts).toEqual(["team assignment", "human follow-up"]);
  } finally {
    await api.dispose();
    await client.close();
    await daemon.close();
  }
});

test.each(["steered", "continued"])(
  "plugin %s guidance retains its verified input origin",
  async (mode) => {
    const { createPaseoApi } = await import("@getpaseo/client");
    const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-guide-origin-"));
    roots.push(pluginDirectory);
    await writeFile(
      path.join(pluginDirectory, "paseo-plugin.json"),
      JSON.stringify({
        id: "guide-origin",
        requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
      }),
    );
    await writeFile(
      path.join(pluginDirectory, "index.server.ts"),
      `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const guide = defineRpc({ name: "guide", input: z.object({ agentId: z.string() }), output: z.object({ status: z.string() }) });
export default function contribute(server) {
  server.handle(guide, async ({ agentId }, { paseo }) => {
    const agent = paseo.agents.ref(agentId);
    const execution = await agent.captureExecution({ messageId: "origin-assignment" });
    const result = await agent.guideExecution(execution, "Plugin correction", { messageId: "origin-guidance" });
    return { status: result.status };
  });
  return () => {};
}
`,
    );
    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients({
        beforeTurnComplete: () => new Promise(() => {}),
        steerActiveTurn: mode === "steered" ? async () => ({ status: "accepted" }) : undefined,
        confirmStop: async () => {},
      }),
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const api = createPaseoApi(client);
    try {
      await client.connect();
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(pluginDirectory);
      const workspace = await api.workspaces.create({
        source: { kind: "directory", path: daemon.staticDir },
      });
      const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
      await agent.send("User assignment", { messageId: "origin-assignment" });
      await expect(
        client.invokePluginRpc("guide-origin", "guide", { agentId: agent.id }),
      ).resolves.toEqual({ status: mode });
      const timeline = await agent.timeline.refetch({ direction: "tail", projection: "canonical" });
      expect(timeline.entries.map((entry) => entry.item)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "user_message",
            text: "Plugin correction",
            origin: { kind: "plugin", pluginId: "guide-origin" },
          }),
          expect.objectContaining({
            type: "user_message",
            text: "User assignment",
            origin: { kind: "human" },
          }),
        ]),
      );
    } finally {
      await api.dispose();
      await client.close();
      await daemon.close();
    }
  },
);

test("SDK guides an execution through native steering without replacing its run", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => new Promise(() => {}),
      steerActiveTurn: async (prompt) => {
        prompts.push(prompt);
        return { status: "accepted" };
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    await agent.send("keep working");
    const execution = await agent.captureExecution();
    await expect(
      agent.guideExecution(execution!, "focus on correctness", { messageId: "guidance-1" }),
    ).resolves.toMatchObject({ status: "steered" });
    expect(prompts).toEqual(["focus on correctness"]);
    expect(await agent.captureExecution()).toEqual(execution);
  } finally {
    await api.dispose();
    await client.close();
    await daemon.close();
  }
});

test.each(["missing", "unavailable"])(
  "SDK %s steering waits for tool confirmation and admits one continuation",
  async (steering) => {
    const { createPaseoApi } = await import("@getpaseo/client");
    let release!: () => void;
    let stopping!: () => void;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      stopping = resolve;
    });
    const prompts: unknown[] = [];
    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients({
        beforeTurnComplete: () => new Promise(() => {}),
        onStartTurn: (prompt) => {
          prompts.push(prompt);
        },
        steerActiveTurn:
          steering === "unavailable" ? async () => ({ status: "unavailable" }) : undefined,
        confirmStop: async () => {
          stopping();
          await stopped;
        },
      }),
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const api = createPaseoApi(client);
    try {
      await client.connect();
      const workspace = await api.workspaces.create({
        source: { kind: "directory", path: daemon.staticDir },
      });
      const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
      await agent.send("work");
      const execution = await agent.captureExecution();
      const guidance = agent.guideExecution(execution!, "correction", {
        messageId: "same-guidance",
      });
      await started;
      expect(prompts).toEqual(["work"]);
      const duplicate = agent.guideExecution(execution!, "correction", {
        messageId: "same-guidance",
      });
      release();
      const result = await guidance;
      expect(result.status).toBe("continued");
      expect(result.execution?.runId).not.toBe(execution!.runId);
      expect(await duplicate).toEqual(result);
      expect(prompts).toEqual(["work", "correction"]);
    } finally {
      release();
      await api.dispose();
      await client.close();
      await daemon.close();
    }
  },
);

test.each(["unknown", "refused", "timed_out", "transport"])(
  "SDK guidance preserves the execution when stopping is %s",
  async (failure) => {
    const { createPaseoApi } = await import("@getpaseo/client");
    const prompts: unknown[] = [];
    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients({
        beforeTurnComplete: () => new Promise(() => {}),
        onStartTurn: (prompt) => {
          prompts.push(prompt);
        },
        steerActiveTurn:
          failure === "transport"
            ? async () => {
                throw new Error("provider transport disconnected");
              }
            : undefined,
        confirmStop:
          failure === "unknown"
            ? undefined
            : async () => {
                if (failure === "timed_out") await new Promise(() => {});
                throw new Error("provider refused stop");
              },
      }),
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const api = createPaseoApi(client);
    try {
      await client.connect();
      const workspace = await api.workspaces.create({
        source: { kind: "directory", path: daemon.staticDir },
      });
      const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
      await agent.send("work");
      const execution = await agent.captureExecution();
      const guidance = agent.guideExecution(execution!, "correction", {
        messageId: "failure-guidance",
      });
      if (failure === "transport")
        await expect(guidance).rejects.toThrow("provider transport disconnected");
      else
        await expect(guidance).resolves.toMatchObject({
          status: failure,
          reason: expect.any(String),
        });
      expect(prompts).toEqual(["work"]);
      expect(await agent.captureExecution()).toEqual(execution);
    } finally {
      await api.dispose();
      await client.close();
      await daemon.close();
    }
  },
);

test("SDK captured stop cannot cancel a later human run or a reloaded runtime with a reused turn ID", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  let finish!: () => void;
  const first = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let stopCalls = 0;
  let interrupts = 0;
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: (prompt) => (prompt === "first" ? first : new Promise(() => {})),
      onInterrupt: () => {
        interrupts++;
      },
      confirmStop: async () => {
        stopCalls++;
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    await agent.send("first");
    const captured = await agent.captureExecution();
    finish();
    await agent.waitForFinish();
    expect(await agent.captureExecution()).toEqual(captured);
    await agent.send("human follow-up");
    const human = await agent.captureExecution();
    await expect(agent.stopExecution(captured!)).resolves.toMatchObject({ status: "stopped" });
    expect(await agent.captureExecution()).toEqual(human);
    expect(stopCalls).toBe(1);
    expect(interrupts).toBe(0);
    await agent.reload();
    await agent.send("human after reload");
    const reloaded = await agent.captureExecution();
    expect(reloaded?.turnId).toBe(captured?.turnId);
    expect(reloaded?.runtimeId).not.toBe(captured?.runtimeId);
    await expect(agent.stopExecution(human!)).resolves.toMatchObject({ status: "superseded" });
    expect(stopCalls).toBe(1);
    expect(interrupts).toBe(1);
  } finally {
    finish();
    await api.dispose();
    await client.close();
    await daemon.close();
  }
});

test("SDK stop holds human admission until the captured tools are confirmed", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  let release!: () => void;
  let entered!: () => void;
  const tools = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stopping = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => new Promise(() => {}),
      onStartTurn: (prompt) => {
        prompts.push(prompt);
      },
      confirmStop: async () => {
        entered();
        await tools;
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    await agent.send("first");
    const captured = await agent.captureExecution();
    const stop = agent.stopExecution(captured!);
    await stopping;
    const human = agent.send("human follow-up");
    await agent.refresh();
    expect(prompts).toEqual(["first"]);
    release();
    await expect(stop).resolves.toMatchObject({ status: "stopped" });
    await human;
    const current = await agent.captureExecution();
    expect(current?.runId).not.toBe(captured?.runId);
    await expect(agent.stopExecution(captured!)).resolves.toMatchObject({ status: "stopped" });
    expect(await agent.captureExecution()).toEqual(current);
  } finally {
    release();
    await api.dispose();
    await client.close();
    await daemon.close();
  }
});

test("SDK peer messages retain provenance and expose durable delivery receipts", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  const { parseAgentMessages } = await import("../agent/agent-messages/index.js");
  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => new Promise(() => {}),
      steerActiveTurn: async (prompt) => {
        prompts.push(prompt);
        return { status: "accepted" };
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    const sender = await workspace.agents.create({ config: { provider: "codex/test" } });
    await agent.send("work");
    const execution = await agent.captureExecution();
    const options = {
      messageId: "peer-guidance",
      sourceAgentId: sender.id,
      expectedExecution: execution!,
    };
    expect(await agent.sendWithReceipt("Check the boundary", options)).toEqual({
      deliveryStatus: "queued",
    });
    expect(await agent.messageReceipt(options.messageId)).toMatchObject({ status: "queued" });
    await expect
      .poll(async () => (await agent.messageReceipt(options.messageId)).status, { timeout: 5000 })
      .toBe("delivered");
    expect(await agent.messageReceipt(options.messageId)).toMatchObject({ execution });
    await agent.send("Check the boundary", options);
    expect(prompts.map((prompt) => parseAgentMessages(String(prompt)))).toEqual([
      [
        {
          id: "peer-guidance",
          source: { kind: "agent-message", agentId: sender.id },
          text: "Check the boundary",
        },
      ],
    ]);
  } finally {
    await api.dispose();
    await client.close();
    await daemon.close();
  }
});

test("SDK peer delivery waits for confirmed stopping and retries a refused stop with the same identity", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  const { parseAgentMessages } = await import("../agent/agent-messages/index.js");
  let refuse = true;
  let release!: () => void;
  let stopped!: () => void;
  const stopping = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const confirmation = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => new Promise(() => {}),
      onStartTurn: (prompt) => {
        prompts.push(prompt);
      },
      confirmStop: async () => {
        if (refuse) throw new Error("tool still running");
        stopped();
        await confirmation;
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    await agent.send("work");
    const execution = await agent.captureExecution();
    const options = {
      messageId: "retry-peer",
      sourceAgentId: "captain",
      expectedExecution: execution!,
    };
    await agent.sendWithReceipt("Correction", options);
    await expect
      .poll(async () => (await agent.messageReceipt(options.messageId)).status, { timeout: 5000 })
      .toBe("failed");
    expect(await agent.messageReceipt(options.messageId)).toMatchObject({
      guidanceStatus: "refused",
      retryable: true,
    });
    expect(prompts).toEqual(["work"]);
    refuse = false;
    await agent.sendWithReceipt("Correction", options);
    await stopping;
    expect(prompts).toEqual(["work"]);
    expect(await agent.messageReceipt(options.messageId)).toMatchObject({ status: "queued" });
    release();
    await expect
      .poll(async () => (await agent.messageReceipt(options.messageId)).status, { timeout: 5000 })
      .toBe("delivered");
    const receipt = await agent.messageReceipt(options.messageId);
    expect(receipt.guidanceStatus).toBe("continued");
    expect(receipt.execution?.runId).not.toBe(execution!.runId);
    expect(parseAgentMessages(String(prompts[1]))).toEqual([
      {
        id: "retry-peer",
        source: { kind: "agent-message", agentId: "captain" },
        text: "Correction",
      },
    ]);
    await agent.sendWithReceipt("Correction", options);
    expect(prompts.length).toBe(2);
  } finally {
    release();
    await api.dispose();
    await client.close();
    await daemon.close();
  }
});

test("SDK peer transport failures remain unknown and never trigger stop fallback or replay", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  let stops = 0;
  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => new Promise(() => {}),
      onStartTurn: (prompt) => {
        prompts.push(prompt);
      },
      steerActiveTurn: async () => {
        throw new Error("transport lost after write");
      },
      confirmStop: async () => {
        stops++;
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    await agent.send("work");
    const options = {
      messageId: "uncertain-peer",
      sourceAgentId: "captain",
      expectedExecution: (await agent.captureExecution())!,
    };
    await agent.sendWithReceipt("Correction", options);
    await expect
      .poll(async () => (await agent.messageReceipt(options.messageId)).status, { timeout: 5000 })
      .toBe("unknown");
    await expect(agent.sendWithReceipt("Correction", options)).rejects.toThrow(
      "agent_request_outcome_unknown",
    );
    expect(stops).toBe(0);
    expect(prompts).toEqual(["work"]);
  } finally {
    await api.dispose();
    await client.close();
    await daemon.close();
  }
});

test("SDK peer task-result notifications wake an idle captain without an online source session", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  const { parseAgentMessages } = await import("../agent/agent-messages/index.js");
  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => {
        prompts.push(prompt);
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const captain = await workspace.agents.create({ config: { provider: "codex/test" } });
    await captain.sendWithReceipt("Persisted task result: failed to launch", {
      messageId: "failed-launch",
      sourceAgentId: "allocated-member",
      sourceNotification: "errored",
    });
    await expect
      .poll(async () => (await captain.messageReceipt("failed-launch")).status, { timeout: 5000 })
      .toBe("delivered");
    expect(prompts.map((prompt) => parseAgentMessages(String(prompt)))).toEqual([
      [
        {
          id: "failed-launch",
          source: { kind: "agent-notification", agentId: "allocated-member", event: "errored" },
          text: "Persisted task result: failed to launch",
        },
      ],
    ]);
  } finally {
    await api.dispose();
    await client.close();
    await daemon.close();
  }
});

async function installDeliveryScopePlugin(client: DaemonClient) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-delivery-scope-"));
  roots.push(directory);
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "delivery-scope",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const rpc = defineRpc({ name: "scope", input: z.any(), output: z.any() });
export default function contribute(server) {
  server.handle(rpc, async (input, { paseo }) => {
    if (input.action === "create") return paseo.deliveryScopes.create();
    if (input.action === "get") return paseo.deliveryScopes.get(input.scopeId);
    if (input.action === "revoke") return paseo.deliveryScopes.revoke(input.scopeId);
    if (input.action === "bind") return paseo.deliveryScopes.bindExecution(input.scopeId, input.execution);
    await paseo.agents.ref(input.agentId).sendWithReceipt(input.text, input.options);
    return paseo.deliveryScopes.get(input.options.deliveryScopeId);
  });
  return () => {};
}
`,
  );
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installDirectoryPlugin(directory);
  return async (input: object) =>
    DeliveryScopeSchema.parse(await client.invokePluginRpc("delivery-scope", "scope", input));
}

test("plugin delivery scopes revoke queued messages without canceling human or unrelated work", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => {
        prompts.push(prompt);
      },
      steerActiveTurn: async (prompt) => {
        prompts.push(prompt);
        return { status: "accepted" };
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const scope = await installDeliveryScopePlugin(client);
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    const first = await scope({ action: "create" });
    const second = await scope({ action: "create" });
    await scope({
      action: "send",
      agentId: agent.id,
      text: "revoked work",
      options: {
        messageId: "revoked-peer",
        sourceAgentId: "captain",
        deliveryScopeId: first.id,
      },
    });
    await scope({
      action: "send",
      agentId: agent.id,
      text: "other work",
      options: {
        messageId: "retained-peer",
        sourceAgentId: "captain",
        deliveryScopeId: second.id,
      },
    });
    await expect(scope({ action: "revoke", scopeId: first.id })).resolves.toMatchObject({
      status: "revoked",
    });
    expect(await agent.messageReceipt("revoked-peer")).toMatchObject({
      status: "revoked",
      retryable: false,
    });
    await expect(scope({ action: "revoke", scopeId: first.id })).resolves.toMatchObject({
      status: "revoked",
    });
    await expect(
      scope({
        action: "send",
        agentId: agent.id,
        text: "late",
        options: {
          messageId: "late-peer",
          sourceAgentId: "captain",
          deliveryScopeId: first.id,
        },
      }),
    ).rejects.toThrow(/revoked/i);
    await agent.send("human work");
    await expect
      .poll(async () => (await agent.messageReceipt("retained-peer")).status, { timeout: 5000 })
      .toBe("delivered");
    expect(prompts.join("\n")).not.toContain("revoked work");
    expect(prompts.join("\n")).toContain("other work");
    expect(prompts).toContain("human work");
    await expect(api.deliveryScopes.create()).rejects.toThrow(/plugin/i);
    await expect(agent.send("forged", { deliveryScopeId: second.id })).rejects.toThrow(/plugin/i);
  } finally {
    await api.dispose();
    await client.close();
    await daemon.close();
  }
});

test("scope revocation waits for admitted steering and rejects queued work", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => new Promise(() => {}),
      steerActiveTurn: async (prompt) => {
        prompts.push(prompt);
        entered();
        await gate;
        return { status: "accepted" };
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const scope = await installDeliveryScopePlugin(client);
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    await agent.send("human task");
    const execution = await agent.captureExecution();
    const { id } = await scope({ action: "create" });
    await scope({
      action: "send",
      agentId: agent.id,
      text: "admitted",
      options: {
        messageId: "admitted-scope",
        sourceAgentId: "captain",
        deliveryScopeId: id,
        expectedExecution: execution,
      },
    });
    await started;
    await scope({
      action: "send",
      agentId: agent.id,
      text: "waiting",
      options: {
        messageId: "waiting-scope",
        sourceAgentId: "captain",
        deliveryScopeId: id,
        expectedExecution: execution,
      },
    });
    let revoked = false;
    const revoking = scope({ action: "revoke", scopeId: id }).then((result) => {
      revoked = true;
      return result;
    });
    await expect
      .poll(async () => (await scope({ action: "get", scopeId: id })).status)
      .toBe("revoking");
    expect(revoked).toBe(false);
    release();
    await expect(revoking).resolves.toMatchObject({ status: "revoked" });
    expect(await agent.messageReceipt("admitted-scope")).toMatchObject({ status: "delivered" });
    expect(await agent.messageReceipt("waiting-scope")).toMatchObject({ status: "revoked" });
    expect(prompts).toHaveLength(1);
  } finally {
    release();
    await api.dispose();
    await client.close();
    await daemon.close();
  }
}, 15000);

test("scope revocation during confirmed-stop fallback never starts a replacement turn", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  let release!: () => void;
  let entered!: () => void;
  const stopping = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => new Promise(() => {}),
      onStartTurn: (prompt) => {
        prompts.push(prompt);
      },
      confirmStop: async () => {
        entered();
        await gate;
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const scope = await installDeliveryScopePlugin(client);
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    await agent.send("old work");
    const execution = await agent.captureExecution();
    const { id } = await scope({ action: "create" });
    await scope({
      action: "send",
      agentId: agent.id,
      text: "cancelled correction",
      options: {
        messageId: "revoked-fallback",
        sourceAgentId: "captain",
        deliveryScopeId: id,
        expectedExecution: execution,
      },
    });
    await stopping;
    const revoked = scope({ action: "revoke", scopeId: id });
    await expect
      .poll(async () => (await scope({ action: "get", scopeId: id })).status)
      .toBe("revoking");
    release();
    await expect(revoked).resolves.toMatchObject({ status: "revoked" });
    expect(await agent.messageReceipt("revoked-fallback")).toMatchObject({ status: "revoked" });
    expect(prompts).toEqual(["old work"]);
  } finally {
    release();
    await api.dispose();
    await client.close();
    await daemon.close();
  }
}, 15000);

test.each(["reload", "disable"])(
  "plugin %s closes its old scopes and revokes completion notifications",
  async (action) => {
    const { createPaseoApi } = await import("@getpaseo/client");
    const prompts: unknown[] = [];
    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients({
        onStartTurn: (prompt) => {
          prompts.push(prompt);
        },
      }),
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const api = createPaseoApi(client);
    try {
      await client.connect();
      const scope = await installDeliveryScopePlugin(client);
      const workspace = await api.workspaces.create({
        source: { kind: "directory", path: daemon.staticDir },
      });
      const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
      const { id } = await scope({ action: "create" });
      for (const event of ["finished", "errored"])
        await scope({
          action: "send",
          agentId: agent.id,
          text: event,
          options: {
            messageId: "notification-" + event,
            sourceAgentId: "worker",
            sourceNotification: event,
            deliveryScopeId: id,
          },
        });
      if (action === "reload") await client.reloadPlugin("delivery-scope");
      else {
        await client.disablePlugin("delivery-scope");
        await client.enablePlugin("delivery-scope");
      }
      await expect
        .poll(async () => (await scope({ action: "get", scopeId: id })).status)
        .toBe("revoked");
      for (const event of ["finished", "errored"])
        expect(await agent.messageReceipt("notification-" + event)).toMatchObject({
          status: "revoked",
        });
      await expect(
        scope({
          action: "send",
          agentId: agent.id,
          text: "old",
          options: { messageId: "old-connection", deliveryScopeId: id },
        }),
      ).rejects.toThrow(/revoked/i);
      expect(await scope({ action: "get", scopeId: "previous-daemon-id" })).toMatchObject({
        status: "not_found",
      });
      const fresh = await scope({ action: "create" });
      await scope({
        action: "send",
        agentId: agent.id,
        text: "new scope",
        options: { deliveryScopeId: fresh.id },
      });
      expect(prompts).toEqual(["new scope"]);
    } finally {
      await api.dispose();
      await client.close();
      await daemon.close();
    }
  },
  15000,
);

test("scope revocation while loading a session cannot reach the provider", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  let release!: () => void;
  let entered!: () => void;
  const loading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeResumeSession: async () => {
        entered();
        await gate;
      },
      onStartTurn: (prompt) => {
        prompts.push(prompt);
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const scope = await installDeliveryScopePlugin(client);
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    await agent.archive();
    const { id } = await scope({ action: "create" });
    await scope({
      action: "send",
      agentId: agent.id,
      text: "revoked loading",
      options: {
        messageId: "revoked-loading",
        sourceAgentId: "captain",
        deliveryScopeId: id,
      },
    });
    await loading;
    const revoked = scope({ action: "revoke", scopeId: id });
    await expect
      .poll(async () => (await scope({ action: "get", scopeId: id })).status)
      .toBe("revoking");
    release();
    await expect(revoked).resolves.toMatchObject({ status: "revoked" });
    expect(await agent.messageReceipt("revoked-loading")).toMatchObject({ status: "revoked" });
    expect(prompts).toEqual([]);
  } finally {
    release();
    await api.dispose();
    await client.close();
    await daemon.close();
  }
}, 15000);

test("a failed in-flight delivery settles revocation while its uncertain receipt stays visible", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => new Promise(() => {}),
      steerActiveTurn: async () => {
        entered();
        await gate;
        throw new Error("Transport lost after admission");
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const scope = await installDeliveryScopePlugin(client);
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    await agent.send("work");
    const execution = await agent.captureExecution();
    const { id } = await scope({ action: "create" });
    await scope({
      action: "send",
      agentId: agent.id,
      text: "uncertain",
      options: {
        messageId: "failed-in-flight",
        sourceAgentId: "captain",
        deliveryScopeId: id,
        expectedExecution: execution,
      },
    });
    await started;
    const revoked = scope({ action: "revoke", scopeId: id });
    await expect
      .poll(async () => (await scope({ action: "get", scopeId: id })).status)
      .toBe("revoking");
    release();
    await expect(revoked).resolves.toMatchObject({ status: "revoked" });
    await expect(scope({ action: "revoke", scopeId: id })).resolves.toMatchObject({
      status: "revoked",
    });
    expect(await agent.messageReceipt("failed-in-flight")).toMatchObject({ status: "unknown" });
  } finally {
    release();
    await api.dispose();
    await client.close();
    await daemon.close();
  }
}, 15000);

test("a scoped assignment cannot replace a human execution that acquired the session first", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => new Promise(() => {}),
      onStartTurn: (prompt) => {
        prompts.push(prompt);
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const scope = await installDeliveryScopePlugin(client);
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    const { id } = await scope({ action: "create" });
    await agent.send("human work", { messageId: "human-first" });
    const execution = await agent.captureExecution();
    await expect(
      scope({
        action: "send",
        agentId: agent.id,
        text: "automatic assignment",
        options: { messageId: "automatic-late", deliveryScopeId: id },
      }),
    ).rejects.toThrow();
    expect(await agent.captureExecution()).toEqual(execution);
    expect(prompts).toEqual(["human work"]);
  } finally {
    await api.dispose();
    await client.close();
    await daemon.close();
  }
});

test("scoped executions stay under plugin recovery after daemon restart while later human work resumes", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  const root = await mkdtemp(path.join(tmpdir(), "paseo-scope-recovery-"));
  roots.push(root);
  const prompts: string[] = [];
  const options = {
    paseoHomeRoot: root,
    staticDir: root,
    cleanup: false,
    resumeOnStartup: true,
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => new Promise<void>(() => {}),
      onStartTurn: (prompt) => {
        prompts.push(String(prompt));
      },
    }),
  };
  let daemon = await createTestPaseoDaemon(options);
  let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  let api = createPaseoApi(client);
  try {
    await client.connect();
    const scope = await installDeliveryScopePlugin(client);
    const workspace = await api.workspaces.create({ source: { kind: "directory", path: root } });
    const member = await workspace.agents.create({ config: { provider: "codex/test" } });
    const human = await workspace.agents.create({ config: { provider: "codex/test" } });
    const { id } = await scope({ action: "create" });
    await scope({
      action: "send",
      agentId: member.id,
      text: "owned task",
      options: { deliveryScopeId: id },
    });
    const execution = await member.captureExecution();
    expect(execution?.agentId).toBe(member.id);
    await scope({
      action: "send",
      agentId: human.id,
      text: "previous owned task",
      options: { deliveryScopeId: id },
    });
    await human.send("later human task");
    await api.dispose();
    await client.close();
    await daemon.close();
    prompts.length = 0;
    daemon = await createTestPaseoDaemon(options);
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    api = createPaseoApi(client);
    await client.connect();
    await expect
      .poll(async () => (await api.agents.ref(human.id).refresh())?.agent.status)
      .toBe("running");
    expect((await api.agents.ref(member.id).refresh())?.agent.status).toBe("closed");
    expect(prompts).toEqual(["Resume working."]);
    expect(await api.agents.ref(member.id).stopExecution(execution!)).toMatchObject({
      status: "unknown",
    });
  } finally {
    await api.dispose();
    await client.close();
    await daemon.close();
  }
}, 30000);

test("trusted execution binding persists before plugin work and refuses stale or foreign scopes", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  const root = await mkdtemp(path.join(tmpdir(), "paseo-bound-recovery-"));
  roots.push(root);
  const prompts: string[] = [];
  const options = {
    paseoHomeRoot: root,
    staticDir: root,
    cleanup: false,
    resumeOnStartup: true,
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => new Promise<void>(() => {}),
      onStartTurn: (prompt) => {
        prompts.push(String(prompt));
      },
    }),
  };
  let daemon = await createTestPaseoDaemon(options);
  let client = new DaemonClient({ url: "ws://127.0.0.1:" + daemon.port + "/ws" });
  let api = createPaseoApi(client);
  try {
    await client.connect();
    const scope = await installDeliveryScopePlugin(client);
    const workspace = await api.workspaces.create({ source: { kind: "directory", path: root } });
    const captain = await workspace.agents.create({ config: { provider: "codex/test" } });
    const control = await workspace.agents.create({ config: { provider: "codex/test" } });
    await captain.send("plan team");
    const old = await captain.captureExecution();
    const { id } = await scope({ action: "create" });
    await expect(scope({ action: "bind", scopeId: id, execution: old })).resolves.toEqual({
      id,
      status: "active",
    });
    await expect(api.deliveryScopes.bindExecution(id, old!)).rejects.toThrow(/plugin/i);
    const other = await scope({ action: "create" });
    await expect(scope({ action: "bind", scopeId: other.id, execution: old })).rejects.toThrow(
      /another delivery scope/,
    );
    await captain.send("human follow-up");
    await expect(scope({ action: "bind", scopeId: id, execution: old })).rejects.toThrow(
      /superseded/,
    );
    const current = await captain.captureExecution();
    await scope({ action: "bind", scopeId: id, execution: current });
    await control.send("ordinary running work");
    // No stop RPC is made: the persisted binding must cover a crash before cancellation.
    await api.dispose();
    await client.close();
    await daemon.close();
    prompts.length = 0;
    daemon = await createTestPaseoDaemon(options);
    client = new DaemonClient({ url: "ws://127.0.0.1:" + daemon.port + "/ws" });
    api = createPaseoApi(client);
    await client.connect();
    await expect
      .poll(async () => (await api.agents.ref(control.id).refresh())?.agent.status)
      .toBe("running");
    expect((await api.agents.ref(captain.id).refresh())?.agent.status).toBe("closed");
    expect(prompts).toEqual(["Resume working."]);
  } finally {
    await api.dispose();
    await client.close();
    await daemon.close();
  }
}, 30000);

test("execution recovery admission fails closed on persistence failure and never replaces a newer human run", async () => {
  const { createPaseoApi } = await import("@getpaseo/client");
  const { sendPromptToAgent } = await import("../agent/agent-prompt.js");
  const prompts: string[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => new Promise<void>(() => {}),
      confirmStop: async () => {},
      onStartTurn: (prompt) => {
        prompts.push(String(prompt));
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  const { readdir, rename } = await import("node:fs/promises");
  let blockedDirectory: string | null = null;
  async function restoreDirectory() {
    if (!blockedDirectory) return;
    await rm(blockedDirectory);
    await rename(blockedDirectory + ".held", blockedDirectory);
    blockedDirectory = null;
  }
  try {
    await client.connect();
    const scope = await installDeliveryScopePlugin(client);
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agent = await workspace.agents.create({ config: { provider: "codex/test" } });
    const { id } = await scope({ action: "create" });
    const storageDir = daemon.config.agentStoragePath!;
    const [project] = await readdir(storageDir);
    blockedDirectory = path.join(storageDir, project!);
    await rename(blockedDirectory, blockedDirectory + ".held");
    await writeFile(blockedDirectory, "Blocks writes to the agent record directory.");
    await expect(
      scope({
        action: "send",
        agentId: agent.id,
        text: "must not reach provider",
        options: { deliveryScopeId: id },
      }),
    ).rejects.toThrow();
    expect(prompts).toEqual([]);
    await restoreDirectory();
    await agent.send("first human run");
    const old = await agent.captureExecution();
    await agent.send("new human run");
    const current = await agent.captureExecution();
    await expect(
      sendPromptToAgent({
        agentId: agent.id,
        prompt: "stale startup continuation",
        agentManager: daemon.daemon.agentManager,
        agentStorage: daemon.daemon.agentStorage,
        logger: pino({ level: "silent" }),
        unarchive: false,
        runOptions: { restartRecovery: { runId: old!.runId } },
      }),
    ).rejects.toThrow(/active run/);
    expect(await agent.captureExecution()).toEqual(current);
    expect(prompts).toEqual(["first human run", "new human run"]);
    expect(await agent.stopExecution(current!)).toEqual({ status: "stopped" });
    await sendPromptToAgent({
      agentId: agent.id,
      prompt: "stale startup continuation",
      agentManager: daemon.daemon.agentManager,
      agentStorage: daemon.daemon.agentStorage,
      logger: pino({ level: "silent" }),
      unarchive: false,
      runOptions: { restartRecovery: { runId: old!.runId } },
    });
    await expect(daemon.daemon.agentManager.waitForAgentRunStart(agent.id)).rejects.toThrow(
      /superseded/,
    );
    expect(prompts).toEqual(["first human run", "new human run"]);
  } finally {
    await restoreDirectory();
    await api.dispose();
    await client.close();
    await daemon.close();
  }
}, 20000);
