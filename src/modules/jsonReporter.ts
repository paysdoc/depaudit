import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import ignore from "ignore";
import type { ScanResult } from "../types/scanResult.js";
import type { FindingsJsonSchema, FindingsJsonEntry } from "../types/findingsJson.js";
import { CURRENT_SCHEMA_VERSION } from "../types/findingsJson.js";
import type { ClassifiedFinding } from "../types/depauditConfig.js";

export function buildFindingsJsonSchema(result: ScanResult): FindingsJsonSchema {
  const entries: FindingsJsonEntry[] = result.findings.map((cf: ClassifiedFinding) => ({
    package: cf.finding.package,
    version: cf.finding.version,
    ecosystem: cf.finding.ecosystem,
    manifestPath: cf.finding.manifestPath,
    findingId: cf.finding.findingId,
    severity: cf.finding.severity,
    summary: cf.finding.summary ?? "",
    classification: cf.category,
    source: cf.finding.source,
    upgradeSuggestion: null,
  }));

  entries.sort((a, b) => {
    return (
      a.manifestPath.localeCompare(b.manifestPath) ||
      a.source.localeCompare(b.source) ||
      a.findingId.localeCompare(b.findingId) ||
      a.package.localeCompare(b.package) ||
      a.version.localeCompare(b.version)
    );
  });

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    sourceAvailability: {
      osv: result.osvAvailable,
      socket: result.socketAvailable,
    },
    findings: entries,
  };
}

async function isFindingsJsonGitignored(scanPath: string): Promise<boolean> {
  const absPath = resolve(scanPath);
  let raw: string;
  try {
    raw = await readFile(`${absPath}/.gitignore`, "utf8");
  } catch {
    return false;
  }
  const ig = ignore();
  ig.add(raw);
  return ig.ignores(".depaudit/findings.json");
}

export async function writeFindingsJson(
  scanPath: string,
  result: ScanResult,
  options: { stdoutStream?: NodeJS.WritableStream } = {}
): Promise<void> {
  const stream = options.stdoutStream ?? process.stdout;
  const schema = buildFindingsJsonSchema(result);
  const outPath = resolve(scanPath, ".depaudit", "findings.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
  const covered = await isFindingsJsonGitignored(scanPath);
  if (!covered) {
    stream.write(
      "warning: .depaudit/findings.json is not gitignored — run 'depaudit setup' or add '.depaudit/' to your .gitignore\n"
    );
  }
}
