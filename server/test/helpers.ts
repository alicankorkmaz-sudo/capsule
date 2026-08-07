import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeContext } from "../src/paths";
import type { RuntimeContext } from "../src/types";

export interface TempEnv {
  root: string;
  home: string;
  project: string;
  ctx: RuntimeContext;
}

export async function makeTempEnv(): Promise<TempEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capsule-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const projectsDir = path.join(root, "Code");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(path.join(home, "Library", "Application Support", "Claude"), { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });
  const ctx = createRuntimeContext({
    homeDir: home,
    cwd: project,
    appDir: path.join(home, ".capsule"),
    projectsDir
  });
  return { root, home, project, ctx };
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}
