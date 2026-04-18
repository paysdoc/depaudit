import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import ignore from "ignore";
import type { ClassifiedFinding, FindingCategory } from "../types/depauditConfig.js";

export type SourceAvailabilityLabel = "available" | "unavailable";

export interface FindingRecord {
  package: string;
  version: string;
  ecosystem: string;
  manifestPath: string;
  findingId: string;
  severity: string;
  summary: string | null;
  classification: FindingCategory;
  source: string;
  upgrade?: { suggestedVersion: string };
}

/**
 * Schema for `.depaudit/findings.json` — the static snapshot consumed by `/depaudit-triage`.
 * `classification` uses the verbatim `FindingCategory` strings (hyphenated `expired-accept` included).
 * `upgrade` is present only for OSV findings with a known resolving version; absent otherwise.
 * Cross-check `scannedAt` and the CLI exit code: a zero-finding file with a non-zero exit
 * means the scan hit a config/lint error before source queries were made.
 */
export interface FindingsJsonV1 {
  version: number;
  scannedAt: string;
  sourceAvailability: {
    osv: SourceAvailabilityLabel;
    socket: SourceAvailabilityLabel;
  };
  classifications: FindingCategory[];
  counts: {
    new: number;
    accepted: number;
    whitelisted: number;
    "expired-accept": number;
  };
  findings: FindingRecord[];
}

export interface RenderInput {
  findings: ClassifiedFinding[];
  socketAvailable: boolean;
  osvAvailable?: boolean;
  generatedAt: Date;
}

export interface GitignoreCheckResult {
  ignored: boolean;
  reason: "missing" | "not-matched" | "ok";
}

const ALL_CLASSIFICATIONS: FindingCategory[] = ["new", "accepted", "whitelisted", "expired-accept"];

export function renderFindingsJson(input: RenderInput): string {
  const osvLabel: SourceAvailabilityLabel = input.osvAvailable !== false ? "available" : "unavailable";
  const socketLabel: SourceAvailabilityLabel = input.socketAvailable ? "available" : "unavailable";

  const counts = { new: 0, accepted: 0, whitelisted: 0, "expired-accept": 0 };
  for (const cf of input.findings) {
    counts[cf.category] = (counts[cf.category] ?? 0) + 1;
  }

  const records: FindingRecord[] = input.findings.map((cf) => {
    const upgrade =
      cf.finding.source === "osv" && cf.finding.fixedIn
        ? { suggestedVersion: cf.finding.fixedIn }
        : undefined;

    return {
      package: cf.finding.package,
      version: cf.finding.version,
      ecosystem: cf.finding.ecosystem,
      manifestPath: cf.finding.manifestPath,
      findingId: cf.finding.findingId,
      severity: cf.finding.severity,
      summary: cf.finding.summary ?? null,
      classification: cf.category,
      source: cf.finding.source,
      ...(upgrade ? { upgrade } : {}),
    };
  });

  records.sort((a, b) => {
    for (const key of ["classification", "ecosystem", "package", "version", "findingId", "manifestPath"] as const) {
      const cmp = a[key].localeCompare(b[key]);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });

  const obj: FindingsJsonV1 = {
    version: 1,
    scannedAt: input.generatedAt.toISOString(),
    sourceAvailability: { osv: osvLabel, socket: socketLabel },
    classifications: ALL_CLASSIFICATIONS,
    counts,
    findings: records,
  };

  return JSON.stringify(obj, null, 2) + "\n";
}

export async function writeFindingsFile(scanPath: string, input: RenderInput): Promise<void> {
  const dir = join(scanPath, ".depaudit");
  const file = join(dir, "findings.json");
  await mkdir(dir, { recursive: true });
  await writeFile(file, renderFindingsJson(input), "utf8");
}

/**
 * Checks whether `.depaudit/findings.json` is covered by `<scanPath>/.gitignore`.
 * Only reads the root `.gitignore`; nested gitignore files are not walked.
 */
export async function checkGitignore(scanPath: string): Promise<GitignoreCheckResult> {
  let content: string;
  try {
    content = await readFile(join(scanPath, ".gitignore"), "utf8");
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "ENOENT") return { ignored: false, reason: "missing" };
    throw err;
  }

  const ig = ignore();
  ig.add(content);

  if (ig.ignores(".depaudit/findings.json")) {
    return { ignored: true, reason: "ok" };
  }
  return { ignored: false, reason: "not-matched" };
}

const GITIGNORE_WARNING =
  "warning: .depaudit/findings.json is not gitignored — add '.depaudit/' to your .gitignore or run 'depaudit setup'\n";

export function printGitignoreWarning(
  check: GitignoreCheckResult,
  stream: NodeJS.WritableStream = process.stderr
): void {
  if (check.ignored) return;
  stream.write(GITIGNORE_WARNING);
}
