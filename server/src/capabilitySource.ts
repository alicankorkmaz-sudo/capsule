import fs from "node:fs/promises";
import path from "node:path";

/** Skill asset files above this size are left out of the catalog snapshot. */
export const SKILL_FILE_MAX_BYTES = 512 * 1024;

/** Directories that never belong in a skill snapshot, beyond dot-directories. */
const IGNORED_DIRS = new Set(["node_modules"]);

export interface SkippedSkillFile {
  /** Path relative to the skill directory, using forward slashes. */
  path: string;
  reason: string;
}

export interface SkillDirectory {
  content: string;
  files: Record<string, string>;
  skipped: SkippedSkillFile[];
}

export interface CapabilitySourceSnapshot {
  content: string;
  /** Only present when the source is a skill directory. */
  files?: Record<string, string>;
  warnings: string[];
}

/**
 * Snapshot a skill directory: `SKILL.md` becomes the content, every other
 * regular text file (recursively) becomes an entry in `files`. Dotfiles,
 * dot-directories and node_modules are ignored outright; binary, oversized or
 * otherwise unreadable files are reported in `skipped` so callers can warn.
 */
export async function readSkillDirectory(dir: string): Promise<SkillDirectory> {
  const root = path.resolve(dir);
  const skillPath = path.join(root, "SKILL.md");
  let content: string;
  try {
    content = await fs.readFile(skillPath, "utf8");
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // Keep ENOENT so callers can tell "source gone" from other read failures.
    throw Object.assign(new Error(`No SKILL.md in ${root}`), { code: "ENOENT" });
  }
  const files: Record<string, string> = {};
  const skipped: SkippedSkillFile[] = [];
  await walkSkillDirectory(root, "", files, skipped);
  return { content, files, skipped };
}

/**
 * Re-read the source a skill or instruction capability is linked to. A skill
 * source is either a skill directory (content + files) or a single file
 * (content only); an instruction source is always a file.
 */
export async function readCapabilitySource(
  kind: "skill" | "instruction",
  sourcePath: string
): Promise<CapabilitySourceSnapshot> {
  const resolved = path.resolve(sourcePath);
  const stat = await fs.stat(resolved);
  if (stat.isDirectory()) {
    if (kind !== "skill") throw new Error(`Instruction source is a directory: ${resolved}`);
    const skill = await readSkillDirectory(resolved);
    return { content: skill.content, files: skill.files, warnings: skippedWarnings(resolved, skill.skipped) };
  }
  return { content: await fs.readFile(resolved, "utf8"), warnings: [] };
}

export function skippedWarnings(dir: string, skipped: SkippedSkillFile[]): string[] {
  return skipped.map((item) => `Skipped ${path.join(dir, item.path)}: ${item.reason}`);
}

export function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

async function walkSkillDirectory(
  root: string,
  relativeDir: string,
  files: Record<string, string>,
  skipped: SkippedSkillFile[]
): Promise<void> {
  const entries = await fs.readdir(path.join(root, relativeDir), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (relativePath === "SKILL.md") continue;
    const absolutePath = path.join(root, relativePath);

    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const target = await fs.stat(absolutePath);
        if (target.isDirectory()) {
          skipped.push({ path: relativePath, reason: "symlinked directory (not followed)" });
          continue;
        }
        isDirectory = false;
        isFile = target.isFile();
      } catch {
        skipped.push({ path: relativePath, reason: "broken symlink" });
        continue;
      }
    }

    if (isDirectory) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walkSkillDirectory(root, relativePath, files, skipped);
      continue;
    }
    if (!isFile) continue;

    const stat = await fs.stat(absolutePath);
    if (stat.size > SKILL_FILE_MAX_BYTES) {
      skipped.push({
        path: relativePath,
        reason: `larger than ${SKILL_FILE_MAX_BYTES / 1024} KiB (${Math.ceil(stat.size / 1024)} KiB)`
      });
      continue;
    }
    const text = decodeText(await fs.readFile(absolutePath));
    if (text === undefined) {
      skipped.push({ path: relativePath, reason: "binary file" });
      continue;
    }
    files[relativePath] = text;
  }
}

/** Returns the buffer as UTF-8 text, or undefined when it looks binary. */
function decodeText(buffer: Buffer): string | undefined {
  if (buffer.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return undefined;
  }
}
