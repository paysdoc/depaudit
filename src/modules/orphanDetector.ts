import type { Finding } from "../types/finding.js";
import type { DepauditConfig, SupplyChainAccept } from "../types/depauditConfig.js";
import type { OsvScannerConfig, IgnoredVuln } from "../types/osvScannerConfig.js";

export interface OrphanResult {
  orphanedSupplyChain: SupplyChainAccept[];
  orphanedCve: IgnoredVuln[];
}

/**
 * Pure function — no I/O.
 *
 * Determines which accept entries in the config files are "orphaned" (i.e. the
 * finding they were created to suppress no longer appears in the current scan).
 *
 * Source discrimination rules:
 * - Supply-chain accepts are checked against socket findings only
 * - CVE accepts are checked against osv findings only
 * - A socket finding does NOT protect a CVE accept and vice-versa
 */
export function findOrphans(
  findings: Finding[],
  depauditConfig: DepauditConfig,
  osvConfig: OsvScannerConfig
): OrphanResult {
  // Build the seen set from socket findings
  const seenSupplyChain = new Set<string>();
  for (const f of findings) {
    if (f.source === "socket") {
      const key = `${f.package}|${f.version}|${f.findingId}`;
      seenSupplyChain.add(key);
    }
  }

  // Build the seen set from osv findings
  const seenCve = new Set<string>();
  for (const f of findings) {
    if (f.source === "osv") {
      seenCve.add(f.findingId);
    }
  }

  // Find orphaned supply chain accepts
  const orphanedSupplyChain: SupplyChainAccept[] = [];
  for (const sca of depauditConfig.supplyChainAccepts) {
    const key = `${sca.package}|${sca.version}|${sca.findingId}`;
    if (!seenSupplyChain.has(key)) {
      orphanedSupplyChain.push(sca);
    }
  }

  // Find orphaned CVE accepts
  const orphanedCve: IgnoredVuln[] = [];
  for (const vuln of osvConfig.ignoredVulns) {
    if (!seenCve.has(vuln.id)) {
      orphanedCve.push(vuln);
    }
  }

  return { orphanedSupplyChain, orphanedCve };
}
