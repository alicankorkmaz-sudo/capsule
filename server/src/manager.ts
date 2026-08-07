import type {
  DisabledEntry,
  RuntimeContext,
  ServerIdentity,
  ServerRecord,
  TargetKey
} from "./types";
import { McpServerConfigSchema, ServerNameSchema, TargetKeySchema } from "./types";
import { decodeIdentity, disabledStoreKey } from "./identity";
import path from "node:path";
import { labelForTarget, projectPathOrDefault, scopeForTarget } from "./paths";
import {
  addDisabledEntry,
  listBackups,
  readDisabledStore,
  removeDisabledEntryById,
  restoreBackup,
  restoreBackupGroup
} from "./storage";
import {
  getCodexConfig,
  listCodexServers,
  removeCodexServer,
  setCodexEnabled,
  upsertCodexServer
} from "./adapters/codex";
import {
  getClaudeDesktopConfig,
  listClaudeDesktopServers,
  removeClaudeDesktopServer,
  upsertClaudeDesktopServer
} from "./adapters/claudeDesktop";
import {
  getClaudeCodeConfig,
  listClaudeCodeServers,
  removeClaudeCodeServer,
  setClaudeProjectEnabled,
  upsertClaudeCodeServer
} from "./adapters/claudeCode";
import { determineTransport, makeRecord } from "./adapters/common";

export interface AddServerInput {
  targets: TargetKey[];
  name: string;
  config: unknown;
  projectPath?: string;
  allowElevated?: boolean;
}

export interface PatchServerInput {
  name?: string;
  config?: unknown;
  enabled?: boolean;
  projectPath?: string;
  allowElevated?: boolean;
}

export interface MoveServerInput {
  target: TargetKey;
  name?: string;
  projectPath?: string;
  allowElevated?: boolean;
}

export type CopyServerInput = MoveServerInput;

export interface CopyServersInput extends Omit<CopyServerInput, "name"> {
  ids: string[];
}

export type MoveServersInput = CopyServersInput;

export class McpManager {
  constructor(private readonly ctx: RuntimeContext) {}

  async listServers(projectPath?: string): Promise<ServerRecord[]> {
    await this.migrateNativeDisabledCodexServers("codex");
    await this.migrateNativeDisabledCodexServers("codex-project", projectPath);
    const active = [
      ...(await listCodexServers(this.ctx)),
      ...(await listCodexServers(this.ctx, "codex-project", projectPath)),
      ...(await listClaudeDesktopServers(this.ctx)),
      ...(await listClaudeCodeServers(this.ctx, projectPath))
    ];
    const store = await readDisabledStore(this.ctx);
    const disabled = Object.entries(store.entries).map(([id, entry]) => disabledEntryToRecord(id, entry));
    return [...active, ...disabled].sort((a, b) => {
      const byTarget = a.label.localeCompare(b.label);
      return byTarget || a.name.localeCompare(b.name);
    });
  }

  async getServer(id: string, raw = false): Promise<ServerRecord | undefined> {
    const identity = decodeIdentity(id);
    if (identity.disabled) {
      const store = await readDisabledStore(this.ctx);
      const entry = store.entries[id];
      return entry ? disabledEntryToRecord(id, entry, raw) : undefined;
    }

    const active = await this.listServers(identity.projectPath);
    const record = active.find((item) => item.id === id);
    if (!record) return undefined;
    if (!raw) return record;
    const config = await this.getRawConfig(identity);
    return config ? { ...record, config } : record;
  }

  async addServer(input: AddServerInput): Promise<ServerRecord[]> {
    const name = ServerNameSchema.parse(input.name);
    const config = McpServerConfigSchema.parse(input.config);
    const targets = input.targets.map((target) => TargetKeySchema.parse(target));

    for (const target of targets) {
      await this.upsert(target, name, config, {
        projectPath: input.projectPath,
        allowElevated: input.allowElevated
      });
    }
    return this.listServers(input.projectPath);
  }

  async patchServer(id: string, input: PatchServerInput): Promise<ServerRecord[]> {
    const identity = decodeIdentity(id);
    if (typeof input.enabled === "boolean") {
      if (input.enabled) {
        await this.enable(identity, id, input.allowElevated);
      } else {
        await this.disable(identity, id, input.allowElevated);
      }
    }

    if (input.config || input.name) {
      if (identity.disabled) {
        throw new Error("Enable a disabled server before editing it.");
      }
      const currentConfig = await this.getRawConfig(identity);
      if (!currentConfig) throw new Error(`MCP server not found: ${identity.name}`);
      const name = input.name ? ServerNameSchema.parse(input.name) : identity.name;
      const config = McpServerConfigSchema.parse(input.config ?? currentConfig);
      await this.upsert(identity.target, name, config, {
        previousName: identity.name,
        projectPath: identity.projectPath ?? input.projectPath,
        allowElevated: input.allowElevated
      });
    }

    return this.listServers(input.projectPath ?? identity.projectPath);
  }

  async deleteServer(id: string, allowElevated = false): Promise<ServerRecord[]> {
    const identity = decodeIdentity(id);
    if (identity.disabled) {
      await removeDisabledEntryById(this.ctx, id);
      return this.listServers(identity.projectPath);
    }

    await this.removeActive(identity, allowElevated);
    return this.listServers(identity.projectPath);
  }

  async moveServer(id: string, input: MoveServerInput): Promise<ServerRecord[]> {
    return this.transferServer(id, input, true);
  }

  async copyServer(id: string, input: CopyServerInput): Promise<ServerRecord[]> {
    return this.transferServer(id, input, false);
  }

  async copyServers(input: CopyServersInput): Promise<ServerRecord[]> {
    return this.transferServers(input, false);
  }

  async moveServers(input: MoveServersInput): Promise<ServerRecord[]> {
    return this.transferServers(input, true);
  }

  private async transferServers(
    input: CopyServersInput,
    removeSource: boolean
  ): Promise<ServerRecord[]> {
    for (const id of input.ids) {
      await this.transferServer(id, input, removeSource);
    }
    return this.listServers(input.projectPath);
  }

  private async transferServer(
    id: string,
    input: MoveServerInput,
    removeSource: boolean
  ): Promise<ServerRecord[]> {
    const sourceIdentity = decodeIdentity(id);
    const source = await this.getServer(id, true);
    if (!source) throw new Error(`MCP server not found: ${sourceIdentity.name}`);

    const target = TargetKeySchema.parse(input.target);
    const name = ServerNameSchema.parse(input.name ?? source.name);
    const projectPath = targetNeedsProject(target)
      ? projectPathOrDefault(this.ctx, input.projectPath ?? source.projectPath)
      : undefined;

    if (isSameDestination(source, target, name, projectPath)) {
      throw new Error(
        `Choose a different destination file or name for this ${removeSource ? "move" : "copy"}.`
      );
    }

    const config = McpServerConfigSchema.parse(source.config);
    await this.upsert(target, name, config, {
      projectPath,
      allowElevated: input.allowElevated
    });

    const destination = await this.findServer(target, name, projectPath);
    if (!destination) {
      throw new Error("Destination server was not found after writing it.");
    }
    if (!source.enabled) {
      await this.disable(
        {
          target: destination.target,
          name: destination.name,
          sourcePath: destination.sourcePath,
          scope: destination.scope,
          projectPath: destination.projectPath
        },
        destination.id,
        input.allowElevated
      );
    }

    if (removeSource) {
      if (sourceIdentity.disabled) {
        await removeDisabledEntryById(this.ctx, id);
      } else {
        await this.removeActive(sourceIdentity, input.allowElevated);
      }
    }

    return this.listServers(projectPath ?? source.projectPath);
  }

  async listBackups() {
    return listBackups(this.ctx);
  }

  async restoreBackup(backupId: string, allowElevated = false) {
    await restoreBackup(this.ctx, backupId, allowElevated);
  }

  async restoreBackupGroup(groupId: string, allowElevated = false) {
    await restoreBackupGroup(this.ctx, groupId, allowElevated);
  }

  validateConfig(config: unknown) {
    return McpServerConfigSchema.safeParse(config);
  }

  private async migrateNativeDisabledCodexServers(
    target: "codex" | "codex-project",
    projectPath?: string
  ): Promise<void> {
    const codexServers = await listCodexServers(this.ctx, target, projectPath);
    for (const server of codexServers.filter((record) => !record.enabled)) {
      const config = await getCodexConfig(this.ctx, server.name, target, projectPath);
      if (!config) continue;
      await removeCodexServer(this.ctx, server, false);
      await addDisabledEntry(this.ctx, {
        target,
        name: server.name,
        sourcePath: server.sourcePath,
        scope: server.scope,
        projectPath: server.projectPath,
        disabled: true,
        disabledAt: new Date().toISOString(),
        config,
        label: server.label
      });
    }
  }

  private async getRawConfig(identity: ServerIdentity): Promise<Record<string, unknown> | undefined> {
    switch (identity.target) {
      case "codex":
        return getCodexConfig(this.ctx, identity.name);
      case "codex-project":
        return getCodexConfig(this.ctx, identity.name, "codex-project", identity.projectPath);
      case "claude-desktop":
        return getClaudeDesktopConfig(this.ctx, identity.name);
      case "claude-code-user":
      case "claude-code-local":
      case "claude-code-project":
        return getClaudeCodeConfig(this.ctx, identity);
    }
  }

  private async upsert(
    target: TargetKey,
    name: string,
    config: unknown,
    options: { previousName?: string; projectPath?: string; allowElevated?: boolean }
  ): Promise<void> {
    switch (target) {
      case "codex":
        await upsertCodexServer(this.ctx, name, config, options);
        return;
      case "codex-project":
        await upsertCodexServer(this.ctx, name, config, { ...options, target: "codex-project" });
        return;
      case "claude-desktop":
        await upsertClaudeDesktopServer(this.ctx, name, config, options);
        return;
      case "claude-code-user":
      case "claude-code-local":
      case "claude-code-project":
        await upsertClaudeCodeServer(this.ctx, target, name, config, options);
        return;
    }
  }

  private async findServer(
    target: TargetKey,
    name: string,
    projectPath?: string
  ): Promise<ServerRecord | undefined> {
    const records = await this.listServers(projectPath);
    return records.find((record) => {
      if (record.target !== target || record.name !== name) return false;
      if (!targetNeedsProject(target)) return true;
      return normalizePath(record.projectPath) === normalizePath(projectPath);
    });
  }

  private async disable(identity: ServerIdentity, id: string, allowElevated = false): Promise<void> {
    if (identity.disabled) return;
    if (identity.target === "claude-code-project") {
      await setClaudeProjectEnabled(this.ctx, identity, false, allowElevated);
      return;
    }

    const active = (await this.listServers(identity.projectPath)).find((record) => record.id === id);
    const config = await this.removeActive(identity, allowElevated);
    const entry: DisabledEntry = {
      ...identity,
      disabled: true,
      disabledAt: new Date().toISOString(),
      config,
      label: active?.label ?? labelForTarget(identity.target)
    };
    await addDisabledEntry(this.ctx, entry);
  }

  private async enable(identity: ServerIdentity, id: string, allowElevated = false): Promise<void> {
    if (identity.disabled) {
      const store = await readDisabledStore(this.ctx);
      const entry = store.entries[id];
      if (!entry) throw new Error("Disabled server entry not found.");
      const config =
        entry.target === "codex" || entry.target === "codex-project"
          ? { ...entry.config, enabled: true }
          : entry.config;
      await this.upsert(entry.target, entry.name, config, {
        projectPath: entry.projectPath,
        allowElevated
      });
      await removeDisabledEntryById(this.ctx, id);
      return;
    }
    if (identity.target === "codex" || identity.target === "codex-project") {
      await setCodexEnabled(this.ctx, identity, true, allowElevated);
      return;
    }
    if (identity.target === "claude-code-project") {
      await setClaudeProjectEnabled(this.ctx, identity, true, allowElevated);
      return;
    }
  }

  private async removeActive(
    identity: ServerIdentity,
    allowElevated = false
  ): Promise<Record<string, unknown>> {
    switch (identity.target) {
      case "codex": {
        const config = await getCodexConfig(this.ctx, identity.name);
        await removeCodexServer(this.ctx, identity, allowElevated);
        return config ?? {};
      }
      case "codex-project": {
        const config = await getCodexConfig(this.ctx, identity.name, "codex-project", identity.projectPath);
        await removeCodexServer(this.ctx, identity, allowElevated);
        return config ?? {};
      }
      case "claude-desktop":
        return removeClaudeDesktopServer(this.ctx, identity, allowElevated);
      case "claude-code-user":
      case "claude-code-local":
      case "claude-code-project":
        return removeClaudeCodeServer(this.ctx, identity, allowElevated);
    }
  }
}

function targetNeedsProject(target: TargetKey): boolean {
  return target === "claude-code-local" || target === "claude-code-project" || target === "codex-project";
}

function isSameDestination(
  source: ServerRecord,
  target: TargetKey,
  name: string,
  projectPath?: string
): boolean {
  if (source.target !== target || source.name !== name) return false;
  if (!targetNeedsProject(target)) return true;
  return normalizePath(source.projectPath) === normalizePath(projectPath);
}

function normalizePath(value?: string): string {
  return value ? path.resolve(value).replace(/\/+$/, "") : "";
}

function disabledEntryToRecord(id: string, entry: DisabledEntry, raw = false): ServerRecord {
  const identity: ServerIdentity = {
    target: entry.target,
    name: entry.name,
    sourcePath: entry.sourcePath,
    scope: entry.scope || scopeForTarget(entry.target),
    projectPath: entry.projectPath,
    disabled: true
  };
  const record = makeRecord(
    entry.target,
    {
      name: entry.name,
      sourcePath: entry.sourcePath,
      scope: identity.scope,
      projectPath: entry.projectPath,
      disabled: true
    },
    entry.config,
    false,
    "app-store"
  );
  return {
    ...record,
    id: id || disabledStoreKey(identity),
    label: entry.label || labelForTarget(entry.target),
    transport: determineTransport(entry.config),
    config: raw ? entry.config : record.config,
    enabled: false,
    disabled: true
  };
}
