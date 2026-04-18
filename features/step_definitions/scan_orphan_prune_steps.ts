import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { Given, When, Then, Before, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { DepauditWorld, PROJECT_ROOT } from "../support/world.js";
import { startMockSocketServer } from "../support/mockSocketServer.js";
import { runDepaudit } from "./scan_steps.js";

// ─── Lifecycle hooks ─────────────────────────────────────────────────────────

Before<DepauditWorld>({ tags: "@adw-13" }, function (this: DepauditWorld) {
  this.socketToken = undefined;
  this.socketMockUrl = undefined;
  this.socketMock = undefined;
  this.socketAlertPackage = undefined;
  this.socketAlertVersion = undefined;
  this.socketRequestTimeoutMs = undefined;
  this.capturedFileContent = undefined;
  this.fakeOsvBinDir = undefined;
});

After<DepauditWorld>({ tags: "@adw-13" }, async function (this: DepauditWorld) {
  if (this.socketMock) {
    await this.socketMock.stop();
    this.socketMock = undefined;
  }
  // Restore any snapshotted fixture files
  if (this.originalFileContents) {
    for (const [filePath, content] of this.originalFileContents.entries()) {
      await writeFile(filePath, content, "utf8");
    }
    this.originalFileContents.clear();
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function futureDateStr(days = 60): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Build a valid .depaudit.yml with supplyChainAccepts entries. */
function buildScaYml(accepts: Array<{ pkg: string; version: string; findingId: string }>): string {
  const expires = futureDateStr(60);
  const lines = [
    "version: 1",
    "policy:",
    "  severityThreshold: medium",
    "  ecosystems: auto",
    "  maxAcceptDays: 90",
    "  maxCommonAndFineDays: 365",
    "commonAndFine: []",
    "supplyChainAccepts:",
  ];
  for (const a of accepts) {
    lines.push(`  - package: "${a.pkg}"`);
    lines.push(`    version: "${a.version}"`);
    lines.push(`    findingId: "${a.findingId}"`);
    lines.push(`    expires: "${expires}"`);
    lines.push(`    reason: "Test acceptance for BDD scenario — automated"`);
  }
  return lines.join("\n") + "\n";
}

/** Read and snapshot fixture files before test, restore after. */
async function snapshotFile(world: DepauditWorld, filePath: string): Promise<void> {
  if (!world.originalFileContents) {
    world.originalFileContents = new Map<string, string>();
  }
  try {
    const content = await readFile(filePath, "utf8");
    world.originalFileContents.set(filePath, content);
  } catch {
    // File may not exist yet — snapshot as null sentinel means "delete on restore"
    world.originalFileContents.set(filePath, "");
  }
}

async function snapshotFixtureFiles(world: DepauditWorld, fixturePath: string): Promise<void> {
  const ymlPath = join(fixturePath, ".depaudit.yml");
  const tomlPath = join(fixturePath, "osv-scanner.toml");
  await snapshotFile(world, ymlPath);
  await snapshotFile(world, tomlPath);
}

/** Get the first npm package from a fixture's package.json */
async function getFirstNpmPackage(fixturePath: string): Promise<{ name: string; version: string }> {
  const pkgPath = resolve(fixturePath, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = Object.entries(pkg.dependencies ?? {});
  if (deps.length === 0) throw new Error(`No dependencies in ${pkgPath}`);
  const [name, versionRange] = deps[0];
  const version = versionRange.replace(/^[^0-9]*/, "");
  return { name, version };
}

function buildSocketNpmResponse(pkgName: string, pkgVersion: string, alertType: string, severity = "high"): unknown[] {
  return [{
    purl: `pkg:npm/${encodeURIComponent(pkgName)}@${encodeURIComponent(pkgVersion)}`,
    alerts: [{ type: alertType, severity, props: { title: `${alertType} detected` } }],
  }];
}

// ─── Given steps ──────────────────────────────────────────────────────────────

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose OSV scan fails catastrophically",
  async function (this: DepauditWorld, fixturePath: string) {
    const { access } = await import("node:fs/promises");
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
    // Snapshot fixture files for restore
    await snapshotFixtureFiles(this, this.fixturePath);
    // Create a fake osv-scanner binary that always fails with exit code 2
    const binDir = await mkdtemp(join(tmpdir(), "fake-osv-scanner-"));
    const fakeBinPath = join(binDir, "osv-scanner");
    // Write a shell script that exits with code 2 (catastrophic failure, not "findings" exit 1)
    await writeFile(fakeBinPath, "#!/bin/sh\necho 'osv-scanner: catastrophic internal error' >&2\nexit 2\n", { mode: 0o755 });
    this.fakeOsvBinDir = binDir;
  }
);

Given<DepauditWorld>(
  "the repository's .depaudit.yml has a `supplyChainAccepts` entry for package {string} at version {string} that matches no current finding",
  async function (this: DepauditWorld, pkg: string, version: string) {
    // Snapshot original file before we (possibly) overwrite
    const ymlPath = join(this.fixturePath, ".depaudit.yml");
    await snapshotFile(this, ymlPath);
    // The fixture already has this entry pre-committed — just verify it's there
    try {
      const content = await readFile(ymlPath, "utf8");
      if (!content.includes(pkg)) {
        // Write it if it's not there (for cases where step is declarative)
        await writeFile(ymlPath, buildScaYml([{ pkg, version, findingId: "install-scripts" }]), "utf8");
      }
    } catch {
      await writeFile(ymlPath, buildScaYml([{ pkg, version, findingId: "install-scripts" }]), "utf8");
    }
  }
);

Given<DepauditWorld>(
  "the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for id {string} that matches no current finding",
  async function (this: DepauditWorld, cveId: string) {
    const tomlPath = join(this.fixturePath, "osv-scanner.toml");
    await snapshotFile(this, tomlPath);
    // The fixture already has this entry pre-committed — just verify it's there
    try {
      const content = await readFile(tomlPath, "utf8");
      if (!content.includes(cveId)) {
        const tomlContent = [
          "[[IgnoredVulns]]",
          `id = "${cveId}"`,
          `ignoreUntil = ${futureDateStr(60)}`,
          `reason = "Stale CVE accept for BDD scenario"`,
          "",
        ].join("\n");
        await writeFile(tomlPath, tomlContent, "utf8");
      }
    } catch {
      const tomlContent = [
        "[[IgnoredVulns]]",
        `id = "${cveId}"`,
        `ignoreUntil = ${futureDateStr(60)}`,
        `reason = "Stale CVE accept for BDD scenario"`,
        "",
      ].join("\n");
      await writeFile(tomlPath, tomlContent, "utf8");
    }
  }
);

Given<DepauditWorld>(
  "the repository's .depaudit.yml has two `supplyChainAccepts` entries: one matching the Socket alert and one for package {string} at version {string} that matches no current finding",
  async function (this: DepauditWorld, ghostPkg: string, ghostVersion: string) {
    const ymlPath = join(this.fixturePath, ".depaudit.yml");
    await snapshotFile(this, ymlPath);
    const alertPkg = this.socketAlertPackage ?? "ms";
    const alertVersion = this.socketAlertVersion ?? "2.1.3";
    const content = buildScaYml([
      { pkg: alertPkg, version: alertVersion, findingId: "install-scripts" },
      { pkg: ghostPkg, version: ghostVersion, findingId: "install-scripts" },
    ]);
    await writeFile(ymlPath, content, "utf8");
  }
);

// Note: "the repository's .depaudit.yml has version 1, default policy, and empty..."
// is already defined in depaudit_yml_steps.ts — do not duplicate it here.

// Note: "a mock Socket API that responds with an {string} alert for a package in that manifest"
// is already defined in scan_socket_supply_chain_steps.ts — do not duplicate it here.

// ─── When steps ───────────────────────────────────────────────────────────────

// "I run {string}" is already defined in scan_steps.ts

// Capture content steps
When<DepauditWorld>(
  "I capture the content of .depaudit.yml in {string}",
  async function (this: DepauditWorld, fixturePath: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    const ymlPath = join(absPath, ".depaudit.yml");
    this.capturedFileContent = await readFile(ymlPath, "utf8");
  }
);

When<DepauditWorld>(
  "I capture the content of osv-scanner.toml in {string}",
  async function (this: DepauditWorld, fixturePath: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    const tomlPath = join(absPath, "osv-scanner.toml");
    this.capturedFileContent = await readFile(tomlPath, "utf8");
  }
);

// ─── Then steps ───────────────────────────────────────────────────────────────

Then<DepauditWorld>(
  "the .depaudit.yml in {string} no longer contains a `supplyChainAccepts` entry for package {string}",
  async function (this: DepauditWorld, fixturePath: string, pkg: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    const ymlPath = join(absPath, ".depaudit.yml");
    const content = await readFile(ymlPath, "utf8");
    assert.ok(
      !content.includes(`package: "${pkg}"`) && !content.includes(`package: ${pkg}`),
      `expected .depaudit.yml to NOT contain package "${pkg}", but got:\n${content}`
    );
  }
);

Then<DepauditWorld>(
  "the .depaudit.yml in {string} still contains the matching `supplyChainAccepts` entry",
  async function (this: DepauditWorld, fixturePath: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    const ymlPath = join(absPath, ".depaudit.yml");
    const content = await readFile(ymlPath, "utf8");
    const pkg = this.socketAlertPackage ?? "ms";
    assert.ok(
      content.includes(`package: "${pkg}"`) || content.includes(`package: ${pkg}`),
      `expected .depaudit.yml to still contain package "${pkg}", but got:\n${content}`
    );
  }
);

Then<DepauditWorld>(
  "the .depaudit.yml in {string} still contains a `supplyChainAccepts` entry for package {string}",
  async function (this: DepauditWorld, fixturePath: string, pkg: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    const ymlPath = join(absPath, ".depaudit.yml");
    const content = await readFile(ymlPath, "utf8");
    assert.ok(
      content.includes(`package: "${pkg}"`) || content.includes(`package: ${pkg}`),
      `expected .depaudit.yml to still contain package "${pkg}", but got:\n${content}`
    );
  }
);

Then<DepauditWorld>(
  "the .depaudit.yml in {string} still contains a `supplyChainAccepts` entry matching the Socket alert",
  async function (this: DepauditWorld, fixturePath: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    const ymlPath = join(absPath, ".depaudit.yml");
    const content = await readFile(ymlPath, "utf8");
    const pkg = this.socketAlertPackage ?? "ms";
    assert.ok(
      content.includes(`package: "${pkg}"`) || content.includes(`package: ${pkg}`),
      `expected .depaudit.yml to still contain Socket alert package "${pkg}", but got:\n${content}`
    );
  }
);

Then<DepauditWorld>(
  "the osv-scanner.toml in {string} no longer contains an `[[IgnoredVulns]]` entry for id {string}",
  async function (this: DepauditWorld, fixturePath: string, cveId: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    const tomlPath = join(absPath, "osv-scanner.toml");
    let content: string;
    try {
      content = await readFile(tomlPath, "utf8");
    } catch {
      // File was completely removed — that also means no entry
      return;
    }
    assert.ok(
      !content.includes(`"${cveId}"`),
      `expected osv-scanner.toml to NOT contain id "${cveId}", but got:\n${content}`
    );
  }
);

Then<DepauditWorld>(
  "the osv-scanner.toml in {string} still contains an `[[IgnoredVulns]]` entry for id {string}",
  async function (this: DepauditWorld, fixturePath: string, cveId: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    const tomlPath = join(absPath, "osv-scanner.toml");
    const content = await readFile(tomlPath, "utf8");
    assert.ok(
      content.includes(`"${cveId}"`),
      `expected osv-scanner.toml to still contain id "${cveId}", but got:\n${content}`
    );
  }
);

Then<DepauditWorld>(
  "the osv-scanner.toml in {string} still contains an `[[IgnoredVulns]]` entry for that CVE",
  async function (this: DepauditWorld, fixturePath: string) {
    // "that CVE" refers to the CVE written by the scan_accepts_steps.ts step
    // The fixture uses semver 5.7.1 → GHSA-c2qf-rxjj-qqgw
    const KNOWN_CVE_ID = "GHSA-c2qf-rxjj-qqgw";
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    const tomlPath = join(absPath, "osv-scanner.toml");
    const content = await readFile(tomlPath, "utf8");
    assert.ok(
      content.includes(`"${KNOWN_CVE_ID}"`),
      `expected osv-scanner.toml to still contain id "${KNOWN_CVE_ID}", but got:\n${content}`
    );
  }
);

Then<DepauditWorld>(
  "the .depaudit.yml content in {string} is byte-identical to the captured content",
  async function (this: DepauditWorld, fixturePath: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    const ymlPath = join(absPath, ".depaudit.yml");
    const currentContent = await readFile(ymlPath, "utf8");
    assert.strictEqual(
      currentContent,
      this.capturedFileContent,
      `expected .depaudit.yml content to be byte-identical to captured content.\nCaptured:\n${this.capturedFileContent}\nCurrent:\n${currentContent}`
    );
  }
);

Then<DepauditWorld>(
  "the osv-scanner.toml content in {string} is byte-identical to the captured content",
  async function (this: DepauditWorld, fixturePath: string) {
    const absPath = resolve(PROJECT_ROOT, fixturePath);
    const tomlPath = join(absPath, "osv-scanner.toml");
    const currentContent = await readFile(tomlPath, "utf8");
    assert.strictEqual(
      currentContent,
      this.capturedFileContent,
      `expected osv-scanner.toml content to be byte-identical to captured content.\nCaptured:\n${this.capturedFileContent}\nCurrent:\n${currentContent}`
    );
  }
);

// ─── Ensure env forwarding is active ──────────────────────────────────────────
void runDepaudit;
