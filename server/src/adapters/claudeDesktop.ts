import type { RuntimeContext, ServerIdentity, ServerRecord } from "../types";
import { McpServerConfigSchema, ServerNameSchema } from "../types";
import { claudeDesktopConfigPath, scopeForTarget } from "../paths";
import { readJsonFile, writeJsonFileSafe } from "../storage";
import {
  assertUniqueName,
  makeRecord,
  normalizeForClaude,
  reservedClaudeName,
  toRecord
} from "./common";

type ClaudeDesktopDocument = Record<string, unknown> & {
  mcpServers?: Record<string, unknown>;
};

export async function listClaudeDesktopServers(ctx: RuntimeContext): Promise<ServerRecord[]> {
  const sourcePath = claudeDesktopConfigPath(ctx);
  const doc = await readClaudeDesktopDoc(sourcePath);
  const servers = toRecord(doc.mcpServers);
  return Object.entries(servers)
    .filter(([, value]) => typeof value === "object" && value !== null)
    .map(([name, config]) =>
      makeRecord(
        "claude-desktop",
        {
          name,
          sourcePath,
          scope: scopeForTarget("claude-desktop")
        },
        toRecord(config),
        true,
        "app-store"
      )
    );
}

export async function getClaudeDesktopConfig(
  ctx: RuntimeContext,
  name: string
): Promise<Record<string, unknown> | undefined> {
  const doc = await readClaudeDesktopDoc(claudeDesktopConfigPath(ctx));
  return toRecord(doc.mcpServers)[name] as Record<string, unknown> | undefined;
}

export async function upsertClaudeDesktopServer(
  ctx: RuntimeContext,
  name: string,
  config: unknown,
  options: { previousName?: string; allowElevated?: boolean } = {}
): Promise<void> {
  ServerNameSchema.parse(name);
  if (reservedClaudeName(name)) throw new Error(`"${name}" is reserved by Claude.`);
  const parsed = McpServerConfigSchema.parse(config);
  const sourcePath = claudeDesktopConfigPath(ctx);
  const doc = await readClaudeDesktopDoc(sourcePath);
  const servers = toRecord(doc.mcpServers);
  assertUniqueName(servers, name, options.previousName);
  if (options.previousName && options.previousName !== name) {
    delete servers[options.previousName];
  }
  servers[name] = normalizeForClaude(parsed);
  doc.mcpServers = servers;
  await writeJsonFileSafe(
    ctx,
    sourcePath,
    doc,
    `upsert Claude Desktop MCP server ${name}`,
    options.allowElevated
  );
}

export async function removeClaudeDesktopServer(
  ctx: RuntimeContext,
  identity: ServerIdentity,
  allowElevated = false
): Promise<Record<string, unknown>> {
  const sourcePath = claudeDesktopConfigPath(ctx);
  const doc = await readClaudeDesktopDoc(sourcePath);
  const servers = toRecord(doc.mcpServers);
  const config = toRecord(servers[identity.name]);
  if (!Object.keys(config).length) {
    throw new Error(`Claude Desktop MCP server not found: ${identity.name}`);
  }
  delete servers[identity.name];
  doc.mcpServers = servers;
  await writeJsonFileSafe(ctx, sourcePath, doc, `remove Claude Desktop MCP server ${identity.name}`, allowElevated);
  return config;
}

async function readClaudeDesktopDoc(sourcePath: string): Promise<ClaudeDesktopDocument> {
  return readJsonFile<ClaudeDesktopDocument>(sourcePath, {});
}
