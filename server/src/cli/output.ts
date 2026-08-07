import fs from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

export class CliExit extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

export const defaultIO: CliIO = {
  out: (text) => stdout.write(text),
  err: (text) => process.stderr.write(text)
};

export function printResult(value: unknown, json: boolean | undefined, io: CliIO, human?: () => string): void {
  if (json || !human) {
    io.out(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  io.out(human());
}

export function table(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) => Math.max(...all.map((row) => (row[column] ?? "").length)));
  const line = (row: string[]) =>
    row.map((cell, column) => (cell ?? "").padEnd(widths[column])).join("  ").trimEnd();
  if (!rows.length) return `${line(headers)}\n(none)\n`;
  return `${[line(headers), ...rows.map(line)].join("\n")}\n`;
}

export async function askYesNo(question: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(`${question} Re-run with --yes or --force to confirm non-interactively.`);
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export async function confirmOrAbort(question: string, yes: boolean | undefined): Promise<void> {
  if (yes) return;
  const confirmed = await askYesNo(question);
  if (!confirmed) throw new Error("Aborted.");
}

export interface ConfigInputFlags {
  config?: string;
  configFile?: string;
}

export async function readConfigInput(
  flags: ConfigInputFlags,
  readStdin: () => Promise<string> = readAllStdin
): Promise<unknown> {
  if (flags.config && flags.configFile) {
    throw new Error("Use either --config or --config-file, not both.");
  }
  let text: string;
  if (flags.config) {
    text = flags.config;
  } else if (flags.configFile) {
    text = flags.configFile === "-" ? await readStdin() : await fs.readFile(flags.configFile, "utf8");
  } else if (!stdin.isTTY) {
    text = await readStdin();
  } else {
    throw new Error("Provide --config <json>, --config-file <path>, or pipe JSON via stdin.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Config is not valid JSON.");
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
