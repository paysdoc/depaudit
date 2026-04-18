import type { Finding } from "../types/finding.js";
import type { OsvScannerConfig, IgnoredVuln } from "../types/osvScannerConfig.js";
import type { DepauditConfig, ClassifiedFinding, CommonAndFineEntry, SupplyChainAccept } from "../types/depauditConfig.js";
import { SEVERITY_RANK } from "../types/depauditConfig.js";

export function classifyFindings(
  findings: Finding[],
  depauditConfig: DepauditConfig,
  osvConfig: OsvScannerConfig,
  now: Date = new Date()
): ClassifiedFinding[] {
  const cveAcceptByIdMap = new Map<string, IgnoredVuln[]>();
  for (const vuln of osvConfig.ignoredVulns) {
    const list = cveAcceptByIdMap.get(vuln.id) ?? [];
    list.push(vuln);
    cveAcceptByIdMap.set(vuln.id, list);
  }

  const scaAcceptByKey = new Map<string, SupplyChainAccept[]>();
  for (const sca of depauditConfig.supplyChainAccepts) {
    const key = `${sca.package}|${sca.version}|${sca.findingId}`;
    const list = scaAcceptByKey.get(key) ?? [];
    list.push(sca);
    scaAcceptByKey.set(key, list);
  }

  const cfByPkgAlert = new Map<string, CommonAndFineEntry[]>();
  for (const cf of depauditConfig.commonAndFine) {
    const key = `${cf.package}|${cf.alertType}`;
    const list = cfByPkgAlert.get(key) ?? [];
    list.push(cf);
    cfByPkgAlert.set(key, list);
  }

  const thresholdRank = SEVERITY_RANK[
    depauditConfig.policy.severityThreshold === "medium" ? "MEDIUM"
    : depauditConfig.policy.severityThreshold === "high" ? "HIGH"
    : "CRITICAL"
  ];

  const result: ClassifiedFinding[] = [];

  for (const finding of findings) {
    // Rule 1: CVE accept
    if (finding.source === "osv") {
      const cveAccepts = cveAcceptByIdMap.get(finding.findingId);
      if (cveAccepts && cveAccepts.length > 0) {
        const active = cveAccepts.find((v) => new Date(v.ignoreUntil) >= now);
        if (active) {
          result.push({ finding, category: "accepted" });
        } else {
          result.push({ finding, category: "expired-accept" });
        }
        continue;
      }
    }

    // Rule 2: Supply-chain accept
    if (finding.source === "socket") {
      const key = `${finding.package}|${finding.version}|${finding.findingId}`;
      const scaAccepts = scaAcceptByKey.get(key);
      if (scaAccepts && scaAccepts.length > 0) {
        const active = scaAccepts.find((s) => new Date(s.expires) >= now);
        if (active) {
          result.push({ finding, category: "accepted" });
        } else {
          result.push({ finding, category: "expired-accept" });
        }
        continue;
      }
    }

    // Rule 3: commonAndFine match (any source)
    const cfKey = `${finding.package}|${finding.findingId}`;
    const cfEntries = cfByPkgAlert.get(cfKey);
    if (cfEntries && cfEntries.length > 0) {
      const active = cfEntries.find((cf) => new Date(cf.expires) >= now);
      if (active) {
        result.push({ finding, category: "whitelisted" });
        continue;
      }
    }

    // Rule 4: severity threshold — drop below-threshold from new bucket
    const rank = SEVERITY_RANK[finding.severity];
    if (rank >= thresholdRank) {
      result.push({ finding, category: "new" });
    }
    // else: drop entirely
  }

  return result;
}
