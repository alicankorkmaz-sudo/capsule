import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileManager } from "../src/profileManager";
import { makeTempEnv, readJson } from "./helpers";

describe("ProfileManager", () => {
  it("seeds portable Vanilla and Personal profiles", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);

    const overview = await manager.getOverview();

    expect(overview.profiles.map((profile) => profile.name)).toEqual(["Vanilla", "Personal"]);
    expect(overview.profiles[0].system).toBe("vanilla");
  });

  it("deduplicates explicit and implicit default MCP transports", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const explicitStdio = await manager.createCapability({
      kind: "mcp",
      name: "playwright",
      config: { type: "stdio", command: "npx", args: ["@playwright/mcp@latest"] }
    });
    const implicitStdio = await manager.createCapability({
      kind: "mcp",
      name: "playwright",
      config: { command: "npx", args: ["@playwright/mcp@latest"] }
    });
    const implicitHttp = await manager.createCapability({
      kind: "mcp",
      name: "sentry",
      config: { url: "https://mcp.sentry.dev/mcp" }
    });
    const explicitHttp = await manager.createCapability({
      kind: "mcp",
      name: "sentry",
      config: { type: "http", url: "https://mcp.sentry.dev/mcp" }
    });

    expect(implicitStdio.id).toBe(explicitStdio.id);
    expect(explicitHttp.id).toBe(implicitHttp.id);
    expect((await manager.getOverview()).capabilities).toHaveLength(2);
  });

  it("compiles and applies one catalog profile to multiple projects", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const instruction = await manager.createCapability({
      kind: "instruction",
      name: "TypeScript rules",
      content: "Use strict TypeScript."
    });
    const hook = await manager.createCapability({
      kind: "hook",
      name: "Format after edit",
      event: "PostToolUse",
      matcher: "Edit|Write",
      handlers: [{ type: "command", command: "npm run format" }]
    });
    const mcp = await manager.createCapability({
      kind: "mcp",
      name: "weather",
      config: { type: "http", url: "https://example.com/mcp" }
    });
    const skill = await manager.createCapability({
      kind: "skill",
      name: "review-code",
      content: "---\nname: review-code\ndescription: Review code\n---\nReview carefully.\n"
    });
    const profile = await manager.createProfile({
      name: "Work",
      capabilityIds: [instruction.id, hook.id, mcp.id, skill.id]
    });
    const secondProject = path.join(env.root, "second-project");
    await fs.mkdir(secondProject);

    await manager.applyProfile(profile.id, env.project, { confirmOwnership: true });
    await manager.applyProfile(profile.id, secondProject, { confirmOwnership: true });

    expect(await fs.readFile(path.join(env.project, "CLAUDE.local.md"), "utf8")).toContain(
      "Use strict TypeScript"
    );
    const settings = await readJson<{ hooks: Record<string, unknown[]> }>(
      path.join(env.project, ".claude", "settings.local.json")
    );
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    const assignments = (await manager.getOverview()).assignments;
    expect(assignments).toHaveLength(2);
    expect(assignments.every((assignment) => assignment.profileId === profile.id)).toBe(true);

    const runtimeDirs = await fs.readdir(path.join(env.ctx.appDir, "runtime"));
    expect(runtimeDirs).toHaveLength(2);
    for (const runtime of runtimeDirs) {
      const config = await readJson<{ mcpServers: Record<string, unknown> }>(
        path.join(env.ctx.appDir, "runtime", runtime, "mcp.json")
      );
      expect(config.mcpServers.weather).toBeDefined();
      expect(
        await fs.readFile(
          path.join(env.ctx.appDir, "runtime", runtime, "profile-skills", "skills", "review-code", "SKILL.md"),
          "utf8"
        )
      ).toContain("Review carefully");
    }
  });

  it("requires confirmation before adopting existing local files and restores them on deactivate", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    await fs.mkdir(path.join(env.project, ".claude"));
    await fs.writeFile(path.join(env.project, ".claude", "settings.local.json"), '{"theme":"dark"}\n');
    await fs.writeFile(path.join(env.project, "CLAUDE.local.md"), "original instructions\n");

    const preview = await manager.previewApply("personal", env.project);
    expect(preview.needsOwnershipConfirmation).toBe(true);
    await expect(manager.applyProfile("personal", env.project)).rejects.toThrow("ownership confirmation");

    await manager.applyProfile("personal", env.project, { confirmOwnership: true });
    await manager.deactivate(env.project);

    expect(await fs.readFile(path.join(env.project, ".claude", "settings.local.json"), "utf8")).toBe(
      '{"theme":"dark"}\n'
    );
    expect(await fs.readFile(path.join(env.project, "CLAUDE.local.md"), "utf8")).toBe(
      "original instructions\n"
    );
  });

  it("detects external drift and blocks an overwrite without force", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    await manager.applyProfile("personal", env.project, { confirmOwnership: true });
    await fs.writeFile(path.join(env.project, "CLAUDE.local.md"), "external edit\n");

    expect((await manager.previewApply("personal", env.project)).drifted).toBe(true);
    await expect(manager.applyProfile("personal", env.project)).rejects.toThrow("Resolve drift");
    await manager.applyProfile("personal", env.project, { force: true });
    expect((await manager.previewApply("personal", env.project)).drifted).toBe(false);
  });

  it("produces an isolated dry-run launch contract", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);

    const normal = await manager.launch("personal", env.project, {
      confirmOwnership: true,
      dryRun: true
    });
    expect(normal.args).toContain("--setting-sources");
    expect(normal.args).toContain("--strict-mcp-config");
    expect(normal.command).toContain("launch.cjs");
    expect(normal.command).not.toContain("open");

    const runtimeDir = (await fs.readdir(path.join(env.ctx.appDir, "runtime")))[0];
    const runner = await fs.readFile(path.join(env.ctx.appDir, "runtime", runtimeDir, "launch.cjs"), "utf8");
    expect(runner).toMatch(/^#!\/usr\/bin\/env node/);

    const vanilla = await manager.launch("vanilla", env.project, { force: true, dryRun: true });
    expect(vanilla.args).toEqual(["--safe-mode"]);
  });

  it("passes a plugin's bundled MCP servers through --strict-mcp-config", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const installPath = path.join(env.root, "plugins", "factory");
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(
      path.join(installPath, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "factory-gitlab": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/servers/gitlab/server.mjs"] }
        }
      })
    );
    const plugin = await manager.createCapability({
      kind: "installed-plugin",
      name: "factory",
      pluginId: "factory@factory-marketplace",
      installPath
    });
    const profile = await manager.createProfile({ name: "Factory", capabilityIds: [plugin.id] });

    const compiled = await manager.compileProfile(profile.id, env.project);

    // Launching with --strict-mcp-config means anything absent here never reaches Claude Code.
    const server = compiled.mcpConfig.mcpServers["factory-gitlab"];
    expect(server).toBeDefined();
    expect(server.args).toEqual([path.join(installPath, "servers", "gitlab", "server.mjs")]);
    expect(compiled.pluginDirs).toContain(installPath);
  });

  it("follows an installed plugin to its new version after an update", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const pluginId = "factory@factory-marketplace";
    const cacheRoot = path.join(env.home, ".claude", "plugins", "cache", "factory-marketplace", "factory");
    // Claude leaves the superseded version directory in place after updating,
    // so the stale path stays readable and must not be what we launch.
    const oldPath = path.join(cacheRoot, "1.2.1");
    const newPath = path.join(cacheRoot, "1.3.0");
    for (const dir of [oldPath, newPath]) {
      await fs.mkdir(dir, { recursive: true });
    }

    const plugin = await manager.createCapability({
      kind: "installed-plugin",
      name: "factory",
      pluginId,
      installPath: oldPath,
      version: "1.2.1"
    });
    const profile = await manager.createProfile({ name: "Factory", capabilityIds: [plugin.id] });

    manager.discoverInstalledPlugins = async () => [
      { id: pluginId, version: "1.3.0", scope: "user", enabled: true, installPath: newPath }
    ];

    const compiled = await manager.compileProfile(profile.id, env.project);

    expect(compiled.pluginDirs).toContain(newPath);
    expect(compiled.pluginDirs).not.toContain(oldPath);
    expect(compiled.warnings.join(" ")).toContain("1.3.0");

    // The refreshed version is folded back into the catalog, so the UI stops
    // reporting the superseded one without a manual sync.
    const stored = (await manager.getOverview()).capabilities.find((item) => item.id === plugin.id);
    expect(stored?.version).toBe("1.3.0");
  });

  it("keeps a plugin pinned to a path outside the Claude-managed cache", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const pluginId = "factory@factory-marketplace";
    const pinnedPath = path.join(env.root, "vendor", "factory");
    const cachePath = path.join(env.home, ".claude", "plugins", "cache", "factory-marketplace", "factory", "1.3.0");
    for (const dir of [pinnedPath, cachePath]) {
      await fs.mkdir(dir, { recursive: true });
    }

    const plugin = await manager.createCapability({
      kind: "installed-plugin",
      name: "factory",
      pluginId,
      installPath: pinnedPath
    });
    const profile = await manager.createProfile({ name: "Factory", capabilityIds: [plugin.id] });

    manager.discoverInstalledPlugins = async () => [
      { id: pluginId, version: "1.3.0", scope: "user", enabled: true, installPath: cachePath }
    ];

    const compiled = await manager.compileProfile(profile.id, env.project);

    expect(compiled.pluginDirs).toContain(pinnedPath);
    expect(compiled.pluginDirs).not.toContain(cachePath);
  });

  it("keeps an existing MCP capability when a plugin bundles the same server name", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const installPath = path.join(env.root, "plugins", "dupe");
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(
      path.join(installPath, ".mcp.json"),
      JSON.stringify({ mcpServers: { weather: { command: "node", args: ["bundled.mjs"] } } })
    );
    const mcp = await manager.createCapability({
      kind: "mcp",
      name: "weather",
      config: { type: "http", url: "https://example.com/mcp" }
    });
    const plugin = await manager.createCapability({
      kind: "installed-plugin",
      name: "dupe",
      pluginId: "dupe@marketplace",
      installPath
    });
    const profile = await manager.createProfile({ name: "Dupe", capabilityIds: [mcp.id, plugin.id] });

    const compiled = await manager.compileProfile(profile.id, env.project);

    expect(compiled.mcpConfig.mcpServers.weather).toEqual({ type: "http", url: "https://example.com/mcp" });
    expect(compiled.warnings.join(" ")).toContain('bundles an MCP server named "weather"');
  });

  it("keeps custom plugin editing inside its managed workspace", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const plugin = await manager.createCapability({ kind: "custom-plugin", name: "my-tools" });

    expect(plugin.kind).toBe("custom-plugin");
    await manager.writePluginFile(plugin.id, "skills/review/SKILL.md", "Review this change.\n");
    expect(await manager.readPluginFile(plugin.id, "skills/review/SKILL.md")).toContain("Review");
    await expect(manager.writePluginFile(plugin.id, "../../outside.txt", "bad")).rejects.toThrow(
      "escapes its workspace"
    );
    await manager.removePluginFile(plugin.id, "skills/review/SKILL.md");
    expect(await manager.listPluginFiles(plugin.id)).not.toContain("skills/review/SKILL.md");
  });

  it("scans a projects folder into the catalog without creating or changing profiles", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const alpha = path.join(env.ctx.projectsDir, "alpha");
    const beta = path.join(env.ctx.projectsDir, "beta");
    await fs.mkdir(path.join(alpha, ".claude", "skills", "review"), { recursive: true });
    await fs.mkdir(path.join(beta, ".claude", "skills", "review"), { recursive: true });
    await fs.writeFile(
      path.join(alpha, ".claude", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\nReview carefully.\n"
    );
    await fs.writeFile(
      path.join(beta, ".claude", "skills", "review", "SKILL.md"),
      "---\r\nname: review\r\ndescription: Review code\r\n---\r\nReview carefully.\r\n"
    );
    await fs.writeFile(path.join(alpha, "CLAUDE.md"), "Alpha instructions.\n");
    await fs.writeFile(path.join(beta, "CLAUDE.md"), "Alpha instructions.\r\n");
    await fs.writeFile(
      path.join(beta, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "npm test" }] }] } })
    );
    await fs.writeFile(
      path.join(beta, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://example.com/mcp" } } })
    );
    await fs.mkdir(path.join(env.home, ".claude", "skills", "global-review"), { recursive: true });
    await fs.writeFile(
      path.join(env.home, ".claude", "skills", "global-review", "SKILL.md"),
      "---\nname: global-review\ndescription: Global review\n---\nReview globally.\n"
    );
    await fs.writeFile(path.join(env.home, ".claude", "CLAUDE.md"), "Global instructions.\n");
    await fs.writeFile(
      path.join(env.home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } })
    );
    await fs.writeFile(
      path.join(env.home, ".codex", "config.toml"),
      '[mcp_servers.global_docs]\nurl = "https://example.com/global-mcp"\n'
    );
    await fs.mkdir(path.join(env.home, ".codex", "skills", "codex-review"), { recursive: true });
    await fs.writeFile(
      path.join(env.home, ".codex", "skills", "codex-review", "SKILL.md"),
      "---\nname: codex-review\ndescription: Codex review\n---\nReview from Codex.\n"
    );
    await fs.writeFile(path.join(env.home, ".codex", "AGENTS.md"), "Global Codex instructions.\n");

    const beforeProfiles = (await manager.getOverview()).profiles.map(({ id, name, capabilityIds }) => ({ id, name, capabilityIds }));
    const projectOnly = await manager.scanFolder(env.ctx.projectsDir, false);
    expect(projectOnly.every((item) => item.sourcePath.startsWith(env.ctx.projectsDir))).toBe(true);
    const candidates = await manager.scanFolder(env.ctx.projectsDir);
    expect(candidates.map((item) => item.kind)).toEqual(expect.arrayContaining(["skill", "instruction", "hook", "mcp"]));
    expect(candidates.some((item) => item.sourcePath === path.join(env.home, ".claude", "CLAUDE.md"))).toBe(true);
    expect(candidates.some((item) => item.sourcePath === path.join(env.home, ".codex", "AGENTS.md"))).toBe(true);
    expect(candidates.some((item) => item.name === "codex-review")).toBe(true);
    expect(candidates.some((item) => item.name === "global_docs")).toBe(true);
    expect(candidates.some((item) => item.kind === "installed-plugin")).toBe(false);
    expect(candidates.filter((item) => item.kind === "skill" && item.name === "review")).toHaveLength(1);
    expect(
      candidates.filter(
        (item) => item.kind === "instruction" && item.name === "CLAUDE.md" && item.sourcePath.startsWith(env.ctx.projectsDir)
      )
    ).toHaveLength(1);

    const imported = await manager.commitCatalogImport(candidates.map((item) => item.id));
    const overview = await manager.getOverview();
    expect(imported.map((item) => item.kind)).toEqual(expect.arrayContaining(["skill", "instruction", "hook", "mcp"]));
    expect(overview.profiles.map(({ id, name, capabilityIds }) => ({ id, name, capabilityIds }))).toEqual(beforeProfiles);
    expect(overview.capabilities.every((item) => item.description?.startsWith("Imported from "))).toBe(true);
  });

  it("reuses an equivalent catalog capability during import", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const skillRoot = path.join(env.ctx.projectsDir, "alpha", ".claude", "skills", "review");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "Review carefully.\n");
    const existing = await manager.createCapability({
      kind: "skill",
      name: "review",
      content: "Review carefully.\r\n"
    });

    const candidates = await manager.scanFolder(env.ctx.projectsDir, false);
    const imported = await manager.commitCatalogImport(candidates.map((item) => item.id));
    const overview = await manager.getOverview();

    expect(imported).toHaveLength(1);
    expect(imported[0].id).toBe(existing.id);
    expect(overview.capabilities.filter((item) => item.name === "review")).toHaveLength(1);
  });

  it("merges legacy identical capabilities and preserves profile references", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const original = await manager.createCapability({
      kind: "skill",
      name: "review",
      content: "Review carefully.\n"
    });
    const profile = await manager.createProfile({ name: "Review", capabilityIds: [original.id] });
    const storePath = path.join(env.ctx.appDir, "profiles.json");
    const store = await readJson<any>(storePath);
    const duplicateId = "import-legacy-duplicate";
    store.capabilities[duplicateId] = {
      ...store.capabilities[original.id],
      id: duplicateId,
      description: "Imported from another project",
      createdAt: "2099-01-01T00:00:00.000Z"
    };
    store.profiles[profile.id].capabilityIds = [duplicateId, original.id];
    await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`);

    const overview = await manager.getOverview();
    expect(overview.capabilities.filter((item) => item.name === "review")).toHaveLength(1);
    expect(overview.profiles.find((item) => item.id === profile.id)?.capabilityIds).toEqual([original.id]);
  });

  it("launches unmanaged without touching the project or recording an assignment", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const settingsPath = path.join(env.project, ".claude", "settings.local.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, '{"mine":true}\n');

    const launch = await manager.launchUnmanaged(env.project, { dryRun: true, extraArgs: ["--resume"] });

    // The project's own settings survive verbatim, and no profile flags are injected.
    expect(await fs.readFile(settingsPath, "utf8")).toBe('{"mine":true}\n');
    expect(launch.args).toEqual(["--resume"]);
    expect(launch.args).not.toContain("--safe-mode");
    expect((await manager.getOverview(env.project)).selectedAssignment).toBeUndefined();
  });

  it("deactivates even when the original backups are gone", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    await manager.applyProfile("personal", env.project, { confirmOwnership: true });

    // Simulate pruned/hand-deleted backups.
    await fs.rm(path.join(env.ctx.appDir, "backups"), { recursive: true, force: true });

    await expect(manager.deactivate(env.project)).resolves.toBeUndefined();
    expect((await manager.getOverview(env.project)).selectedAssignment).toBeUndefined();
  });

  it("still restores surviving backups on deactivate", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const instructionsPath = path.join(env.project, "CLAUDE.local.md");
    await fs.writeFile(instructionsPath, "original instructions\n");

    await manager.applyProfile("personal", env.project, { confirmOwnership: true });
    expect(await fs.readFile(instructionsPath, "utf8")).not.toBe("original instructions\n");

    await manager.deactivate(env.project);
    expect(await fs.readFile(instructionsPath, "utf8")).toBe("original instructions\n");
  });

  it("keeps applying a profile when one is explicitly launched", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);

    const launch = await manager.launch("vanilla", env.project, { dryRun: true, confirmOwnership: true });

    expect(launch.args).toContain("--safe-mode");
    const overview = await manager.getOverview(env.project);
    expect(overview.selectedAssignment?.profileId).toBe("vanilla");
  });
});
