import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type {
  Capability,
  CapabilityKind,
  CompiledProfile,
  HookCapability,
  InstalledPlugin,
  Profile,
  ProfileStore,
  ProjectAssignment,
  RuntimeContext
} from "./types";
import { CapabilityKindSchema, HookHandlerSchema, McpServerConfigSchema } from "./types";
import { McpManager } from "./manager";
import {
  assignmentKey,
  capabilityFingerprint,
  createCustomPluginWorkspace,
  createId,
  customPluginsRoot,
  findAssignment,
  listCapabilities,
  listProfiles,
  listWorkspaceFiles,
  readProfileStore,
  readWorkspaceFile,
  removeWorkspaceFile,
  runtimeRoot,
  writeProfileStore,
  writeWorkspaceFile
} from "./profileStorage";
import {
  backupFile,
  ensureDir,
  pathExists,
  readJsonFile,
  readTextIfExists,
  restoreBackup,
  writeJsonFileSafe,
  writeTextFileSafe
} from "./storage";

const execFileAsync = promisify(execFile);
const PROFILE_KEYS = new Set([
  "hooks",
  "disableAllHooks",
  "enabledPlugins",
  "extraKnownMarketplaces",
  "plugins",
  "skillOverrides",
  "enableAllProjectMcpServers"
]);

export interface CapabilityInput {
  kind: CapabilityKind;
  name: string;
  description?: string;
  config?: unknown;
  pluginId?: string;
  installPath?: string;
  version?: string;
  scope?: string;
  rootPath?: string;
  content?: string;
  files?: Record<string, string>;
  event?: string;
  matcher?: string;
  handlers?: unknown[];
}

export interface ProfileInput {
  name: string;
  description?: string;
  capabilityIds?: string[];
}

export interface ApplyPreview {
  projectPath: string;
  profile: Profile;
  settingsPath: string;
  instructionsPath: string;
  needsOwnershipConfirmation: boolean;
  drifted: boolean;
  warnings: string[];
  outputs: { settings: string; instructions: string; mcp: string };
}

export interface ImportCandidate {
  id: string;
  kind: CapabilityKind;
  name: string;
  sourcePath: string;
  summary?: string;
}

interface ImportDescriptor {
  kind: CapabilityKind;
  name: string;
  sourcePath: string;
  meta: Record<string, unknown>;
}

export class ProfileManager {
  private readonly mcp: McpManager;
  private readonly importCandidates = new Map<string, ImportDescriptor>();

  constructor(private readonly ctx: RuntimeContext) {
    this.mcp = new McpManager(ctx);
  }

  async getOverview(projectPath?: string) {
    const store = await readProfileStore(this.ctx);
    const assignments = await this.assignmentStatuses(store);
    return {
      capabilities: listCapabilities(store).map(maskCapability),
      profiles: listProfiles(store),
      assignments,
      selectedAssignment: projectPath
        ? assignments.find((item) => item.projectPath === path.resolve(projectPath))
        : undefined
    };
  }

  async listCapabilities(): Promise<Capability[]> {
    return listCapabilities(await readProfileStore(this.ctx)).map(maskCapability);
  }

  async getCapability(id: string, raw = false): Promise<Capability | undefined> {
    const item = (await readProfileStore(this.ctx)).capabilities[id];
    return item ? (raw ? item : maskCapability(item)) : undefined;
  }

  async createCapability(input: CapabilityInput): Promise<Capability> {
    const store = await readProfileStore(this.ctx);
    const now = new Date().toISOString();
    const id = createId(input.kind);
    const hydratedInput =
      input.kind === "custom-plugin" && !input.rootPath
        ? {
            ...input,
            rootPath: await createCustomPluginWorkspace(this.ctx, id, input.name)
          }
        : input;
    const item = validateCapabilityInput(hydratedInput, {
      id,
      createdAt: now,
      updatedAt: now
    });
    const equivalent = Object.values(store.capabilities).find(
      (existing) => capabilityFingerprint(existing) === capabilityFingerprint(item)
    );
    if (equivalent) return maskCapability(equivalent);
    store.capabilities[item.id] = item;
    await writeProfileStore(this.ctx, store, `create ${item.kind} capability ${item.name}`);
    return maskCapability(item);
  }

  async updateCapability(id: string, input: Partial<CapabilityInput>): Promise<Capability> {
    const store = await readProfileStore(this.ctx);
    const current = store.capabilities[id];
    if (!current) throw new Error("Capability not found.");
    if (input.kind && input.kind !== current.kind) throw new Error("Capability kind cannot change.");
    const merged = capabilityToInput(current, input);
    const next = validateCapabilityInput(merged, {
      id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    });
    const equivalent = Object.values(store.capabilities).find(
      (existing) => existing.id !== id && capabilityFingerprint(existing) === capabilityFingerprint(next)
    );
    if (equivalent) {
      replaceCapabilityReferences(store, id, equivalent.id);
      delete store.capabilities[id];
      await writeProfileStore(this.ctx, store, `merge duplicate ${next.kind} capability ${next.name}`);
      return maskCapability(equivalent);
    }
    store.capabilities[id] = next;
    markProfilesPending(store, id);
    await writeProfileStore(this.ctx, store, `update ${next.kind} capability ${next.name}`);
    return maskCapability(next);
  }

  async deleteCapability(id: string): Promise<void> {
    const store = await readProfileStore(this.ctx);
    const item = store.capabilities[id];
    if (!item) throw new Error("Capability not found.");
    const usedBy = Object.values(store.profiles).filter((profile) => profile.capabilityIds.includes(id));
    if (usedBy.length) {
      throw new Error(`Capability is used by: ${usedBy.map((profile) => profile.name).join(", ")}`);
    }
    delete store.capabilities[id];
    await writeProfileStore(this.ctx, store, `delete ${item.kind} capability ${item.name}`);
  }

  async createProfile(input: ProfileInput): Promise<Profile> {
    const store = await readProfileStore(this.ctx);
    validateReferences(store, input.capabilityIds ?? []);
    const now = new Date().toISOString();
    const profile: Profile = {
      id: createId("profile"),
      name: requiredName(input.name),
      description: cleanOptional(input.description),
      capabilityIds: unique(input.capabilityIds ?? []),
      createdAt: now,
      updatedAt: now
    };
    assertUniqueProfileName(store, profile.name);
    store.profiles[profile.id] = profile;
    await writeProfileStore(this.ctx, store, `create profile ${profile.name}`);
    return profile;
  }

  async updateProfile(id: string, input: Partial<ProfileInput>): Promise<Profile> {
    const store = await readProfileStore(this.ctx);
    const current = store.profiles[id];
    if (!current) throw new Error("Profile not found.");
    if (current.system) throw new Error("The Vanilla system profile cannot be edited.");
    const capabilityIds = unique(input.capabilityIds ?? current.capabilityIds);
    validateReferences(store, capabilityIds);
    const next: Profile = {
      ...current,
      name: input.name === undefined ? current.name : requiredName(input.name),
      description:
        input.description === undefined ? current.description : cleanOptional(input.description),
      capabilityIds,
      updatedAt: new Date().toISOString()
    };
    assertUniqueProfileName(store, next.name, id);
    store.profiles[id] = next;
    for (const assignment of Object.values(store.assignments)) {
      if (assignment.profileId === id) assignment.state = "pending";
    }
    await writeProfileStore(this.ctx, store, `update profile ${next.name}`);
    return next;
  }

  async deleteProfile(id: string): Promise<void> {
    const store = await readProfileStore(this.ctx);
    const profile = store.profiles[id];
    if (!profile) throw new Error("Profile not found.");
    if (profile.system) throw new Error("The Vanilla system profile cannot be deleted.");
    const assigned = Object.values(store.assignments).filter((item) => item.profileId === id);
    if (assigned.length) throw new Error("Deactivate or switch projects using this profile first.");
    delete store.profiles[id];
    await writeProfileStore(this.ctx, store, `delete profile ${profile.name}`);
  }

  async discoverInstalledPlugins(): Promise<InstalledPlugin[]> {
    try {
      const { stdout } = await execFileAsync("claude", ["plugin", "list", "--json"], {
        maxBuffer: 10 * 1024 * 1024
      });
      const parsed = JSON.parse(stdout) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(isInstalledPlugin)
        .map((item) => ({
          id: item.id,
          version: item.version,
          scope: item.scope,
          enabled: item.enabled,
          installPath: item.installPath
        }));
    } catch (err) {
      throw new Error(`Could not read installed Claude plugins: ${errorMessage(err)}`);
    }
  }

  async syncInstalledPlugins(): Promise<Capability[]> {
    const plugins = await this.discoverInstalledPlugins();
    const store = await readProfileStore(this.ctx);
    const now = new Date().toISOString();
    for (const plugin of plugins) {
      const id = `installed-plugin-${hash(plugin.id).slice(0, 16)}`;
      const current = store.capabilities[id];
      store.capabilities[id] = {
        id,
        kind: "installed-plugin",
        name: plugin.id,
        description: `Installed Claude plugin (${plugin.scope ?? "unknown"} scope)`,
        pluginId: plugin.id,
        version: plugin.version,
        scope: plugin.scope,
        installPath: plugin.installPath,
        createdAt: current?.createdAt ?? now,
        updatedAt: now
      };
    }
    await writeProfileStore(this.ctx, store, "refresh installed Claude plugins");
    return listCapabilities(store).map(maskCapability);
  }

  async forkPlugin(capabilityId: string, name?: string): Promise<Capability> {
    const store = await readProfileStore(this.ctx);
    const source = store.capabilities[capabilityId];
    if (!source || source.kind !== "installed-plugin") {
      throw new Error("Only an installed plugin can be copied into a custom workspace.");
    }
    const now = new Date().toISOString();
    const id = createId("custom-plugin");
    const displayName = requiredName(name ?? `${source.name} custom`);
    const rootPath = await createCustomPluginWorkspace(this.ctx, id, displayName, source.installPath);
    const item: Capability = {
      id,
      kind: "custom-plugin",
      name: displayName,
      description: `Editable copy of ${source.pluginId}`,
      rootPath,
      createdAt: now,
      updatedAt: now
    };
    store.capabilities[id] = item;
    await writeProfileStore(this.ctx, store, `fork plugin ${source.pluginId}`);
    return item;
  }

  async listPluginFiles(capabilityId: string): Promise<string[]> {
    return listWorkspaceFiles(await this.customPluginRoot(capabilityId));
  }

  async readPluginFile(capabilityId: string, filePath: string): Promise<string> {
    return readWorkspaceFile(await this.customPluginRoot(capabilityId), filePath);
  }

  async writePluginFile(capabilityId: string, filePath: string, content: string): Promise<void> {
    const root = await this.customPluginRoot(capabilityId);
    await writeWorkspaceFile(this.ctx, root, filePath, content);
    const store = await readProfileStore(this.ctx);
    const item = store.capabilities[capabilityId];
    if (item) {
      item.updatedAt = new Date().toISOString();
      markProfilesPending(store, capabilityId);
      await writeProfileStore(this.ctx, store, `update custom plugin ${item.name}`);
    }
  }

  async removePluginFile(capabilityId: string, filePath: string): Promise<void> {
    const root = await this.customPluginRoot(capabilityId);
    await removeWorkspaceFile(this.ctx, root, filePath);
    const store = await readProfileStore(this.ctx);
    const item = store.capabilities[capabilityId];
    if (item) {
      item.updatedAt = new Date().toISOString();
      markProfilesPending(store, capabilityId);
      await writeProfileStore(this.ctx, store, `delete custom plugin file ${filePath}`);
    }
  }

  async validateCustomPlugin(capabilityId: string): Promise<{ ok: boolean; output: string }> {
    const root = await this.customPluginRoot(capabilityId);
    try {
      const { stdout, stderr } = await execFileAsync("claude", ["plugin", "validate", root], {
        maxBuffer: 2 * 1024 * 1024
      });
      return { ok: true, output: `${stdout}${stderr}`.trim() };
    } catch (err) {
      const output = commandOutput(err);
      return { ok: false, output: output || errorMessage(err) };
    }
  }

  async compileProfile(profileId: string, projectPath: string): Promise<CompiledProfile> {
    const store = await readProfileStore(this.ctx);
    const profile = store.profiles[profileId];
    if (!profile) throw new Error("Profile not found.");
    const settings: Record<string, unknown> = {};
    const hooks: Record<string, unknown[]> = {};
    const instructions: string[] = [];
    const mcpServers: Record<string, Record<string, unknown>> = {};
    const pluginDirs: string[] = [];
    const skills: Capability[] = [];
    const warnings: string[] = [];

    for (const capabilityId of profile.capabilityIds) {
      const item = store.capabilities[capabilityId];
      if (!item) throw new Error(`Profile references missing capability: ${capabilityId}`);
      switch (item.kind) {
        case "mcp":
          if (mcpServers[item.name]) throw new Error(`Duplicate MCP server name: ${item.name}`);
          mcpServers[item.name] = item.config;
          break;
        case "installed-plugin":
          if (!(await pathExists(item.installPath))) {
            throw new Error(`Installed plugin is missing: ${item.pluginId}`);
          }
          pluginDirs.push(item.installPath);
          break;
        case "custom-plugin":
          await this.assertCustomPluginPath(item.rootPath);
          pluginDirs.push(item.rootPath);
          break;
        case "skill":
          skills.push(item);
          break;
        case "hook": {
          const handlers = item.handlers.map((handler) => HookHandlerSchema.parse(handler));
          const group: Record<string, unknown> = { hooks: handlers };
          if (item.matcher) group.matcher = item.matcher;
          hooks[item.event] ??= [];
          const canonical = JSON.stringify(group);
          if (!hooks[item.event].some((existing) => JSON.stringify(existing) === canonical)) {
            hooks[item.event].push(group);
          }
          break;
        }
        case "instruction":
          instructions.push(`## ${item.name}\n\n${item.content.trim()}`);
          break;
      }
    }
    if (Object.keys(hooks).length) settings.hooks = hooks;

    const runtimeDir = this.projectRuntimeDir(projectPath);
    const syntheticPluginDir = skills.length ? path.join(runtimeDir, "profile-skills") : undefined;
    if (syntheticPluginDir) pluginDirs.push(syntheticPluginDir);
    if (profile.system === "vanilla" && profile.capabilityIds.length) {
      warnings.push("Vanilla ignores capability references and always launches in safe mode.");
    }
    return {
      profile,
      settings,
      instructions: instructions.length
        ? `# Profile: ${profile.name}\n\n${instructions.join("\n\n")}\n`
        : `# Profile: ${profile.name}\n`,
      mcpConfig: { mcpServers },
      pluginDirs: unique(pluginDirs),
      syntheticPluginDir,
      warnings
    };
  }

  async previewApply(profileId: string, projectPath: string): Promise<ApplyPreview> {
    const resolvedProject = path.resolve(projectPath);
    const compiled = await this.compileProfile(profileId, resolvedProject);
    const settingsPath = projectSettingsPath(resolvedProject);
    const instructionsPath = projectInstructionsPath(resolvedProject);
    const store = await readProfileStore(this.ctx);
    const assignment = findAssignment(store, resolvedProject);
    const drifted = assignment ? (await this.projectHash(resolvedProject)) !== assignment.appliedHash : false;
    return {
      projectPath: resolvedProject,
      profile: compiled.profile,
      settingsPath,
      instructionsPath,
      needsOwnershipConfirmation:
        !assignment && ((await pathExists(settingsPath)) || (await pathExists(instructionsPath))),
      drifted,
      warnings: compiled.warnings,
      outputs: {
        settings: `${JSON.stringify(compiled.settings, null, 2)}\n`,
        instructions: compiled.instructions,
        mcp: `${JSON.stringify(compiled.mcpConfig, null, 2)}\n`
      }
    };
  }

  async applyProfile(
    profileId: string,
    projectPath: string,
    options: { confirmOwnership?: boolean; force?: boolean } = {}
  ): Promise<ProjectAssignment> {
    const resolvedProject = path.resolve(projectPath);
    const preview = await this.previewApply(profileId, resolvedProject);
    if (preview.needsOwnershipConfirmation && !options.confirmOwnership) {
      throw new Error("Existing local Claude files require ownership confirmation before applying.");
    }
    if (preview.drifted && !options.force) {
      throw new Error("Managed Claude files changed outside Capsule. Resolve drift before applying.");
    }
    const store = await readProfileStore(this.ctx);
    const previous = findAssignment(store, resolvedProject);
    if (previous && previous.profileId !== profileId && (await this.hasActiveSession(resolvedProject))) {
      throw new Error("Close active Claude sessions for this project before switching profiles.");
    }
    const backupGroupId = `profile-apply-${Date.now()}-${hash(resolvedProject).slice(0, 8)}`;
    const originalBackupIds = previous?.originalBackupIds ?? [
      (await backupFile(this.ctx, preview.settingsPath, `adopt ${resolvedProject}`, backupGroupId)).id,
      (await backupFile(this.ctx, preview.instructionsPath, `adopt ${resolvedProject}`, backupGroupId)).id
    ];

    try {
      await writeJsonFileSafe(
        this.ctx,
        preview.settingsPath,
        JSON.parse(preview.outputs.settings),
        `apply profile ${preview.profile.name}`
      );
      await writeTextFileSafe(
        this.ctx,
        preview.instructionsPath,
        preview.outputs.instructions,
        `apply profile ${preview.profile.name}`
      );
      await this.writeRuntime(resolvedProject, await this.compileProfile(profileId, resolvedProject));
    } catch (err) {
      await Promise.all(originalBackupIds.map((id) => restoreBackup(this.ctx, id).catch(() => undefined)));
      throw err;
    }

    const assignment: ProjectAssignment = {
      projectPath: resolvedProject,
      profileId,
      appliedHash: await this.projectHash(resolvedProject),
      state: "applied",
      originalBackupIds,
      updatedAt: new Date().toISOString()
    };
    store.assignments[assignmentKey(resolvedProject)] = assignment;
    await writeProfileStore(this.ctx, store, `assign profile ${preview.profile.name} to ${resolvedProject}`);
    return assignment;
  }

  async deactivate(projectPath: string): Promise<void> {
    const resolvedProject = path.resolve(projectPath);
    const store = await readProfileStore(this.ctx);
    const key = assignmentKey(resolvedProject);
    const assignment = store.assignments[key];
    if (!assignment) return;
    if (await this.hasActiveSession(resolvedProject)) {
      throw new Error("Close active Claude sessions for this project before deactivating its profile.");
    }
    for (const backupId of assignment.originalBackupIds ?? []) {
      await restoreBackup(this.ctx, backupId);
    }
    delete store.assignments[key];
    await writeProfileStore(this.ctx, store, `deactivate profile for ${resolvedProject}`);
  }

  async launch(
    profileId: string,
    projectPath: string,
    options: {
      confirmOwnership?: boolean;
      force?: boolean;
      dryRun?: boolean;
      extraArgs?: string[];
    } = {}
  ): Promise<{ launched: boolean; command: string; args: string[]; warnings: string[] }> {
    const assignment = await this.applyProfile(profileId, projectPath, options);
    const store = await readProfileStore(this.ctx);
    const profile = store.profiles[profileId];
    const runtimeDir = this.projectRuntimeDir(assignment.projectPath);
    const compiled = await this.compileProfile(profileId, assignment.projectPath);
    const claudeArgs =
      profile.system === "vanilla"
        ? ["--safe-mode", ...(options.extraArgs ?? [])]
        : [
            "--setting-sources",
            "local",
            "--settings",
            path.join(runtimeDir, "base-settings.json"),
            "--strict-mcp-config",
            "--mcp-config",
            path.join(runtimeDir, "mcp.json"),
            ...compiled.pluginDirs.flatMap((pluginDir) => ["--plugin-dir", pluginDir]),
            ...(options.extraArgs ?? [])
          ];
    return this.spawnLaunch(assignment.projectPath, runtimeDir, claudeArgs, compiled.warnings, options.dryRun);
  }

  /**
   * Launch Claude Code without applying or recording anything. Used when no
   * profile override was given and the project has no assignment: the project
   * keeps its own configuration and Capsule stays out of the way.
   */
  async launchUnmanaged(
    projectPath: string,
    options: { dryRun?: boolean; extraArgs?: string[] } = {}
  ): Promise<{ launched: boolean; command: string; args: string[]; warnings: string[] }> {
    const resolvedProject = path.resolve(projectPath);
    const claudeArgs = [...(options.extraArgs ?? [])];
    const runtimeDir = this.projectRuntimeDir(resolvedProject);
    return this.spawnLaunch(resolvedProject, runtimeDir, claudeArgs, [], options.dryRun);
  }

  private async spawnLaunch(
    projectPath: string,
    runtimeDir: string,
    claudeArgs: string[],
    warnings: string[],
    dryRun?: boolean
  ): Promise<{ launched: boolean; command: string; args: string[]; warnings: string[] }> {
    const runnerPath = await this.writeLaunchRunner(runtimeDir, projectPath, claudeArgs);
    const runnerCommand = `${shellQuote(process.execPath)} ${shellQuote(runnerPath)}`;
    const command = `cd ${shellQuote(projectPath)} && exec ${runnerCommand}`;
    if (dryRun) return { launched: false, command, args: claudeArgs, warnings };
    if (process.platform !== "darwin" || !(await this.ghosttyExists())) {
      return {
        launched: false,
        command,
        args: claudeArgs,
        warnings: [...warnings, "Ghostty was not found; run the displayed command manually."]
      };
    }
    const script = [
      'tell application "Ghostty"',
      `set profileConfig to new surface configuration from {initial working directory:${appleScriptQuote(projectPath)}, command:${appleScriptQuote(`shell:exec ${runnerCommand}`)}, wait after command:true}`,
      "new window with configuration profileConfig",
      "activate",
      "end tell"
    ].join("\n");
    try {
      await execFileAsync("/usr/bin/osascript", ["-e", script]);
      return { launched: true, command, args: claudeArgs, warnings };
    } catch (err) {
      return {
        launched: false,
        command,
        args: claudeArgs,
        warnings: [
          ...warnings,
          `Ghostty could not be opened: ${errorMessage(err)}. Run the displayed command manually.`
        ]
      };
    }
  }

  async scanImport(projectPath?: string): Promise<ImportCandidate[]> {
    this.importCandidates.clear();
    return this.scanSources(projectPath ? [path.resolve(projectPath)] : [], true, true);
  }

  async scanFolder(folderPath: string, includeGlobal = true): Promise<ImportCandidate[]> {
    const root = path.resolve(requiredValue(folderPath, "Scan folder"));
    let stat;
    try {
      stat = await fs.stat(root);
    } catch {
      throw new Error(`Scan folder does not exist: ${root}`);
    }
    if (!stat.isDirectory()) throw new Error(`Scan path is not a directory: ${root}`);

    const children = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(root, entry.name));
    this.importCandidates.clear();
    return this.scanSources([root, ...children], includeGlobal, false);
  }

  private async scanSources(
    projectPaths: string[],
    includeGlobal: boolean,
    includeInstalledPlugins: boolean
  ): Promise<ImportCandidate[]> {
    const candidates: ImportCandidate[] = [];
    let installedPlugins: InstalledPlugin[] = [];
    if (includeInstalledPlugins) {
      installedPlugins = await this.discoverInstalledPlugins().catch(() => []);
      for (const plugin of installedPlugins) {
        candidates.push(this.importCandidate("installed-plugin", plugin.id, plugin.installPath, { pluginId: plugin.id }));
      }
    }

    const serverLists = [];
    if (projectPaths.length) {
      for (const projectPath of projectPaths) serverLists.push(await this.mcp.listServers(projectPath));
    } else {
      serverLists.push(await this.mcp.listServers());
    }
    const allowedProjects = new Set(projectPaths.map((projectPath) => path.resolve(projectPath)));
    for (const server of serverLists.flat()) {
      if (!server.enabled) continue;
      if (!includeGlobal && !server.projectPath) continue;
      if (server.projectPath && allowedProjects.size && !allowedProjects.has(path.resolve(server.projectPath))) continue;
      candidates.push(this.importCandidate("mcp", server.name, server.sourcePath, { serverId: server.id }));
    }

    const settingsPaths = [
      ...(includeGlobal ? [path.join(this.ctx.homeDir, ".claude", "settings.json")] : []),
      ...projectPaths.flatMap((projectPath) => [
        path.join(projectPath, ".claude", "settings.json"),
        path.join(projectPath, ".claude", "settings.local.json")
      ])
    ];
    for (const settingsPath of unique(settingsPaths)) {
      const doc = await readJsonFile<Record<string, unknown>>(settingsPath, {});
      for (const [event, groups] of Object.entries(asRecord(doc.hooks))) {
        if (!Array.isArray(groups)) continue;
        groups.forEach((_group, index) => {
          candidates.push(this.importCandidate("hook", `${event} hook ${index + 1}`, settingsPath, { event, index }));
        });
      }
    }
    const skillRoots = [
      ...(includeGlobal
        ? [
            path.join(this.ctx.homeDir, ".claude", "skills"),
            path.join(this.ctx.homeDir, ".codex", "skills"),
            path.join(this.ctx.homeDir, ".agents", "skills")
          ]
        : []),
      ...projectPaths.flatMap((projectPath) => [
        path.join(projectPath, ".claude", "skills"),
        path.join(projectPath, ".codex", "skills"),
        path.join(projectPath, ".agents", "skills")
      ])
    ];
    for (const root of unique(skillRoots)) {
      if (!(await pathExists(root))) continue;
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        const skillPath = path.join(root, entry.name, "SKILL.md");
        if (entry.isDirectory() && (await pathExists(skillPath))) {
          candidates.push(this.importCandidate("skill", entry.name, skillPath, { skillPath }));
        }
      }
    }
    const instructionPaths = [
      ...(includeGlobal
        ? [
            path.join(this.ctx.homeDir, ".claude", "CLAUDE.md"),
            path.join(this.ctx.homeDir, ".codex", "AGENTS.md")
          ]
        : []),
      ...projectPaths.flatMap((projectPath) => [
        path.join(projectPath, "CLAUDE.md"),
        path.join(projectPath, "AGENTS.md"),
        path.join(projectPath, ".claude", "CLAUDE.md"),
        path.join(projectPath, "CLAUDE.local.md")
      ])
    ];
    for (const instructionPath of unique(instructionPaths)) {
      if (await pathExists(instructionPath)) {
        candidates.push(
          this.importCandidate("instruction", path.basename(instructionPath), instructionPath, { instructionPath })
        );
      }
    }
    const uniqueCandidates: ImportCandidate[] = [];
    const seenFingerprints = new Set<string>();
    for (const candidate of candidates) {
      const descriptor = this.importCandidates.get(candidate.id);
      if (!descriptor) continue;
      const preview = await this.materializeImportCapability(
        descriptor,
        installedPlugins,
        candidate.id,
        "1970-01-01T00:00:00.000Z"
      );
      if (!preview) continue;
      const fingerprint = capabilityFingerprint(preview);
      if (seenFingerprints.has(fingerprint)) continue;
      seenFingerprints.add(fingerprint);
      uniqueCandidates.push(candidate);
    }
    return uniqueCandidates;
  }

  async commitCatalogImport(candidateIds: string[]): Promise<Capability[]> {
    const store = await readProfileStore(this.ctx);
    const capabilityIds = await this.importCapabilities(store, candidateIds);
    await writeProfileStore(this.ctx, store, `import ${capabilityIds.length} capabilities into catalog`);
    return capabilityIds.map((id) => maskCapability(store.capabilities[id]));
  }

  async commitImport(candidateIds: string[], profileName = "Work"): Promise<Profile> {
    const store = await readProfileStore(this.ctx);
    const capabilityIds = await this.importCapabilities(store, candidateIds);
    const existing = Object.values(store.profiles).find(
      (profile) => profile.name.toLowerCase() === profileName.toLowerCase()
    );
    const now = new Date().toISOString();
    const profile: Profile = existing && !existing.system
      ? { ...existing, capabilityIds: unique([...existing.capabilityIds, ...capabilityIds]), updatedAt: now }
      : {
          id: createId("profile"),
          name: requiredName(profileName),
          description: "Imported from the current Claude Code configuration.",
          capabilityIds: unique(capabilityIds),
          createdAt: now,
          updatedAt: now
        };
    store.profiles[profile.id] = profile;
    await writeProfileStore(this.ctx, store, `import Claude configuration into ${profile.name}`);
    return profile;
  }

  private async importCapabilities(store: ProfileStore, candidateIds: string[]): Promise<string[]> {
    const installed = await this.discoverInstalledPlugins().catch(() => []);
    const capabilityIds: string[] = [];
    for (const encoded of candidateIds) {
      const descriptor = this.importCandidates.get(encoded);
      if (!descriptor) throw new Error("Import candidate expired or was not produced by the latest scan.");
      const id = `import-${hash(JSON.stringify(descriptor)).slice(0, 20)}`;
      let item: Capability | undefined = store.capabilities[id];
      if (!item) {
        const now = new Date().toISOString();
        const candidate = await this.materializeImportCapability(descriptor, installed, id, now);
        if (!candidate) continue;
        item = Object.values(store.capabilities).find(
          (existing) => capabilityFingerprint(existing) === capabilityFingerprint(candidate)
        );
        if (!item) {
          item = candidate;
          store.capabilities[id] = item;
        }
      }
      capabilityIds.push(item.id);
    }
    return unique(capabilityIds);
  }

  private async materializeImportCapability(
    descriptor: ImportDescriptor,
    installed: InstalledPlugin[],
    id: string,
    now: string
  ): Promise<Capability | undefined> {
    const base = {
      id,
      description: `Imported from ${descriptor.sourcePath}`,
      createdAt: now,
      updatedAt: now
    };
    if (descriptor.kind === "installed-plugin") {
      const plugin = installed.find((entry) => entry.id === descriptor.meta.pluginId);
      if (!plugin) throw new Error(`Installed plugin is missing: ${descriptor.name}`);
      return {
        ...base,
        kind: "installed-plugin",
        name: plugin.id,
        pluginId: plugin.id,
        version: plugin.version,
        scope: plugin.scope,
        installPath: plugin.installPath
      };
    }
    if (descriptor.kind === "mcp") {
      const server = await this.mcp.getServer(String(descriptor.meta.serverId), true);
      if (!server) throw new Error(`MCP server is missing: ${descriptor.name}`);
      return {
        ...base,
        kind: "mcp",
        name: server.name,
        config: McpServerConfigSchema.parse(server.config)
      };
    }
    if (descriptor.kind === "skill") {
      return {
        ...base,
        kind: "skill",
        name: descriptor.name,
        content: await fs.readFile(String(descriptor.meta.skillPath), "utf8")
      };
    }
    if (descriptor.kind === "instruction") {
      return {
        ...base,
        kind: "instruction",
        name: `${descriptor.name} (${path.basename(path.dirname(descriptor.sourcePath))})`,
        content: await fs.readFile(String(descriptor.meta.instructionPath), "utf8")
      };
    }
    if (descriptor.kind === "hook") {
      const doc = await readJsonFile<Record<string, unknown>>(descriptor.sourcePath, {});
      const groups = asRecord(doc.hooks)[String(descriptor.meta.event)];
      const group = Array.isArray(groups) ? asRecord(groups[Number(descriptor.meta.index)]) : {};
      return {
        ...base,
        kind: "hook",
        name: descriptor.name,
        event: String(descriptor.meta.event),
        matcher: typeof group.matcher === "string" ? group.matcher : undefined,
        handlers: Array.isArray(group.hooks)
          ? group.hooks.filter(isRecord).map((handler) => ({ ...handler }))
          : []
      };
    }
    return undefined;
  }

  private importCandidate(
    kind: CapabilityKind,
    name: string,
    sourcePath: string,
    meta: Record<string, unknown>
  ): ImportCandidate {
    const descriptor = { kind, name, sourcePath, meta };
    const id = `import-candidate-${hash(JSON.stringify(descriptor)).slice(0, 20)}`;
    this.importCandidates.set(id, descriptor);
    return { id, kind, name, sourcePath };
  }

  private async writeRuntime(projectPath: string, compiled: CompiledProfile): Promise<void> {
    const runtimeDir = this.projectRuntimeDir(projectPath);
    await ensureDir(runtimeDir);
    await writePrivateJson(path.join(runtimeDir, "mcp.json"), compiled.mcpConfig);
    await writePrivateJson(path.join(runtimeDir, "base-settings.json"), await this.sanitizedUserSettings());
    if (compiled.syntheticPluginDir) {
      await fs.rm(compiled.syntheticPluginDir, { recursive: true, force: true });
      await ensureDir(path.join(compiled.syntheticPluginDir, ".claude-plugin"));
      await writePrivateJson(path.join(compiled.syntheticPluginDir, ".claude-plugin", "plugin.json"), {
        name: "profile-skills",
        version: "1.0.0",
        description: `Generated skills for ${compiled.profile.name}`
      });
      const store = await readProfileStore(this.ctx);
      for (const id of compiled.profile.capabilityIds) {
        const item = store.capabilities[id];
        if (!item || item.kind !== "skill") continue;
        const skillRoot = path.join(compiled.syntheticPluginDir, "skills", safeName(item.name));
        await ensureDir(skillRoot);
        await fs.writeFile(path.join(skillRoot, "SKILL.md"), item.content, { mode: 0o600 });
        for (const [relativePath, content] of Object.entries(item.files ?? {})) {
          const target = safeChild(skillRoot, relativePath);
          await ensureDir(path.dirname(target));
          await fs.writeFile(target, content, { mode: 0o600 });
        }
      }
    }
  }

  private async sanitizedUserSettings(): Promise<Record<string, unknown>> {
    const source = await readJsonFile<Record<string, unknown>>(
      path.join(this.ctx.homeDir, ".claude", "settings.json"),
      {}
    );
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (!PROFILE_KEYS.has(key)) result[key] = value;
    }
    if (isRecord(result.env)) {
      const env = { ...result.env };
      delete env.ENABLE_CLAUDEAI_MCP_SERVERS;
      result.env = env;
    }
    return result;
  }

  private async assignmentStatuses(store: ProfileStore): Promise<ProjectAssignment[]> {
    const result: ProjectAssignment[] = [];
    for (const assignment of Object.values(store.assignments)) {
      const currentHash = await this.projectHash(assignment.projectPath);
      result.push({
        ...assignment,
        state:
          assignment.state === "pending"
            ? "pending"
            : currentHash === assignment.appliedHash
              ? "applied"
              : "drifted"
      });
    }
    return result.sort((left, right) => left.projectPath.localeCompare(right.projectPath));
  }

  private async projectHash(projectPath: string): Promise<string> {
    const settings = await readTextIfExists(projectSettingsPath(projectPath));
    const instructions = await readTextIfExists(projectInstructionsPath(projectPath));
    return hash(JSON.stringify([settings ?? null, instructions ?? null]));
  }

  private projectRuntimeDir(projectPath: string): string {
    return path.join(runtimeRoot(this.ctx), hash(path.resolve(projectPath)).slice(0, 24));
  }

  private async customPluginRoot(capabilityId: string): Promise<string> {
    const item = (await readProfileStore(this.ctx)).capabilities[capabilityId];
    if (!item || item.kind !== "custom-plugin") throw new Error("Custom plugin not found.");
    await this.assertCustomPluginPath(item.rootPath);
    return item.rootPath;
  }

  private async assertCustomPluginPath(rootPath: string): Promise<void> {
    const root = path.resolve(customPluginsRoot(this.ctx));
    const resolved = path.resolve(rootPath);
    if (!resolved.startsWith(`${root}${path.sep}`) || !(await pathExists(resolved))) {
      throw new Error("Custom plugin path is outside the managed catalog or no longer exists.");
    }
  }

  private async ghosttyExists(): Promise<boolean> {
    return (
      (await pathExists("/Applications/Ghostty.app")) ||
      (await pathExists(path.join(this.ctx.homeDir, "Applications", "Ghostty.app")))
    );
  }

  private async hasActiveSession(projectPath: string): Promise<boolean> {
    const sessionsDir = path.join(this.projectRuntimeDir(projectPath), "sessions");
    if (!(await pathExists(sessionsDir))) return false;
    const names = await fs.readdir(sessionsDir);
    for (const name of names.filter((value) => value.endsWith(".pid"))) {
      const sessionPath = path.join(sessionsDir, name);
      const text = await readTextIfExists(sessionPath);
      const pid = Number(text?.trim());
      if (!Number.isInteger(pid) || pid <= 1) {
        await fs.rm(sessionPath, { force: true });
        continue;
      }
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        await fs.rm(sessionPath, { force: true });
      }
    }
    return false;
  }

  private async writeLaunchRunner(
    runtimeDir: string,
    projectPath: string,
    claudeArgs: string[]
  ): Promise<string> {
    const runnerPath = path.join(runtimeDir, "launch.cjs");
    const sessionsDir = path.join(runtimeDir, "sessions");
    await ensureDir(sessionsDir);
    const sessionPath = path.join(sessionsDir, `${createId("session")}.pid`);
    const payload = JSON.stringify({ projectPath, claudeArgs, sessionPath });
    const source = [
      "#!/usr/bin/env node",
      '"use strict";',
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `const payload = ${payload};`,
      'fs.writeFileSync(payload.sessionPath, String(process.pid), { mode: 0o600 });',
      'const child = spawn("claude", payload.claudeArgs, { cwd: payload.projectPath, stdio: "inherit", env: process.env });',
      'const cleanup = () => { try { fs.rmSync(payload.sessionPath, { force: true }); } catch {} };',
      'child.on("exit", (code, signal) => { cleanup(); if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });',
      'child.on("error", (error) => { cleanup(); console.error(error.message); process.exit(1); });',
      '["SIGINT", "SIGTERM", "SIGHUP"].forEach((signal) => process.on(signal, () => child.kill(signal)));',
      ""
    ].join("\n");
    await fs.writeFile(runnerPath, source, { mode: 0o700 });
    return runnerPath;
  }
}

function validateCapabilityInput(
  input: CapabilityInput,
  meta: { id: string; createdAt: string; updatedAt: string }
): Capability {
  const kind = CapabilityKindSchema.parse(input.kind);
  const base = {
    ...meta,
    kind,
    name: requiredName(input.name),
    description: cleanOptional(input.description)
  };
  switch (kind) {
    case "mcp":
      return { ...base, kind, config: McpServerConfigSchema.parse(input.config) };
    case "installed-plugin":
      return {
        ...base,
        kind,
        pluginId: requiredName(input.pluginId ?? input.name),
        installPath: requiredValue(input.installPath ?? "", "Plugin install path"),
        version: cleanOptional(input.version),
        scope: cleanOptional(input.scope)
      };
    case "custom-plugin":
      return { ...base, kind, rootPath: requiredValue(input.rootPath ?? "", "Custom plugin path") };
    case "skill":
      return { ...base, kind, content: input.content ?? "", files: input.files ?? {} };
    case "hook":
      return {
        ...base,
        kind,
        event: requiredName(input.event ?? ""),
        matcher: cleanOptional(input.matcher),
        handlers: (input.handlers ?? []).map((handler) => HookHandlerSchema.parse(handler))
      };
    case "instruction":
      return { ...base, kind, content: input.content ?? "" };
  }
}

function capabilityToInput(current: Capability, patch: Partial<CapabilityInput>): CapabilityInput {
  return { ...current, ...patch, kind: current.kind, name: patch.name ?? current.name } as CapabilityInput;
}

function markProfilesPending(store: ProfileStore, capabilityId: string): void {
  const profileIds = new Set(
    Object.values(store.profiles)
      .filter((profile) => profile.capabilityIds.includes(capabilityId))
      .map((profile) => profile.id)
  );
  for (const assignment of Object.values(store.assignments)) {
    if (profileIds.has(assignment.profileId)) assignment.state = "pending";
  }
}

function replaceCapabilityReferences(store: ProfileStore, fromId: string, toId: string): void {
  for (const profile of Object.values(store.profiles)) {
    if (!profile.capabilityIds.includes(fromId)) continue;
    profile.capabilityIds = unique(
      profile.capabilityIds.map((capabilityId) => capabilityId === fromId ? toId : capabilityId)
    );
    for (const assignment of Object.values(store.assignments)) {
      if (assignment.profileId === profile.id) assignment.state = "pending";
    }
  }
}

function validateReferences(store: ProfileStore, ids: string[]): void {
  const missing = ids.filter((id) => !store.capabilities[id]);
  if (missing.length) throw new Error(`Unknown capability references: ${missing.join(", ")}`);
}

function assertUniqueProfileName(store: ProfileStore, name: string, exceptId?: string): void {
  const duplicate = Object.values(store.profiles).find(
    (profile) => profile.id !== exceptId && profile.name.toLowerCase() === name.toLowerCase()
  );
  if (duplicate) throw new Error(`A profile named "${name}" already exists.`);
}

function maskCapability(item: Capability): Capability {
  if (item.kind !== "mcp") return item;
  return { ...item, config: asRecord(maskSecrets(item.config)) };
}

function maskSecrets(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => {
      const secret = /token|secret|password|api[_-]?key|authorization/i.test(childKey || key);
      return [childKey, secret && typeof childValue === "string" ? "••••••••" : maskSecrets(childValue, childKey)];
    })
  );
}

function isInstalledPlugin(value: unknown): value is InstalledPlugin {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.installPath === "string" &&
    typeof value.enabled === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function requiredName(value: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 120) throw new Error("Name must contain 1 to 120 characters.");
  return clean;
}

function requiredValue(value: string, label: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 4096) throw new Error(`${label} is required.`);
  return clean;
}

function cleanOptional(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean || undefined;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectSettingsPath(projectPath: string): string {
  return path.join(projectPath, ".claude", "settings.local.json");
}

function projectInstructionsPath(projectPath: string): string {
  return path.join(projectPath, "CLAUDE.local.md");
}

function safeName(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  if (!clean) throw new Error(`Invalid skill name: ${value}`);
  return clean;
}

function safeChild(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error("Invalid skill asset path.");
  const target = path.resolve(root, relativePath);
  const resolvedRoot = path.resolve(root);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Skill asset escapes its directory.");
  return target;
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const temp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function commandOutput(err: unknown): string {
  if (!isRecord(err)) return "";
  return [err.stdout, err.stderr].filter((value) => typeof value === "string").join("\n").trim();
}
