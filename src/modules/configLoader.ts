import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parse } from "smol-toml";
import type { OsvScannerConfig, IgnoredVuln } from "../types/osvScannerConfig.js";
import { ConfigParseError } from "../types/osvScannerConfig.js";

export { ConfigParseError } from "../types/osvScannerConfig.js";

function findSourceLines(raw: string): number[] {
  const lines: number[] = [];
  const rawLines = raw.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    if (rawLines[i].trim() === "[[IgnoredVulns]]") {
      lines.push(i + 1);
    }
  }
  return lines;
}

export async function loadOsvScannerConfig(repoRoot: string): Promise<OsvScannerConfig> {
  const absPath = join(resolve(repoRoot), "osv-scanner.toml");

  let raw: string;
  try {
    raw = await readFile(absPath, "utf8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { ignoredVulns: [], filePath: null };
    }
    throw err;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    const e = err as { name?: string; line?: number; column?: number; message?: string };
    const line = typeof e.line === "number" ? e.line : 1;
    const column = typeof e.column === "number" ? e.column : 1;
    throw new ConfigParseError(absPath, line, column, e.message ?? String(err));
  }

  const rawEntries = (parsed["IgnoredVulns"] as Array<Record<string, unknown>> | undefined) ?? [];
  const sourceLines = findSourceLines(raw);

  const ignoredVulns: IgnoredVuln[] = rawEntries.map((entry, idx) => {
    const id = String(entry["id"] ?? "");
    const rawUntil = entry["ignoreUntil"];
    const ignoreUntil =
      rawUntil instanceof Date
        ? rawUntil.toISOString().slice(0, 10)
        : String(rawUntil ?? "");
    const reason =
      typeof entry["reason"] === "string" ? entry["reason"] : undefined;
    const sourceLine = sourceLines[idx];
    return { id, ignoreUntil, reason, sourceLine };
  });

  return { ignoredVulns, filePath: absPath };
}
