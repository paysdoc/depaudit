import { describe, it, expect } from "vitest";
import { filterAcceptedFindings } from "../findingFilter.js";
import type { Finding } from "../../types/finding.js";
import type { OsvScannerConfig } from "../../types/osvScannerConfig.js";

const NOW = new Date("2026-04-18T00:00:00.000Z");

function daysFromNow(n: number): string {
  const d = new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function makeFinding(findingId: string): Finding {
  return {
    source: "osv",
    ecosystem: "npm",
    package: "test-pkg",
    version: "1.0.0",
    findingId,
    severity: "HIGH",
    manifestPath: "/tmp/package.json",
  };
}

const emptyConfig: OsvScannerConfig = { ignoredVulns: [], filePath: null };

describe("filterAcceptedFindings", () => {
  it("returns empty array when findings is empty", () => {
    const result = filterAcceptedFindings([], emptyConfig, NOW);
    expect(result).toEqual([]);
  });

  it("passes all findings through when ignoredVulns is empty", () => {
    const findings = [makeFinding("CVE-2021-23337"), makeFinding("GHSA-test")];
    const result = filterAcceptedFindings(findings, emptyConfig, NOW);
    expect(result).toHaveLength(2);
  });

  it("filters out finding whose id matches a non-expired acceptance", () => {
    const config: OsvScannerConfig = {
      filePath: "/tmp/osv-scanner.toml",
      ignoredVulns: [{ id: "CVE-2021-23337", ignoreUntil: daysFromNow(30), reason: "ok", sourceLine: 1 }],
    };
    const findings = [makeFinding("CVE-2021-23337")];
    const result = filterAcceptedFindings(findings, config, NOW);
    expect(result).toHaveLength(0);
  });

  it("does NOT filter finding with expired acceptance", () => {
    const config: OsvScannerConfig = {
      filePath: "/tmp/osv-scanner.toml",
      ignoredVulns: [{ id: "CVE-2021-23337", ignoreUntil: daysFromNow(-1), reason: "ok", sourceLine: 1 }],
    };
    const findings = [makeFinding("CVE-2021-23337")];
    const result = filterAcceptedFindings(findings, config, NOW);
    expect(result).toHaveLength(1);
  });

  it("passes through findings whose ids do not appear in ignoredVulns", () => {
    const config: OsvScannerConfig = {
      filePath: "/tmp/osv-scanner.toml",
      ignoredVulns: [{ id: "CVE-UNRELATED", ignoreUntil: daysFromNow(30), reason: "ok", sourceLine: 1 }],
    };
    const findings = [makeFinding("CVE-2021-23337")];
    const result = filterAcceptedFindings(findings, config, NOW);
    expect(result).toHaveLength(1);
  });

  it("handles mixed expiry: accepts if any non-expired entry matches", () => {
    const config: OsvScannerConfig = {
      filePath: "/tmp/osv-scanner.toml",
      ignoredVulns: [
        { id: "CVE-2021-23337", ignoreUntil: daysFromNow(-1), reason: "expired", sourceLine: 1 },
        { id: "CVE-2021-23337", ignoreUntil: daysFromNow(30), reason: "valid", sourceLine: 5 },
      ],
    };
    const findings = [makeFinding("CVE-2021-23337"), makeFinding("OTHER-CVE")];
    const result = filterAcceptedFindings(findings, config, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].findingId).toBe("OTHER-CVE");
  });
});
