import { promisify } from "node:util";
import * as childProcess from "node:child_process";
import { dirname } from "node:path";
import type { Manifest } from "../types/manifest.js";
import type { Finding, Severity } from "../types/finding.js";

export type ExecFileFn = (
  file: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = promisify(childProcess.execFile) as ExecFileFn;

const CANONICAL_SEVERITIES = new Set<string>(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);

function cvssScoreToSeverity(score: number): Severity {
  if (score >= 9.0) return "CRITICAL";
  if (score >= 7.0) return "HIGH";
  if (score >= 4.0) return "MEDIUM";
  if (score > 0) return "LOW";
  return "UNKNOWN";
}

function extractCvssScore(scoreString: string): number | null {
  // CVSS vector string contains /BV:... we extract the base score from metadata
  // OSV uses "score" field or we parse the CVSS vector's base score.
  // The score field in OSV severity entries is the CVSS vector string, not a number.
  // We need to parse the CVSS vector to determine base score, but that's complex.
  // Instead, use a heuristic: parse the AV/AC/PR/UI/S/C/I/A components.
  // For simplicity, fall back to UNKNOWN when we can't determine the score.
  // Real CVSS parsing is out of scope for this slice; we handle the `database_specific.severity` path first.
  return null;
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
      // Try to extract numeric base score from the CVSS vector's overall score.
      // OSV sometimes has a numeric score alongside; we check if the score field
      // is actually a number-like string vs a vector string.
      const possibleNumber = parseFloat(entry.score);
      if (!isNaN(possibleNumber) && possibleNumber <= 10) {
        return cvssScoreToSeverity(possibleNumber);
      }
      // score is a CVSS vector string — parse out component scores to approximate
      // For this slice we do a simple approach: HIGH for any CVSS_V3 entry
      // with I:H or C:H, otherwise MEDIUM. This is a best-effort approximation.
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
  execFile: ExecFileFn = defaultExecFile
): Promise<Finding[]> {
  if (manifests.length === 0) return [];

  const dirs = [...new Set(manifests.map((m) => dirname(m.path)))].sort();

  let stdout: string;
  try {
    const result = await execFile("osv-scanner", ["scan", "source", "--format=json", ...dirs]);
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

      if (ecosystem !== "npm") {
        throw new Error(
          `OsvScannerAdapter: unsupported ecosystem "${ecosystem}" — polyglot support lands in issue #4`
        );
      }

      for (const vuln of pkg.vulnerabilities) {
        findings.push({
          source: "osv",
          ecosystem: "npm",
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
