import path from "node:path";
import { McpManager } from "../manager";
import { ProfileManager } from "../profileManager";
import { createRuntimeContext } from "../paths";
import type { RuntimeContext } from "../types";
import type { CliIO } from "./output";

export interface GlobalOpts {
  project?: string;
  json?: boolean;
  yes?: boolean;
  elevated?: boolean;
}

export interface CliDeps {
  ctx: RuntimeContext;
  manager: McpManager;
  profiles: ProfileManager;
  projectPath: string;
  opts: GlobalOpts;
  io: CliIO;
}

export function buildCliDeps(opts: GlobalOpts, io: CliIO, ctxOverride?: RuntimeContext): CliDeps {
  const projectOverride = opts.project ? path.resolve(opts.project) : undefined;
  const ctx = ctxOverride ?? createRuntimeContext(projectOverride ? { cwd: projectOverride } : {});
  return {
    ctx,
    manager: new McpManager(ctx),
    profiles: new ProfileManager(ctx),
    projectPath: projectOverride ?? ctx.cwd,
    opts,
    io
  };
}
