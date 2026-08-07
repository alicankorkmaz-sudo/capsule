import type { Command } from "commander";
import type { ServerRecord, TargetKey } from "../types";
import { TargetKeySchema } from "../types";
import type { CliDeps } from "./context";
import { confirmOrAbort, printResult, readConfigInput, table } from "./output";
import { resolveServerId } from "./resolve";

interface ConfigFlags {
  config?: string;
  configFile?: string;
}

export function registerServerCommands(program: Command, getDeps: () => CliDeps): void {
  const servers = program.command("servers").description("Manage MCP servers across client configs");

  servers
    .command("list")
    .description("List MCP servers across all targets")
    .action(async () => {
      const deps = getDeps();
      const records = await deps.manager.listServers(deps.projectPath);
      printResult(records, deps.opts.json, deps.io, () => serverTable(records));
    });

  servers
    .command("get <server>")
    .description("Show one MCP server (id or name)")
    .option("--show-secrets", "print unredacted config values")
    .action(async (ref: string, options: { showSecrets?: boolean }) => {
      const deps = getDeps();
      const id = await resolveServerId(deps.manager, ref, deps.projectPath);
      const record = await deps.manager.getServer(id, Boolean(options.showSecrets));
      if (!record) throw new Error(`MCP server not found: ${ref}`);
      printResult(record, deps.opts.json, deps.io, () => `${JSON.stringify(record, null, 2)}\n`);
    });

  servers
    .command("add <name>")
    .description("Add an MCP server to one or more targets")
    .requiredOption("-t, --target <target...>", `targets: ${TargetKeySchema.options.join(", ")}`)
    .option("--config <json>", "server config as a JSON string")
    .option("--config-file <path>", "read server config from a JSON file (- for stdin)")
    .action(async (name: string, options: ConfigFlags & { target: string[] }) => {
      const deps = getDeps();
      const config = await readValidConfig(deps, options);
      const records = await deps.manager.addServer({
        targets: options.target.map((target) => TargetKeySchema.parse(target)),
        name,
        config,
        projectPath: deps.projectPath,
        allowElevated: deps.opts.elevated
      });
      printResult(records, deps.opts.json, deps.io, () => serverTable(records));
    });

  servers
    .command("edit <server>")
    .description("Edit an MCP server (id or name)")
    .option("--name <name>", "rename the server")
    .option("--config <json>", "replace config with a JSON string")
    .option("--config-file <path>", "replace config from a JSON file (- for stdin)")
    .option("--enable", "enable the server")
    .option("--disable", "disable the server")
    .action(async (ref: string, options: ConfigFlags & { name?: string; enable?: boolean; disable?: boolean }) => {
      const deps = getDeps();
      if (options.enable && options.disable) throw new Error("Use either --enable or --disable, not both.");
      const hasConfig = Boolean(options.config || options.configFile);
      if (!hasConfig && !options.name && !options.enable && !options.disable) {
        throw new Error("Nothing to change. Pass --name, --config, --config-file, --enable, or --disable.");
      }
      const id = await resolveServerId(deps.manager, ref, deps.projectPath);
      const records = await deps.manager.patchServer(id, {
        name: options.name,
        config: hasConfig ? await readValidConfig(deps, options) : undefined,
        enabled: options.enable ? true : options.disable ? false : undefined,
        projectPath: deps.projectPath,
        allowElevated: deps.opts.elevated
      });
      printResult(records, deps.opts.json, deps.io, () => serverTable(records));
    });

  servers
    .command("rm <server...>")
    .description("Remove MCP servers (ids or names)")
    .action(async (refs: string[]) => {
      const deps = getDeps();
      const ids = [];
      for (const ref of refs) ids.push(await resolveServerId(deps.manager, ref, deps.projectPath));
      await confirmOrAbort(`Remove ${ids.length} MCP server${ids.length === 1 ? "" : "s"}?`, deps.opts.yes);
      let records: ServerRecord[] = [];
      for (const id of ids) records = await deps.manager.deleteServer(id, deps.opts.elevated);
      printResult(records, deps.opts.json, deps.io, () => serverTable(records));
    });

  servers
    .command("move <server...>")
    .description("Move MCP servers to another target")
    .requiredOption("-t, --target <target>", `destination: ${TargetKeySchema.options.join(", ")}`)
    .option("--name <name>", "rename at the destination (single server only)")
    .action(async (refs: string[], options: { target: string; name?: string }) => {
      await transfer(getDeps(), refs, options, "move");
    });

  servers
    .command("copy <server...>")
    .description("Copy MCP servers to another target")
    .requiredOption("-t, --target <target>", `destination: ${TargetKeySchema.options.join(", ")}`)
    .option("--name <name>", "rename at the destination (single server only)")
    .action(async (refs: string[], options: { target: string; name?: string }) => {
      await transfer(getDeps(), refs, options, "copy");
    });

  servers
    .command("validate")
    .description("Validate an MCP server config")
    .option("--config <json>", "server config as a JSON string")
    .option("--config-file <path>", "read server config from a JSON file (- for stdin)")
    .action(async (options: ConfigFlags) => {
      const deps = getDeps();
      const config = await readConfigInput(options);
      const result = deps.manager.validateConfig(config);
      if (!result.success) {
        const errors = result.error.issues.map((issue) => issue.message);
        printResult({ ok: false, errors }, deps.opts.json, deps.io, () =>
          `Invalid config:\n${errors.map((error) => `  - ${error}`).join("\n")}\n`
        );
        throw new Error("Config is invalid.");
      }
      printResult({ ok: true, config: result.data }, deps.opts.json, deps.io, () => "Config is valid.\n");
    });
}

async function transfer(
  deps: CliDeps,
  refs: string[],
  options: { target: string; name?: string },
  mode: "move" | "copy"
): Promise<void> {
  const target = TargetKeySchema.parse(options.target) as TargetKey;
  if (options.name && refs.length > 1) throw new Error("--name only works with a single server.");
  const ids = [];
  for (const ref of refs) ids.push(await resolveServerId(deps.manager, ref, deps.projectPath));
  const input = { target, projectPath: deps.projectPath, allowElevated: deps.opts.elevated };
  const records =
    ids.length === 1
      ? mode === "move"
        ? await deps.manager.moveServer(ids[0], { ...input, name: options.name })
        : await deps.manager.copyServer(ids[0], { ...input, name: options.name })
      : mode === "move"
        ? await deps.manager.moveServers({ ...input, ids })
        : await deps.manager.copyServers({ ...input, ids });
  printResult(records, deps.opts.json, deps.io, () => serverTable(records));
}

async function readValidConfig(deps: CliDeps, flags: ConfigFlags): Promise<unknown> {
  const config = await readConfigInput(flags);
  const result = deps.manager.validateConfig(config);
  if (!result.success) throw result.error;
  return result.data;
}

function serverTable(records: ServerRecord[]): string {
  return table(
    ["NAME", "TARGET", "TRANSPORT", "ENABLED", "ISSUES"],
    records.map((record) => [
      record.name,
      record.label,
      record.transport,
      record.enabled ? "yes" : "no",
      record.validationErrors.join("; ")
    ])
  );
}
