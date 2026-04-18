import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Given } from "@cucumber/cucumber";
import { DepauditWorld } from "../support/world.js";

// The actual finding ID produced by fixtures/one-finding-npm (semver 5.7.1)
const KNOWN_CVE_ID = "GHSA-c2qf-rxjj-qqgw";

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

async function writeAcceptToml(world: DepauditWorld, content: string): Promise<void> {
  const tomlPath = join(world.fixturePath, "osv-scanner.toml");
  await writeFile(tomlPath, content, "utf8");
  world.writtenFiles.push(tomlPath);
}

// ─── Given steps ──────────────────────────────────────────────────────────────

Given<DepauditWorld>(
  "the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for that CVE's id with a valid `ignoreUntil` and a `reason` of at least 20 characters",
  async function (this: DepauditWorld) {
    const content = [
      "[[IgnoredVulns]]",
      `id = "${KNOWN_CVE_ID}"`,
      `ignoreUntil = ${isoDate(30)}`,
      `reason = "upstream fix pending in semver release"`,
      "",
    ].join("\n");
    await writeAcceptToml(this, content);
  }
);

Given<DepauditWorld>(
  "the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry whose id does NOT match that CVE",
  async function (this: DepauditWorld) {
    const content = [
      "[[IgnoredVulns]]",
      `id = "CVE-UNRELATED-9999"`,
      `ignoreUntil = ${isoDate(30)}`,
      `reason = "unrelated CVE acceptance for testing"`,
      "",
    ].join("\n");
    await writeAcceptToml(this, content);
  }
);

Given<DepauditWorld>(
  "the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry with `ignoreUntil` set {int} days in the past",
  async function (this: DepauditWorld, days: number) {
    const content = [
      "[[IgnoredVulns]]",
      `id = "${KNOWN_CVE_ID}"`,
      `ignoreUntil = ${isoDate(-days)}`,
      `reason = "upstream fix pending in semver release"`,
      "",
    ].join("\n");
    await writeAcceptToml(this, content);
  }
);

Given<DepauditWorld>(
  "the repository's osv-scanner.toml contains a TOML syntax error",
  async function (this: DepauditWorld) {
    const content = `[[IgnoredVulns\nid = "${KNOWN_CVE_ID}"\n`;
    await writeAcceptToml(this, content);
  }
);

Given<DepauditWorld>(
  "the repository's osv-scanner.toml has two `[[IgnoredVulns]]` entries with the same `id` that both match that CVE",
  async function (this: DepauditWorld) {
    const content = [
      "[[IgnoredVulns]]",
      `id = "${KNOWN_CVE_ID}"`,
      `ignoreUntil = ${isoDate(30)}`,
      `reason = "upstream fix pending in semver release"`,
      "",
      "[[IgnoredVulns]]",
      `id = "${KNOWN_CVE_ID}"`,
      `ignoreUntil = ${isoDate(30)}`,
      `reason = "upstream fix pending in semver release"`,
      "",
    ].join("\n");
    await writeAcceptToml(this, content);
  }
);

// Note: "a fixture Node repository at {string} whose manifest pins a package with a known OSV CVE"
// is registered in scan_steps.ts. It sets this.fixturePath to the resolved fixture dir.
// The steps above then write osv-scanner.toml relative to this.fixturePath.
