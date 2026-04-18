import { discoverManifests } from "../modules/manifestDiscoverer.js";
import { runOsvScanner } from "../modules/osvScannerAdapter.js";
import { printFindings } from "../modules/stdoutReporter.js";
import { loadOsvScannerConfig, ConfigParseError } from "../modules/configLoader.js";
import { lintOsvScannerConfig } from "../modules/linter.js";
import { printLintResult } from "../modules/lintReporter.js";
import { filterAcceptedFindings } from "../modules/findingFilter.js";

export async function runScanCommand(scanPath: string): Promise<number> {
  let config;
  try {
    config = await loadOsvScannerConfig(scanPath);
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

  const lintResult = lintOsvScannerConfig(config);
  if (!lintResult.isClean) {
    process.stderr.write("Lint failed — aborting scan\n");
    printLintResult(lintResult, config.filePath ?? "osv-scanner.toml");
    return 1;
  }
  if (lintResult.warnings.length > 0) {
    printLintResult(lintResult, config.filePath ?? "osv-scanner.toml");
  }

  const manifests = await discoverManifests(scanPath);
  const findings = await runOsvScanner(manifests);
  const filtered = filterAcceptedFindings(findings, config);
  printFindings(filtered);
  return filtered.length === 0 ? 0 : 1;
}
