import type { ScanResult } from "../types/scanResult.js";
import type { ClassifiedFinding, FindingCategory } from "../types/depauditConfig.js";
import { MARKDOWN_COMMENT_MARKER, type MarkdownReportOptions } from "../types/markdownReport.js";

function bucketByCategory(findings: ClassifiedFinding[]): Record<FindingCategory, ClassifiedFinding[]> {
  return {
    new: findings.filter((c) => c.category === "new"),
    accepted: findings.filter((c) => c.category === "accepted"),
    whitelisted: findings.filter((c) => c.category === "whitelisted"),
    "expired-accept": findings.filter((c) => c.category === "expired-accept"),
  };
}

function compareForRender(a: ClassifiedFinding, b: ClassifiedFinding): number {
  return (
    a.finding.manifestPath.localeCompare(b.finding.manifestPath) ||
    a.finding.source.localeCompare(b.finding.source) ||
    a.finding.findingId.localeCompare(b.finding.findingId) ||
    a.finding.package.localeCompare(b.finding.package) ||
    a.finding.version.localeCompare(b.finding.version)
  );
}

function escapeCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function defaultSuggestedAction(cf: ClassifiedFinding): string {
  if (cf.category === "expired-accept") return "re-evaluate or extend acceptance";
  if (cf.finding.fixedVersion) return `upgrade ${cf.finding.package} to >=${cf.finding.fixedVersion}`;
  return "investigate; accept or upgrade";
}

function renderTable(rows: ClassifiedFinding[], suggestedAction: (cf: ClassifiedFinding) => string): string {
  if (rows.length === 0) return "";
  const header = "| severity | package | version | finding-id | suggested action |";
  const separator = "| --- | --- | --- | --- | --- |";
  const bodyLines = rows.map((cf) => {
    const f = cf.finding;
    const action = escapeCell(suggestedAction(cf));
    return `| ${escapeCell(f.severity)} | ${escapeCell(f.package)} | ${escapeCell(f.version)} | ${escapeCell(f.findingId)} | ${action} |`;
  });
  return [header, separator, ...bodyLines].join("\n");
}

export function renderMarkdownReport(result: ScanResult, options: MarkdownReportOptions = {}): string {
  const buckets = bucketByCategory(result.findings);
  buckets.new.sort(compareForRender);
  buckets["expired-accept"].sort(compareForRender);

  const action = options.suggestedActionFor ?? defaultSuggestedAction;

  const lines: string[] = [];
  lines.push("");
  lines.push(MARKDOWN_COMMENT_MARKER);
  lines.push("");
  lines.push(result.exitCode === 0 ? "## depaudit gate: PASS" : "## depaudit gate: FAIL");
  lines.push("");
  lines.push(`- new: ${buckets.new.length}`);
  lines.push(`- accepted: ${buckets.accepted.length}`);
  lines.push(`- whitelisted: ${buckets.whitelisted.length}`);
  lines.push(`- expired: ${buckets["expired-accept"].length}`);

  if (buckets.new.length > 0) {
    lines.push("");
    lines.push(`### New findings (${buckets.new.length})`);
    lines.push("");
    lines.push(renderTable(buckets.new, action));
  }

  if (buckets["expired-accept"].length > 0) {
    lines.push("");
    lines.push(`### Expired accepts (${buckets["expired-accept"].length})`);
    lines.push("");
    lines.push(renderTable(buckets["expired-accept"], action));
  }

  if (result.socketAvailable === false) {
    lines.push("");
    lines.push("> supply-chain unavailable — Socket scan failed; CVE-only gating ran for this run.");
  }

  if (result.osvAvailable === false) {
    lines.push("");
    lines.push("> CVE scan unavailable — OSV scanner failed; supply-chain gating ran for this run.");
  }

  return lines.join("\n") + "\n";
}
