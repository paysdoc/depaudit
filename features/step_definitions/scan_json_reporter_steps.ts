import { readFile, writeFile, stat, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Given, Then, Before, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { DepauditWorld, PROJECT_ROOT } from "../support/world.js";
import { startMockSocketServer } from "../support/mockSocketServer.js";

// ─── Module-level state for "that finding" cross-step references ─────────────

let lastFoundFinding: Record<string, unknown> | null = null;

// ─── Lifecycle hooks ──────────────────────────────────────────────────────────

Before<DepauditWorld>({ tags: "@adw-8" }, function (this: DepauditWorld) {
  lastFoundFinding = null;
  this.socketToken = undefined;
  this.socketMockUrl = undefined;
  this.socketMock = undefined;
  this.socketAlertPackage = undefined;
  this.socketAlertVersion = undefined;
  this.socketRequestTimeoutMs = undefined;
});

After<DepauditWorld>({ tags: "@adw-8" }, async function (this: DepauditWorld) {
  if (this.socketMock) {
    await this.socketMock.stop();
    this.socketMock = undefined;
  }
  // Clean up .depaudit/ directory that the scan writes
  if (this.fixturePath) {
    try {
      await rm(join(this.fixturePath, ".depaudit"), { recursive: true, force: true });
    } catch {
      // already gone
    }
  }
  // Clean up any files written dynamically by steps
  for (const f of this.writtenFiles) {
    try { await rm(f, { force: true }); } catch { /* ok */ }
  }
  this.writtenFiles = [];
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function futureDateStr(days = 60): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

async function readFindingsJson(fixturePath: string, relPath: string): Promise<Record<string, unknown>> {
  const absPath = join(fixturePath, relPath);
  const content = await readFile(absPath, "utf8");
  return JSON.parse(content) as Record<string, unknown>;
}

// ─── Given: fixture setup ─────────────────────────────────────────────────────

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose manifest pins a package with a known OSV CVE that has a resolving upgrade version",
  async function (this: DepauditWorld, fixturePath: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    const { access } = await import("node:fs/promises");
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose manifest pins a package with a known OSV CVE that has no resolving upgrade",
  async function (this: DepauditWorld, fixturePath: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    const { access } = await import("node:fs/promises");
    await access(this.fixturePath);
  }
);

// ─── Given: gitignore management ─────────────────────────────────────────────

Given<DepauditWorld>(
  "the repository's .gitignore excludes {string}",
  async function (this: DepauditWorld, _pattern: string) {
    // Fixture already has the correct .gitignore; this step verifies the intent
    const giPath = join(this.fixturePath, ".gitignore");
    try {
      await stat(giPath);
    } catch {
      // If missing, write one
      await writeFile(giPath, ".depaudit/\n", "utf8");
      this.writtenFiles.push(giPath);
    }
  }
);

Given<DepauditWorld>(
  "the repository's .gitignore does not exclude {string}",
  async function (this: DepauditWorld, _pattern: string) {
    // Ensure the fixture has a .gitignore that doesn't cover .depaudit/
    const giPath = join(this.fixturePath, ".gitignore");
    await writeFile(giPath, "node_modules/\ndist/\n", "utf8");
    this.writtenFiles.push(giPath);
  }
);

Given<DepauditWorld>("the repository has no .gitignore", async function (this: DepauditWorld) {
  const giPath = join(this.fixturePath, ".gitignore");
  try {
    await rm(giPath, { force: true });
    this.writtenFiles.push(giPath + ":deleted");
  } catch {
    // already gone
  }
});

// ─── Given: .depaudit.yml commonAndFine ──────────────────────────────────────

Given<DepauditWorld>(
  /the repository's \.depaudit\.yml has a `commonAndFine` entry matching that \(package, alertType\) pair with a valid `expires`/,
  async function (this: DepauditWorld) {
    const pkg = this.socketAlertPackage ?? "ms";
    const alertType = "install-scripts";
    const expires = futureDateStr(60);
    const ymlPath = join(this.fixturePath, ".depaudit.yml");
    const content = [
      "version: 1",
      "policy:",
      "  severityThreshold: medium",
      "  ecosystems: auto",
      "  maxAcceptDays: 90",
      "  maxCommonAndFineDays: 365",
      "supplyChainAccepts: []",
      "commonAndFine:",
      `  - package: "${pkg}"`,
      `    alertType: "${alertType}"`,
      `    expires: "${expires}"`,
      `    reason: "Test whitelisting for BDD scenario"`,
    ].join("\n") + "\n";
    await writeFile(ymlPath, content, "utf8");
    this.writtenFiles.push(ymlPath);
  }
);

// ─── Given: stale findings.json ──────────────────────────────────────────────

Given<DepauditWorld>(
  "a stale {string} from a previous run exists under that repository with a single stale finding entry",
  async function (this: DepauditWorld, relPath: string) {
    const absPath = join(this.fixturePath, relPath);
    await mkdir(join(this.fixturePath, ".depaudit"), { recursive: true });
    const stale = JSON.stringify({
      version: 1,
      scannedAt: "2020-01-01T00:00:00.000Z",
      sourceAvailability: { osv: "available", socket: "available" },
      classifications: ["new", "accepted", "whitelisted", "expired-accept"],
      counts: { new: 1, accepted: 0, whitelisted: 0, "expired-accept": 0 },
      findings: [{
        package: "stale-package",
        version: "1.0.0",
        ecosystem: "npm",
        manifestPath: "/stale/path",
        findingId: "STALE-CVE-0000",
        severity: "HIGH",
        summary: "stale finding from previous run",
        classification: "new",
        source: "osv",
      }],
    }, null, 2) + "\n";
    await writeFile(absPath, stale, "utf8");
  }
);

// ─── Then: file existence ─────────────────────────────────────────────────────

Then<DepauditWorld>(
  "the file {string} is written under the scanned repository",
  async function (this: DepauditWorld, relPath: string) {
    const absPath = join(this.fixturePath, relPath);
    await stat(absPath);
  }
);

Then<DepauditWorld>(
  "{string} is valid JSON",
  async function (this: DepauditWorld, relPath: string) {
    const absPath = join(this.fixturePath, relPath);
    const content = await readFile(absPath, "utf8");
    JSON.parse(content);
  }
);

// ─── Then: top-level field assertions ─────────────────────────────────────────

Then<DepauditWorld>(
  "{string} has a top-level {string} field set to {int}",
  async function (this: DepauditWorld, relPath: string, field: string, expected: number) {
    const json = await readFindingsJson(this.fixturePath, relPath);
    assert.equal(json[field], expected, `Expected ${field} === ${expected}, got ${String(json[field])}`);
  }
);

Then<DepauditWorld>(
  "{string} has a top-level {string} field set to {string}",
  async function (this: DepauditWorld, relPath: string, field: string, expected: string) {
    const json = await readFindingsJson(this.fixturePath, relPath);
    assert.equal(json[field], expected, `Expected ${field} === "${expected}", got "${String(json[field])}"`);
  }
);

Then<DepauditWorld>(
  "{string} has a top-level {string} array with length {int}",
  async function (this: DepauditWorld, relPath: string, field: string, expectedLen: number) {
    const json = await readFindingsJson(this.fixturePath, relPath);
    const arr = json[field];
    assert.ok(Array.isArray(arr), `Expected ${field} to be an array`);
    assert.equal((arr as unknown[]).length, expectedLen,
      `Expected ${field}.length === ${expectedLen}, got ${(arr as unknown[]).length}`);
  }
);

Then<DepauditWorld>(
  "{string} has a top-level {string} field that is a valid ISO-8601 timestamp",
  async function (this: DepauditWorld, relPath: string, field: string) {
    const json = await readFindingsJson(this.fixturePath, relPath);
    const val = json[field];
    assert.equal(typeof val, "string", `Expected ${field} to be a string`);
    const d = new Date(val as string);
    assert.ok(!isNaN(d.getTime()), `Expected ${field} to be a valid date, got "${String(val)}"`);
    assert.ok((val as string).includes("T") && (val as string).endsWith("Z"), `Expected ISO-8601 UTC format`);
  }
);

// ─── Then: generic dotted-path assertion ──────────────────────────────────────

Then<DepauditWorld>(
  "{string} has {string} set to {string}",
  async function (this: DepauditWorld, relPath: string, dotPath: string, expected: string) {
    const json = await readFindingsJson(this.fixturePath, relPath);
    const val = getNestedValue(json, dotPath);
    assert.equal(val, expected, `Expected ${dotPath} === "${expected}", got "${String(val)}"`);
  }
);

// ─── Then: findings array assertions ─────────────────────────────────────────

Then<DepauditWorld>(
  "the first finding in {string} has {string} set to {string}",
  async function (this: DepauditWorld, relPath: string, field: string, expected: string) {
    const json = await readFindingsJson(this.fixturePath, relPath);
    const findings = json["findings"] as Array<Record<string, unknown>>;
    assert.ok(findings.length > 0, "Expected at least one finding");
    assert.equal(findings[0][field], expected,
      `Expected findings[0].${field} === "${expected}", got "${String(findings[0][field])}"`);
  }
);

Then<DepauditWorld>(
  "the first finding in {string} has non-empty {string}, {string}, {string}, {string}, {string}, and {string} fields",
  async function (this: DepauditWorld, relPath: string, f1: string, f2: string, f3: string, f4: string, f5: string, f6: string) {
    const json = await readFindingsJson(this.fixturePath, relPath);
    const findings = json["findings"] as Array<Record<string, unknown>>;
    assert.ok(findings.length > 0, "Expected at least one finding");
    const finding = findings[0];
    for (const field of [f1, f2, f3, f4, f5, f6]) {
      const val = finding[field];
      assert.ok(val !== undefined && val !== null && val !== "",
        `Expected findings[0].${field} to be non-empty, got ${JSON.stringify(val)}`);
    }
  }
);

Then<DepauditWorld>(
  "{string} contains a finding with {string} set to {string}",
  async function (this: DepauditWorld, relPath: string, field: string, expected: string) {
    const json = await readFindingsJson(this.fixturePath, relPath);
    const findings = json["findings"] as Array<Record<string, unknown>>;
    const found = findings.find((f) => f[field] === expected);
    assert.ok(found, `Expected a finding with ${field} === "${expected}" in ${relPath}`);
    lastFoundFinding = found;
  }
);

Then<DepauditWorld>(
  "that finding has {string} set to {string}",
  function (this: DepauditWorld, field: string, expected: string) {
    assert.ok(lastFoundFinding, "No finding was captured by a previous step");
    assert.equal(lastFoundFinding[field], expected,
      `Expected lastFoundFinding.${field} === "${expected}", got "${String(lastFoundFinding[field])}"`);
  }
);

Then<DepauditWorld>(
  "{string} contains a finding with {string} set to {string} and {string} ending in {string}",
  async function (this: DepauditWorld, relPath: string, field1: string, val1: string, field2: string, suffix: string) {
    const json = await readFindingsJson(this.fixturePath, relPath);
    const findings = json["findings"] as Array<Record<string, unknown>>;
    const found = findings.find((f) => {
      const v1 = f[field1] === val1;
      const v2 = typeof f[field2] === "string" && (f[field2] as string).endsWith(suffix);
      return v1 && v2;
    });
    assert.ok(found,
      `Expected a finding with ${field1}="${val1}" and ${field2} ending in "${suffix}" in ${relPath}.\n` +
      `Got findings: ${JSON.stringify(findings.map((f) => ({ [field1]: f[field1], [field2]: f[field2] })))}`);
  }
);

Then<DepauditWorld>(
  "{string} contains at least one finding with {string} set to {string}",
  async function (this: DepauditWorld, relPath: string, field: string, expected: string) {
    const json = await readFindingsJson(this.fixturePath, relPath);
    const findings = json["findings"] as Array<Record<string, unknown>>;
    const found = findings.some((f) => f[field] === expected);
    assert.ok(found, `Expected at least one finding with ${field} === "${expected}" in ${relPath}`);
  }
);

Then<DepauditWorld>(
  /^"([^"]+)" documents "([^"]+)" as one of: (.+)$/,
  async function (this: DepauditWorld, relPath: string, _fieldName: string, listStr: string) {
    const json = await readFindingsJson(this.fixturePath, relPath);
    const expected = listStr.split(",").map((s) => s.trim());
    const classifications = json["classifications"] as string[];
    assert.deepEqual(classifications, expected,
      `Expected classifications to equal ${JSON.stringify(expected)}, got ${JSON.stringify(classifications)}`);
  }
);

Then<DepauditWorld>(
  "the first finding in {string} has an {string} field whose {string} is non-empty",
  async function (this: DepauditWorld, relPath: string, fieldName: string, subField: string) {
    const json = await readFindingsJson(this.fixturePath, relPath);
    const findings = json["findings"] as Array<Record<string, unknown>>;
    assert.ok(findings.length > 0, "Expected at least one finding");
    const field = findings[0][fieldName] as Record<string, unknown> | undefined;
    assert.ok(field, `Expected findings[0].${fieldName} to exist`);
    const subVal = field[subField];
    assert.ok(subVal !== undefined && subVal !== null && subVal !== "",
      `Expected findings[0].${fieldName}.${subField} to be non-empty, got ${JSON.stringify(subVal)}`);
  }
);

Then<DepauditWorld>(
  "the first finding in {string} has no {string} field",
  async function (this: DepauditWorld, relPath: string, fieldName: string) {
    const json = await readFindingsJson(this.fixturePath, relPath);
    const findings = json["findings"] as Array<Record<string, unknown>>;
    assert.ok(findings.length > 0, "Expected at least one finding");
    assert.ok(!(fieldName in findings[0]),
      `Expected findings[0] to NOT have field "${fieldName}", but it does: ${JSON.stringify(findings[0][fieldName])}`);
  }
);

// ─── Then: stdout assertions ──────────────────────────────────────────────────

Then<DepauditWorld>(
  "stdout mentions {string} and {string}",
  function (this: DepauditWorld, term1: string, term2: string) {
    const out = this.result!.stdout;
    assert.ok(out.includes(term1),
      `Expected stdout to mention "${term1}".\nstdout: ${out}`);
    assert.ok(out.includes(term2),
      `Expected stdout to mention "${term2}".\nstdout: ${out}`);
  }
);

Then<DepauditWorld>(
  "stdout does not mention {string}",
  function (this: DepauditWorld, term: string) {
    const out = this.result!.stdout;
    assert.ok(!out.includes(term),
      `Expected stdout NOT to mention "${term}".\nstdout: ${out}`);
  }
);

// ─── Then: stderr assertions ──────────────────────────────────────────────────

Then<DepauditWorld>(
  "stderr mentions {string} and {string}",
  function (this: DepauditWorld, term1: string, term2: string) {
    const err = this.result!.stderr;
    assert.ok(err.includes(term1),
      `Expected stderr to mention "${term1}".\nstderr: ${err}`);
    assert.ok(err.includes(term2),
      `Expected stderr to mention "${term2}".\nstderr: ${err}`);
  }
);
// "stderr does not mention {string}" is defined in scan_socket_supply_chain_steps.ts

// ─── Then: stale entry check ──────────────────────────────────────────────────

Then<DepauditWorld>(
  "{string} does not contain the stale finding entry",
  async function (this: DepauditWorld, relPath: string) {
    const json = await readFindingsJson(this.fixturePath, relPath);
    const findings = json["findings"] as Array<Record<string, unknown>>;
    const stale = findings.find((f) => f["package"] === "stale-package" && f["findingId"] === "STALE-CVE-0000");
    assert.ok(!stale, `Expected stale finding to be gone but found: ${JSON.stringify(stale)}`);
  }
);

// Ensure the mock server infrastructure is available via world (imported for side effects)
void startMockSocketServer;
