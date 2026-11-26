import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentExtensionMcpServer,
  AgentExtensionMcpSource,
  AgentExtensionMcpTransport,
  AgentExtensionSkill,
  AgentExtensionSkillScope,
} from "@getpaseo/protocol/messages";
import { parse as parseYaml } from "yaml";
import type { AgentSlashCommand, McpServerConfig } from "./agent-sdk-types.js";
import { PASEO_MCP_SERVER_NAME } from "./runtime-mcp-config.js";

export interface RuntimePluginMcpServerInfo {
  name: string;
  owner?: string;
  transport?: AgentExtensionMcpTransport;
}

export interface DiscoverAgentExtensionsInput {
  /** Agent's configured provider id (e.g. "codex", "antigravity", "cursor", "pi", "claude"). */
  provider: string;
  /** Resolved base adapter provider id when the provider extends another provider. */
  adapterProvider?: string;
  /** Agent working directory. */
  cwd: string;
  /** Override home directory (used in tests). Defaults to os.homedir(). */
  homeDir?: string;
  /** Override environment variables (used in tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Whether Paseo's internal MCP server (or native Paseo tools) is active for this agent. */
  paseoMcpEnabled: boolean;
  /** Whether Paseo's browser_* tools are enabled on the Paseo MCP server. */
  browserToolsEnabled: boolean;
  /** Plugin-injected MCP servers attached to this agent. */
  pluginMcpServers?: readonly RuntimePluginMcpServerInfo[];
  /** Per-agent configured MCP servers (excluding internal paseo). */
  agentMcpServers?: Record<string, McpServerConfig>;
  /** Commands/skills reported dynamically by the live provider session (e.g. Codex skills/list, ACP available_commands_update). */
  providerCommands?: readonly AgentSlashCommand[];
}

export interface DiscoveredAgentExtensions {
  mcpServers: AgentExtensionMcpServer[];
  skills: AgentExtensionSkill[];
}

type ProviderFamily =
  | "antigravity"
  | "codex"
  | "cursor"
  | "pi"
  | "claude"
  | "opencode"
  | "other";

export function resolveProviderFamily(
  provider: string,
  adapterProvider?: string,
): ProviderFamily {
  const candidates = [provider, adapterProvider]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());

  for (const candidate of candidates) {
    if (candidate === "antigravity" || candidate.includes("antigravity")) return "antigravity";
    if (candidate === "codex" || candidate.startsWith("codex")) return "codex";
    if (candidate === "cursor" || candidate.startsWith("cursor")) return "cursor";
    if (candidate === "pi" || candidate.startsWith("pi-") || candidate === "omp") return "pi";
    if (candidate === "claude" || candidate.startsWith("claude")) return "claude";
    if (candidate === "opencode" || candidate.startsWith("opencode")) return "opencode";
  }

  return "other";
}

function inferTransportFromRecord(record: Record<string, unknown>): AgentExtensionMcpTransport {
  const rawType = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  if (rawType === "stdio") return "stdio";
  if (rawType === "sse") return "sse";
  if (rawType === "http" || rawType === "streamable-http" || rawType === "streamablehttp") {
    return "http";
  }
  if (typeof record.command === "string" && record.command.trim().length > 0) {
    return "stdio";
  }
  if (
    (typeof record.url === "string" && record.url.trim().length > 0) ||
    (typeof record.serverUrl === "string" && record.serverUrl.trim().length > 0)
  ) {
    return "http";
  }
  return "unknown";
}

function isMcpEntryDisabled(record: Record<string, unknown>): boolean {
  return record.enabled === false || record.disabled === true;
}

function toPlainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readJsonFileIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await readTextIfExists(filePath);
  if (!raw) return null;
  try {
    return toPlainObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

interface ParsedMcpEntry {
  name: string;
  enabled: boolean;
  transport: AgentExtensionMcpTransport;
  source: AgentExtensionMcpSource;
}

function extractMcpServersFromJsonObject(
  serversObj: Record<string, unknown> | null,
  source: AgentExtensionMcpSource,
): ParsedMcpEntry[] {
  if (!serversObj) return [];
  const entries: ParsedMcpEntry[] = [];
  for (const [name, rawConfig] of Object.entries(serversObj)) {
    const trimmedName = name.trim();
    if (!trimmedName) continue;
    const record = toPlainObject(rawConfig);
    if (!record) continue;
    entries.push({
      name: trimmedName,
      enabled: !isMcpEntryDisabled(record),
      transport: inferTransportFromRecord(record),
      source,
    });
  }
  return entries;
}

async function readJsonMcpConfig(
  filePath: string,
  source: AgentExtensionMcpSource,
  key: "mcpServers" | "mcp" = "mcpServers",
): Promise<ParsedMcpEntry[]> {
  const json = await readJsonFileIfExists(filePath);
  if (!json) return [];
  return extractMcpServersFromJsonObject(toPlainObject(json[key]), source);
}

/**
 * Strip inline TOML comments while respecting single- and double-quoted strings.
 */
function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlHeaderSegments(headerBody: string): string[] {
  const segments: string[] = [];
  let i = 0;
  const len = headerBody.length;
  while (i < len) {
    while (i < len && /\s/.test(headerBody[i]!)) i += 1;
    if (i >= len) break;
    const ch = headerBody[i]!;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let value = "";
      while (i < len) {
        const c = headerBody[i]!;
        if (quote === '"' && c === "\\" && i + 1 < len) {
          value += headerBody[i + 1]!;
          i += 2;
          continue;
        }
        if (c === quote) {
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
      segments.push(value);
      while (i < len && headerBody[i] !== ".") i += 1;
      if (headerBody[i] === ".") i += 1;
    } else {
      let start = i;
      while (i < len && headerBody[i] !== ".") i += 1;
      const seg = headerBody.slice(start, i).trim();
      if (seg) segments.push(seg);
      if (headerBody[i] === ".") i += 1;
    }
  }
  return segments;
}

/**
 * Parses `[mcp_servers.<name>]` sections from a Codex `config.toml` file.
 * Sub-tables like `[mcp_servers.<name>.env]` are ignored for top-level keys
 * (`enabled`, `disabled`, `command`, `url`, `type`) so they don't overwrite server flags.
 */
export function parseCodexTomlMcpServers(
  content: string,
  source: AgentExtensionMcpSource,
): ParsedMcpEntry[] {
  const servers = new Map<
    string,
    { enabled: boolean; transport: AgentExtensionMcpTransport; source: AgentExtensionMcpSource }
  >();
  let currentServer: string | null = null;
  let inServerRootTable = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      const isArrayTable = line.startsWith("[[") && line.endsWith("]]");
      const inner = (isArrayTable ? line.slice(2, -2) : line.slice(1, -1)).trim();
      const segments = parseTomlHeaderSegments(inner);
      if (segments[0] === "mcp_servers" && segments.length >= 2 && segments[1]!.trim()) {
        currentServer = segments[1]!.trim();
        inServerRootTable = segments.length === 2;
        if (!servers.has(currentServer)) {
          servers.set(currentServer, { enabled: true, transport: "unknown", source });
        }
      } else {
        currentServer = null;
        inServerRootTable = false;
      }
      continue;
    }

    if (!currentServer || !inServerRootTable) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim().replace(/^["']|["']$/g, "");
    const rawValue = line.slice(eqIndex + 1).trim();
    const entry = servers.get(currentServer)!;

    if (key === "enabled") {
      if (rawValue === "false") entry.enabled = false;
      else if (rawValue === "true") entry.enabled = true;
    } else if (key === "disabled") {
      if (rawValue === "true") entry.enabled = false;
      else if (rawValue === "false") entry.enabled = true;
    } else if (key === "command" && rawValue.length > 0) {
      if (entry.transport === "unknown") entry.transport = "stdio";
    } else if (key === "url" && rawValue.length > 0) {
      if (entry.transport === "unknown") entry.transport = "http";
    } else if (key === "type") {
      const unquoted = rawValue.replace(/^["']|["']$/g, "").toLowerCase();
      if (unquoted === "stdio" || unquoted === "http" || unquoted === "sse") {
        entry.transport = unquoted;
      }
    }
  }

  return [...servers.entries()].map(([name, info]) => ({
    name,
    enabled: info.enabled,
    transport: info.transport,
    source: info.source,
  }));
}

async function readCodexTomlMcpConfig(
  filePath: string,
  source: AgentExtensionMcpSource,
): Promise<ParsedMcpEntry[]> {
  const content = await readTextIfExists(filePath);
  if (!content) return [];
  return parseCodexTomlMcpServers(content, source);
}

async function discoverProviderLocalMcpServers(input: {
  family: ProviderFamily;
  cwd: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<AgentExtensionMcpServer[]> {
  const { family, cwd, homeDir, env } = input;
  const codexHome = env.CODEX_HOME?.trim() || path.join(homeDir, ".codex");

  // Ordered from lowest precedence (global) to highest precedence (workspace) so workspace
  // entries override global ones — including disabling a globally enabled server.
  const orderedBatches: ParsedMcpEntry[][] = [];

  switch (family) {
    case "antigravity":
      orderedBatches.push(
        await readJsonMcpConfig(path.join(homeDir, ".gemini", "config", "mcp_config.json"), "global"),
        await readJsonMcpConfig(path.join(cwd, ".gemini", "config", "mcp_config.json"), "workspace"),
        await readJsonMcpConfig(path.join(cwd, ".gemini", "mcp_config.json"), "workspace"),
      );
      break;
    case "codex":
      orderedBatches.push(
        await readCodexTomlMcpConfig(path.join(codexHome, "config.toml"), "global"),
        await readCodexTomlMcpConfig(path.join(cwd, ".codex", "config.toml"), "workspace"),
      );
      break;
    case "cursor":
      orderedBatches.push(
        await readJsonMcpConfig(path.join(homeDir, ".cursor", "mcp.json"), "global"),
        await readJsonMcpConfig(path.join(cwd, ".cursor", "mcp.json"), "workspace"),
      );
      break;
    case "pi":
      orderedBatches.push(
        await readJsonMcpConfig(path.join(homeDir, ".pi", "agent", "mcp.json"), "global"),
        await readJsonMcpConfig(path.join(cwd, ".pi", "mcp.json"), "workspace"),
      );
      break;
    case "claude": {
      const claudeGlobal = await readJsonFileIfExists(path.join(homeDir, ".claude.json"));
      const globalEntries = extractMcpServersFromJsonObject(
        toPlainObject(claudeGlobal?.mcpServers),
        "global",
      );
      const projectsObj = toPlainObject(claudeGlobal?.projects);
      const projectEntry = projectsObj ? toPlainObject(projectsObj[cwd]) : null;
      const projectGlobalEntries = extractMcpServersFromJsonObject(
        toPlainObject(projectEntry?.mcpServers),
        "workspace",
      );
      orderedBatches.push(
        globalEntries,
        projectGlobalEntries,
        await readJsonMcpConfig(path.join(cwd, ".mcp.json"), "workspace"),
      );
      break;
    }
    case "opencode":
      orderedBatches.push(
        await readJsonMcpConfig(
          path.join(homeDir, ".config", "opencode", "opencode.json"),
          "global",
          "mcp",
        ),
        await readJsonMcpConfig(path.join(cwd, "opencode.json"), "workspace", "mcp"),
      );
      break;
    case "other":
      break;
  }

  const resolved = new Map<string, ParsedMcpEntry>();
  for (const batch of orderedBatches) {
    for (const entry of batch) {
      resolved.set(entry.name, entry);
    }
  }

  const active: AgentExtensionMcpServer[] = [];
  for (const entry of resolved.values()) {
    if (!entry.enabled) continue;
    active.push({
      name: entry.name,
      source: entry.source,
      transport: entry.transport,
    });
  }

  return active.sort((a, b) => a.name.localeCompare(b.name));
}

export function parseSkillFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const frontmatter = match[1] ?? "";

  try {
    const parsed = toPlainObject(parseYaml(frontmatter));
    if (parsed) {
      const name = typeof parsed.name === "string" ? parsed.name.trim() : undefined;
      const description =
        typeof parsed.description === "string" ? parsed.description.trim() : undefined;
      if (name || description) {
        return {
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
        };
      }
    }
  } catch {
    // Some SKILL.md frontmatter descriptions contain unquoted colons; fall back to line parsing.
  }

  let name: string | undefined;
  let description: string | undefined;
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!name) {
      const nameMatch = line.match(/^\s*name\s*:\s*(.+?)\s*$/);
      if (nameMatch?.[1]) {
        name = nameMatch[1].replace(/^["']|["']$/g, "").trim();
      }
    }
    if (!description) {
      const descMatch = line.match(/^\s*description\s*:\s*(.+?)\s*$/);
      if (descMatch?.[1]) {
        description = descMatch[1].replace(/^["']|["']$/g, "").trim();
      }
    }
  }
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

async function scanSkillsDirectory(
  rootDir: string,
  scope: AgentExtensionSkillScope,
): Promise<AgentExtensionSkill[]> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: AgentExtensionSkill[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return;
      const dirPath = path.join(rootDir, entry.name);
      if (!entry.isDirectory()) {
        if (!entry.isSymbolicLink()) return;
        try {
          const targetStat = await stat(dirPath);
          if (!targetStat.isDirectory()) return;
        } catch {
          return;
        }
      }

      const skillFile = path.join(dirPath, "SKILL.md");
      const content = await readTextIfExists(skillFile);
      if (content === null) return;

      const meta = parseSkillFrontmatter(content);
      results.push({
        name: meta.name || entry.name,
        description: meta.description || "",
        scope,
        path: skillFile,
      });
    }),
  );

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

function resolveSkillDirectories(input: {
  family: ProviderFamily;
  cwd: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}): Array<{ dir: string; scope: AgentExtensionSkillScope }> {
  const { family, cwd, homeDir, env } = input;
  const codexHome = env.CODEX_HOME?.trim() || path.join(homeDir, ".codex");

  const workspaceDirs = [path.join(cwd, ".agents", "skills")];
  const globalDirs = [path.join(homeDir, ".agents", "skills")];
  const builtinDirs: string[] = [];

  switch (family) {
    case "antigravity":
      workspaceDirs.push(path.join(cwd, ".gemini", "skills"));
      globalDirs.push(
        path.join(homeDir, ".gemini", "skills"),
        path.join(homeDir, ".gemini", "antigravity", "skills"),
      );
      builtinDirs.push(path.join(homeDir, ".gemini", "antigravity-cli", "builtin", "skills"));
      break;
    case "codex":
      workspaceDirs.push(path.join(cwd, ".codex", "skills"));
      globalDirs.push(path.join(codexHome, "skills"));
      builtinDirs.push(path.join(codexHome, "skills", ".system"));
      break;
    case "cursor":
      workspaceDirs.push(path.join(cwd, ".cursor", "skills"));
      globalDirs.push(path.join(homeDir, ".cursor", "skills"));
      break;
    case "claude":
      workspaceDirs.push(path.join(cwd, ".claude", "skills"));
      globalDirs.push(path.join(homeDir, ".claude", "skills"));
      break;
    case "pi":
      workspaceDirs.push(path.join(cwd, ".pi", "skills"));
      globalDirs.push(path.join(homeDir, ".pi", "agent", "skills"));
      break;
    case "opencode":
      workspaceDirs.push(path.join(cwd, ".opencode", "skills"));
      globalDirs.push(path.join(homeDir, ".config", "opencode", "skills"));
      break;
    case "other":
      break;
  }

  const seen = new Set<string>();
  const ordered: Array<{ dir: string; scope: AgentExtensionSkillScope }> = [];
  const pushAll = (dirs: string[], scope: AgentExtensionSkillScope) => {
    for (const dir of dirs) {
      const normalized = path.resolve(dir);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      ordered.push({ dir: normalized, scope });
    }
  };

  pushAll(workspaceDirs, "workspace");
  pushAll(globalDirs, "global");
  pushAll(builtinDirs, "builtin");
  return ordered;
}

const SKILL_SCOPE_ORDER: Record<AgentExtensionSkillScope, number> = {
  workspace: 0,
  global: 1,
  builtin: 2,
  provider: 3,
};

export async function discoverAgentExtensions(
  input: DiscoverAgentExtensionsInput,
): Promise<DiscoveredAgentExtensions> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const family = resolveProviderFamily(input.provider, input.adapterProvider);

  const [localMcpServers, scannedSkillBatches] = await Promise.all([
    discoverProviderLocalMcpServers({
      family,
      cwd: input.cwd,
      homeDir,
      env,
    }),
    Promise.all(
      resolveSkillDirectories({ family, cwd: input.cwd, homeDir, env }).map(({ dir, scope }) =>
        scanSkillsDirectory(dir, scope),
      ),
    ),
  ]);

  // Assemble MCP servers: Paseo -> plugin -> agent config -> local provider config.
  const mcpByName = new Map<string, AgentExtensionMcpServer>();

  if (input.paseoMcpEnabled) {
    mcpByName.set(PASEO_MCP_SERVER_NAME, {
      name: PASEO_MCP_SERVER_NAME,
      source: "paseo",
      transport: "http",
      ...(input.browserToolsEnabled ? { badges: ["browser"] } : {}),
    });
  }

  for (const pluginServer of input.pluginMcpServers ?? []) {
    const name = pluginServer.name.trim();
    if (!name || mcpByName.has(name)) continue;
    mcpByName.set(name, {
      name,
      source: "plugin",
      transport: pluginServer.transport ?? "unknown",
      ...(pluginServer.owner ? { detail: pluginServer.owner } : {}),
    });
  }

  for (const [rawName, config] of Object.entries(input.agentMcpServers ?? {})) {
    const name = rawName.trim();
    if (!name || mcpByName.has(name)) continue;
    mcpByName.set(name, {
      name,
      source: "agent",
      transport: inferTransportFromRecord(config as unknown as Record<string, unknown>),
    });
  }

  for (const localServer of localMcpServers) {
    if (mcpByName.has(localServer.name)) continue;
    mcpByName.set(localServer.name, localServer);
  }

  // Assemble skills in precedence order: workspace > global > builtin > provider.
  const skillsByName = new Map<string, AgentExtensionSkill>();
  for (const batch of scannedSkillBatches) {
    for (const skill of batch) {
      const key = skill.name.toLowerCase();
      if (!skillsByName.has(key)) {
        skillsByName.set(key, skill);
      }
    }
  }

  for (const cmd of input.providerCommands ?? []) {
    if (cmd.kind !== "skill") continue;
    const name = cmd.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!skillsByName.has(key)) {
      skillsByName.set(key, {
        name,
        description: cmd.description?.trim() ?? "",
        scope: "provider",
      });
    }
  }

  const skills = [...skillsByName.values()].sort((a, b) => {
    const scopeDiff = SKILL_SCOPE_ORDER[a.scope] - SKILL_SCOPE_ORDER[b.scope];
    if (scopeDiff !== 0) return scopeDiff;
    return a.name.localeCompare(b.name);
  });

  return {
    mcpServers: [...mcpByName.values()],
    skills,
  };
}
