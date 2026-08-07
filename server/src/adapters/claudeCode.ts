import path from "node:path";
import type { RuntimeContext, ServerIdentity, ServerRecord } from "../types";
import { McpServerConfigSchema, ServerNameSchema } from "../types";
import {
  claudeCodeConfigPath,
  projectMcpPath,
  projectPathOrDefault,
  scopeForTarget
} from "../paths";
import { readJsonFile, writeJsonFileSafe } from "../storage";
import {
  assertUniqueName,
  makeRecord,
  normalizeForClaude,
  reservedClaudeName,
  toRecord
} from "./common";

type ClaudeCodeDocument = Record<string, unknown> & {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, ClaudeCodeProjectState>;
};

type ClaudeCodeProjectState = Record<string, unknown> & {
  mcpServers?: Record<string, unknown>;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
};

type ProjectMcpDocument = Record<string, unknown> & {
  mcpServers?: Record<string, unknown>;
};

export async function listClaudeCodeServers(
  ctx: RuntimeContext,
  selectedProjectPath?: string
): Promise<ServerRecord[]> {
  const sourcePath = claudeCodeConfigPath(ctx);
  const doc = await readClaudeCodeDoc(sourcePath);
  const records: ServerRecord[] = [];
  const userServers = toRecord(doc.mcpServers);

  for (const [name, config] of Object.entries(userServers)) {
    if (typeof config !== "object" || config === null) continue;
    records.push(
      makeRecord(
        "claude-code-user",
        { name, sourcePath, scope: scopeForTarget("claude-code-user") },
        toRecord(config),
        true,
        "app-store"
      )
    );
  }

  for (const [projectPath, state] of Object.entries(toRecord(doc.projects))) {
    const projectState = state as ClaudeCodeProjectState;
    for (const [name, config] of Object.entries(toRecord(projectState.mcpServers))) {
      if (typeof config !== "object" || config === null) continue;
      records.push(
        makeRecord(
          "claude-code-local",
          {
            name,
            sourcePath,
            scope: scopeForTarget("claude-code-local"),
            projectPath
          },
          toRecord(config),
          true,
          "app-store"
        )
      );
    }
  }

  records.push(...(await listClaudeProjectServers(ctx, selectedProjectPath)));
  return records;
}

export async function listClaudeProjectServers(
  ctx: RuntimeContext,
  selectedProjectPath?: string
): Promise<ServerRecord[]> {
  const projectPath = projectPathOrDefault(ctx, selectedProjectPath);
  const sourcePath = projectMcpPath(projectPath);
  const projectDoc = await readProjectMcpDoc(sourcePath);
  const codeDoc = await readClaudeCodeDoc(claudeCodeConfigPath(ctx));
  const state = getProjectState(codeDoc, projectPath);
  const disabled = new Set(state.disabledMcpjsonServers ?? []);
  const records: ServerRecord[] = [];
  for (const [name, config] of Object.entries(toRecord(projectDoc.mcpServers))) {
    if (typeof config !== "object" || config === null) continue;
    records.push(
      makeRecord(
        "claude-code-project",
        {
          name,
          sourcePath,
          scope: scopeForTarget("claude-code-project"),
          projectPath
        },
        toRecord(config),
        !disabled.has(name),
        "claude-project-settings"
      )
    );
  }
  return records;
}

export async function getClaudeCodeConfig(
  ctx: RuntimeContext,
  identity: ServerIdentity
): Promise<Record<string, unknown> | undefined> {
  if (identity.target === "claude-code-project") {
    const doc = await readProjectMcpDoc(identity.sourcePath);
    return toRecord(doc.mcpServers)[identity.name] as Record<string, unknown> | undefined;
  }

  const doc = await readClaudeCodeDoc(claudeCodeConfigPath(ctx));
  if (identity.target === "claude-code-user") {
    return toRecord(doc.mcpServers)[identity.name] as Record<string, unknown> | undefined;
  }
  const projectPath = identity.projectPath;
  if (!projectPath) throw new Error("Claude Code personal MCP entries need a project path.");
  const state = getProjectState(doc, projectPath);
  return toRecord(state.mcpServers)[identity.name] as Record<string, unknown> | undefined;
}

export async function upsertClaudeCodeServer(
  ctx: RuntimeContext,
  target: "claude-code-user" | "claude-code-local" | "claude-code-project",
  name: string,
  config: unknown,
  options: { previousName?: string; projectPath?: string; allowElevated?: boolean } = {}
): Promise<void> {
  ServerNameSchema.parse(name);
  if (reservedClaudeName(name)) throw new Error(`"${name}" is reserved by Claude.`);
  const parsed = McpServerConfigSchema.parse(config);
  const normalized = normalizeForClaude(parsed);

  if (target === "claude-code-project") {
    await upsertProjectServer(ctx, name, normalized, options);
    return;
  }

  const sourcePath = claudeCodeConfigPath(ctx);
  const doc = await readClaudeCodeDoc(sourcePath);
  const servers =
    target === "claude-code-user"
      ? toRecord(doc.mcpServers)
      : toRecord(getProjectState(doc, projectPathOrDefault(ctx, options.projectPath)).mcpServers);

  assertUniqueName(servers, name, options.previousName);
  if (options.previousName && options.previousName !== name) {
    delete servers[options.previousName];
  }
  servers[name] = normalized;

  if (target === "claude-code-user") {
    doc.mcpServers = servers;
  } else {
    const projectState = getProjectState(doc, projectPathOrDefault(ctx, options.projectPath));
    projectState.mcpServers = servers;
  }

  await writeJsonFileSafe(ctx, sourcePath, doc, `upsert ${target} MCP server ${name}`, options.allowElevated);
}

export async function removeClaudeCodeServer(
  ctx: RuntimeContext,
  identity: ServerIdentity,
  allowElevated = false
): Promise<Record<string, unknown>> {
  if (identity.target === "claude-code-project") {
    return removeProjectServer(ctx, identity, allowElevated);
  }

  const sourcePath = claudeCodeConfigPath(ctx);
  const doc = await readClaudeCodeDoc(sourcePath);
  const servers =
    identity.target === "claude-code-user"
      ? toRecord(doc.mcpServers)
      : toRecord(getProjectState(doc, requiredProject(identity)).mcpServers);
  const config = toRecord(servers[identity.name]);
  if (!Object.keys(config).length) throw new Error(`Claude Code MCP server not found: ${identity.name}`);
  delete servers[identity.name];

  if (identity.target === "claude-code-user") {
    doc.mcpServers = servers;
  } else {
    getProjectState(doc, requiredProject(identity)).mcpServers = servers;
  }
  await writeJsonFileSafe(ctx, sourcePath, doc, `remove ${identity.target} MCP server ${identity.name}`, allowElevated);
  return config;
}

export async function setClaudeProjectEnabled(
  ctx: RuntimeContext,
  identity: ServerIdentity,
  enabled: boolean,
  allowElevated = false
): Promise<void> {
  const sourcePath = claudeCodeConfigPath(ctx);
  const doc = await readClaudeCodeDoc(sourcePath);
  const state = getProjectState(doc, requiredProject(identity));
  const disabled = new Set(state.disabledMcpjsonServers ?? []);
  const enabledSet = new Set(state.enabledMcpjsonServers ?? []);
  if (enabled) {
    disabled.delete(identity.name);
    enabledSet.add(identity.name);
  } else {
    disabled.add(identity.name);
    enabledSet.delete(identity.name);
  }
  state.disabledMcpjsonServers = [...disabled].sort();
  state.enabledMcpjsonServers = [...enabledSet].sort();
  await writeJsonFileSafe(
    ctx,
    sourcePath,
    doc,
    `${enabled ? "enable" : "disable"} Claude Code team MCP server ${identity.name}`,
    allowElevated
  );
}

async function upsertProjectServer(
  ctx: RuntimeContext,
  name: string,
  config: Record<string, unknown>,
  options: { previousName?: string; projectPath?: string; allowElevated?: boolean }
): Promise<void> {
  const projectPath = projectPathOrDefault(ctx, options.projectPath);
  const sourcePath = projectMcpPath(projectPath);
  const projectDoc = await readProjectMcpDoc(sourcePath);
  const servers = toRecord(projectDoc.mcpServers);
  assertUniqueName(servers, name, options.previousName);
  if (options.previousName && options.previousName !== name) {
    delete servers[options.previousName];
  }
  servers[name] = config;
  projectDoc.mcpServers = servers;
  await writeJsonFileSafe(ctx, sourcePath, projectDoc, `upsert Claude Code team MCP server ${name}`, options.allowElevated);

  const codePath = claudeCodeConfigPath(ctx);
  const codeDoc = await readClaudeCodeDoc(codePath);
  const state = getProjectState(codeDoc, projectPath);
  const enabled = new Set(state.enabledMcpjsonServers ?? []);
  const disabled = new Set(state.disabledMcpjsonServers ?? []);
  if (options.previousName && options.previousName !== name) {
    enabled.delete(options.previousName);
    disabled.delete(options.previousName);
  }
  enabled.add(name);
  disabled.delete(name);
  state.enabledMcpjsonServers = [...enabled].sort();
  state.disabledMcpjsonServers = [...disabled].sort();
  await writeJsonFileSafe(ctx, codePath, codeDoc, `approve Claude Code team MCP server ${name}`, options.allowElevated);
}

async function removeProjectServer(
  ctx: RuntimeContext,
  identity: ServerIdentity,
  allowElevated: boolean
): Promise<Record<string, unknown>> {
  const projectPath = requiredProject(identity);
  const sourcePath = projectMcpPath(projectPath);
  const projectDoc = await readProjectMcpDoc(sourcePath);
  const servers = toRecord(projectDoc.mcpServers);
  const config = toRecord(servers[identity.name]);
  if (!Object.keys(config).length) {
    throw new Error(`Claude Code team MCP server not found: ${identity.name}`);
  }
  delete servers[identity.name];
  projectDoc.mcpServers = servers;
  await writeJsonFileSafe(ctx, sourcePath, projectDoc, `remove Claude Code team MCP server ${identity.name}`, allowElevated);

  const codePath = claudeCodeConfigPath(ctx);
  const codeDoc = await readClaudeCodeDoc(codePath);
  const state = getProjectState(codeDoc, projectPath);
  state.enabledMcpjsonServers = (state.enabledMcpjsonServers ?? []).filter((name) => name !== identity.name);
  state.disabledMcpjsonServers = (state.disabledMcpjsonServers ?? []).filter((name) => name !== identity.name);
  await writeJsonFileSafe(ctx, codePath, codeDoc, `forget Claude Code team MCP server ${identity.name}`, allowElevated);
  return config;
}

async function readClaudeCodeDoc(sourcePath: string): Promise<ClaudeCodeDocument> {
  return readJsonFile<ClaudeCodeDocument>(sourcePath, {});
}

async function readProjectMcpDoc(sourcePath: string): Promise<ProjectMcpDocument> {
  return readJsonFile<ProjectMcpDocument>(sourcePath, {});
}

function getProjectState(doc: ClaudeCodeDocument, projectPath: string): ClaudeCodeProjectState {
  const resolved = path.resolve(projectPath);
  doc.projects = toRecord(doc.projects) as Record<string, ClaudeCodeProjectState>;
  doc.projects[resolved] = toRecord(doc.projects[resolved]) as ClaudeCodeProjectState;
  return doc.projects[resolved];
}

function requiredProject(identity: ServerIdentity): string {
  if (!identity.projectPath) {
    throw new Error("This Claude Code MCP entry needs a project path.");
  }
  return path.resolve(identity.projectPath);
}
