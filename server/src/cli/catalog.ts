import fs from "node:fs/promises";
import type { Command } from "commander";
import type { CapabilityKind } from "../types";
import { CapabilityKindSchema } from "../types";
import type { CapabilityInput } from "../profileManager";
import type { CliDeps } from "./context";
import { confirmOrAbort, printResult, readConfigInput, table } from "./output";
import { capabilityKindLabel } from "./launchFlow";
import { resolveCapabilityId } from "./resolve";

interface CapabilityFlags {
  description?: string;
  config?: string;
  configFile?: string;
  content?: string;
  contentFile?: string;
  rootPath?: string;
  event?: string;
  matcher?: string;
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
      printResult(capability, deps.opts.json, deps.io, () => `${JSON.stringify(capability, null, 2)}\n`);
    });

  catalog
    .command("create <name>")
    .description("Create a capability")
    .requiredOption("-k, --kind <kind>", `kind: ${CapabilityKindSchema.options.join(", ")}`)
    .option("-d, --description <text>", "description")
    .option("--config <json>", "MCP config as JSON (kind: mcp)")
    .option("--config-file <path>", "MCP config file (kind: mcp, - for stdin)")
    .option("--content <text>", "content (kind: skill or instruction)")
    .option("--content-file <path>", "content file (kind: skill or instruction)")
    .option("--root-path <path>", "plugin root directory (kind: custom-plugin)")
    .option("--event <event>", "hook event (kind: hook)")
    .option("--matcher <matcher>", "hook matcher (kind: hook)")
    .action(async (name: string, options: CapabilityFlags & { kind: string }) => {
      const deps = getDeps();
      const kind = CapabilityKindSchema.parse(options.kind);
      const input = await buildCapabilityInput(kind, name, options);
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
    .option("--content-file <path>", "content file")
    .option("--event <event>", "hook event")
    .option("--matcher <matcher>", "hook matcher")
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
      if (options.content !== undefined || options.contentFile) {
        input.content = options.contentFile
          ? await fs.readFile(options.contentFile, "utf8")
          : options.content;
      }
      const capability = await deps.profiles.updateCapability(id, input);
      printResult(capability, deps.opts.json, deps.io, () => `Updated capability "${capability.name}".\n`);
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
  options: CapabilityFlags
): Promise<CapabilityInput> {
  const input: CapabilityInput = { kind, name, description: options.description };
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
      input.content = options.contentFile
        ? await fs.readFile(options.contentFile, "utf8")
        : options.content;
      if (input.content === undefined) {
        throw new Error(`--content or --content-file is required for kind ${kind}.`);
      }
      break;
    case "hook":
      if (!options.event) throw new Error("--event is required for kind hook.");
      input.event = options.event;
      input.matcher = options.matcher;
      break;
    case "installed-plugin":
      throw new Error("Installed plugins are managed via: caps plugins sync");
  }
  return input;
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
