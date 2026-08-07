#!/usr/bin/env node

import path from "node:path";
import { stdout } from "node:process";
import { createRuntimeContext, migrateLegacyAppDir } from "./paths";
import { ProfileManager } from "./profileManager";
import { formatProfileList, resolveProfile, runLaunch } from "./cli/launchFlow";

export { formatProfileList, resolveProfile };

export interface ProfileCliOptions {
  profile?: string;
  projectPath: string;
  confirmOwnership: boolean;
  force: boolean;
  listProfiles: boolean;
  namesOnly: boolean;
  help: boolean;
  claudeArgs: string[];
}

export function parseProfileCliArgs(argv: string[], cwd = process.cwd()): ProfileCliOptions {
  const options: ProfileCliOptions = {
    profile: undefined,
    projectPath: cwd,
    confirmOwnership: false,
    force: false,
    listProfiles: false,
    namesOnly: false,
    help: false,
    claudeArgs: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      options.claudeArgs.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "-p" || argument === "--profile") {
      options.profile = requiredArgument(argv[++index], argument);
    } else if (argument.startsWith("--profile=")) {
      options.profile = requiredArgument(argument.slice("--profile=".length), "--profile");
    } else if (argument === "-C" || argument === "--project") {
      options.projectPath = requiredArgument(argv[++index], argument);
    } else if (argument.startsWith("--project=")) {
      options.projectPath = requiredArgument(argument.slice("--project=".length), "--project");
    } else if (argument === "-y" || argument === "--yes") {
      options.confirmOwnership = true;
    } else if (argument === "-f" || argument === "--force") {
      options.force = true;
    } else if (argument === "-l" || argument === "--list-profiles") {
      options.listProfiles = true;
    } else if (argument === "--names-only") {
      options.listProfiles = true;
      options.namesOnly = true;
    } else if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else {
      options.claudeArgs.push(argument);
    }
  }
  options.projectPath = path.resolve(cwd, options.projectPath);
  return options;
}

export async function runProfileCli(argv: string[]): Promise<number> {
  const options = parseProfileCliArgs(argv);
  if (options.help) {
    stdout.write(helpText());
    return 0;
  }

  const ctx = createRuntimeContext({ cwd: options.projectPath });
  await migrateLegacyAppDir(ctx);
  const manager = new ProfileManager(ctx);
  if (options.listProfiles) {
    const overview = await manager.getOverview(options.projectPath);
    if (options.namesOnly) {
      for (const profile of overview.profiles) stdout.write(`${profile.name}\n`);
    } else {
      stdout.write(formatProfileList(overview.profiles, overview.capabilities));
    }
    return 0;
  }

  return runLaunch(manager, {
    profile: options.profile,
    projectPath: options.projectPath,
    confirmOwnership: options.confirmOwnership,
    force: options.force,
    claudeArgs: options.claudeArgs
  });
}

function requiredArgument(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} requires a value.`);
  return value;
}

function helpText(): string {
  return `Usage: cx [options] [-- Claude arguments]

Starts Claude Code in the current directory.

Without -p, the project's assigned profile is used; a project with no
assigned profile launches with its own existing setup, untouched.
The full manager CLI is available as caps.

Options:
  -p, --profile <name>  Profile name or id (default: the project's assigned
                        profile, or none)
  -C, --project <path>  Project directory (default: current directory)
  -l, --list-profiles   List available profiles
  -y, --yes             Confirm adoption of existing local Claude files
  -f, --force           Overwrite drifted managed files
  -h, --help            Show this help

Examples:
  cx
  cx -p personal
  cx --profile "Work"
  cx -p personal -C /path/to/project -- --resume
`;
}

if (require.main === module) {
  runProfileCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`cx: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
