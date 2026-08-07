import * as TOML from "@iarna/toml";
import type { RuntimeContext, ServerIdentity, ServerRecord } from "../types";
import { McpServerConfigSchema, ServerNameSchema } from "../types";
import { codexConfigPath, codexProjectConfigPath, projectPathOrDefault, scopeForTarget } from "../paths";
import { readTextIfExists, writeTextFileSafe } from "../storage";
import { assertUniqueName, makeRecord, normalizeForCodex, toRecord } from "./common";

type TomlDocument = Record<string, unknown> & {
  mcp_servers?: Record<string, unknown>;
};

function resolveCodexSourcePath(
  ctx: RuntimeContext,
  target: "codex" | "codex-project",
  projectPath?: string
): string {
  return target === "codex-project"
    ? codexProjectConfigPath(projectPathOrDefault(ctx, projectPath))
    : codexConfigPath(ctx);
}

export async function listCodexServers(
  ctx: RuntimeContext,
  target: "codex" | "codex-project" = "codex",
  projectPath?: string
): Promise<ServerRecord[]> {
  const sourcePath = resolveCodexSourcePath(ctx, target, projectPath);
  const doc = await readCodexDoc(sourcePath);
  const servers = toRecord(doc.mcp_servers);
  return Object.entries(servers)
    .filter(([, value]) => typeof value === "object" && value !== null)
    .map(([name, config]) => {
      const recordConfig = toRecord(config);
      return makeRecord(
        target,
        {
          name,
          sourcePath,
          scope: scopeForTarget(target),
          projectPath: target === "codex-project" ? projectPathOrDefault(ctx, projectPath) : undefined
        },
        recordConfig,
        recordConfig.enabled !== false,
        "app-store"
      );
    });
}

export async function getCodexConfig(
  ctx: RuntimeContext,
  name: string,
  target: "codex" | "codex-project" = "codex",
  projectPath?: string
): Promise<Record<string, unknown> | undefined> {
  const doc = await readCodexDoc(resolveCodexSourcePath(ctx, target, projectPath));
  return toRecord(doc.mcp_servers)[name] as Record<string, unknown> | undefined;
}

export async function upsertCodexServer(
  ctx: RuntimeContext,
  name: string,
  config: unknown,
  options: {
    previousName?: string;
    allowElevated?: boolean;
    target?: "codex" | "codex-project";
    projectPath?: string;
  } = {}
): Promise<void> {
  ServerNameSchema.parse(name);
  const parsed = McpServerConfigSchema.parse(config);
  const target = options.target ?? "codex";
  const sourcePath = resolveCodexSourcePath(ctx, target, options.projectPath);
  const doc = await readCodexDoc(sourcePath);
  const servers = toRecord(doc.mcp_servers);
  assertUniqueName(servers, name, options.previousName);
  if (options.previousName && options.previousName !== name) {
    delete servers[options.previousName];
  }
  servers[name] = normalizeForCodex(parsed);
  doc.mcp_servers = servers;
  await writeCodexDoc(ctx, sourcePath, doc, `upsert Codex MCP server ${name}`, options.allowElevated);
}

export async function setCodexEnabled(
  ctx: RuntimeContext,
  identity: ServerIdentity,
  enabled: boolean,
  allowElevated = false
): Promise<void> {
  const sourcePath = resolveCodexSourcePath(ctx, identity.target as "codex" | "codex-project", identity.projectPath);
  const doc = await readCodexDoc(sourcePath);
  const servers = toRecord(doc.mcp_servers);
  const config = toRecord(servers[identity.name]);
  if (!Object.keys(config).length) throw new Error(`Codex MCP server not found: ${identity.name}`);
  config.enabled = enabled;
  servers[identity.name] = config;
  doc.mcp_servers = servers;
  await writeCodexDoc(ctx, sourcePath, doc, `${enabled ? "enable" : "disable"} Codex ${identity.name}`, allowElevated);
}

export async function removeCodexServer(
  ctx: RuntimeContext,
  identity: ServerIdentity,
  allowElevated = false
): Promise<void> {
  const sourcePath = resolveCodexSourcePath(ctx, identity.target as "codex" | "codex-project", identity.projectPath);
  const doc = await readCodexDoc(sourcePath);
  const servers = toRecord(doc.mcp_servers);
  delete servers[identity.name];
  doc.mcp_servers = servers;
  await writeCodexDoc(ctx, sourcePath, doc, `remove Codex MCP server ${identity.name}`, allowElevated);
}

async function readCodexDoc(sourcePath: string): Promise<TomlDocument> {
  const text = await readTextIfExists(sourcePath);
  if (!text || !text.trim()) return {};
  return TOML.parse(text) as TomlDocument;
}

async function writeCodexDoc(
  ctx: RuntimeContext,
  sourcePath: string,
  doc: TomlDocument,
  reason: string,
  allowElevated = false
): Promise<void> {
  await writeTextFileSafe(ctx, sourcePath, TOML.stringify(doc), reason, allowElevated);
}
