import { describe, it, expect } from "vitest";
import { classifyFindings } from "../findingMatcher.js";
import type { Finding } from "../../types/finding.js";
import type { OsvScannerConfig } from "../../types/osvScannerConfig.js";
import type { DepauditConfig } from "../../types/depauditConfig.js";
import { DEFAULT_DEPAUDIT_CONFIG } from "../../types/depauditConfig.js";

const NOW = new Date("2026-04-18T00:00:00.000Z");

function daysFromNow(n: number): string {
  const d = new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function makeOsvFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "osv", ecosystem: "npm", package: "semver", version: "5.7.1",
    findingId: "GHSA-c2qf-rxjj-qqgw", severity: "MEDIUM",
    manifestPath: "/tmp/package-lock.json", ...overrides,
  };
}

function makeSocketFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "socket", ecosystem: "npm", package: "lodash", version: "4.17.20",
    findingId: "deprecated", severity: "MEDIUM",
    manifestPath: "/tmp/package-lock.json", ...overrides,
  };
}

const emptyOsvConfig: OsvScannerConfig = { ignoredVulns: [], filePath: null };
const emptyDepauditConfig: DepauditConfig = { ...DEFAULT_DEPAUDIT_CONFIG, filePath: "/tmp/.depaudit.yml" };

describe("classifyFindings", () => {
  it("empty findings returns []", () => {
    expect(classifyFindings([], emptyDepauditConfig, emptyOsvConfig, NOW)).toHaveLength(0);
  });

  it("OSV finding matching non-expired IgnoredVulns → accepted", () => {
    const finding = makeOsvFinding();
    const osvConfig: OsvScannerConfig = {
      ignoredVulns: [{ id: finding.findingId, ignoreUntil: daysFromNow(30), reason: "pending fix" }],
      filePath: null,
    };
    const result = classifyFindings([finding], emptyDepauditConfig, osvConfig, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("accepted");
  });

  it("OSV finding matching expired IgnoredVulns → expired-accept", () => {
    const finding = makeOsvFinding();
    const osvConfig: OsvScannerConfig = {
      ignoredVulns: [{ id: finding.findingId, ignoreUntil: daysFromNow(-1), reason: "expired" }],
      filePath: null,
    };
    const result = classifyFindings([finding], emptyDepauditConfig, osvConfig, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("expired-accept");
  });

  it("Socket finding matching non-expired supplyChainAccepts → accepted", () => {
    const finding = makeSocketFinding();
    const config: DepauditConfig = {
      ...emptyDepauditConfig,
      supplyChainAccepts: [{
        package: finding.package, version: finding.version, findingId: finding.findingId,
        expires: daysFromNow(30), reason: "upstream fix pending in next major release cycle",
      }],
    };
    const result = classifyFindings([finding], config, emptyOsvConfig, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("accepted");
  });

  it("Socket finding matching expired supplyChainAccepts → expired-accept", () => {
    const finding = makeSocketFinding();
    const config: DepauditConfig = {
      ...emptyDepauditConfig,
      supplyChainAccepts: [{
        package: finding.package, version: finding.version, findingId: finding.findingId,
        expires: daysFromNow(-1), reason: "upstream fix pending in next major release cycle",
      }],
    };
    const result = classifyFindings([finding], config, emptyOsvConfig, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("expired-accept");
  });

  it("finding matching non-expired commonAndFine entry → whitelisted", () => {
    const finding = makeOsvFinding();
    const config: DepauditConfig = {
      ...emptyDepauditConfig,
      commonAndFine: [{ package: finding.package, alertType: finding.findingId, expires: daysFromNow(60) }],
    };
    const result = classifyFindings([finding], config, emptyOsvConfig, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("whitelisted");
  });

  it("first-match-wins: expired CVE accept beats valid commonAndFine → expired-accept", () => {
    const finding = makeOsvFinding();
    const osvConfig: OsvScannerConfig = {
      ignoredVulns: [{ id: finding.findingId, ignoreUntil: daysFromNow(-1), reason: "expired" }],
      filePath: null,
    };
    const config: DepauditConfig = {
      ...emptyDepauditConfig,
      commonAndFine: [{ package: finding.package, alertType: finding.findingId, expires: daysFromNow(60) }],
    };
    const result = classifyFindings([finding], config, osvConfig, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("expired-accept");
  });

  it("severity threshold medium: MEDIUM finding → new", () => {
    const result = classifyFindings([makeOsvFinding({ severity: "MEDIUM" })], emptyDepauditConfig, emptyOsvConfig, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("new");
  });

  it("severity threshold medium: LOW finding → dropped", () => {
    const result = classifyFindings([makeOsvFinding({ severity: "LOW" })], emptyDepauditConfig, emptyOsvConfig, NOW);
    expect(result).toHaveLength(0);
  });

  it("severity threshold high: MEDIUM finding → dropped", () => {
    const config: DepauditConfig = {
      ...emptyDepauditConfig, policy: { ...DEFAULT_DEPAUDIT_CONFIG.policy, severityThreshold: "high" },
    };
    expect(classifyFindings([makeOsvFinding({ severity: "MEDIUM" })], config, emptyOsvConfig, NOW)).toHaveLength(0);
  });

  it("severity threshold high: HIGH finding → new", () => {
    const config: DepauditConfig = {
      ...emptyDepauditConfig, policy: { ...DEFAULT_DEPAUDIT_CONFIG.policy, severityThreshold: "high" },
    };
    const result = classifyFindings([makeOsvFinding({ severity: "HIGH" })], config, emptyOsvConfig, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("new");
  });

  it("severity threshold critical: HIGH finding → dropped", () => {
    const config: DepauditConfig = {
      ...emptyDepauditConfig, policy: { ...DEFAULT_DEPAUDIT_CONFIG.policy, severityThreshold: "critical" },
    };
    expect(classifyFindings([makeOsvFinding({ severity: "HIGH" })], config, emptyOsvConfig, NOW)).toHaveLength(0);
  });

  it("severity threshold critical: CRITICAL finding → new", () => {
    const config: DepauditConfig = {
      ...emptyDepauditConfig, policy: { ...DEFAULT_DEPAUDIT_CONFIG.policy, severityThreshold: "critical" },
    };
    const result = classifyFindings([makeOsvFinding({ severity: "CRITICAL" })], config, emptyOsvConfig, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("new");
  });

  it("threshold does not drop whitelisted: LOW whitelisted still returned", () => {
    const finding = makeOsvFinding({ severity: "LOW" });
    const config: DepauditConfig = {
      ...emptyDepauditConfig,
      commonAndFine: [{ package: finding.package, alertType: finding.findingId, expires: daysFromNow(60) }],
    };
    const result = classifyFindings([finding], config, emptyOsvConfig, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("whitelisted");
  });

  it("UNKNOWN severity with no accept match → dropped", () => {
    expect(classifyFindings([makeOsvFinding({ severity: "UNKNOWN" })], emptyDepauditConfig, emptyOsvConfig, NOW)).toHaveLength(0);
  });

  it("order preservation: [high, low-dropped, critical] → [high, critical]", () => {
    const a = makeOsvFinding({ findingId: "CVE-A", severity: "HIGH" });
    const dropped = makeOsvFinding({ findingId: "CVE-B", severity: "LOW" });
    const c = makeOsvFinding({ findingId: "CVE-C", severity: "CRITICAL" });
    const result = classifyFindings([a, dropped, c], emptyDepauditConfig, emptyOsvConfig, NOW);
    expect(result).toHaveLength(2);
    expect(result[0].finding.findingId).toBe("CVE-A");
    expect(result[1].finding.findingId).toBe("CVE-C");
  });
});
