import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  renderFindingsJson,
  writeFindingsFile,
  checkGitignore,
  printGitignoreWarning,
  type RenderInput,
  type GitignoreCheckResult,
} from "../jsonReporter.js";
import type { ClassifiedFinding } from "../../types/depauditConfig.js";
import type { Finding } from "../../types/finding.js";

const FROZEN_DATE = new Date("2026-04-18T12:00:00.000Z");

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
    findingId: "install-scripts", severity: "HIGH",
    manifestPath: "/tmp/package-lock.json", ...overrides,
  };
}

function cf(finding: Finding, category: ClassifiedFinding["category"]): ClassifiedFinding {
  return { finding, category };
}

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "jsonReporter");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

// ─── renderFindingsJson ───────────────────────────────────────────────────────

describe("renderFindingsJson", () => {
  it("empty result returns canonical structure", () => {
    const result = renderFindingsJson({ findings: [], socketAvailable: true, generatedAt: FROZEN_DATE });
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed["version"]).toBe(1);
    expect(parsed["scannedAt"]).toBe(FROZEN_DATE.toISOString());
    expect(parsed["sourceAvailability"]).toEqual({ osv: "available", socket: "available" });
    expect(parsed["classifications"]).toEqual(["new", "accepted", "whitelisted", "expired-accept"]);
    expect(parsed["counts"]).toEqual({ new: 0, accepted: 0, whitelisted: 0, "expired-accept": 0 });
    expect(parsed["findings"]).toEqual([]);
    expect(result.endsWith("\n")).toBe(true);
  });

  it("mixed classifications render all four categories", async () => {
    const findings: ClassifiedFinding[] = [
      cf(makeOsvFinding({ fixedIn: "5.7.2" }), "new"),
      cf(makeOsvFinding({ ecosystem: "pip", package: "urllib3", version: "1.26.4", findingId: "GHSA-foo-bar-baz", manifestPath: "/tmp/requirements.txt" }), "accepted"),
      cf(makeSocketFinding({ ecosystem: "pip", package: "requests", version: "2.6.0", findingId: "install-scripts", manifestPath: "/tmp/requirements.txt" }), "whitelisted"),
      cf(makeSocketFinding({ package: "ms", version: "2.0.0", findingId: "deprecated", manifestPath: "/tmp/package-lock.json" }), "expired-accept"),
    ];
    const result = renderFindingsJson({ findings, socketAvailable: true, generatedAt: FROZEN_DATE });
    expect(result).toBe(readFixture("mixed-classifications.json"));
  });

  it("socket unavailable maps to sourceAvailability.socket unavailable", () => {
    const findings: ClassifiedFinding[] = [
      cf(makeOsvFinding({ summary: "ReDoS in semver" }), "new"),
    ];
    const result = renderFindingsJson({ findings, socketAvailable: false, generatedAt: FROZEN_DATE });
    expect(result).toBe(readFixture("socket-unavailable.json"));
  });

  it("classification hyphen is preserved for expired-accept", () => {
    const result = renderFindingsJson({
      findings: [cf(makeOsvFinding(), "expired-accept")],
      socketAvailable: true,
      generatedAt: FROZEN_DATE,
    });
    const parsed = JSON.parse(result) as { findings: Array<{ classification: string }> };
    expect(parsed.findings[0].classification).toBe("expired-accept");
  });

  it("classifications enum is always emitted regardless of findings content", () => {
    const result = renderFindingsJson({ findings: [], socketAvailable: true, generatedAt: FROZEN_DATE });
    const parsed = JSON.parse(result) as { classifications: string[] };
    expect(parsed.classifications).toEqual(["new", "accepted", "whitelisted", "expired-accept"]);
  });

  it("summary undefined becomes null in JSON output", () => {
    const finding = makeOsvFinding({ summary: undefined });
    const result = renderFindingsJson({
      findings: [cf(finding, "new")],
      socketAvailable: true,
      generatedAt: FROZEN_DATE,
    });
    const parsed = JSON.parse(result) as { findings: Array<{ summary: unknown }> };
    expect(parsed.findings[0].summary).toBeNull();
    expect("summary" in parsed.findings[0]).toBe(true);
  });

  it("upgrade field present only for OSV finding with fixedIn", () => {
    const withFix = makeOsvFinding({ fixedIn: "5.7.2" });
    const withoutFix = makeOsvFinding({ package: "ms", version: "2.0.0", findingId: "CVE-X", fixedIn: undefined });
    const socketFinding = makeSocketFinding();

    const result = renderFindingsJson({
      findings: [cf(withFix, "new"), cf(withoutFix, "new"), cf(socketFinding, "new")],
      socketAvailable: true,
      generatedAt: FROZEN_DATE,
    });
    const parsed = JSON.parse(result) as { findings: Array<Record<string, unknown>> };
    const fixEntry = parsed.findings.find((f) => f["package"] === "semver");
    const noFixEntry = parsed.findings.find((f) => f["findingId"] === "CVE-X");
    const socketEntry = parsed.findings.find((f) => f["source"] === "socket");

    expect((fixEntry as { upgrade?: { suggestedVersion: string } }).upgrade?.suggestedVersion).toBe("5.7.2");
    expect("upgrade" in (noFixEntry as object)).toBe(false);
    expect("upgrade" in (socketEntry as object)).toBe(false);
  });

  it("counts match finding categories", () => {
    const findings: ClassifiedFinding[] = [
      cf(makeOsvFinding(), "new"),
      cf(makeOsvFinding({ findingId: "A" }), "new"),
      cf(makeOsvFinding({ findingId: "B" }), "new"),
      cf(makeOsvFinding({ findingId: "C" }), "accepted"),
      cf(makeOsvFinding({ findingId: "D" }), "accepted"),
      cf(makeOsvFinding({ findingId: "E" }), "whitelisted"),
      cf(makeOsvFinding({ findingId: "F" }), "expired-accept"),
    ];
    const result = renderFindingsJson({ findings, socketAvailable: true, generatedAt: FROZEN_DATE });
    const parsed = JSON.parse(result) as { counts: Record<string, number> };
    expect(parsed.counts).toEqual({ new: 3, accepted: 2, whitelisted: 1, "expired-accept": 1 });
  });

  it("scannedAt is the input Date's ISO string", () => {
    const result = renderFindingsJson({ findings: [], socketAvailable: true, generatedAt: FROZEN_DATE });
    const parsed = JSON.parse(result) as { scannedAt: string };
    expect(parsed.scannedAt).toBe(FROZEN_DATE.toISOString());
  });

  it("findings array is stably sorted regardless of input order", () => {
    const a = cf(makeOsvFinding({ package: "zlib", findingId: "Z1" }), "new");
    const b = cf(makeOsvFinding({ package: "aws-sdk", findingId: "A1" }), "whitelisted");
    const c = cf(makeSocketFinding({ findingId: "install-scripts" }), "accepted");

    const order1 = renderFindingsJson({ findings: [a, b, c], socketAvailable: true, generatedAt: FROZEN_DATE });
    const order2 = renderFindingsJson({ findings: [c, a, b], socketAvailable: true, generatedAt: FROZEN_DATE });
    const order3 = renderFindingsJson({ findings: [b, c, a], socketAvailable: true, generatedAt: FROZEN_DATE });
    expect(order1).toBe(order2);
    expect(order2).toBe(order3);
  });

  it("version is 1", () => {
    const result = renderFindingsJson({ findings: [], socketAvailable: true, generatedAt: FROZEN_DATE });
    const parsed = JSON.parse(result) as { version: number };
    expect(parsed.version).toBe(1);
  });

  it("osvAvailable false maps to sourceAvailability.osv unavailable", () => {
    const result = renderFindingsJson({ findings: [], socketAvailable: true, osvAvailable: false, generatedAt: FROZEN_DATE });
    const parsed = JSON.parse(result) as { sourceAvailability: { osv: string } };
    expect(parsed.sourceAvailability.osv).toBe("unavailable");
  });
});

// ─── writeFindingsFile ────────────────────────────────────────────────────────

describe("writeFindingsFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "depaudit-jsonreporter-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const input: RenderInput = { findings: [], socketAvailable: true, generatedAt: FROZEN_DATE };

  it("creates .depaudit/ directory when missing", async () => {
    await writeFindingsFile(tmpDir, input);
    expect(existsSync(join(tmpDir, ".depaudit", "findings.json"))).toBe(true);
  });

  it("overwrites existing findings.json", async () => {
    const depauditDir = join(tmpDir, ".depaudit");
    mkdirSync(depauditDir);
    writeFileSync(join(depauditDir, "findings.json"), "stale content", "utf8");

    await writeFindingsFile(tmpDir, input);
    const content = readFileSync(join(depauditDir, "findings.json"), "utf8");
    expect(content).not.toBe("stale content");
    expect(JSON.parse(content)).toMatchObject({ version: 1 });
  });

  it("written content equals renderFindingsJson output", async () => {
    await writeFindingsFile(tmpDir, input);
    const written = await readFile(join(tmpDir, ".depaudit", "findings.json"), "utf8");
    expect(written).toBe(renderFindingsJson(input));
  });
});

// ─── checkGitignore ───────────────────────────────────────────────────────────

describe("checkGitignore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "depaudit-gitignore-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("no .gitignore returns missing", async () => {
    const result = await checkGitignore(tmpDir);
    expect(result).toEqual({ ignored: false, reason: "missing" });
  });

  it("empty .gitignore returns not-matched", async () => {
    writeFileSync(join(tmpDir, ".gitignore"), "", "utf8");
    const result = await checkGitignore(tmpDir);
    expect(result).toEqual({ ignored: false, reason: "not-matched" });
  });

  it(".gitignore with unrelated line returns not-matched", async () => {
    writeFileSync(join(tmpDir, ".gitignore"), "dist/\nnode_modules/\n", "utf8");
    const result = await checkGitignore(tmpDir);
    expect(result).toEqual({ ignored: false, reason: "not-matched" });
  });

  it(".gitignore containing .depaudit/ returns ok", async () => {
    writeFileSync(join(tmpDir, ".gitignore"), ".depaudit/\n", "utf8");
    const result = await checkGitignore(tmpDir);
    expect(result).toEqual({ ignored: true, reason: "ok" });
  });

  it(".gitignore containing .depaudit/findings.json returns ok", async () => {
    writeFileSync(join(tmpDir, ".gitignore"), ".depaudit/findings.json\n", "utf8");
    const result = await checkGitignore(tmpDir);
    expect(result).toEqual({ ignored: true, reason: "ok" });
  });

  it(".gitignore containing **/*.json broad pattern returns ok", async () => {
    writeFileSync(join(tmpDir, ".gitignore"), "**/*.json\n", "utf8");
    const result = await checkGitignore(tmpDir);
    expect(result).toEqual({ ignored: true, reason: "ok" });
  });
});

// ─── printGitignoreWarning ────────────────────────────────────────────────────

describe("printGitignoreWarning", () => {
  const EXPECTED_WARNING =
    "warning: .depaudit/findings.json is not gitignored — add '.depaudit/' to your .gitignore or run 'depaudit setup'\n";

  function captureStream(): { stream: NodeJS.WritableStream; output: () => string } {
    let buf = "";
    const stream = {
      write: (chunk: string) => { buf += chunk; return true; },
    } as unknown as NodeJS.WritableStream;
    return { stream, output: () => buf };
  }

  it("emits nothing when ignored", () => {
    const { stream, output } = captureStream();
    const check: GitignoreCheckResult = { ignored: true, reason: "ok" };
    printGitignoreWarning(check, stream);
    expect(output()).toBe("");
  });

  it("emits warning when not-matched", () => {
    const { stream, output } = captureStream();
    const check: GitignoreCheckResult = { ignored: false, reason: "not-matched" };
    printGitignoreWarning(check, stream);
    expect(output()).toBe(EXPECTED_WARNING);
  });

  it("emits warning when missing", () => {
    const { stream, output } = captureStream();
    const check: GitignoreCheckResult = { ignored: false, reason: "missing" };
    printGitignoreWarning(check, stream);
    expect(output()).toBe(EXPECTED_WARNING);
  });
});
