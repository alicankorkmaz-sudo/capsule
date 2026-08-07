import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { McpManager } from "../src/manager";
import {
  claudeCodeConfigPath,
  claudeDesktopConfigPath,
  codexConfigPath,
  codexProjectConfigPath,
  projectMcpPath
} from "../src/paths";
import { makeTempEnv, readJson } from "./helpers";

describe("McpManager", () => {
  it("hides disabled Codex servers by moving them out of config.toml", async () => {
    const env = await makeTempEnv();
    await fs.writeFile(
      codexConfigPath(env.ctx),
      [
        "[mcp_servers.context7]",
        'command = "npx"',
        'args = ["-y", "@upstash/context7-mcp"]',
        ""
      ].join("\n")
    );
    const manager = new McpManager(env.ctx);

    const server = (await manager.listServers()).find((item) => item.target === "codex")!;
    expect(server.enabled).toBe(true);

    await manager.patchServer(server.id, { enabled: false });
    expect(await fs.readFile(codexConfigPath(env.ctx), "utf8")).not.toContain("context7");

    const disabled = (await manager.listServers()).find(
      (item) => item.target === "codex" && item.name === "context7"
    )!;
    expect(disabled.disabled).toBe(true);
    await manager.patchServer(disabled.id, { enabled: true });
    expect(await fs.readFile(codexConfigPath(env.ctx), "utf8")).toContain("context7");
  });

  it("migrates existing Codex enabled=false entries into the disabled store", async () => {
    const env = await makeTempEnv();
    await fs.writeFile(
      codexConfigPath(env.ctx),
      [
        "[mcp_servers.hidden]",
        'command = "npx"',
        'args = ["-y", "hidden-mcp"]',
        "enabled = false",
        ""
      ].join("\n")
    );
    const manager = new McpManager(env.ctx);

    const hidden = (await manager.listServers()).find((item) => item.target === "codex" && item.name === "hidden");

    expect(hidden?.disabled).toBe(true);
    expect(await fs.readFile(codexConfigPath(env.ctx), "utf8")).not.toContain("hidden");
  });

  it("moves Claude Desktop disabled servers into the app-managed disabled store", async () => {
    const env = await makeTempEnv();
    await fs.writeFile(
      claudeDesktopConfigPath(env.ctx),
      JSON.stringify(
        {
          mcpServers: {
            stitch: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
              env: { API_KEY: "secret" }
            }
          }
        },
        null,
        2
      )
    );
    const manager = new McpManager(env.ctx);
    const server = (await manager.listServers()).find((item) => item.target === "claude-desktop")!;

    await manager.patchServer(server.id, { enabled: false });
    const desktopAfterDisable = await readJson<{ mcpServers: Record<string, unknown> }>(
      claudeDesktopConfigPath(env.ctx)
    );
    expect(desktopAfterDisable.mcpServers.stitch).toBeUndefined();

    const disabled = (await manager.listServers()).find((item) => item.target === "claude-desktop")!;
    expect(disabled.disabled).toBe(true);
    expect(disabled.config.env).toEqual({ API_KEY: "••••••••" });

    await manager.patchServer(disabled.id, { enabled: true });
    const desktopAfterEnable = await readJson<{ mcpServers: Record<string, unknown> }>(
      claudeDesktopConfigPath(env.ctx)
    );
    expect(desktopAfterEnable.mcpServers.stitch).toMatchObject({ command: "node" });
  });

  it("writes Claude Code team MCP servers and tracks project approvals", async () => {
    const env = await makeTempEnv();
    const manager = new McpManager(env.ctx);

    await manager.addServer({
      targets: ["claude-code-project"],
      name: "weather",
      projectPath: env.project,
      config: { type: "http", url: "https://example.com/mcp" }
    });

    const projectConfig = await readJson<{ mcpServers: Record<string, unknown> }>(
      projectMcpPath(env.project)
    );
    expect(projectConfig.mcpServers.weather).toMatchObject({ type: "http" });

    const claudeState = await readJson<{ projects: Record<string, { enabledMcpjsonServers: string[] }> }>(
      claudeCodeConfigPath(env.ctx)
    );
    expect(claudeState.projects[path.resolve(env.project)].enabledMcpjsonServers).toContain("weather");

    const server = (await manager.listServers(env.project)).find((item) => item.name === "weather")!;
    await manager.patchServer(server.id, { enabled: false });
    const disabledState = await readJson<{ projects: Record<string, { disabledMcpjsonServers: string[] }> }>(
      claudeCodeConfigPath(env.ctx)
    );
    expect(disabledState.projects[path.resolve(env.project)].disabledMcpjsonServers).toContain("weather");
  });

  it("creates backups before mutations", async () => {
    const env = await makeTempEnv();
    const manager = new McpManager(env.ctx);

    await manager.addServer({
      targets: ["claude-code-user"],
      name: "github",
      config: { type: "http", url: "https://example.com/mcp" }
    });

    const backups = await manager.listBackups();
    expect(backups.length).toBeGreaterThan(0);
    expect(backups[0].sourcePath).toBe(claudeCodeConfigPath(env.ctx));
  });

  it("moves a server from Claude Code personal project state to Claude Code user config", async () => {
    const env = await makeTempEnv();
    await fs.writeFile(
      claudeCodeConfigPath(env.ctx),
      JSON.stringify(
        {
          projects: {
            [path.resolve(env.project)]: {
              mcpServers: {
                localtool: {
                  type: "stdio",
                  command: "node",
                  args: ["local.js"]
                }
              },
              enabledMcpjsonServers: [],
              disabledMcpjsonServers: []
            }
          }
        },
        null,
        2
      )
    );
    const manager = new McpManager(env.ctx);
    const localServer = (await manager.listServers(env.project)).find(
      (item) => item.target === "claude-code-local" && item.name === "localtool"
    )!;

    await manager.moveServer(localServer.id, {
      target: "claude-code-user"
    });

    const state = await readJson<{
      mcpServers: Record<string, unknown>;
      projects: Record<string, { mcpServers: Record<string, unknown> }>;
    }>(claudeCodeConfigPath(env.ctx));

    expect(state.mcpServers.localtool).toMatchObject({ command: "node" });
    expect(state.projects[path.resolve(env.project)].mcpServers.localtool).toBeUndefined();
  });

  it("copies a repository-level Codex MCP server into another repository", async () => {
    const env = await makeTempEnv();
    const destinationProject = path.join(path.dirname(env.project), "destination-project");
    const manager = new McpManager(env.ctx);

    await manager.addServer({
      targets: ["codex-project"],
      name: "weather",
      projectPath: env.project,
      config: { command: "npx", args: ["-y", "weather-mcp"] }
    });

    const source = (await manager.listServers(env.project)).find(
      (item) => item.target === "codex-project" && item.name === "weather"
    )!;
    await manager.copyServer(source.id, {
      target: "codex-project",
      projectPath: destinationProject
    });

    expect(await fs.readFile(codexProjectConfigPath(env.project), "utf8")).toContain("weather");
    expect(await fs.readFile(codexProjectConfigPath(destinationProject), "utf8")).toContain("weather");
  });

  it("copies multiple repository-level MCP servers into another repository", async () => {
    const env = await makeTempEnv();
    const destinationProject = path.join(path.dirname(env.project), "bulk-destination");
    const manager = new McpManager(env.ctx);

    await manager.addServer({
      targets: ["codex-project"],
      name: "weather",
      projectPath: env.project,
      config: { command: "npx", args: ["weather-mcp"] }
    });
    await manager.addServer({
      targets: ["codex-project"],
      name: "github",
      projectPath: env.project,
      config: { command: "npx", args: ["github-mcp"] }
    });

    const sources = (await manager.listServers(env.project)).filter(
      (item) => item.target === "codex-project"
    );
    await manager.copyServers({
      ids: sources.map((item) => item.id),
      target: "codex-project",
      projectPath: destinationProject
    });

    const destination = await fs.readFile(codexProjectConfigPath(destinationProject), "utf8");
    expect(destination).toContain("weather");
    expect(destination).toContain("github");
    expect(await fs.readFile(codexProjectConfigPath(env.project), "utf8")).toContain("weather");
  });

  it("moves multiple repository-level MCP servers into another repository", async () => {
    const env = await makeTempEnv();
    const destinationProject = path.join(path.dirname(env.project), "bulk-move-destination");
    const manager = new McpManager(env.ctx);

    for (const name of ["weather", "github"]) {
      await manager.addServer({
        targets: ["codex-project"],
        name,
        projectPath: env.project,
        config: { command: "npx", args: [`${name}-mcp`] }
      });
    }

    const sources = (await manager.listServers(env.project)).filter(
      (item) => item.target === "codex-project"
    );
    await manager.moveServers({
      ids: sources.map((item) => item.id),
      target: "codex-project",
      projectPath: destinationProject
    });

    const destination = await fs.readFile(codexProjectConfigPath(destinationProject), "utf8");
    const source = await fs.readFile(codexProjectConfigPath(env.project), "utf8");
    expect(destination).toContain("weather");
    expect(destination).toContain("github");
    expect(source).not.toContain("weather");
    expect(source).not.toContain("github");
  });

  it("writes project-level Codex MCP servers to <project>/.codex/config.toml", async () => {
    const env = await makeTempEnv();
    const manager = new McpManager(env.ctx);

    await manager.addServer({
      targets: ["codex-project"],
      name: "weather",
      projectPath: env.project,
      config: { command: "npx", args: ["-y", "weather-mcp"] }
    });

    const configPath = codexProjectConfigPath(env.project);
    expect(await fs.readFile(configPath, "utf8")).toContain("weather");
    await expect(fs.readFile(codexConfigPath(env.ctx), "utf8")).rejects.toThrow();

    const server = (await manager.listServers(env.project)).find(
      (item) => item.target === "codex-project" && item.name === "weather"
    )!;
    expect(server.enabled).toBe(true);
    expect(server.projectPath).toBe(path.resolve(env.project));

    await manager.patchServer(server.id, { enabled: false });
    expect(await fs.readFile(configPath, "utf8")).not.toContain("weather");

    const disabled = (await manager.listServers(env.project)).find(
      (item) => item.target === "codex-project" && item.name === "weather"
    )!;
    expect(disabled.disabled).toBe(true);

    await manager.patchServer(disabled.id, { enabled: true });
    expect(await fs.readFile(configPath, "utf8")).toContain("weather");

    const reenabled = (await manager.listServers(env.project)).find(
      (item) => item.target === "codex-project" && item.name === "weather"
    )!;
    await manager.deleteServer(reenabled.id);
    expect(await fs.readFile(configPath, "utf8")).not.toContain("weather");
  });

  it("migrates existing project-level Codex enabled=false entries into the disabled store", async () => {
    const env = await makeTempEnv();
    const configPath = codexProjectConfigPath(env.project);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      [
        "[mcp_servers.hidden]",
        'command = "npx"',
        'args = ["-y", "hidden-mcp"]',
        "enabled = false",
        ""
      ].join("\n")
    );
    const manager = new McpManager(env.ctx);

    const hidden = (await manager.listServers(env.project)).find(
      (item) => item.target === "codex-project" && item.name === "hidden"
    );

    expect(hidden?.disabled).toBe(true);
    expect(await fs.readFile(configPath, "utf8")).not.toContain("hidden");
  });
});
