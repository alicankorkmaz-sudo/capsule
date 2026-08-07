import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ProfileManager } from "../profileManager";
import type { Capability, Profile } from "../types";
import { askYesNo, defaultIO, type CliIO } from "./output";

export interface LaunchOptions {
  /** Explicit profile override. Undefined means "no override" — use the
   *  project's assigned profile, or launch unmanaged if it has none. */
  profile?: string;
  projectPath: string;
  confirmOwnership: boolean;
  force: boolean;
  claudeArgs: string[];
}

export function resolveProfile(profiles: Profile[], query: string): Profile {
  const normalized = query.trim().toLowerCase();
  const profile = profiles.find(
    (candidate) => candidate.id.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized
  );
  if (!profile) {
    throw new Error(
      `Profile not found: ${query}. Available profiles: ${profiles.map((candidate) => candidate.name).join(", ")}`
    );
  }
  return profile;
}

export function formatProfileList(profiles: Profile[], capabilities: Capability[]): string {
  const capabilityById = new Map(capabilities.map((capability) => [capability.id, capability]));
  const blocks = profiles.map((profile) => {
    const enabled = profile.capabilityIds
      .map((id) => capabilityById.get(id))
      .filter((capability): capability is Capability => Boolean(capability));
    const lines = [
      `${profile.name}${profile.system === "vanilla" ? " (system)" : ""}`,
      `  ${profile.description ?? "No description."}`
    ];
    if (!enabled.length) {
      lines.push("  Enabled capabilities: none");
    } else {
      lines.push(`  Enabled capabilities (${enabled.length}):`);
      lines.push(...enabled.map((capability) => `    - ${capability.name} [${capabilityKindLabel(capability)}]`));
    }
    return lines.join("\n");
  });
  return `${blocks.join("\n\n")}\n`;
}

export function capabilityKindLabel(capability: Capability): string {
  switch (capability.kind) {
    case "mcp": return "MCP server";
    case "installed-plugin": return "Installed plugin";
    case "custom-plugin": return "Custom plugin";
    case "skill": return "Skill";
    case "hook": return `Hook · ${capability.event}`;
    case "instruction": return "Instruction";
  }
}

export async function runLaunch(
  manager: ProfileManager,
  options: LaunchOptions,
  io: CliIO = defaultIO
): Promise<number> {
  await assertDirectory(options.projectPath);
  const overview = await manager.getOverview(options.projectPath);

  // No explicit override: fall back to whatever this project is already
  // assigned. With no assignment there is nothing to apply, so leave the
  // project's own configuration untouched and just start Claude.
  const profileRef = options.profile ?? overview.selectedAssignment?.profileId;
  if (!profileRef) {
    const launch = await manager.launchUnmanaged(options.projectPath, {
      dryRun: true,
      extraArgs: options.claudeArgs
    });
    for (const warning of launch.warnings) io.err(`Warning: ${warning}\n`);
    io.out(`Starting Claude with the project's own setup in ${options.projectPath}\n`);
    return runCommand(launch.command, options.projectPath);
  }

  const profile = resolveProfile(overview.profiles, profileRef);
  const preview = await manager.previewApply(profile.id, options.projectPath);
  let confirmOwnership = options.confirmOwnership;
  let force = options.force;

  if (preview.needsOwnershipConfirmation && !confirmOwnership) {
    confirmOwnership = await askYesNo(
      "This project already has local Claude configuration. Back it up and let Capsule manage it?"
    );
    if (!confirmOwnership) return 1;
  }
  if (preview.drifted && !force) {
    force = await askYesNo("Managed Claude files changed outside Capsule. Overwrite those changes?");
    if (!force) return 1;
  }

  const launch = await manager.launch(profile.id, options.projectPath, {
    confirmOwnership,
    force,
    dryRun: true,
    extraArgs: options.claudeArgs
  });
  for (const warning of launch.warnings) io.err(`Warning: ${warning}\n`);
  io.out(`Starting Claude with profile "${profile.name}" in ${options.projectPath}\n`);
  return runCommand(launch.command, options.projectPath);
}

export async function assertDirectory(projectPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(projectPath);
  } catch {
    throw new Error(`Project directory does not exist: ${projectPath}`);
  }
  if (!stat.isDirectory()) throw new Error(`Project path is not a directory: ${projectPath}`);
}

function runCommand(command: string, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: "/bin/sh",
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
