import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, EOL } from "node:os";
import { Writable } from "node:stream";
import { buildFindingsJsonSchema, writeFindingsJson } from "../jsonReporter.js";
import type { ScanResult } from "../../types/scanResult.js";
import type { ClassifiedFinding } from "../../types/depauditConfig.js";
import type { Finding } from "../../types/finding.js";

const FIXTURES_DIR = resolve(__dirname, "fixtures/json-output");

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

function makeScanResult(
  findings: ClassifiedFinding[] = [],
  overrides: Partial<ScanResult> = {}
): ScanResult {
  return { findings, socketAvailable: true, osvAvailable: true, exitCode: 0, ...overrides };
}

function captureStream(): { stream: Writable; captured: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, captured: () => buf };
}

// ─── Group 1: buildFindingsJsonSchema pure helper ─────────────────────────────

describe("buildFindingsJsonSchema", () => {
  it("empty findings produces schemaVersion 1, both sources true, empty array", () => {
    const result = buildFindingsJsonSchema(makeScanResult());
    expect(result).toEqual({
      schemaVersion: 1,
      sourceAvailability: { osv: true, socket: true },
      findings: [],
    });
  });

  it("single new/osv finding maps all fields correctly", () => {
    const finding = makeOsvFinding({ summary: "desc" });
    const result = buildFindingsJsonSchema(
      makeScanResult([{ finding, category: "new" }])
    );
    expect(result.findings).toHaveLength(1);
    const entry = result.findings[0];
    expect(entry.package).toBe("semver");
    expect(entry.version).toBe("5.7.1");
    expect(entry.ecosystem).toBe("npm");
    expect(entry.manifestPath).toBe("/repo/package-lock.json");
    expect(entry.findingId).toBe("GHSA-c2qf-rxjj-qqgw");
    expect(entry.severity).toBe("MEDIUM");
    expect(entry.summary).toBe("desc");
    expect(entry.classification).toBe("new");
    expect(entry.source).toBe("osv");
    expect(entry.upgradeSuggestion).toBeNull();
  });

  it("summary defaults to empty string when absent", () => {
    const finding = makeOsvFinding();
    delete (finding as Partial<Finding>).summary;
    const result = buildFindingsJsonSchema(makeScanResult([{ finding, category: "new" }]));
    expect(result.findings[0].summary).toBe("");
  });

  it.each(["new", "accepted", "whitelisted", "expired-accept"] as const)(
    "classification %s passes through verbatim",
    (category) => {
      const finding = makeOsvFinding();
      const result = buildFindingsJsonSchema(makeScanResult([{ finding, category }]));
      expect(result.findings[0].classification).toBe(category);
    }
  );

  it("osv and socket sources map correctly", () => {
    const osvFinding = makeOsvFinding();
    const socketFinding = makeSocketFinding();
    const result = buildFindingsJsonSchema(
      makeScanResult([
        { finding: osvFinding, category: "new" },
        { finding: socketFinding, category: "new" },
      ])
    );
    const sources = result.findings.map((e) => e.source);
    expect(sources).toContain("osv");
    expect(sources).toContain("socket");
  });

  it("shuffled input yields same output as sorted input", () => {
    const a = makeOsvFinding({ package: "alpha", findingId: "GHSA-aaaa" });
    const b = makeOsvFinding({ package: "beta", findingId: "GHSA-bbbb" });
    const c = makeOsvFinding({ package: "gamma", findingId: "GHSA-cccc" });
    const sorted = buildFindingsJsonSchema(
      makeScanResult([
        { finding: a, category: "new" },
        { finding: b, category: "new" },
        { finding: c, category: "new" },
      ])
    );
    const shuffled = buildFindingsJsonSchema(
      makeScanResult([
        { finding: c, category: "new" },
        { finding: a, category: "new" },
        { finding: b, category: "new" },
      ])
    );
    expect(shuffled.findings.map((e) => e.package)).toEqual(
      sorted.findings.map((e) => e.package)
    );
  });

  it("two findings differing only by findingId sort ascending by findingId", () => {
    const a = makeOsvFinding({ findingId: "GHSA-zzzz" });
    const b = makeOsvFinding({ findingId: "GHSA-aaaa" });
    const result = buildFindingsJsonSchema(
      makeScanResult([
        { finding: a, category: "new" },
        { finding: b, category: "new" },
      ])
    );
    expect(result.findings[0].findingId).toBe("GHSA-aaaa");
    expect(result.findings[1].findingId).toBe("GHSA-zzzz");
  });

  it("manifestPath is the primary sort key", () => {
    const a = makeOsvFinding({ manifestPath: "/z/lock.json", package: "alpha" });
    const b = makeOsvFinding({ manifestPath: "/a/lock.json", package: "beta" });
    const result = buildFindingsJsonSchema(
      makeScanResult([
        { finding: a, category: "new" },
        { finding: b, category: "new" },
      ])
    );
    expect(result.findings[0].manifestPath).toBe("/a/lock.json");
    expect(result.findings[1].manifestPath).toBe("/z/lock.json");
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as [boolean, boolean][])(
    "sourceAvailability osv=%s socket=%s mirrors scan result",
    (osv, socket) => {
      const result = buildFindingsJsonSchema(
        makeScanResult([], { osvAvailable: osv, socketAvailable: socket })
      );
      expect(result.sourceAvailability.osv).toBe(osv);
      expect(result.sourceAvailability.socket).toBe(socket);
    }
  );
});

// ─── Group 2: writeFindingsJson write path ────────────────────────────────────

describe("writeFindingsJson", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "depaudit-json-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes .depaudit/findings.json under the scan root", async () => {
    await writeFindingsJson(tmpDir, makeScanResult(), { stdoutStream: captureStream().stream });
    const content = await readFile(join(tmpDir, ".depaudit", "findings.json"), "utf8");
    expect(content).toBeTruthy();
    const parsed = JSON.parse(content) as unknown;
    expect(parsed).toMatchObject({ schemaVersion: 1 });
  });

  it("creates the .depaudit/ directory if absent", async () => {
    await writeFindingsJson(tmpDir, makeScanResult(), { stdoutStream: captureStream().stream });
    const { stat } = await import("node:fs/promises");
    const stats = await stat(join(tmpDir, ".depaudit"));
    expect(stats.isDirectory()).toBe(true);
  });

  it("overwrites an existing file on re-run with no append", async () => {
    const depauditDir = join(tmpDir, ".depaudit");
    await mkdir(depauditDir, { recursive: true });
    await writeFile(join(depauditDir, "findings.json"), '{"stale":true}\n', "utf8");

    await writeFindingsJson(tmpDir, makeScanResult(), { stdoutStream: captureStream().stream });
    const content = await readFile(join(depauditDir, "findings.json"), "utf8");
    const parsed = JSON.parse(content) as { stale?: boolean };
    expect(parsed.stale).toBeUndefined();
    expect(parsed).toMatchObject({ schemaVersion: 1 });
  });

  it("output matches empty.expected.json fixture", async () => {
    const { stream } = captureStream();
    // Write a .gitignore that covers .depaudit/ so no warning
    await writeFile(join(tmpDir, ".gitignore"), ".depaudit/\n", "utf8");
    await writeFindingsJson(tmpDir, makeScanResult(), { stdoutStream: stream });
    const actual = await readFile(join(tmpDir, ".depaudit", "findings.json"), "utf8");
    const expected = await readFile(join(FIXTURES_DIR, "empty.expected.json"), "utf8");
    expect(actual).toBe(expected);
  });

  it("output matches mixed-classifications.expected.json fixture", async () => {
    const { stream } = captureStream();
    await writeFile(join(tmpDir, ".gitignore"), ".depaudit/\n", "utf8");
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ package: "semver", version: "5.7.1", findingId: "GHSA-c2qf-rxjj-qqgw", severity: "MEDIUM", summary: "Regular expression denial of service" }), category: "new" },
      { finding: makeOsvFinding({ package: "lodash", version: "4.17.20", findingId: "GHSA-jf85-cpcp-j695", severity: "HIGH", summary: "Prototype pollution via merge" }), category: "accepted" },
      { finding: makeSocketFinding({ package: "ms", version: "2.1.3", findingId: "expired-vuln", severity: "LOW", summary: undefined }), category: "expired-accept" },
      { finding: makeSocketFinding({ package: "minimist", version: "1.2.5", findingId: "install-scripts", severity: "HIGH", summary: "install-scripts detected" }), category: "whitelisted" },
    ];
    await writeFindingsJson(tmpDir, makeScanResult(findings), { stdoutStream: stream });
    const actual = await readFile(join(tmpDir, ".depaudit", "findings.json"), "utf8");
    const expected = await readFile(join(FIXTURES_DIR, "mixed-classifications.expected.json"), "utf8");
    expect(actual).toBe(expected);
  });

  it("output matches socket-unavailable.expected.json fixture", async () => {
    const { stream } = captureStream();
    await writeFile(join(tmpDir, ".gitignore"), ".depaudit/\n", "utf8");
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ package: "lodash", version: "4.17.20", findingId: "GHSA-jf85-cpcp-j695", severity: "HIGH", summary: undefined }), category: "new" },
      { finding: makeOsvFinding({ package: "semver", version: "5.7.1", findingId: "GHSA-c2qf-rxjj-qqgw", severity: "MEDIUM", summary: undefined }), category: "new" },
    ];
    await writeFindingsJson(tmpDir, makeScanResult(findings, { socketAvailable: false }), { stdoutStream: stream });
    const actual = await readFile(join(tmpDir, ".depaudit", "findings.json"), "utf8");
    const expected = await readFile(join(FIXTURES_DIR, "socket-unavailable.expected.json"), "utf8");
    expect(actual).toBe(expected);
  });

  it("output matches osv-unavailable.expected.json fixture", async () => {
    const { stream } = captureStream();
    await writeFile(join(tmpDir, ".gitignore"), ".depaudit/\n", "utf8");
    const findings: ClassifiedFinding[] = [
      { finding: makeSocketFinding({ package: "lodash", version: "4.17.20", findingId: "install-scripts", severity: "HIGH", summary: "install-scripts detected" }), category: "new" },
      { finding: makeSocketFinding({ package: "ms", version: "2.1.3", findingId: "deprecated", severity: "MEDIUM", summary: "deprecated detected" }), category: "new" },
    ];
    await writeFindingsJson(tmpDir, makeScanResult(findings, { osvAvailable: false }), { stdoutStream: stream });
    const actual = await readFile(join(tmpDir, ".depaudit", "findings.json"), "utf8");
    const expected = await readFile(join(FIXTURES_DIR, "osv-unavailable.expected.json"), "utf8");
    expect(actual).toBe(expected);
  });

  it("output matches deterministic-order.expected.json — reverse input produces ascending output", async () => {
    const { stream } = captureStream();
    await writeFile(join(tmpDir, ".gitignore"), ".depaudit/\n", "utf8");
    const findings: ClassifiedFinding[] = [
      { finding: makeOsvFinding({ package: "gamma", version: "3.0.0", findingId: "GHSA-cccc-cccc-cccc", severity: "LOW", summary: undefined }), category: "new" },
      { finding: makeOsvFinding({ package: "beta", version: "2.0.0", findingId: "GHSA-bbbb-bbbb-bbbb", severity: "MEDIUM", summary: undefined }), category: "new" },
      { finding: makeOsvFinding({ package: "alpha", version: "1.0.0", findingId: "GHSA-aaaa-aaaa-aaaa", severity: "HIGH", summary: undefined }), category: "new" },
    ];
    await writeFindingsJson(tmpDir, makeScanResult(findings), { stdoutStream: stream });
    const actual = await readFile(join(tmpDir, ".depaudit", "findings.json"), "utf8");
    const expected = await readFile(join(FIXTURES_DIR, "deterministic-order.expected.json"), "utf8");
    expect(actual).toBe(expected);
  });

  it("output has trailing newline", async () => {
    const { stream } = captureStream();
    await writeFile(join(tmpDir, ".gitignore"), ".depaudit/\n", "utf8");
    await writeFindingsJson(tmpDir, makeScanResult(), { stdoutStream: stream });
    const actual = await readFile(join(tmpDir, ".depaudit", "findings.json"), "utf8");
    expect(actual.endsWith("\n")).toBe(true);
  });
});

// ─── Group 3: gitignore check ─────────────────────────────────────────────────

describe("writeFindingsJson gitignore check", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "depaudit-gi-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("no warning when .gitignore contains .depaudit/", async () => {
    await writeFile(join(tmpDir, ".gitignore"), ".depaudit/\n", "utf8");
    const { stream, captured } = captureStream();
    await writeFindingsJson(tmpDir, makeScanResult(), { stdoutStream: stream });
    expect(captured()).toBe("");
  });

  it("no warning when .gitignore contains .depaudit/findings.json", async () => {
    await writeFile(join(tmpDir, ".gitignore"), ".depaudit/findings.json\n", "utf8");
    const { stream, captured } = captureStream();
    await writeFindingsJson(tmpDir, makeScanResult(), { stdoutStream: stream });
    expect(captured()).toBe("");
  });

  it("warning when no .gitignore exists", async () => {
    const { stream, captured } = captureStream();
    await writeFindingsJson(tmpDir, makeScanResult(), { stdoutStream: stream });
    expect(captured()).toContain("warning: .depaudit/findings.json is not gitignored");
  });

  it("warning when .gitignore exists with unrelated rules", async () => {
    await writeFile(join(tmpDir, ".gitignore"), "node_modules/\ndist/\n", "utf8");
    const { stream, captured } = captureStream();
    await writeFindingsJson(tmpDir, makeScanResult(), { stdoutStream: stream });
    expect(captured()).toContain("warning: .depaudit/findings.json is not gitignored");
  });

  it("no warning when .gitignore has .depaudit/ even with a negation (negation inside ignored dir has no effect per gitignore semantics)", async () => {
    // gitignore: you cannot re-include a file if a parent directory is excluded
    await writeFile(join(tmpDir, ".gitignore"), ".depaudit/\n!.depaudit/findings.json\n", "utf8");
    const { stream, captured } = captureStream();
    await writeFindingsJson(tmpDir, makeScanResult(), { stdoutStream: stream });
    expect(captured()).toBe("");
  });

  it("exactly one warning per call", async () => {
    const { stream, captured } = captureStream();
    await writeFindingsJson(tmpDir, makeScanResult(), { stdoutStream: stream });
    const count = (captured().match(/warning:/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("warning text starts with the required prefix", async () => {
    const { stream, captured } = captureStream();
    await writeFindingsJson(tmpDir, makeScanResult(), { stdoutStream: stream });
    expect(captured()).toMatch(/^warning: \.depaudit\/findings\.json is not gitignored/);
  });

  it(".gitignore with CRLF line endings is parsed correctly", async () => {
    await writeFile(join(tmpDir, ".gitignore"), ".depaudit/\r\n", "utf8");
    const { stream, captured } = captureStream();
    await writeFindingsJson(tmpDir, makeScanResult(), { stdoutStream: stream });
    expect(captured()).toBe("");
  });
});
