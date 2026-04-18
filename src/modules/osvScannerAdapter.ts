import { promisify } from "node:util";
import * as childProcess from "node:child_process";
import { dirname } from "node:path";
import type { Manifest } from "../types/manifest.js";
import type { Ecosystem, Finding, Severity } from "../types/finding.js";

export type ExecFileFn = (
  file: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = promisify(childProcess.execFile) as ExecFileFn;

const CANONICAL_SEVERITIES = new Set<string>(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);

const OSV_ECOSYSTEM_MAP: Record<string, Ecosystem> = {
  "npm": "npm",
  "PyPI": "pip",
  "Go": "gomod",
  "crates.io": "cargo",
  "Maven": "maven",
  "RubyGems": "gem",
  "Packagist": "composer",
};

function mapOsvEcosystem(osvEcosystem: string): Ecosystem {
  const mapped = OSV_ECOSYSTEM_MAP[osvEcosystem];
  if (!mapped) {
    throw new Error(
      `OsvScannerAdapter: unknown ecosystem "${osvEcosystem}" — supported: ${Object.keys(OSV_ECOSYSTEM_MAP).join(", ")}`
    );
  }
  return mapped;
}

function cvssScoreToSeverity(score: number): Severity {
  if (score >= 9.0) return "CRITICAL";
  if (score >= 7.0) return "HIGH";
  if (score >= 4.0) return "MEDIUM";
  if (score > 0) return "LOW";
  return "UNKNOWN";
}

function deriveSeverity(vuln: {
  database_specific?: { severity?: string };
  severity?: Array<{ type: string; score: string }>;
}): Severity {
  const dbSev = vuln.database_specific?.severity;
  if (dbSev && CANONICAL_SEVERITIES.has(dbSev)) {
    return dbSev as Severity;
  }

  const severityEntries = vuln.severity ?? [];
  for (const entry of severityEntries) {
    if (entry.type === "CVSS_V3" || entry.type === "CVSS_V2") {
      const possibleNumber = parseFloat(entry.score);
      if (!isNaN(possibleNumber) && possibleNumber <= 10) {
        return cvssScoreToSeverity(possibleNumber);
      }
      if (entry.score.includes("/I:H") || entry.score.includes("/C:H")) {
        return "HIGH";
      }
      return "MEDIUM";
    }
  }

  return "UNKNOWN";
}

interface OsvOutput {
  results: Array<{
    source: { path: string; type: string };
    packages: Array<{
      package: { name: string; version: string; ecosystem: string };
      vulnerabilities: Array<{
        id: string;
        summary?: string;
        database_specific?: { severity?: string };
        severity?: Array<{ type: string; score: string }>;
        aliases?: string[];
      }>;
    }>;
  }>;
}

export async function runOsvScanner(
  manifests: Manifest[],
  execFile: ExecFileFn = defaultExecFile,
  overrideConfigFile?: string
): Promise<Finding[]> {
  if (manifests.length === 0) return [];

  const dirs = [...new Set(manifests.map((m) => dirname(m.path)))].sort();

  const args = ["scan", "source", "--format=json"];
  if (overrideConfigFile !== undefined) {
    args.push("--config", overrideConfigFile);
  }
  args.push(...dirs);

  let stdout: string;
  try {
    const result = await execFile("osv-scanner", args);
    stdout = result.stdout;
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    if (e.code === 1 && e.stdout) {
      stdout = e.stdout;
    } else {
      throw err;
    }
  }

  const parsed: OsvOutput = JSON.parse(stdout);
  const findings: Finding[] = [];

  for (const result of parsed.results) {
    for (const pkg of result.packages) {
      const { name, version, ecosystem } = pkg.package;
      const mappedEcosystem = mapOsvEcosystem(ecosystem);

      for (const vuln of pkg.vulnerabilities) {
        findings.push({
          source: "osv",
          ecosystem: mappedEcosystem,
          package: name,
          version,
          findingId: vuln.id,
          severity: deriveSeverity(vuln),
          summary: vuln.summary,
          manifestPath: result.source.path,
        });
      }
    }
  }

  return findings;
}
