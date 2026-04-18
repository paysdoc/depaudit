import { stat } from "node:fs/promises";
import { loadOsvScannerConfig, loadDepauditConfig, ConfigParseError } from "../modules/configLoader.js";
import { lintOsvScannerConfig, lintDepauditConfig } from "../modules/linter.js";
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

  let depauditConfig;
  try {
    depauditConfig = await loadDepauditConfig(repoRoot);
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

  let osvConfig;
  try {
    osvConfig = await loadOsvScannerConfig(repoRoot);
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

  const depauditLint = lintDepauditConfig(depauditConfig);
  const osvLint = lintOsvScannerConfig(osvConfig);

  printLintResult(depauditLint, depauditConfig.filePath ?? ".depaudit.yml");
  printLintResult(osvLint, osvConfig.filePath ?? "osv-scanner.toml");

  return depauditLint.isClean && osvLint.isClean ? 0 : 1;
}
