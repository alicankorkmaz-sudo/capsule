import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import type { Capability, CapabilityKind } from "../types";
import { CapabilityKindSchema } from "../types";
import type { CapabilityInput, CapabilitySyncResult } from "../profileManager";
import { readCapabilitySource, readSkillDirectory, skippedWarnings } from "../capabilitySource";
import type { CliDeps } from "./context";
import type { CliIO } from "./output";
import { CliExit, confirmOrAbort, printResult, readConfigInput, table } from "./output";
import { capabilityKindLabel } from "./launchFlow";
import { resolveCapabilityId } from "./resolve";

interface CapabilityFlags {
  description?: string;
  config?: string;
  configFile?: string;
  content?: string;
  contentFile?: string;
  fromDir?: string;
  /** A path from --source, false from --no-source, undefined when neither was given. */
  source?: string | false;
  rootPath?: string;
  event?: string;
  matcher?: string;
  command?: string;
  timeout?: string;
}

export function registerCatalogCommands(program: Command, getDeps: () => CliDeps): void {
  const catalog = program.command("catalog").description("Manage the capability catalog");

  catalog
    .command("list")
    .description("List capabilities")
    .option("-k, --kind <kind>", `filter by kind: ${CapabilityKindSchema.options.join(", ")}`)
    .action(async (options: { kind?: string }) => {
      const deps = getDeps();
      const kind = options.kind ? CapabilityKindSchema.parse(options.kind) : undefined;
      const capabilities = (await deps.profiles.listCapabilities()).filter(
        (capability) => !kind || capability.kind === kind
      );
      printResult(capabilities, deps.opts.json, deps.io, () =>
        table(
          ["ID", "KIND", "NAME", "DESCRIPTION"],
          capabilities.map((capability) => [
            capability.id,
            capabilityKindLabel(capability),
            capability.name,
            capability.description ?? ""
          ])
        )
      );
    });

  catalog
    .command("get <capability>")
    .description("Show one capability (id or name)")
    .option("--show-secrets", "print unredacted config values")
    .action(async (ref: string, options: { showSecrets?: boolean }) => {
      const deps = getDeps();
      const id = await resolveCapabilityId(deps.profiles, ref);
      const capability = await deps.profiles.getCapability(id, Boolean(options.showSecrets));
      if (!capability) throw new Error(`Capability not found: ${ref}`);
      printResult(capability, deps.opts.json, deps.io, () => describeCapability(capability));
    });

  catalog
    .command("create <name>")
    .description("Create a capability")
    .requiredOption("-k, --kind <kind>", `kind: ${CapabilityKindSchema.options.join(", ")}`)
    .option("-d, --description <text>", "description")
    .option("--config <json>", "MCP config as JSON (kind: mcp)")
    .option("--config-file <path>", "MCP config file (kind: mcp, - for stdin)")
    .option("--content <text>", "content (kind: skill or instruction)")
    .option("--content-file <path>", "content file, linked as the source (kind: skill or instruction)")
    .option("--from-dir <dir>", "skill directory: SKILL.md plus its other files, linked as the source (kind: skill)")
    .option("--source <path>", "link a source for `caps catalog sync`; read from it when no content is given")
    .option("--no-source", "do not link --content-file/--from-dir as the source")
    .option("--root-path <path>", "plugin root directory (kind: custom-plugin)")
    .option("--event <event>", "hook event (kind: hook)")
    .option("--matcher <matcher>", "hook matcher (kind: hook)")
    .option("--command <command>", "shell command the hook runs (kind: hook)")
    .option("--timeout <seconds>", "hook command timeout in seconds (kind: hook)")
    .action(async (name: string, options: CapabilityFlags & { kind: string }) => {
      const deps = getDeps();
      const kind = CapabilityKindSchema.parse(options.kind);
      const input = await buildCapabilityInput(kind, name, options, deps.io);
      const capability = await deps.profiles.createCapability(input);
      printResult(capability, deps.opts.json, deps.io, () =>
        `Created ${capabilityKindLabel(capability)} "${capability.name}" (${capability.id}).\n`
      );
    });

  catalog
    .command("edit <capability>")
    .description("Edit a capability (id or name)")
    .option("--name <name>", "rename")
    .option("-d, --description <text>", "description")
    .option("--config <json>", "MCP config as JSON")
    .option("--config-file <path>", "MCP config file (- for stdin)")
    .option("--content <text>", "content")
    .option("--content-file <path>", "content file, linked as the source")
    .option("--from-dir <dir>", "replace a skill's SKILL.md and files from a directory, linked as the source")
    .option("--source <path>", "link a source for `caps catalog sync` (content is not re-read)")
    .option("--no-source", "remove the source link")
    .option("--event <event>", "hook event")
    .option("--matcher <matcher>", "hook matcher")
    .option("--command <command>", "replace the hook's handlers with this shell command")
    .option("--timeout <seconds>", "hook command timeout in seconds (with --command)")
    .action(async (ref: string, options: CapabilityFlags & { name?: string }) => {
      const deps = getDeps();
      const id = await resolveCapabilityId(deps.profiles, ref);
      const input: Partial<CapabilityInput> = {
        name: options.name,
        description: options.description,
        event: options.event,
        matcher: options.matcher
      };
      if (options.config || options.configFile) {
        input.config = await readConfigInput(options);
      }
      const hasContentFlags =
        options.content !== undefined || Boolean(options.contentFile) || Boolean(options.fromDir);
      if (hasContentFlags || options.source !== undefined) {
        const current = await deps.profiles.getCapability(id);
        if (!current) throw new Error(`Capability not found: ${ref}`);
        assertContentKind(current.kind, options);
        if (hasContentFlags) Object.assign(input, await readContentFlags(options, deps.io));
        if (options.source !== undefined) input.sourcePath = explicitSource(options.source);
      }
      if (options.command !== undefined) {
        input.handlers = [commandHandler(options)];
      } else if (options.timeout !== undefined) {
        throw new Error("--timeout needs --command.");
      }
      const capability = await deps.profiles.updateCapability(id, input);
      printResult(capability, deps.opts.json, deps.io, () => `Updated capability "${capability.name}".\n`);
    });

  catalog
    .command("sync [capability...]")
    .description("Re-read linked sources and refresh skill/instruction snapshots (default: every linked capability)")
    .option("--dry-run", "report what would change without saving")
    .action(async (refs: string[], options: { dryRun?: boolean }) => {
      const deps = getDeps();
      const ids: string[] = [];
      for (const ref of refs) ids.push(await resolveCapabilityId(deps.profiles, ref));
      const results = await deps.profiles.syncCapabilities(ids, { dryRun: options.dryRun });
      for (const result of results) {
        for (const warning of result.warnings) deps.io.err(`Warning: ${warning}\n`);
      }
      printResult(results, deps.opts.json, deps.io, () => syncSummary(results, Boolean(options.dryRun)));
      // Partial failures are reported but do not fail the run; only a sync in
      // which nothing could be read at all exits non-zero.
      const failed = results.filter((result) => !["updated", "unchanged"].includes(result.status));
      if (results.length && failed.length === results.length) throw new CliExit(1);
    });

  catalog
    .command("rm <capability>")
    .description("Delete a capability (id or name)")
    .action(async (ref: string) => {
      const deps = getDeps();
      const id = await resolveCapabilityId(deps.profiles, ref);
      await confirmOrAbort(`Delete capability ${ref}?`, deps.opts.yes);
      await deps.profiles.deleteCapability(id);
      printResult({ deleted: id }, deps.opts.json, deps.io, () => `Deleted capability ${ref}.\n`);
    });

  registerPluginCommands(program, getDeps);
}

function registerPluginCommands(program: Command, getDeps: () => CliDeps): void {
  const plugins = program.command("plugins").description("Manage Claude Code plugins in the catalog");

  plugins
    .command("sync")
    .description("Sync installed Claude Code plugins into the catalog")
    .action(async () => {
      const deps = getDeps();
      const capabilities = await deps.profiles.syncInstalledPlugins();
      printResult(capabilities, deps.opts.json, deps.io, () =>
        table(
          ["ID", "NAME", "DESCRIPTION"],
          capabilities.map((capability) => [capability.id, capability.name, capability.description ?? ""])
        )
      );
    });

  plugins
    .command("fork <capability>")
    .description("Fork an installed plugin into an editable custom plugin")
    .option("--name <name>", "name for the fork")
    .action(async (ref: string, options: { name?: string }) => {
      const deps = getDeps();
      const id = await resolveCapabilityId(deps.profiles, ref);
      const capability = await deps.profiles.forkPlugin(id, options.name);
      printResult(capability, deps.opts.json, deps.io, () =>
        `Forked into custom plugin "${capability.name}" (${capability.id}).\n`
      );
    });

  plugins
    .command("files <capability>")
    .description("List a plugin's files")
    .action(async (ref: string) => {
      const deps = getDeps();
      const id = await resolveCapabilityId(deps.profiles, ref);
      const files = await deps.profiles.listPluginFiles(id);
      printResult(files, deps.opts.json, deps.io, () => (files.length ? `${files.join("\n")}\n` : "(none)\n"));
    });

  plugins
    .command("cat <capability> <path>")
    .description("Print a plugin file")
    .action(async (ref: string, filePath: string) => {
      const deps = getDeps();
      const id = await resolveCapabilityId(deps.profiles, ref);
      const content = await deps.profiles.readPluginFile(id, filePath);
      printResult({ path: filePath, content }, deps.opts.json, deps.io, () => content);
    });

  plugins
    .command("write <capability> <path>")
    .description("Write a plugin file (custom plugins only)")
    .option("--content <text>", "file content")
    .option("--file <path>", "read content from a local file (- for stdin)")
    .action(async (ref: string, filePath: string, options: { content?: string; file?: string }) => {
      const deps = getDeps();
      const id = await resolveCapabilityId(deps.profiles, ref);
      const content = await readContent(options);
      await deps.profiles.writePluginFile(id, filePath, content);
      printResult({ written: filePath }, deps.opts.json, deps.io, () => `Wrote ${filePath}.\n`);
    });

  plugins
    .command("rm-file <capability> <path>")
    .description("Remove a plugin file (custom plugins only)")
    .action(async (ref: string, filePath: string) => {
      const deps = getDeps();
      const id = await resolveCapabilityId(deps.profiles, ref);
      await confirmOrAbort(`Remove plugin file ${filePath}?`, deps.opts.yes);
      await deps.profiles.removePluginFile(id, filePath);
      printResult({ removed: filePath }, deps.opts.json, deps.io, () => `Removed ${filePath}.\n`);
    });

  plugins
    .command("validate <capability>")
    .description("Validate a custom plugin")
    .action(async (ref: string) => {
      const deps = getDeps();
      const id = await resolveCapabilityId(deps.profiles, ref);
      const result = await deps.profiles.validateCustomPlugin(id);
      printResult(result, deps.opts.json, deps.io, () => `${result.output}\n`);
      if (!result.ok) throw new Error("Plugin validation failed.");
    });
}

async function buildCapabilityInput(
  kind: CapabilityKind,
  name: string,
  options: CapabilityFlags,
  io: CliIO
): Promise<CapabilityInput> {
  const input: CapabilityInput = { kind, name, description: options.description };
  assertContentKind(kind, options);
  switch (kind) {
    case "mcp":
      input.config = await readConfigInput(options);
      break;
    case "custom-plugin":
      if (!options.rootPath) throw new Error("--root-path is required for kind custom-plugin.");
      input.rootPath = options.rootPath;
      break;
    case "skill":
    case "instruction":
      Object.assign(input, await readContentFlags(options, io));
      if (input.content === undefined && typeof options.source === "string") {
        const snapshot = await readCapabilitySource(kind, options.source);
        for (const warning of snapshot.warnings) io.err(`Warning: ${warning}\n`);
        input.content = snapshot.content;
        input.files = snapshot.files;
      }
      if (input.content === undefined) {
        throw new Error(
          kind === "skill"
            ? "--content, --content-file, --from-dir or --source is required for kind skill."
            : "--content, --content-file or --source is required for kind instruction."
        );
      }
      if (options.source !== undefined) input.sourcePath = explicitSource(options.source) ?? undefined;
      break;
    case "hook":
      if (!options.event) throw new Error("--event is required for kind hook.");
      if (!options.command) throw new Error("--command is required for kind hook.");
      input.event = options.event;
      input.matcher = options.matcher;
      input.handlers = [commandHandler(options)];
      break;
    case "installed-plugin":
      throw new Error("Installed plugins are managed via: caps plugins sync");
  }
  return input;
}

function assertContentKind(kind: CapabilityKind, options: CapabilityFlags): void {
  if (options.fromDir && kind !== "skill") throw new Error("--from-dir only applies to skills.");
  if (options.source !== undefined && kind !== "skill" && kind !== "instruction") {
    throw new Error("--source/--no-source only apply to skills and instructions.");
  }
}

/**
 * Read --content / --content-file / --from-dir. A file or directory read this
 * way becomes the capability's source link, so `caps catalog sync` can refresh
 * it later; an explicit --source/--no-source overrides that afterwards.
 */
async function readContentFlags(
  options: CapabilityFlags,
  io: CliIO
): Promise<Pick<CapabilityInput, "content" | "files" | "sourcePath">> {
  const given = [options.content !== undefined, Boolean(options.contentFile), Boolean(options.fromDir)];
  if (given.filter(Boolean).length > 1) {
    throw new Error("Use only one of --content, --content-file or --from-dir.");
  }
  if (options.fromDir) {
    const dir = path.resolve(options.fromDir);
    const skill = await readSkillDirectory(dir);
    for (const warning of skippedWarnings(dir, skill.skipped)) io.err(`Warning: ${warning}\n`);
    return { content: skill.content, files: skill.files, sourcePath: dir };
  }
  if (options.contentFile) {
    return {
      content: await fs.readFile(options.contentFile, "utf8"),
      sourcePath: path.resolve(options.contentFile)
    };
  }
  if (options.content !== undefined) return { content: options.content };
  return {};
}

function explicitSource(source: string | false): string | null {
  return source === false ? null : path.resolve(source);
}

/** Human view of one capability: its JSON, but skill files listed by path. */
function describeCapability(capability: Capability): string {
  if (capability.kind !== "skill") return `${JSON.stringify(capability, null, 2)}\n`;
  const { files = {}, ...rest } = capability;
  const paths = Object.keys(files).sort();
  const lines = [JSON.stringify(rest, null, 2), "", `Files (${paths.length}):`];
  if (!paths.length) lines.push("  (none besides SKILL.md)");
  for (const filePath of paths) lines.push(`  ${filePath}  (${Buffer.byteLength(files[filePath], "utf8")} bytes)`);
  return `${lines.join("\n")}\n`;
}

function syncSummary(results: CapabilitySyncResult[], dryRun: boolean): string {
  if (!results.length) {
    return "No capabilities have a source link. Use --content-file, --from-dir or --source to add one.\n";
  }
  const label = (result: CapabilitySyncResult) =>
    result.status === "updated" && dryRun ? "would update" : result.status === "missing" ? "source missing" : result.status;
  return table(
    ["STATUS", "NAME", "SOURCE", "DETAILS"],
    results.map((result) => [
      label(result),
      result.name,
      result.sourcePath ?? "",
      result.error ?? result.changes.join(", ")
    ])
  );
}

function commandHandler(options: CapabilityFlags): Record<string, unknown> {
  const command = options.command?.trim();
  if (!command) throw new Error("--command must not be empty.");
  const handler: Record<string, unknown> = { type: "command", command };
  if (options.timeout !== undefined) {
    const timeout = Number(options.timeout);
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new Error("--timeout must be a positive whole number of seconds.");
    }
    handler.timeout = timeout;
  }
  return handler;
}

async function readContent(options: { content?: string; file?: string }): Promise<string> {
  if (options.content !== undefined && options.file) {
    throw new Error("Use either --content or --file, not both.");
  }
  if (options.content !== undefined) return options.content;
  if (options.file && options.file !== "-") return fs.readFile(options.file, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
