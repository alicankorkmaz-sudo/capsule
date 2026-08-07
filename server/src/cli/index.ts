#!/usr/bin/env node

import { Command, CommanderError } from "commander";
import { ZodError } from "zod";
import type { RuntimeContext } from "../types";
import { createRuntimeContext, migrateLegacyAppDir } from "../paths";
import { buildCliDeps, type CliDeps } from "./context";
import { CliExit, defaultIO, type CliIO } from "./output";
import { registerServerCommands } from "./servers";
import { registerTargetCommands } from "./targets";
import { registerBackupCommands } from "./backups";
import { registerProfileCommands } from "./profiles";
import { registerCatalogCommands } from "./catalog";
import { registerImportCommands } from "./import";

export interface RunCliOptions {
  ctx?: RuntimeContext;
  io?: CliIO;
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const io = options.io ?? defaultIO;
  await migrateLegacyAppDir(options.ctx ?? createRuntimeContext());
  const program = new Command();
  program
    .name("caps")
    .description(
      "Manage profiles and capabilities (MCP servers, plugins, skills, hooks, instructions) from the terminal"
    )
    .option("-C, --project <path>", "project directory (default: current directory)")
    .option("--json", "print JSON instead of human-readable output")
    .option("-y, --yes", "skip confirmation prompts")
    .option("--elevated", "allow writes that need elevated permissions")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.out(text),
      writeErr: (text) => io.err(text)
    });

  let deps: CliDeps | undefined;
  const getDeps = () => {
    deps ??= buildCliDeps(program.opts(), io, options.ctx);
    return deps;
  };

  registerServerCommands(program, getDeps);
  registerTargetCommands(program, getDeps);
  registerBackupCommands(program, getDeps);
  registerProfileCommands(program, getDeps);
  registerCatalogCommands(program, getDeps);
  registerImportCommands(program, getDeps);

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CliExit) return error.code;
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return 0;
      return error.exitCode || 2;
    }
    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => `  - ${issue.message}`).join("\n");
      io.err(`caps: invalid input:\n${issues}\n`);
      return 2;
    }
    io.err(`caps: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`caps: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
