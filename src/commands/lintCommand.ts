import { stat } from "node:fs/promises";
import { loadOsvScannerConfig, ConfigParseError } from "../modules/configLoader.js";
import { lintOsvScannerConfig } from "../modules/linter.js";
import { printLintResult } from "../modules/lintReporter.js";

export async function runLintCommand(repoRoot: string): Promise<number> {
  try {
    const s = await stat(repoRoot);
    if (!s.isDirectory()) {
      process.stderr.write(`Path does not exist: ${repoRoot}\n`);
      return 2;
    }
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "ENOTDIR") {
      process.stderr.write(`Path does not exist: ${repoRoot}\n`);
      return 2;
    }
    throw err;
  }

  let config;
  try {
    config = await loadOsvScannerConfig(repoRoot);
  } catch (err: unknown) {
    if (err instanceof ConfigParseError) {
      printLintResult(
        { errors: [{ severity: "error", message: err.message, line: err.line, column: err.column }], warnings: [], isClean: false },
        err.filePath
      );
      return 2;
    }
    throw err;
  }

  const result = lintOsvScannerConfig(config);
  printLintResult(result, config.filePath ?? "osv-scanner.toml");
  return result.isClean ? 0 : 1;
}
