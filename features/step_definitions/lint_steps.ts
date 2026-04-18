import { writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Given, Then, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { DepauditWorld, PROJECT_ROOT } from "../support/world.js";

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

async function writeTomL(world: DepauditWorld, fixturePath: string, content: string): Promise<void> {
  const tomlPath = join(resolve(PROJECT_ROOT, fixturePath), "osv-scanner.toml");
  await writeFile(tomlPath, content, "utf8");
  world.writtenFiles.push(tomlPath);
  world.fixturePath = resolve(PROJECT_ROOT, fixturePath);
}

After<DepauditWorld>(async function (this: DepauditWorld) {
  for (const f of this.writtenFiles) {
    await unlink(f).catch(() => undefined);
  }
  this.writtenFiles = [];
});

// ─── Given steps ──────────────────────────────────────────────────────────────

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose osv-scanner.toml has one valid `[[IgnoredVulns]]` entry",
  async function (this: DepauditWorld, fixturePath: string) {
    const content = [
      "[[IgnoredVulns]]",
      `id = "CVE-2021-23337"`,
      `ignoreUntil = ${isoDate(30)}`,
      `reason = "upstream fix pending in 4.17.21"`,
      "",
    ].join("\n");
    await writeTomL(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose osv-scanner.toml has an `[[IgnoredVulns]]` entry with `ignoreUntil` set {int} days in the past",
  async function (this: DepauditWorld, fixturePath: string, days: number) {
    const content = [
      "[[IgnoredVulns]]",
      `id = "CVE-2021-23337"`,
      `ignoreUntil = ${isoDate(-days)}`,
      `reason = "upstream fix pending in 4.17.21"`,
      "",
    ].join("\n");
    await writeTomL(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose osv-scanner.toml has an `[[IgnoredVulns]]` entry with `ignoreUntil` set {int} days in the future",
  async function (this: DepauditWorld, fixturePath: string, days: number) {
    const content = [
      "[[IgnoredVulns]]",
      `id = "CVE-2021-23337"`,
      `ignoreUntil = ${isoDate(days)}`,
      `reason = "upstream fix pending in 4.17.21"`,
      "",
    ].join("\n");
    await writeTomL(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose osv-scanner.toml has an `[[IgnoredVulns]]` entry with `ignoreUntil` set exactly 90 days from today",
  async function (this: DepauditWorld, fixturePath: string) {
    const content = [
      "[[IgnoredVulns]]",
      `id = "CVE-2021-23337"`,
      `ignoreUntil = ${isoDate(90)}`,
      `reason = "upstream fix pending in 4.17.21"`,
      "",
    ].join("\n");
    await writeTomL(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose osv-scanner.toml has an `[[IgnoredVulns]]` entry with a `reason` of {int} characters",
  async function (this: DepauditWorld, fixturePath: string, len: number) {
    const reason = "x".repeat(len);
    const content = [
      "[[IgnoredVulns]]",
      `id = "CVE-2021-23337"`,
      `ignoreUntil = ${isoDate(30)}`,
      `reason = "${reason}"`,
      "",
    ].join("\n");
    await writeTomL(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose osv-scanner.toml has an `[[IgnoredVulns]]` entry with a `reason` of exactly 20 characters",
  async function (this: DepauditWorld, fixturePath: string) {
    const reason = "x".repeat(20);
    const content = [
      "[[IgnoredVulns]]",
      `id = "CVE-2021-23337"`,
      `ignoreUntil = ${isoDate(30)}`,
      `reason = "${reason}"`,
      "",
    ].join("\n");
    await writeTomL(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose osv-scanner.toml has two `[[IgnoredVulns]]` entries with the same `id`",
  async function (this: DepauditWorld, fixturePath: string) {
    const content = [
      "[[IgnoredVulns]]",
      `id = "CVE-2021-23337"`,
      `ignoreUntil = ${isoDate(30)}`,
      `reason = "upstream fix pending in 4.17.21"`,
      "",
      "[[IgnoredVulns]]",
      `id = "CVE-2021-23337"`,
      `ignoreUntil = ${isoDate(30)}`,
      `reason = "upstream fix pending in 4.17.21"`,
      "",
    ].join("\n");
    await writeTomL(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose osv-scanner.toml has an `[[IgnoredVulns]]` entry with `ignoreUntil` in the past and a second `[[IgnoredVulns]]` entry with a `reason` shorter than 20 characters",
  async function (this: DepauditWorld, fixturePath: string) {
    const content = [
      "[[IgnoredVulns]]",
      `id = "CVE-2021-23337"`,
      `ignoreUntil = ${isoDate(-7)}`,
      `reason = "upstream fix pending in 4.17.21"`,
      "",
      "[[IgnoredVulns]]",
      `id = "GHSA-test-1234-abcd"`,
      `ignoreUntil = ${isoDate(30)}`,
      `reason = "too short"`,
      "",
    ].join("\n");
    await writeTomL(this, fixturePath, content);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose osv-scanner.toml contains a TOML syntax error",
  async function (this: DepauditWorld, fixturePath: string) {
    const content = "[[IgnoredVulns\nid = \"CVE-2021-23337\"\n";
    await writeTomL(this, fixturePath, content);
  }
);

Given<DepauditWorld>("the repository has no osv-scanner.toml", async function (this: DepauditWorld) {
  // no-op: clean-npm fixture has no osv-scanner.toml committed
});

// ─── Then steps ───────────────────────────────────────────────────────────────

Then<DepauditWorld>(
  "stderr mentions {string}",
  function (this: DepauditWorld, substring: string) {
    assert.ok(
      this.result!.stderr.includes(substring),
      `expected stderr to contain "${substring}", got:\n${this.result!.stderr}`
    );
  }
);

Then<DepauditWorld>(
  'stderr mentions the file name "osv-scanner.toml"',
  function (this: DepauditWorld) {
    assert.ok(
      this.result!.stderr.includes("osv-scanner.toml"),
      `expected stderr to mention "osv-scanner.toml", got:\n${this.result!.stderr}`
    );
  }
);

Then<DepauditWorld>(
  "stderr mentions the line number of the parse error",
  function (this: DepauditWorld) {
    assert.match(
      this.result!.stderr,
      /:\d+:\d+:/,
      `expected stderr to contain :<line>:<col>: pattern, got:\n${this.result!.stderr}`
    );
  }
);

Then<DepauditWorld>(
  "stderr mentions the column number of the parse error",
  function (this: DepauditWorld) {
    assert.match(
      this.result!.stderr,
      /:\d+:\d+:/,
      `expected stderr to contain :<line>:<col>: pattern, got:\n${this.result!.stderr}`
    );
  }
);

Then<DepauditWorld>(
  "stderr indicates that the date is in the past",
  function (this: DepauditWorld) {
    const hasPast = /already passed|in the past/i.test(this.result!.stderr);
    assert.ok(hasPast, `expected stderr to indicate date is in the past, got:\n${this.result!.stderr}`);
  }
);

Then<DepauditWorld>(
  "stderr mentions the 90-day cap",
  function (this: DepauditWorld) {
    const hasCap = /90-day cap|90 day cap|exceeds.*cap/i.test(this.result!.stderr);
    assert.ok(hasCap, `expected stderr to mention 90-day cap, got:\n${this.result!.stderr}`);
  }
);

Then<DepauditWorld>(
  "stderr mentions the 20-character minimum",
  function (this: DepauditWorld) {
    const hasMin = /20 character/i.test(this.result!.stderr);
    assert.ok(hasMin, `expected stderr to mention 20-character minimum, got:\n${this.result!.stderr}`);
  }
);

Then<DepauditWorld>(
  "stderr mentions the duplicated id",
  function (this: DepauditWorld) {
    const hasDuplicate = /duplicate/i.test(this.result!.stderr);
    assert.ok(hasDuplicate, `expected stderr to mention duplicate id, got:\n${this.result!.stderr}`);
  }
);
