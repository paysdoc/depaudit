import type { Finding } from "../types/finding.js";
import type { OsvScannerConfig } from "../types/osvScannerConfig.js";

export function filterAcceptedFindings(
  findings: Finding[],
  config: OsvScannerConfig,
  now: Date = new Date()
): Finding[] {
  const acceptedIds = new Set<string>();
  for (const entry of config.ignoredVulns) {
    const until = Date.parse(entry.ignoreUntil);
    if (!isNaN(until) && until >= now.getTime()) {
      acceptedIds.add(entry.id);
    }
  }
  return findings.filter((f) => !acceptedIds.has(f.findingId));
}
