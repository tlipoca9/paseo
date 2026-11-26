import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverAgentExtensions,
  parseCodexTomlMcpServers,
  parseSkillFrontmatter,
} from "./agent-extensions.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("parseCodexTomlMcpServers", () => {
  it("parses enabled/disabled servers, ignores sub-tables, and handles quoted keys", () => {
    const toml = `
[features]
enabled = false

[mcp_servers.node_repl]
command = "/usr/local/bin/node_repl"

[mcp_servers.node_repl.env]
enabled = false
NODE_ENV = "production"

[mcp_servers.iWiki]
url = "https://example.test/mcp" # inline comment
enabled = true

[mcp_servers."computer-use"]
enabled = false
command = "./computer-use"

[mcp_servers.disabled_flag]
disabled = true
url = "https://disabled.test/mcp"
`;

    expect(parseCodexTomlMcpServers(toml, "global")).toEqual([
      { name: "node_repl", enabled: true, transport: "stdio", source: "global" },
      { name: "iWiki", enabled: true, transport: "http", source: "global" },
      { name: "computer-use", enabled: false, transport: "stdio", source: "global" },
      { name: "disabled_flag", enabled: false, transport: "http", source: "global" },
    ]);
  });
});

describe("parseSkillFrontmatter", () => {
  it("extracts name and description from YAML frontmatter and falls back on unquoted colons", () => {
    expect(
      parseSkillFrontmatter(`---
name: my-skill
description: Does useful things
---
# Body`),
    ).toEqual({ name: "my-skill", description: "Does useful things" });

    expect(
      parseSkillFrontmatter(`---
name: colon-skill
description: Use for foo: bar: baz cases
---
# Body`),
    ).toEqual({ name: "colon-skill", description: "Use for foo: bar: baz cases" });
  });
});

describe("discoverAgentExtensions", () => {
  it("discovers Paseo, plugin, and Antigravity MCP servers plus workspace/global/builtin skills", async () => {
    const homeDir = await makeTempDir("paseo-ext-home-");
    const cwd = await makeTempDir("paseo-ext-cwd-");

    await writeText(
      path.join(homeDir, ".gemini", "config", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          firecrawl: { command: "firecrawl-mcp" },
          gongfeng: { url: "https://gongfeng.test/mcp" },
          muted: { command: "muted-mcp", enabled: false },
        },
      }),
    );

    await writeText(
      path.join(cwd, ".agents", "skills", "local-skill", "SKILL.md"),
      "---\nname: local-skill\ndescription: Workspace skill\n---\n",
    );
    await writeText(
      path.join(cwd, ".agents", "skills", "shared-skill", "SKILL.md"),
      "---\nname: shared-skill\ndescription: Workspace override\n---\n",
    );
    await writeText(
      path.join(homeDir, ".agents", "skills", "shared-skill", "SKILL.md"),
      "---\nname: shared-skill\ndescription: Global version\n---\n",
    );
    await writeText(
      path.join(homeDir, ".agents", "skills", "global-skill", "SKILL.md"),
      "---\nname: global-skill\ndescription: Global skill\n---\n",
    );
    await writeText(
      path.join(homeDir, ".gemini", "antigravity-cli", "builtin", "skills", "builtin-skill", "SKILL.md"),
      "---\nname: builtin-skill\ndescription: Builtin skill\n---\n",
    );

    // Symlinked global skill directory
    const externalSkillDir = await makeTempDir("paseo-ext-symlink-");
    await writeText(
      path.join(externalSkillDir, "SKILL.md"),
      "---\nname: linked-skill\ndescription: Symlinked skill\n---\n",
    );
    await symlink(externalSkillDir, path.join(homeDir, ".agents", "skills", "linked-skill"));

    const result = await discoverAgentExtensions({
      provider: "antigravity",
      cwd,
      homeDir,
      env: {},
      paseoMcpEnabled: true,
      browserToolsEnabled: true,
      pluginMcpServers: [{ name: "company-plugin", owner: "acme-plugin", transport: "http" }],
    });

    expect(result.mcpServers).toEqual([
      { name: "paseo", source: "paseo", transport: "http", badges: ["browser"] },
      { name: "company-plugin", source: "plugin", transport: "http", detail: "acme-plugin" },
      { name: "firecrawl", source: "global", transport: "stdio" },
      { name: "gongfeng", source: "global", transport: "http" },
    ]);

    expect(result.skills.map((s) => ({ name: s.name, scope: s.scope, description: s.description }))).toEqual([
      { name: "local-skill", scope: "workspace", description: "Workspace skill" },
      { name: "shared-skill", scope: "workspace", description: "Workspace override" },
      { name: "global-skill", scope: "global", description: "Global skill" },
      { name: "linked-skill", scope: "global", description: "Symlinked skill" },
      { name: "builtin-skill", scope: "builtin", description: "Builtin skill" },
    ]);
  });

  it("merges Codex global & workspace config.toml, respects workspace disables, and merges provider skills", async () => {
    const homeDir = await makeTempDir("paseo-codex-home-");
    const cwd = await makeTempDir("paseo-codex-cwd-");

    await writeText(
      path.join(homeDir, ".codex", "config.toml"),
      `
[mcp_servers.iWiki]
url = "https://iwiki.test/mcp"

[mcp_servers.codegraph]
command = "codegraph"

[mcp_servers.disabled_global]
enabled = false
command = "nope"
`,
    );

    await writeText(
      path.join(cwd, ".codex", "config.toml"),
      `
[mcp_servers.codegraph]
enabled = false

[mcp_servers.project_mcp]
command = "project-mcp"
`,
    );

    await writeText(
      path.join(cwd, ".codex", "skills", "codex-local", "SKILL.md"),
      "---\nname: codex-local\ndescription: Local codex skill\n---\n",
    );

    const result = await discoverAgentExtensions({
      provider: "codex",
      cwd,
      homeDir,
      env: {},
      paseoMcpEnabled: true,
      browserToolsEnabled: false,
      providerCommands: [
        { name: "compact", description: "Compact", argumentHint: "", kind: "command" },
        { name: "codex-local", description: "Duplicate", argumentHint: "", kind: "skill" },
        { name: "remote-codex-skill", description: "From skills/list", argumentHint: "", kind: "skill" },
      ],
    });

    expect(result.mcpServers).toEqual([
      { name: "paseo", source: "paseo", transport: "http" },
      { name: "iWiki", source: "global", transport: "http" },
      { name: "project_mcp", source: "workspace", transport: "stdio" },
    ]);

    expect(result.skills.map((s) => ({ name: s.name, scope: s.scope }))).toEqual([
      { name: "codex-local", scope: "workspace" },
      { name: "remote-codex-skill", scope: "provider" },
    ]);
  });

  it("reads Cursor and Pi MCP configs and filters disabled entries", async () => {
    const homeDir = await makeTempDir("paseo-cursor-pi-home-");
    const cwd = await makeTempDir("paseo-cursor-pi-cwd-");

    await writeText(
      path.join(homeDir, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          peekaboo: { command: "peekaboo-mcp" },
          off: { command: "off", enabled: false },
        },
      }),
    );
    await writeText(
      path.join(cwd, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          repoMcp: { url: "http://localhost:9000/mcp" },
        },
      }),
    );
    await writeText(
      path.join(homeDir, ".pi", "agent", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          piServer: { url: "https://pi.test/mcp" },
          piDisabled: { command: "x", disabled: true },
        },
      }),
    );

    const cursorResult = await discoverAgentExtensions({
      provider: "cursor",
      cwd,
      homeDir,
      env: {},
      paseoMcpEnabled: false,
      browserToolsEnabled: false,
    });
    expect(cursorResult.mcpServers).toEqual([
      { name: "peekaboo", source: "global", transport: "stdio" },
      { name: "repoMcp", source: "workspace", transport: "http" },
    ]);

    const piResult = await discoverAgentExtensions({
      provider: "pi",
      cwd,
      homeDir,
      env: {},
      paseoMcpEnabled: false,
      browserToolsEnabled: false,
    });
    expect(piResult.mcpServers).toEqual([
      { name: "piServer", source: "global", transport: "http" },
    ]);
  });
});
