import os from "node:os";
import path from "node:path";
import { readTextIfExists } from "./storage";

/** Codex's default `project_doc_max_bytes`; anything past it is cut off. */
export const CODEX_DOC_MAX_BYTES = 32 * 1024;

/** Same depth Claude Code follows `@path` imports to. */
const MAX_IMPORT_DEPTH = 5;

/**
 * Inline Claude-style `@path` imports so the text works in Codex, which reads
 * instruction files literally and would otherwise see only the `@path` line.
 *
 * Only an import that stands alone on its line is expanded, and never inside a
 * fenced code block. Relative paths resolve against the importing file's
 * directory (`baseDir` for the top-level text); `~` is the home directory.
 * Unreadable, cyclic or too deeply nested imports are left as written and
 * reported in `warnings`.
 */
export async function expandInstructionImports(
  text: string,
  baseDir: string,
  homeDir: string = os.homedir()
): Promise<{ text: string; warnings: string[] }> {
  const warnings: string[] = [];
  const expanded = await expand(text, baseDir, homeDir, [], warnings);
  return { text: expanded, warnings };
}

async function expand(
  text: string,
  baseDir: string,
  homeDir: string,
  chain: string[],
  warnings: string[]
): Promise<string> {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = undefined;
      out.push(line);
      continue;
    }
    const importMatch = fence ? null : /^\s*@(\S+)\s*$/.exec(line);
    if (!importMatch) {
      out.push(line);
      continue;
    }
    const target = resolveImport(importMatch[1], baseDir, homeDir);
    if (chain.includes(target)) {
      warnings.push(`Instruction import ${importMatch[1]} is circular; left as written for Codex.`);
      out.push(line);
      continue;
    }
    if (chain.length >= MAX_IMPORT_DEPTH) {
      warnings.push(`Instruction import ${importMatch[1]} is nested too deeply; left as written for Codex.`);
      out.push(line);
      continue;
    }
    const content = await readTextIfExists(target).catch(() => undefined);
    if (content === undefined) {
      warnings.push(`Instruction import ${importMatch[1]} could not be read; Codex will not see it.`);
      out.push(line);
      continue;
    }
    out.push(
      (await expand(content, path.dirname(target), homeDir, [...chain, target], warnings)).replace(/\n+$/, "")
    );
  }
  return out.join("\n");
}

function resolveImport(raw: string, baseDir: string, homeDir: string): string {
  if (raw === "~" || raw.startsWith("~/")) return path.join(homeDir, raw.slice(1));
  return path.resolve(baseDir, raw);
}
