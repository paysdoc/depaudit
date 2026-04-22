import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { discoverManifests } from "../modules/manifestDiscoverer.js";
import { runOsvScanner } from "../modules/osvScannerAdapter.js";
import { printFindings } from "../modules/stdoutReporter.js";
import { loadOsvScannerConfig, loadDepauditConfig, ConfigParseError } from "../modules/configLoader.js";
import { lintOsvScannerConfig, lintDepauditConfig } from "../modules/linter.js";
import { printLintResult } from "../modules/lintReporter.js";
import { classifyFindings } from "../modules/findingMatcher.js";
import { fetchSocketFindings, SocketAuthError, type PackageRef } from "../modules/socketApiClient.js";
import { findOrphans } from "../modules/orphanDetector.js";
import { pruneDepauditYml, pruneOsvScannerToml } from "../modules/configWriter.js";
import { writeFindingsJson } from "../modules/jsonReporter.js";
import { renderMarkdownReport } from "../modules/markdownReporter.js";
import type { ScanResult } from "../types/scanResult.js";
import type { Manifest } from "../types/manifest.js";
import type { Ecosystem } from "../types/finding.js";

// Extracts all packages from manifest files (lock files, requirements.txt).
// Returns direct+transitive package refs for the Socket API call.
// This ensures Socket runs even for repos with no CVEs.
async function extractPackagesFromManifests(manifests: Manifest[]): Promise<PackageRef[]> {
  const refs: PackageRef[] = [];

  for (const manifest of manifests) {
    try {
      if (manifest.ecosystem === "npm") {
        const lockPath = resolve(dirname(manifest.path), "package-lock.json");
        const raw = JSON.parse(await readFile(lockPath, "utf8")) as {
          packages?: Record<string, { version?: string }>;
        };
        for (const [key, pkg] of Object.entries(raw.packages ?? {})) {
          if (!key.startsWith("node_modules/")) continue;
          const namePart = key.slice("node_modules/".length);
          // Skip nested packages (node_modules/parent/node_modules/child)
          const isScoped = namePart.startsWith("@");
          const slashCount = (namePart.match(/\//g) ?? []).length;
          if (isScoped && slashCount !== 1) continue;
          if (!isScoped && slashCount !== 0) continue;
          if (!pkg.version) continue;
          refs.push({ ecosystem: "npm", package: namePart, version: pkg.version, manifestPath: manifest.path });
        }
      } else if (manifest.ecosystem === "pip") {
        const content = await readFile(manifest.path, "utf8");
        for (const line of content.split("\n")) {
          const match = line.trim().match(/^([A-Za-z0-9_.-]+)==([^\s]+)$/);
          if (match) {
            refs.push({ ecosystem: "pip", package: match[1], version: match[2], manifestPath: manifest.path });
          }
        }
      }
      // Other ecosystems: rely on OSV findings (which include all transitive packages)
    } catch {
      // Manifest unreadable — skip; OSV findings cover CVE cases
    }
  }

  return refs;
}

export async function runScanCommand(
  scanPath: string,
  options: { format: "markdown" | "text" } = { format: "markdown" }
): Promise<ScanResult> {
  let depauditConfig;
  try {
    depauditConfig = await loadDepauditConfig(scanPath);
  } catch (err: unknown) {
    if (err instanceof ConfigParseError) {
      printLintResult(
        { errors: [{ severity: "error", message: err.message, line: err.line, column: err.column }], warnings: [], isClean: false },
        err.filePath
      );
      return { findings: [], socketAvailable: true, osvAvailable: true, exitCode: 2 };
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
      return { findings: [], socketAvailable: true, osvAvailable: true, exitCode: 2 };
    }
    throw err;
  }

  const depauditLint = lintDepauditConfig(depauditConfig);
  const osvLint = lintOsvScannerConfig(osvConfig);

  if (!depauditLint.isClean || !osvLint.isClean) {
    process.stderr.write("Lint failed — aborting scan\n");
    printLintResult(depauditLint, depauditConfig.filePath ?? ".depaudit.yml");
    printLintResult(osvLint, osvConfig.filePath ?? "osv-scanner.toml");
    return { findings: [], socketAvailable: true, osvAvailable: true, exitCode: 1 };
  }

  if (depauditLint.warnings.length > 0) {
    printLintResult(depauditLint, depauditConfig.filePath ?? ".depaudit.yml");
  }
  if (osvLint.warnings.length > 0) {
    printLintResult(osvLint, osvConfig.filePath ?? "osv-scanner.toml");
  }

  const manifests = await discoverManifests(scanPath);

  let osvAvailable = true;
  let osvFindings: import("../types/finding.js").Finding[] = [];
  // Raw OSV findings without applying the ignore config — used for orphan detection.
  // We use an empty temp TOML so osv-scanner reports ALL CVEs regardless of osv-scanner.toml.
  let osvRawFindings: import("../types/finding.js").Finding[] = [];
  let emptyConfigDir: string | undefined;

  try {
    osvFindings = await runOsvScanner(manifests);
  } catch {
    osvAvailable = false;
  }

  // Run a second pass with no ignore config to get the full unfiltered CVE list.
  // This is needed because osv-scanner suppresses accepted CVEs from its output,
  // which would otherwise make all accepted CVEs appear as orphans.
  if (osvAvailable && osvConfig.ignoredVulns.length > 0) {
    try {
      emptyConfigDir = await mkdtemp(join(tmpdir(), "depaudit-empty-cfg-"));
      const emptyConfigPath = join(emptyConfigDir, "osv-scanner.toml");
      await writeFile(emptyConfigPath, "", "utf8");
      osvRawFindings = await runOsvScanner(manifests, undefined, emptyConfigPath);
    } catch {
      // If raw scan fails, fall back to using the filtered findings.
      // This is safe: we just won't prune CVE accepts in this run.
      osvRawFindings = osvFindings;
    }
  } else {
    osvRawFindings = osvFindings;
  }

  // Build package ref set: manifests (all packages) + OSV findings (transitive CVE packages).
  // Using manifests ensures Socket is called even for clean repos with no CVEs.
  const packageRefMap = new Map<string, PackageRef>();

  const manifestPackages = await extractPackagesFromManifests(manifests);
  for (const ref of manifestPackages) {
    const key = `${ref.ecosystem}|${ref.package}|${ref.version}|${ref.manifestPath}`;
    packageRefMap.set(key, ref);
  }
  // OSV findings may include transitive packages not in lock files (e.g. go.sum, Cargo.lock)
  for (const f of osvFindings) {
    const key = `${f.ecosystem}|${f.package}|${f.version}|${f.manifestPath}` as string;
    if (!packageRefMap.has(key)) {
      packageRefMap.set(key, { ecosystem: f.ecosystem as Ecosystem, package: f.package, version: f.version, manifestPath: f.manifestPath });
    }
  }

  if (!osvAvailable) {
    process.stderr.write("osv: CVE scan failed catastrophically — continuing on available data\n");
  }

  let socketResult: { findings: import("../types/finding.js").Finding[]; available: boolean };
  try {
    socketResult = await fetchSocketFindings([...packageRefMap.values()]);
  } catch (err: unknown) {
    if (err instanceof SocketAuthError) {
      process.stderr.write(`error: ${err.message}\n`);
      return { findings: [], socketAvailable: false, osvAvailable: true, exitCode: 2 };
    }
    throw err;
  }

  if (!socketResult.available) {
    process.stderr.write("socket: supply-chain unavailable — scan continuing on CVE findings only\n");
  }

  // Use osvRawFindings (unfiltered by osv-scanner) so FindingMatcher can produce
  // the full four-way classification including "accepted" entries for findings.json.
  // Stdout and exit code are only affected by "new" and "expired-accept" categories.
  const allFindings = [...osvRawFindings, ...socketResult.findings];
  const classified = classifyFindings(allFindings, depauditConfig, osvConfig);

  const newFindings = classified.filter((c) => c.category === "new").map((c) => c.finding);

  const expiredAccepts = classified.filter((c) => c.category === "expired-accept");

  if (options.format === "text") {
    printFindings(newFindings);
    for (const cf of expiredAccepts) {
      process.stderr.write(`expired accept: ${cf.finding.package} ${cf.finding.version} ${cf.finding.findingId}\n`);
    }
  }

  // Auto-prune orphaned accept entries (fail-open guard: only prune when source was available).
  // For CVE orphan detection, use osvRawFindings (without suppression from osv-scanner.toml)
  // so we can correctly identify which CVEs are still present in the tree.
  const findingsForOrphanDetection = [...osvRawFindings, ...socketResult.findings];
  const orphans = findOrphans(findingsForOrphanDetection, depauditConfig, osvConfig);

  if (socketResult.available && depauditConfig.filePath && orphans.orphanedSupplyChain.length > 0) {
    const n = await pruneDepauditYml(depauditConfig.filePath, orphans.orphanedSupplyChain);
    if (n > 0) {
      process.stderr.write(
        `auto-prune: removed ${n} orphaned supplyChainAccepts entr${n === 1 ? "y" : "ies"} from .depaudit.yml\n`
      );
    }
  }

  if (osvAvailable && osvConfig.filePath && orphans.orphanedCve.length > 0) {
    const n = await pruneOsvScannerToml(osvConfig.filePath, orphans.orphanedCve);
    if (n > 0) {
      process.stderr.write(
        `auto-prune: removed ${n} orphaned IgnoredVulns entr${n === 1 ? "y" : "ies"} from osv-scanner.toml\n`
      );
    }
  }

  const exitCode = newFindings.length === 0 && expiredAccepts.length === 0 && osvAvailable ? 0 : 1;

  if (options.format === "markdown") {
    process.stdout.write(renderMarkdownReport({ findings: classified, socketAvailable: socketResult.available, osvAvailable, exitCode }));
  }

  await writeFindingsJson(scanPath, { findings: classified, socketAvailable: socketResult.available, osvAvailable, exitCode });

  return { findings: classified, socketAvailable: socketResult.available, osvAvailable, exitCode };
}
