import { writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { DepauditWorld, PROJECT_ROOT } from "../support/world.js";

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

function cleanYml(severityThreshold = "medium"): string {
  return [
    "version: 1",
    "policy:",
    `  severityThreshold: ${severityThreshold}`,
    "  ecosystems: auto",
    "  maxAcceptDays: 90",
    "  maxCommonAndFineDays: 365",
    "commonAndFine: []",
    "supplyChainAccepts: []",
  ].join("\n") + "\n";
}

function scaEntry(expires: string, reason = "upstream fix pending in next major release cycle"): string {
  return [
    "  - package: some-pkg",
    '    version: "1.0.0"',
    "    findingId: SOCK-test-001",
    `    expires: "${expires}"`,
    `    reason: "${reason}"`,
  ].join("\n");
}

function cafEntry(expires: string): string {
  return [
    "  - package: some-pkg",
    "    alertType: test-alert",
    `    expires: "${expires}"`,
  ].join("\n");
}

async function writeYml(world: DepauditWorld, fixturePath: string, content: string): Promise<void> {
  const absPath = resolve(PROJECT_ROOT, fixturePath);
  const ymlPath = join(absPath, ".depaudit.yml");
  await writeFile(ymlPath, content, "utf8");
  world.writtenFiles.push(ymlPath);
  world.fixturePath = absPath;
}

async function writeYmlToFixture(world: DepauditWorld, content: string): Promise<void> {
  const ymlPath = join(world.fixturePath, ".depaudit.yml");
  await writeFile(ymlPath, content, "utf8");
  world.writtenFiles.push(ymlPath);
}

async function writeTomlToFixture(world: DepauditWorld, content: string): Promise<void> {
  const tomlPath = join(world.fixturePath, "osv-scanner.toml");
  await writeFile(tomlPath, content, "utf8");
  world.writtenFiles.push(tomlPath);
}

// ─── Given: fixture sets path + writes .depaudit.yml ─────────────────────────

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml has version 1, default policy, and empty `commonAndFine` and `supplyChainAccepts`",
  async function (this: DepauditWorld, fixturePath: string) {
    await writeYml(this, fixturePath, cleanYml());
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml contains a YAML syntax error",
  async function (this: DepauditWorld, fixturePath: string) {
    await writeYml(this, fixturePath, "version: 1\npolicy:\n  key: {unclosed: mapping\n");
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml omits the `version` field",
  async function (this: DepauditWorld, fixturePath: string) {
    await writeYml(
      this,
      fixturePath,
      "policy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine: []\nsupplyChainAccepts: []\n"
    );
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml has `version: 999`",
  async function (this: DepauditWorld, fixturePath: string) {
    await writeYml(this, fixturePath, cleanYml().replace("version: 1", "version: 999"));
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml has version 1 and no `policy` block",
  async function (this: DepauditWorld, fixturePath: string) {
    await writeYml(this, fixturePath, "version: 1\ncommonAndFine: []\nsupplyChainAccepts: []\n");
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml sets `policy.severityThreshold` to {string}",
  async function (this: DepauditWorld, fixturePath: string, threshold: string) {
    await writeYml(this, fixturePath, cleanYml(threshold));
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml has a `supplyChainAccepts` entry with `expires` set {int} days in the future",
  async function (this: DepauditWorld, fixturePath: string, days: number) {
    const content =
      "version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine: []\nsupplyChainAccepts:\n" +
      scaEntry(isoDate(days)) +
      "\n";
    await writeYml(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml has a `supplyChainAccepts` entry with `expires` set exactly 90 days from today",
  async function (this: DepauditWorld, fixturePath: string) {
    const content =
      "version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine: []\nsupplyChainAccepts:\n" +
      scaEntry(isoDate(90)) +
      "\n";
    await writeYml(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml has a `supplyChainAccepts` entry with `expires` set {int} days in the past",
  async function (this: DepauditWorld, fixturePath: string, days: number) {
    const content =
      "version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine: []\nsupplyChainAccepts:\n" +
      scaEntry(isoDate(-days)) +
      "\n";
    await writeYml(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml has a `supplyChainAccepts` entry with a `reason` of {int} characters",
  async function (this: DepauditWorld, fixturePath: string, len: number) {
    const content =
      "version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine: []\nsupplyChainAccepts:\n" +
      scaEntry(isoDate(30), "x".repeat(len)) +
      "\n";
    await writeYml(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml has a `supplyChainAccepts` entry with a `reason` of exactly 20 characters",
  async function (this: DepauditWorld, fixturePath: string) {
    const content =
      "version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine: []\nsupplyChainAccepts:\n" +
      scaEntry(isoDate(30), "x".repeat(20)) +
      "\n";
    await writeYml(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml has two `supplyChainAccepts` entries with the same `\\(package, version, findingId)` tuple",
  async function (this: DepauditWorld, fixturePath: string) {
    const entry = scaEntry(isoDate(30));
    const content =
      "version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine: []\nsupplyChainAccepts:\n" +
      entry +
      "\n" +
      entry +
      "\n";
    await writeYml(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml has a `commonAndFine` entry with `expires` set {int} days in the future",
  async function (this: DepauditWorld, fixturePath: string, days: number) {
    const content =
      "version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine:\n" +
      cafEntry(isoDate(days)) +
      "\nsupplyChainAccepts: []\n";
    await writeYml(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml has a `commonAndFine` entry with `expires` set exactly 365 days from today",
  async function (this: DepauditWorld, fixturePath: string) {
    const content =
      "version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine:\n" +
      cafEntry(isoDate(365)) +
      "\nsupplyChainAccepts: []\n";
    await writeYml(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml has a `commonAndFine` entry with `expires` set {int} days in the past",
  async function (this: DepauditWorld, fixturePath: string, days: number) {
    const content =
      "version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine:\n" +
      cafEntry(isoDate(-days)) +
      "\nsupplyChainAccepts: []\n";
    await writeYml(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml sets `policy.ecosystems` to {string}",
  async function (this: DepauditWorld, fixturePath: string, ecosystems: string) {
    const content = [
      "version: 1",
      "policy:",
      `  severityThreshold: medium`,
      `  ecosystems: ${ecosystems}`,
      "  maxAcceptDays: 90",
      "  maxCommonAndFineDays: 365",
      "commonAndFine: []",
      "supplyChainAccepts: []",
    ].join("\n") + "\n";
    await writeYml(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml sets `policy.ecosystems` to a list containing an unknown ecosystem {string}",
  async function (this: DepauditWorld, fixturePath: string, ecosystem: string) {
    const content = [
      "version: 1",
      "policy:",
      "  severityThreshold: medium",
      `  ecosystems: [${ecosystem}]`,
      "  maxAcceptDays: 90",
      "  maxCommonAndFineDays: 365",
      "commonAndFine: []",
      "supplyChainAccepts: []",
    ].join("\n") + "\n";
    await writeYml(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml has a `supplyChainAccepts` entry with no `reason` field",
  async function (this: DepauditWorld, fixturePath: string) {
    const content = [
      "version: 1",
      "policy:",
      "  severityThreshold: medium",
      "  ecosystems: auto",
      "  maxAcceptDays: 90",
      "  maxCommonAndFineDays: 365",
      "commonAndFine: []",
      "supplyChainAccepts:",
      "  - package: some-pkg",
      '    version: "1.0.0"',
      "    findingId: SOCK-test-001",
      `    expires: "${isoDate(30)}"`,
    ].join("\n") + "\n";
    await writeYml(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose .depaudit.yml has an invalid `severityThreshold` enum value and a `supplyChainAccepts` entry with a `reason` shorter than 20 characters",
  async function (this: DepauditWorld, fixturePath: string) {
    const content =
      "version: 1\npolicy:\n  severityThreshold: bogus\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine: []\nsupplyChainAccepts:\n" +
      scaEntry(isoDate(30), "short") +
      "\n";
    await writeYml(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose osv-scanner.toml has an `[[IgnoredVulns]]` entry with `ignoreUntil` in the past and whose .depaudit.yml has a `supplyChainAccepts` entry with `expires` in the past",
  async function (this: DepauditWorld, fixturePath: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    this.fixturePath = absPath;

    const tomlContent = [
      "[[IgnoredVulns]]",
      `id = "CVE-2021-23337"`,
      `ignoreUntil = ${isoDate(-1)}`,
      `reason = "upstream fix pending in 4.17.21"`,
      "",
    ].join("\n");
    const tomlPath = join(absPath, "osv-scanner.toml");
    await writeFile(tomlPath, tomlContent, "utf8");
    this.writtenFiles.push(tomlPath);

    const ymlContent =
      "version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine: []\nsupplyChainAccepts:\n" +
      scaEntry(isoDate(-1)) +
      "\n";
    const ymlPath = join(absPath, ".depaudit.yml");
    await writeFile(ymlPath, ymlContent, "utf8");
    this.writtenFiles.push(ymlPath);
  }
);

// ─── Given: fixture sets path only (no yml written — manifest determines findings) ──

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose manifest pins a package with a known LOW-severity OSV finding",
  async function (this: DepauditWorld, fixturePath: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose manifest pins a package with a known MEDIUM-severity OSV finding",
  async function (this: DepauditWorld, fixturePath: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose manifest pins a package with a known HIGH-severity OSV finding",
  async function (this: DepauditWorld, fixturePath: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose manifest pins a package with a known CRITICAL-severity OSV finding",
  async function (this: DepauditWorld, fixturePath: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} that produces one MEDIUM-severity OSV finding and one HIGH-severity OSV finding",
  async function (this: DepauditWorld, fixturePath: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

// ─── Given/And: repository has no .depaudit.yml ───────────────────────────────

Given<DepauditWorld>(
  "the repository has no .depaudit.yml",
  async function (this: DepauditWorld) {
    // no-op: fixture has no .depaudit.yml committed; absent file is treated as clean default
  }
);

// ─── And: write .depaudit.yml to already-set fixturePath ─────────────────────

Given<DepauditWorld>(
  "the repository's .depaudit.yml has version 1, default policy, and empty `commonAndFine` and `supplyChainAccepts`",
  async function (this: DepauditWorld) {
    await writeYmlToFixture(this, cleanYml());
  }
);

Given<DepauditWorld>(
  "the repository's .depaudit.yml has version 1 and no `policy` block",
  async function (this: DepauditWorld) {
    await writeYmlToFixture(this, "version: 1\ncommonAndFine: []\nsupplyChainAccepts: []\n");
  }
);

Given<DepauditWorld>(
  "the repository's .depaudit.yml sets `policy.severityThreshold` to {string}",
  async function (this: DepauditWorld, threshold: string) {
    await writeYmlToFixture(this, cleanYml(threshold));
  }
);

Given<DepauditWorld>(
  "the repository's .depaudit.yml contains a YAML syntax error",
  async function (this: DepauditWorld) {
    await writeYmlToFixture(this, "version: 1\npolicy:\n  key: {unclosed: mapping\n");
  }
);

Given<DepauditWorld>(
  "the repository's .depaudit.yml has a `supplyChainAccepts` entry with `expires` set {int} days in the past",
  async function (this: DepauditWorld, days: number) {
    const content =
      "version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine: []\nsupplyChainAccepts:\n" +
      scaEntry(isoDate(-days)) +
      "\n";
    await writeYmlToFixture(this, content);
  }
);

Given<DepauditWorld>(
  "the repository's .depaudit.yml has a `commonAndFine` entry with `expires` set {int} days in the past",
  async function (this: DepauditWorld, days: number) {
    const content =
      "version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine:\n" +
      cafEntry(isoDate(-days)) +
      "\nsupplyChainAccepts: []\n";
    await writeYmlToFixture(this, content);
  }
);

Given<DepauditWorld>(
  "the repository's .depaudit.yml has a `commonAndFine` entry with `expires` set {int} days in the future",
  async function (this: DepauditWorld, days: number) {
    const content =
      "version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine:\n" +
      cafEntry(isoDate(days)) +
      "\nsupplyChainAccepts: []\n";
    await writeYmlToFixture(this, content);
  }
);

Given<DepauditWorld>(
  "the repository's .depaudit.yml has a valid `supplyChainAccepts` entry for a different package",
  async function (this: DepauditWorld) {
    const content = [
      "version: 1",
      "policy:",
      "  severityThreshold: medium",
      "  ecosystems: auto",
      "  maxAcceptDays: 90",
      "  maxCommonAndFineDays: 365",
      "commonAndFine: []",
      "supplyChainAccepts:",
      "  - package: unrelated-pkg",
      '    version: "2.0.0"',
      "    findingId: SOCK-unrelated-001",
      `    expires: "${isoDate(30)}"`,
      '    reason: "different package unrelated to findings"',
    ].join("\n") + "\n";
    await writeYmlToFixture(this, content);
  }
);

// ─── Then steps ───────────────────────────────────────────────────────────────

Then<DepauditWorld>(
  'stderr mentions the file name ".depaudit.yml"',
  function (this: DepauditWorld) {
    assert.ok(
      this.result!.stderr.includes(".depaudit.yml"),
      `expected stderr to mention ".depaudit.yml", got:\n${this.result!.stderr}`
    );
  }
);

Then<DepauditWorld>(
  "stderr mentions the 365-day cap",
  function (this: DepauditWorld) {
    const hasCap = /365-day cap|365 day cap|exceeds.*cap/i.test(this.result!.stderr);
    assert.ok(hasCap, `expected stderr to mention 365-day cap, got:\n${this.result!.stderr}`);
  }
);

Then<DepauditWorld>(
  "the finding line contains the severity {string}",
  function (this: DepauditWorld, expectedSeverity: string) {
    const lines = this.result!.stdout.trim().split("\n").filter(Boolean);
    const match = lines.some((line) => {
      const parts = line.trim().split(/\s+/);
      return parts.length >= 4 && parts[3] === expectedSeverity;
    });
    assert.ok(match, `expected a finding line with severity "${expectedSeverity}", got:\n${this.result!.stdout}`);
  }
);
