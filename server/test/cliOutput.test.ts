import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { printResult, readConfigInput, table, type CliIO } from "../src/cli/output";

function captureIO(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

describe("table", () => {
  it("pads columns to the widest cell", () => {
    const output = table(["NAME", "TARGET"], [["a", "Codex personal"], ["longer-name", "x"]]);
    expect(output).toBe("NAME         TARGET\na            Codex personal\nlonger-name  x\n");
  });

  it("prints a placeholder when there are no rows", () => {
    expect(table(["NAME"], [])).toBe("NAME\n(none)\n");
  });
});

describe("printResult", () => {
  it("prints JSON when the json flag is set", () => {
    const { io, out } = captureIO();
    printResult({ a: 1 }, true, io, () => "human\n");
    expect(out.join("")).toBe('{\n  "a": 1\n}\n');
  });

  it("prints the human formatter by default", () => {
    const { io, out } = captureIO();
    printResult({ a: 1 }, undefined, io, () => "human\n");
    expect(out.join("")).toBe("human\n");
  });
});

describe("readConfigInput", () => {
  it("parses --config JSON", async () => {
    expect(await readConfigInput({ config: '{"command":"echo"}' })).toEqual({ command: "echo" });
  });

  it("reads --config-file", async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "caps-cli-")), "config.json");
    await fs.writeFile(file, '{"url":"http://localhost"}');
    expect(await readConfigInput({ configFile: file })).toEqual({ url: "http://localhost" });
  });

  it("rejects using both --config and --config-file", async () => {
    await expect(readConfigInput({ config: "{}", configFile: "x" })).rejects.toThrow(
      "either --config or --config-file"
    );
  });

  it("rejects invalid JSON", async () => {
    await expect(readConfigInput({ config: "{nope" })).rejects.toThrow("not valid JSON");
  });
});
