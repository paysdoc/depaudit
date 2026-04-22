import { readFile, access, rm, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Given, When, Then, Before, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { DepauditWorld, PROJECT_ROOT } from "../support/world.js";
import { runDepaudit } from "./scan_steps.js";

// ─── Lifecycle hooks ─────────────────────────────────────────────────────────

Before<DepauditWorld>({ tags: "@adw-8" }, async function (this: DepauditWorld) {
  this.socketToken = undefined;
  this.socketMockUrl = undefined;
  this.socketMock = undefined;
  this.socketAlertPackage = undefined;
  this.socketAlertVersion = undefined;
  this.socketRequestTimeoutMs = undefined;
  this.capturedFileContent = undefined;
  this.fakeOsvBinDir = undefined;
  this.originalFileContents ??= new Map<string, string>();
});

After<DepauditWorld>({ tags: "@adw-8" }, async function (this: DepauditWorld) {
  if (this.socketMock) {
    await this.socketMock.stop();
    this.socketMock = undefined;
  }
  // Clean up .depaudit/findings.json written during each scenario
  // Use originalFileContents to restore if there was a pre-existing file
  if (this.fixturePath && this.fixturePath !== PROJECT_ROOT) {
    const findingsPath = join(this.fixturePath, ".depaudit", "findings.json");
    if (this.originalFileContents?.has(findingsPath)) {
      const original = this.originalFileContents.get(findingsPath)!;
      if (original === "") {
        // File didn't exist before; remove it
        try { await rm(findingsPath); } catch { /* already gone */ }
      } else {
        await writeFile(findingsPath, original, "utf8");
      }
      this.originalFileContents.delete(findingsPath);
    } else {
      // No snapshot = file didn't exist before; remove what the scan created
      try { await rm(findingsPath); } catch { /* didn't get written */ }
    }
  }
  // Restore any other snapshotted fixture files (e.g. .gitignore for mutation check)
  if (this.originalFileContents) {
    for (const [filePath, content] of this.originalFileContents.entries()) {
      if (content === "") {
        try { await rm(filePath); } catch { /* gone */ }
      } else {
        await writeFile(filePath, content, "utf8");
      }
    }
    this.originalFileContents.clear();
  }
});

// ─── Given steps ──────────────────────────────────────────────────────────────

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose manifest at {string} pins a package with a known OSV CVE",
  async function (this: DepauditWorld, fixturePath: string, _manifestFile: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "the directory {string} does not exist in {string}",
  async function (this: DepauditWorld, dir: string, fixturePath: string) {
    const absDir = resolve(PROJECT_ROOT, fixturePath, dir);
    try {
      await rm(absDir, { recursive: true, force: true });
    } catch {
      // already absent
    }
  }
);

Given<DepauditWorld>(
  "{string} in {string} already contains a stale findings array with 5 entries",
  async function (this: DepauditWorld, _file: string, fixturePath: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    const depauditDir = join(absPath, ".depaudit");
    await mkdir(depauditDir, { recursive: true });
    const findingsPath = join(depauditDir, "findings.json");
    // Snapshot before overwrite so After hook restores to the pre-test state
    this.originalFileContents ??= new Map<string, string>();
    try {
      const existing = await readFile(findingsPath, "utf8");
      this.originalFileContents.set(findingsPath, existing);
    } catch {
      this.originalFileContents.set(findingsPath, "");
    }
    const stale = JSON.stringify({
      schemaVersion: 1,
      sourceAvailability: { osv: true, socket: true },
      findings: [
        { package: "stale-a", version: "1.0.0", ecosystem: "npm", manifestPath: "package-lock.json", findingId: "STALE-001", severity: "HIGH", summary: "", classification: "new", source: "osv", upgradeSuggestion: null },
        { package: "stale-b", version: "1.0.0", ecosystem: "npm", manifestPath: "package-lock.json", findingId: "STALE-002", severity: "HIGH", summary: "", classification: "new", source: "osv", upgradeSuggestion: null },
        { package: "stale-c", version: "1.0.0", ecosystem: "npm", manifestPath: "package-lock.json", findingId: "STALE-003", severity: "HIGH", summary: "", classification: "new", source: "osv", upgradeSuggestion: null },
        { package: "stale-d", version: "1.0.0", ecosystem: "npm", manifestPath: "package-lock.json", findingId: "STALE-004", severity: "HIGH", summary: "", classification: "new", source: "osv", upgradeSuggestion: null },
        { package: "stale-e", version: "1.0.0", ecosystem: "npm", manifestPath: "package-lock.json", findingId: "STALE-005", severity: "HIGH", summary: "", classification: "new", source: "osv", upgradeSuggestion: null },
      ],
    }, null, 2) + "\n";
    await writeFile(findingsPath, stale, "utf8");
  }
);

Given<DepauditWorld>(
  "the repository has no .gitignore entry covering {string}",
  function (_path: string) {
    // declared by fixture structure — the fixture's .gitignore does NOT include .depaudit/
  }
);

Given<DepauditWorld>(
  "the repository's .gitignore contains the line {string}",
  function (_line: string) {
    // declared by fixture structure
  }
);

Given<DepauditWorld>(
  "the repository has no .gitignore file",
  function () {
    // declared by fixture structure
  }
);

Given<DepauditWorld>(
  "the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for that CVE's id whose `ignoreUntil` lint-passes but is treated as expired by FindingMatcher at scan time",
  async function (this: DepauditWorld) {
    // Write ignoreUntil as an ISO timestamp 500ms in the future (quoted string in TOML).
    // Linter sees it as a future date (passes). The OSV scan takes ~1.7s, so FindingMatcher
    // evaluates after the timestamp has passed (expired-accept).
    const tomlPath = join(this.fixturePath, "osv-scanner.toml");
    this.originalFileContents ??= new Map<string, string>();
    try {
      this.originalFileContents.set(tomlPath, await readFile(tomlPath, "utf8"));
    } catch {
      this.originalFileContents.set(tomlPath, "");
    }
    // KNOWN_CVE_ID from scan_accepts_steps.ts — semver 5.7.1
    const KNOWN_CVE_ID = "GHSA-c2qf-rxjj-qqgw";
    const inTwoSeconds = new Date(Date.now() + 500).toISOString();
    const content = [
      "[[IgnoredVulns]]",
      `id = "${KNOWN_CVE_ID}"`,
      `ignoreUntil = "${inTwoSeconds}"`,
      `reason = "timing-based expired-accept for BDD scenario"`,
      "",
    ].join("\n");
    await writeFile(tomlPath, content, "utf8");
    this.writtenFiles.push(tomlPath);
  }
);

Given<DepauditWorld>(
  "the repository's .depaudit.yml has a `commonAndFine` entry matching that \\(package, alertType) tuple with a valid expiry",
  async function (this: DepauditWorld) {
    const pkg = this.socketAlertPackage ?? "ms";
    const ymlPath = join(this.fixturePath, ".depaudit.yml");
    this.originalFileContents ??= new Map<string, string>();
    try {
      this.originalFileContents.set(ymlPath, await readFile(ymlPath, "utf8"));
    } catch {
      this.originalFileContents.set(ymlPath, "");
    }
    const expires = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const content = [
      "version: 1",
      "policy:",
      "  severityThreshold: medium",
      "  ecosystems: auto",
      "  maxAcceptDays: 90",
      "  maxCommonAndFineDays: 365",
      "commonAndFine:",
      `  - package: "${pkg}"`,
      `    alertType: "install-scripts"`,
      `    expires: "${expires}"`,
      `    reason: "commonAndFine BDD scenario — whitelisted"`,
      "supplyChainAccepts: []",
    ].join("\n") + "\n";
    await writeFile(ymlPath, content, "utf8");
    this.writtenFiles.push(ymlPath);
  }
);

// ─── When steps ───────────────────────────────────────────────────────────────

When<DepauditWorld>(
  "I capture the content of .gitignore in {string}",
  async function (this: DepauditWorld, fixturePath: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    const gitignorePath = join(absPath, ".gitignore");
    // Snapshot for After-hook restore
    this.originalFileContents ??= new Map<string, string>();
    try {
      const content = await readFile(gitignorePath, "utf8");
      this.capturedFileContent = content;
      this.originalFileContents.set(gitignorePath, content);
    } catch {
      this.capturedFileContent = "";
    }
  }
);

// ─── Then steps ───────────────────────────────────────────────────────────────

Then<DepauditWorld>(
  "the file {string} exists in {string}",
  async function (this: DepauditWorld, file: string, fixturePath: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath, file);
    await access(absPath);
  }
);

Then<DepauditWorld>(
  "the directory {string} exists in {string}",
  async function (this: DepauditWorld, dir: string, fixturePath: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath, dir);
    const { stat } = await import("node:fs/promises");
    const s = await stat(absPath);
    assert.ok(s.isDirectory(), `expected ${absPath} to be a directory`);
  }
);

Then<DepauditWorld>(
  "{string} in {string} is valid JSON",
  async function (this: DepauditWorld, file: string, fixturePath: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath, file);
    const content = await readFile(absPath, "utf8");
    assert.doesNotThrow(() => JSON.parse(content), `expected ${file} to be valid JSON`);
  }
);

Then<DepauditWorld>(
  "{string} in {string} has a top-level array field {string} with {int} entries",
  async function (this: DepauditWorld, file: string, fixturePath: string, field: string, count: number) {
    const absPath = resolve(PROJECT_ROOT, fixturePath, file);
    const parsed = JSON.parse(await readFile(absPath, "utf8")) as Record<string, unknown>;
    const arr = parsed[field];
    assert.ok(Array.isArray(arr), `expected "${field}" to be an array`);
    assert.equal(arr.length, count, `expected "${field}" to have ${count} entries, got ${arr.length}`);
  }
);

Then<DepauditWorld>(
  "{string} in {string} has a top-level object field {string} with `osv` set to {word} and `socket` set to {word}",
  async function (this: DepauditWorld, file: string, fixturePath: string, field: string, osv: string, socket: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath, file);
    const parsed = JSON.parse(await readFile(absPath, "utf8")) as Record<string, unknown>;
    const obj = parsed[field] as Record<string, unknown>;
    assert.ok(obj && typeof obj === "object", `expected "${field}" to be an object`);
    assert.equal(obj["osv"], osv === "true", `expected sourceAvailability.osv to be ${osv}`);
    assert.equal(obj["socket"], socket === "true", `expected sourceAvailability.socket to be ${socket}`);
  }
);

Then<DepauditWorld>(
  "{string} in {string} has a top-level object field {string} with `osv` set to {word}",
  async function (this: DepauditWorld, file: string, fixturePath: string, field: string, osv: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath, file);
    const parsed = JSON.parse(await readFile(absPath, "utf8")) as Record<string, unknown>;
    const obj = parsed[field] as Record<string, unknown>;
    assert.ok(obj && typeof obj === "object", `expected "${field}" to be an object`);
    assert.equal(obj["osv"], osv === "true", `expected ${field}.osv to be ${osv}`);
  }
);

Then<DepauditWorld>(
  "every entry in {string} `findings` array has the fields `package`, `version`, `ecosystem`, `manifestPath`, `findingId`, `severity`, `summary`, `classification`, `source`",
  async function (this: DepauditWorld, file: string) {
    const absPath = resolve(PROJECT_ROOT, this.fixturePath, file);
    const parsed = JSON.parse(await readFile(absPath, "utf8")) as { findings: Record<string, unknown>[] };
    const required = ["package", "version", "ecosystem", "manifestPath", "findingId", "severity", "summary", "classification", "source"];
    for (const entry of parsed.findings) {
      for (const key of required) {
        assert.ok(key in entry, `expected finding to have field "${key}": ${JSON.stringify(entry)}`);
      }
    }
  }
);

Then<DepauditWorld>(
  "{string} in {string} contains at least one entry whose `source` is {string}",
  async function (this: DepauditWorld, file: string, fixturePath: string, source: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath, file);
    const parsed = JSON.parse(await readFile(absPath, "utf8")) as { findings: Record<string, unknown>[] };
    const match = parsed.findings.some((e) => e["source"] === source);
    assert.ok(match, `expected at least one finding with source "${source}"\nfindings: ${JSON.stringify(parsed.findings, null, 2)}`);
  }
);

Then<DepauditWorld>(
  "{string} in {string} contains at least one entry whose `source` is {string} and `findingId` is {string}",
  async function (this: DepauditWorld, file: string, fixturePath: string, source: string, findingId: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath, file);
    const parsed = JSON.parse(await readFile(absPath, "utf8")) as { findings: Record<string, unknown>[] };
    const match = parsed.findings.some((e) => e["source"] === source && e["findingId"] === findingId);
    assert.ok(match, `expected at least one finding with source="${source}" findingId="${findingId}"\nfindings: ${JSON.stringify(parsed.findings, null, 2)}`);
  }
);

Then<DepauditWorld>(
  "{string} in {string} contains at least one entry whose `manifestPath` ends with {string}",
  async function (this: DepauditWorld, file: string, fixturePath: string, suffix: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath, file);
    const parsed = JSON.parse(await readFile(absPath, "utf8")) as { findings: Record<string, unknown>[] };
    const match = parsed.findings.some((e) => String(e["manifestPath"]).endsWith(suffix));
    assert.ok(match, `expected at least one finding with manifestPath ending "${suffix}"\nfindings: ${JSON.stringify(parsed.findings, null, 2)}`);
  }
);

Then<DepauditWorld>(
  "{string} in {string} contains at least one entry whose `ecosystem` is {string}",
  async function (this: DepauditWorld, file: string, fixturePath: string, ecosystem: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath, file);
    const parsed = JSON.parse(await readFile(absPath, "utf8")) as { findings: Record<string, unknown>[] };
    const match = parsed.findings.some((e) => e["ecosystem"] === ecosystem);
    assert.ok(match, `expected at least one finding with ecosystem "${ecosystem}"\nfindings: ${JSON.stringify(parsed.findings, null, 2)}`);
  }
);

Then<DepauditWorld>(
  "{string} in {string} contains at least one entry whose `classification` is {string}",
  async function (this: DepauditWorld, file: string, fixturePath: string, classification: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath, file);
    const parsed = JSON.parse(await readFile(absPath, "utf8")) as { findings: Record<string, unknown>[] };
    const match = parsed.findings.some((e) => e["classification"] === classification);
    assert.ok(match, `expected at least one finding with classification "${classification}"\nfindings: ${JSON.stringify(parsed.findings, null, 2)}`);
  }
);

Then<DepauditWorld>(
  "{string} in {string} contains at least one entry whose `classification` is {string} and `source` is {string}",
  async function (this: DepauditWorld, file: string, fixturePath: string, classification: string, source: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath, file);
    const parsed = JSON.parse(await readFile(absPath, "utf8")) as { findings: Record<string, unknown>[] };
    const match = parsed.findings.some((e) => e["classification"] === classification && e["source"] === source);
    assert.ok(match, `expected at least one finding with classification="${classification}" source="${source}"\nfindings: ${JSON.stringify(parsed.findings, null, 2)}`);
  }
);

Then<DepauditWorld>(
  "stdout mentions {string}",
  function (this: DepauditWorld, text: string) {
    assert.ok(
      this.result!.stdout.includes(text),
      `expected stdout to mention "${text}", got:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "stdout does not mention {string}",
  function (this: DepauditWorld, text: string) {
    assert.ok(
      !this.result!.stdout.includes(text),
      `expected stdout NOT to mention "${text}", got:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "the .gitignore content in {string} is byte-identical to the captured content",
  async function (this: DepauditWorld, fixturePath: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    const gitignorePath = join(absPath, ".gitignore");
    let current: string;
    try {
      current = await readFile(gitignorePath, "utf8");
    } catch {
      current = "";
    }
    assert.strictEqual(
      current,
      this.capturedFileContent,
      `expected .gitignore to be byte-identical to captured content.\nCaptured:\n${this.capturedFileContent}\nCurrent:\n${current}`
    );
  }
);

// ─── Ensure env forwarding is active ──────────────────────────────────────────
void runDepaudit;
