import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { discoverManifests } from "../modules/manifestDiscoverer.js";
import { runOsvScanner } from "../modules/osvScannerAdapter.js";
import { printFindings } from "../modules/stdoutReporter.js";
import { loadOsvScannerConfig, loadDepauditConfig, ConfigParseError } from "../modules/configLoader.js";
import { lintOsvScannerConfig, lintDepauditConfig } from "../modules/linter.js";
import { printLintResult } from "../modules/lintReporter.js";
import { classifyFindings } from "../modules/findingMatcher.js";
import { fetchSocketFindings, SocketAuthError, type PackageRef } from "../modules/socketApiClient.js";
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

export async function runScanCommand(scanPath: string): Promise<ScanResult> {
  let depauditConfig;
  try {
    depauditConfig = await loadDepauditConfig(scanPath);
  } catch (err: unknown) {
    if (err instanceof ConfigParseError) {
      printLintResult(
        { errors: [{ severity: "error", message: err.message, line: err.line, column: err.column }], warnings: [], isClean: false },
        err.filePath
      );
      return { findings: [], socketAvailable: true, exitCode: 2 };
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
      return { findings: [], socketAvailable: true, exitCode: 2 };
    }
    throw err;
  }

  const depauditLint = lintDepauditConfig(depauditConfig);
  const osvLint = lintOsvScannerConfig(osvConfig);

  if (!depauditLint.isClean || !osvLint.isClean) {
    process.stderr.write("Lint failed — aborting scan\n");
    printLintResult(depauditLint, depauditConfig.filePath ?? ".depaudit.yml");
    printLintResult(osvLint, osvConfig.filePath ?? "osv-scanner.toml");
    return { findings: [], socketAvailable: true, exitCode: 1 };
  }

  if (depauditLint.warnings.length > 0) {
    printLintResult(depauditLint, depauditConfig.filePath ?? ".depaudit.yml");
  }
  if (osvLint.warnings.length > 0) {
    printLintResult(osvLint, osvConfig.filePath ?? "osv-scanner.toml");
  }

  const manifests = await discoverManifests(scanPath);
  const osvFindings = await runOsvScanner(manifests);

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

  let socketResult: { findings: import("../types/finding.js").Finding[]; available: boolean };
  try {
    socketResult = await fetchSocketFindings([...packageRefMap.values()]);
  } catch (err: unknown) {
    if (err instanceof SocketAuthError) {
      process.stderr.write(`error: ${err.message}\n`);
      return { findings: [], socketAvailable: false, exitCode: 2 };
    }
    throw err;
  }

  if (!socketResult.available) {
    process.stderr.write("socket: supply-chain unavailable — scan continuing on CVE findings only\n");
  }

  const allFindings = [...osvFindings, ...socketResult.findings];
  const classified = classifyFindings(allFindings, depauditConfig, osvConfig);

  const newFindings = classified.filter((c) => c.category === "new").map((c) => c.finding);
  printFindings(newFindings);

  const expiredAccepts = classified.filter((c) => c.category === "expired-accept");
  for (const cf of expiredAccepts) {
    process.stderr.write(`expired accept: ${cf.finding.package} ${cf.finding.version} ${cf.finding.findingId}\n`);
  }

  const exitCode = newFindings.length === 0 && expiredAccepts.length === 0 ? 0 : 1;
  return { findings: classified, socketAvailable: socketResult.available, exitCode };
}
