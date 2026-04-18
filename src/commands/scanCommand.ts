import { discoverManifests } from "../modules/manifestDiscoverer.js";
import { runOsvScanner } from "../modules/osvScannerAdapter.js";
import { printFindings } from "../modules/stdoutReporter.js";
import { loadOsvScannerConfig, loadDepauditConfig, ConfigParseError } from "../modules/configLoader.js";
import { lintOsvScannerConfig, lintDepauditConfig } from "../modules/linter.js";
import { printLintResult } from "../modules/lintReporter.js";
import { classifyFindings } from "../modules/findingMatcher.js";

export async function runScanCommand(scanPath: string): Promise<number> {
  let depauditConfig;
  try {
    depauditConfig = await loadDepauditConfig(scanPath);
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
    osvConfig = await loadOsvScannerConfig(scanPath);
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

  if (!depauditLint.isClean || !osvLint.isClean) {
    process.stderr.write("Lint failed — aborting scan\n");
    printLintResult(depauditLint, depauditConfig.filePath ?? ".depaudit.yml");
    printLintResult(osvLint, osvConfig.filePath ?? "osv-scanner.toml");
    return 1;
  }

  if (depauditLint.warnings.length > 0) {
    printLintResult(depauditLint, depauditConfig.filePath ?? ".depaudit.yml");
  }
  if (osvLint.warnings.length > 0) {
    printLintResult(osvLint, osvConfig.filePath ?? "osv-scanner.toml");
  }

  const manifests = await discoverManifests(scanPath);
  const findings = await runOsvScanner(manifests);
  const classified = classifyFindings(findings, depauditConfig, osvConfig);

  const newFindings = classified.filter((c) => c.category === "new").map((c) => c.finding);
  printFindings(newFindings);

  const expiredAccepts = classified.filter((c) => c.category === "expired-accept");
  for (const cf of expiredAccepts) {
    process.stderr.write(`expired accept: ${cf.finding.package} ${cf.finding.version} ${cf.finding.findingId}\n`);
  }

  return newFindings.length === 0 && expiredAccepts.length === 0 ? 0 : 1;
}
