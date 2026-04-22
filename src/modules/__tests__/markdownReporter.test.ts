import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { renderMarkdownReport } from "../markdownReporter.js";
import { MARKDOWN_COMMENT_MARKER } from "../../types/markdownReport.js";
import type { ScanResult } from "../../types/scanResult.js";
import type { ClassifiedFinding } from "../../types/depauditConfig.js";
import type { Finding } from "../../types/finding.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/markdown-output");

function makeOsvFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "osv",
    ecosystem: "npm",
    package: "semver",
    version: "5.7.1",
    findingId: "GHSA-c2qf-rxjj-qqgw",
    severity: "MEDIUM",
    manifestPath: "/repo/package-lock.json",
    ...overrides,
  };
}

function makeSocketFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "socket",
    ecosystem: "npm",
    package: "ms",
    version: "2.1.3",
    findingId: "install-scripts",
    severity: "HIGH",
    manifestPath: "/repo/package-lock.json",
    ...overrides,
  };
}

function makeScanResult(findings: ClassifiedFinding[] = [], overrides: Partial<ScanResult> = {}): ScanResult {
  return { findings, socketAvailable: true, osvAvailable: true, exitCode: 0, ...overrides };
}

async function loadFixture(name: string): Promise<string> {
  return readFile(join(FIXTURES_DIR, name), "utf8");
}

// ─── Group 1: Marker and header ──────────────────────────────────────────────

describe("marker and header", () => {
  it("output begins with a blank line then the HTML comment marker", () => {
    const result = renderMarkdownReport(makeScanResult());
    expect(result.startsWith(`\n${MARKDOWN_COMMENT_MARKER}`)).toBe(true);
  });

  it("exitCode 0 → header reads '## depaudit gate: PASS'", () => {
    const result = renderMarkdownReport(makeScanResult([], { exitCode: 0 }));
    expect(result).toContain("## depaudit gate: PASS");
  });

  it("exitCode 1 → header reads '## depaudit gate: FAIL'", () => {
    const result = renderMarkdownReport(makeScanResult([], { exitCode: 1 }));
    expect(result).toContain("## depaudit gate: FAIL");
  });

  it("marker is present on both pass and fail", () => {
    const pass = renderMarkdownReport(makeScanResult([], { exitCode: 0 }));
    const fail = renderMarkdownReport(makeScanResult([], { exitCode: 1 }));
    expect(pass).toContain(MARKDOWN_COMMENT_MARKER);
    expect(fail).toContain(MARKDOWN_COMMENT_MARKER);
  });
});

// ─── Group 2: Per-category count list ────────────────────────────────────────

describe("per-category count list", () => {
  it("all four counts always present even when zero", () => {
    const result = renderMarkdownReport(makeScanResult());
    expect(result).toContain("- new: 0");
    expect(result).toContain("- accepted: 0");
    expect(result).toContain("- whitelisted: 0");
    expect(result).toContain("- expired: 0");
  });

  it("expired count comes from the expired-accept bucket (label is 'expired', not 'expired-accept')", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding(), category: "expired-accept" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toContain("- expired: 1");
    expect(result).not.toContain("- expired-accept:");
  });

  it("counts reflect each category independently", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ findingId: "NEW-001" }), category: "new" },
      { finding: makeOsvFinding({ findingId: "ACC-001" }), category: "accepted" },
      { finding: makeSocketFinding({ findingId: "WHL-001" }), category: "whitelisted" },
      { finding: makeOsvFinding({ findingId: "EXP-001" }), category: "expired-accept" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toContain("- new: 1");
    expect(result).toContain("- accepted: 1");
    expect(result).toContain("- whitelisted: 1");
    expect(result).toContain("- expired: 1");
  });
});

// ─── Group 3: New-findings table ─────────────────────────────────────────────

describe("new-findings table", () => {
  it("table is omitted when new count is zero", () => {
    const result = renderMarkdownReport(makeScanResult());
    expect(result).not.toContain("### New findings");
    expect(result).not.toContain("| severity |");
  });

  it("table header row is exactly the required columns", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding(), category: "new" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toContain("| severity | package | version | finding-id | suggested action |");
    expect(result).toContain("| --- | --- | --- | --- | --- |");
  });

  it("rows appear in deterministic sort order (manifestPath, source, findingId, package, version)", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ findingId: "Z-ID" }), category: "new" },
      { finding: makeOsvFinding({ findingId: "A-ID" }), category: "new" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    const aIdx = result.indexOf("A-ID");
    const zIdx = result.indexOf("Z-ID");
    expect(aIdx).toBeLessThan(zIdx);
  });

  it("shuffled input produces the same output as pre-sorted input", () => {
    const f1: ClassifiedFinding = { finding: makeOsvFinding({ findingId: "B-ID" }), category: "new" };
    const f2: ClassifiedFinding = { finding: makeOsvFinding({ findingId: "A-ID" }), category: "new" };
    const sorted = renderMarkdownReport(makeScanResult([f2, f1], { exitCode: 1 }));
    const shuffled = renderMarkdownReport(makeScanResult([f1, f2], { exitCode: 1 }));
    expect(sorted).toBe(shuffled);
  });

  it("suggested action defaults to 'investigate; accept or upgrade' when fixedVersion is absent", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding(), category: "new" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toContain("investigate; accept or upgrade");
  });

  it("suggested action renders 'upgrade <package> to >=<fixedVersion>' when fixedVersion is set", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ fixedVersion: "5.7.2" }), category: "new" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toContain("upgrade semver to >=5.7.2");
  });

  it("socket-sourced new findings render the plain-text fallback (no fixedVersion)", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeSocketFinding(), category: "new" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toContain("investigate; accept or upgrade");
  });

  it("custom suggestedActionFor hook overrides both fixed-version and plain-text defaults", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ fixedVersion: "5.7.2" }), category: "new" },
    ];
    const result = renderMarkdownReport(
      makeScanResult(findings, { exitCode: 1 }),
      { suggestedActionFor: () => "custom action" }
    );
    expect(result).toContain("custom action");
    expect(result).not.toContain("upgrade semver");
  });

  it("custom hook returning empty string renders an empty cell", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding(), category: "new" },
    ];
    const result = renderMarkdownReport(
      makeScanResult(findings, { exitCode: 1 }),
      { suggestedActionFor: () => "" }
    );
    expect(result).toContain("|  |");
  });
});

// ─── Group 4: Expired-accepts section ────────────────────────────────────────

describe("expired-accepts section", () => {
  it("section is omitted when expired-accept count is zero", () => {
    const result = renderMarkdownReport(makeScanResult());
    expect(result).not.toContain("### Expired accepts");
  });

  it("section header reads '### Expired accepts (<n>)'", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding(), category: "expired-accept" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toContain("### Expired accepts (1)");
  });

  it("suggested action defaults to 're-evaluate or extend acceptance' for expired rows", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ fixedVersion: "5.7.2" }), category: "expired-accept" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toContain("re-evaluate or extend acceptance");
    expect(result).not.toContain("upgrade semver");
  });
});

// ─── Group 5: Supply-chain / OSV annotations ─────────────────────────────────

describe("supply-chain and OSV annotations", () => {
  it("socketAvailable false adds the supply-chain-unavailable line", () => {
    const result = renderMarkdownReport(makeScanResult([], { socketAvailable: false }));
    expect(result).toContain("> supply-chain unavailable — Socket scan failed; CVE-only gating ran for this run.");
  });

  it("socketAvailable true omits the supply-chain-unavailable line", () => {
    const result = renderMarkdownReport(makeScanResult([], { socketAvailable: true }));
    expect(result).not.toContain("> supply-chain unavailable");
  });

  it("osvAvailable false adds the CVE-unavailable line", () => {
    const result = renderMarkdownReport(makeScanResult([], { osvAvailable: false }));
    expect(result).toContain("> CVE scan unavailable — OSV scanner failed; supply-chain gating ran for this run.");
  });

  it("osvAvailable true omits the CVE-unavailable line", () => {
    const result = renderMarkdownReport(makeScanResult([], { osvAvailable: true }));
    expect(result).not.toContain("> CVE scan unavailable");
  });

  it("both false together emit both lines, supply-chain first", () => {
    const result = renderMarkdownReport(makeScanResult([], { socketAvailable: false, osvAvailable: false }));
    const socketIdx = result.indexOf("> supply-chain unavailable");
    const osvIdx = result.indexOf("> CVE scan unavailable");
    expect(socketIdx).toBeGreaterThan(-1);
    expect(osvIdx).toBeGreaterThan(-1);
    expect(socketIdx).toBeLessThan(osvIdx);
  });
});

// ─── Group 6: Cell escapes ────────────────────────────────────────────────────

describe("cell escapes", () => {
  it("pipe character in package name is escaped to \\|", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ package: "foo|bar" }), category: "new" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toContain("foo\\|bar");
    expect(result).not.toMatch(/\| foo\|bar \|/);
  });

  it("newline in suggested action (via hook) is replaced with a space", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ summary: "line1\nline2" }), category: "new" },
    ];
    const result = renderMarkdownReport(
      makeScanResult(findings, { exitCode: 1 }),
      { suggestedActionFor: (cf) => cf.finding.summary ?? "" }
    );
    expect(result).toContain("line1 line2");
    expect(result).not.toContain("line1\nline2");
  });

  it("backslash in package name is double-escaped before pipe escape", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ package: "back\\slash" }), category: "new" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toContain("back\\\\slash");
  });
});

// ─── Group 7: Determinism and purity ─────────────────────────────────────────

describe("determinism and purity", () => {
  it("same ScanResult passed twice yields byte-identical strings", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding(), category: "new" },
    ];
    const result = makeScanResult(findings, { exitCode: 1 });
    expect(renderMarkdownReport(result)).toBe(renderMarkdownReport(result));
  });

  it("renderer does not mutate result.findings", () => {
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ findingId: "B-ID" }), category: "new" },
      { finding: makeOsvFinding({ findingId: "A-ID" }), category: "new" },
    ];
    const frozen = Object.freeze({ ...makeScanResult(findings, { exitCode: 1 }), findings: Object.freeze([...findings]) });
    expect(() => renderMarkdownReport(frozen as ScanResult)).not.toThrow();
    // Verify original order unchanged
    expect((frozen as ScanResult).findings[0].finding.findingId).toBe("B-ID");
  });

  it("output always ends with a single trailing newline", () => {
    const result = renderMarkdownReport(makeScanResult());
    expect(result.endsWith("\n")).toBe(true);
    expect(result.endsWith("\n\n")).toBe(false);
  });
});

// ─── Group 8: Fixture comparison ─────────────────────────────────────────────

describe("fixture comparison", () => {
  it("pass-empty: clean scan all categories at 0", async () => {
    const expected = await loadFixture("pass-empty.expected.md");
    const result = renderMarkdownReport(makeScanResult([], { exitCode: 0 }));
    expect(result).toBe(expected);
  });

  it("pass-with-accepts: accepted=2, whitelisted=1, no new or expired", async () => {
    const expected = await loadFixture("pass-with-accepts.expected.md");
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ findingId: "ACC-1" }), category: "accepted" },
      { finding: makeOsvFinding({ findingId: "ACC-2" }), category: "accepted" },
      { finding: makeSocketFinding({ findingId: "WHL-1" }), category: "whitelisted" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 0 }));
    expect(result).toBe(expected);
  });

  it("fail-new-only: one new OSV finding without fixedVersion", async () => {
    const expected = await loadFixture("fail-new-only.expected.md");
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding(), category: "new" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toBe(expected);
  });

  it("fail-new-with-fix: one new OSV finding with fixedVersion 5.7.2", async () => {
    const expected = await loadFixture("fail-new-with-fix.expected.md");
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ fixedVersion: "5.7.2" }), category: "new" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toBe(expected);
  });

  it("fail-new-multiple: three new findings — OSV+fix, OSV without fix, Socket", async () => {
    const expected = await loadFixture("fail-new-multiple.expected.md");
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ fixedVersion: "5.7.2" }), category: "new" },
      { finding: makeOsvFinding({ package: "lodash", version: "4.17.20", findingId: "CVE-2021-23337", severity: "HIGH" }), category: "new" },
      { finding: makeSocketFinding(), category: "new" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toBe(expected);
  });

  it("fail-expired-only: one expired-accept, no new findings", async () => {
    const expected = await loadFixture("fail-expired-only.expected.md");
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding(), category: "expired-accept" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toBe(expected);
  });

  it("fail-mixed: new + expired-accept + accepted + whitelisted", async () => {
    const expected = await loadFixture("fail-mixed.expected.md");
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding(), category: "new" },
      { finding: makeOsvFinding({ package: "lodash", version: "4.17.20", findingId: "CVE-2021-23337", severity: "HIGH" }), category: "expired-accept" },
      { finding: makeOsvFinding({ findingId: "ACC-1", package: "axios" }), category: "accepted" },
      { finding: makeSocketFinding({ findingId: "WHL-1" }), category: "whitelisted" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1 }));
    expect(result).toBe(expected);
  });

  it("fail-supply-chain-unavailable: new finding + socketAvailable false", async () => {
    const expected = await loadFixture("fail-supply-chain-unavailable.expected.md");
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding(), category: "new" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1, socketAvailable: false }));
    expect(result).toBe(expected);
  });

  it("pass-supply-chain-unavailable: clean pass + socketAvailable false", async () => {
    const expected = await loadFixture("pass-supply-chain-unavailable.expected.md");
    const result = renderMarkdownReport(makeScanResult([], { exitCode: 0, socketAvailable: false }));
    expect(result).toBe(expected);
  });

  it("fail-osv-unavailable: socket finding + osvAvailable false", async () => {
    const expected = await loadFixture("fail-osv-unavailable.expected.md");
    const findings: ClassifiedFinding[] = [
      { finding: makeSocketFinding(), category: "new" },
    ];
    const result = renderMarkdownReport(makeScanResult(findings, { exitCode: 1, osvAvailable: false }));
    expect(result).toBe(expected);
  });

  it("cell-escapes: pipe in package name, newline in suggested action via hook", async () => {
    const expected = await loadFixture("cell-escapes.expected.md");
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ package: "foo|bar", version: "1.0.0", findingId: "CVE-1234", summary: "line1\nline2" }), category: "new" },
    ];
    const result = renderMarkdownReport(
      makeScanResult(findings, { exitCode: 1 }),
      { suggestedActionFor: (cf) => cf.finding.summary ?? "" }
    );
    expect(result).toBe(expected);
  });
});
