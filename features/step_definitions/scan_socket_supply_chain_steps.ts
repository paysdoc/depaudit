import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Given, Then, Before, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { DepauditWorld, PROJECT_ROOT } from "../support/world.js";
import { startMockSocketServer } from "../support/mockSocketServer.js";
import { runDepaudit } from "./scan_steps.js";

const FINDING_LINE_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(UNKNOWN|LOW|MEDIUM|HIGH|CRITICAL)$/;

// ─── Lifecycle hooks ─────────────────────────────────────────────────────────

Before<DepauditWorld>({ tags: "@adw-7" }, function () {
  this.socketToken = undefined;
  this.socketMockUrl = undefined;
  this.socketMock = undefined;
  this.socketAlertPackage = undefined;
  this.socketAlertVersion = undefined;
  this.socketRequestTimeoutMs = undefined;
});

After<DepauditWorld>({ tags: "@adw-7" }, async function () {
  if (this.socketMock) {
    await this.socketMock.stop();
    this.socketMock = undefined;
  }
});

// ─── Fixture steps specific to @adw-7 ────────────────────────────────────────

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose manifest pins a package at version {string}",
  async function (this: DepauditWorld, fixturePath: string, _version: string) {
    const { access } = await import("node:fs/promises");
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

// ─── Token steps ─────────────────────────────────────────────────────────────

Given<DepauditWorld>("SOCKET_API_TOKEN is set to a valid test value", function (this: DepauditWorld) {
  this.socketToken = "test-socket-token-adw7";
});

Given<DepauditWorld>("the SOCKET_API_TOKEN environment variable is unset", function (this: DepauditWorld) {
  // Empty string signals scan_steps.ts to explicitly delete SOCKET_API_TOKEN from env
  this.socketToken = "";
});

// ─── Mock Socket server helpers ───────────────────────────────────────────────

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

async function getFirstPipPackage(fixturePath: string): Promise<{ name: string; version: string }> {
  const reqPath = resolve(fixturePath, "requirements.txt");
  const content = await readFile(reqPath, "utf8");
  const line = content.trim().split("\n").find((l) => l.trim().match(/^[A-Za-z0-9_.-]+==/));
  if (!line) throw new Error(`No pinned packages in ${reqPath}`);
  const [name, version] = line.trim().split("==");
  return { name: name.trim(), version: version.trim() };
}

function buildSocketNpmResponse(pkgName: string, pkgVersion: string, alertType: string, severity = "high"): unknown[] {
  return [{
    purl: `pkg:npm/${encodeURIComponent(pkgName)}@${encodeURIComponent(pkgVersion)}`,
    alerts: [{ type: alertType, severity, props: { title: `${alertType} detected` } }],
  }];
}

function buildSocketPipResponse(pkgName: string, pkgVersion: string, alertType: string, severity = "high"): unknown[] {
  return [{
    purl: `pkg:pypi/${encodeURIComponent(pkgName)}@${encodeURIComponent(pkgVersion)}`,
    alerts: [{ type: alertType, severity, props: { title: `${alertType} detected` } }],
  }];
}

// ─── Mock Socket server steps ─────────────────────────────────────────────────

Given<DepauditWorld>(
  "a mock Socket API that responds with an {string} alert for a package declared in that manifest",
  async function (this: DepauditWorld, alertType: string) {
    const { name, version } = await getFirstNpmPackage(this.fixturePath);
    this.socketAlertPackage = name;
    this.socketAlertVersion = version;
    this.socketMock = await startMockSocketServer({ body: buildSocketNpmResponse(name, version, alertType) });
    this.socketMockUrl = this.socketMock.url;
  }
);

// Alias used by supplyChainAccepts and format scenarios (no "declared" in text)
Given<DepauditWorld>(
  "a mock Socket API that responds with an {string} alert for a package in that manifest",
  async function (this: DepauditWorld, alertType: string) {
    const { name, version } = await getFirstNpmPackage(this.fixturePath);
    this.socketAlertPackage = name;
    this.socketAlertVersion = version;
    this.socketMock = await startMockSocketServer({ body: buildSocketNpmResponse(name, version, alertType) });
    this.socketMockUrl = this.socketMock.url;
  }
);

Given<DepauditWorld>(
  "a mock Socket API that responds with no alerts for every package",
  async function (this: DepauditWorld) {
    this.socketMock = await startMockSocketServer({ body: [] });
    this.socketMockUrl = this.socketMock.url;
  }
);

Given<DepauditWorld>(
  "a mock Socket API that responds with an {string} alert for a different package declared in that manifest",
  async function (this: DepauditWorld, alertType: string) {
    const pkgPath = resolve(this.fixturePath, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.entries(pkg.dependencies ?? {});
    // Second dep is the "different" package (first dep has the CVE)
    const [name, versionRange] = deps.length > 1 ? deps[1] : deps[0];
    const version = versionRange.replace(/^[^0-9]*/, "");
    this.socketAlertPackage = name;
    this.socketAlertVersion = version;
    this.socketMock = await startMockSocketServer({ body: buildSocketNpmResponse(name, version, alertType) });
    this.socketMockUrl = this.socketMock.url;
  }
);

// "for that package at version {string}" — used by the wrong-version scenario
Given<DepauditWorld>(
  "a mock Socket API that responds with an {string} alert for that package at version {string}",
  async function (this: DepauditWorld, alertType: string, version: string) {
    const { name } = await getFirstNpmPackage(this.fixturePath);
    this.socketAlertPackage = name;
    this.socketAlertVersion = version;
    this.socketMock = await startMockSocketServer({ body: buildSocketNpmResponse(name, version, alertType) });
    this.socketMockUrl = this.socketMock.url;
  }
);

Given<DepauditWorld>(
  "a mock Socket API that never responds within the client timeout",
  async function (this: DepauditWorld) {
    // Use a short per-request timeout so this scenario completes in ~2s instead of 90s
    this.socketRequestTimeoutMs = 500;
    this.socketMock = await startMockSocketServer({
      transientKind: "timeout",
      failuresBeforeSuccess: 9999,
    });
    this.socketMockUrl = this.socketMock.url;
  }
);

Given<DepauditWorld>(
  "a mock Socket API that returns HTTP 503 for every request",
  async function (this: DepauditWorld) {
    this.socketRequestTimeoutMs = 500; // Speed up fail-open: 3 retries × ~0ms + 500ms+1s backoff ≈ 2s
    this.socketMock = await startMockSocketServer({
      transientKind: "500",
      failuresBeforeSuccess: 9999,
    });
    this.socketMockUrl = this.socketMock.url;
  }
);

Given<DepauditWorld>(
  "a mock Socket API that returns HTTP 429 for every request",
  async function (this: DepauditWorld) {
    this.socketRequestTimeoutMs = 500;
    this.socketMock = await startMockSocketServer({
      transientKind: "429",
      failuresBeforeSuccess: 9999,
    });
    this.socketMockUrl = this.socketMock.url;
  }
);

Given<DepauditWorld>(
  "a mock Socket API that returns HTTP 401 for every request",
  async function (this: DepauditWorld) {
    this.socketMock = await startMockSocketServer({
      transientKind: "401",
      failuresBeforeSuccess: 9999,
    });
    this.socketMockUrl = this.socketMock.url;
  }
);

Given<DepauditWorld>(
  "a mock Socket API that returns HTTP 503 once and then responds with an {string} alert for a package in that manifest",
  async function (this: DepauditWorld, alertType: string) {
    const { name, version } = await getFirstNpmPackage(this.fixturePath);
    this.socketAlertPackage = name;
    this.socketAlertVersion = version;
    this.socketMock = await startMockSocketServer({
      body: buildSocketNpmResponse(name, version, alertType),
      failuresBeforeSuccess: 1,
      transientKind: "500",
    });
    this.socketMockUrl = this.socketMock.url;
  }
);

Given<DepauditWorld>(
  "a mock Socket API that responds with an {string} alert at severity {string} for a package in that manifest",
  async function (this: DepauditWorld, alertType: string, severity: string) {
    const { name, version } = await getFirstNpmPackage(this.fixturePath);
    this.socketAlertPackage = name;
    this.socketAlertVersion = version;
    this.socketMock = await startMockSocketServer({
      body: buildSocketNpmResponse(name, version, alertType, severity.toLowerCase()),
    });
    this.socketMockUrl = this.socketMock.url;
  }
);

Given<DepauditWorld>(
  "a mock Socket API that responds with an {string} alert for a package declared in {string} and a {string} alert for a package declared in {string}",
  async function (this: DepauditWorld, alertType1: string, _manifest1: string, alertType2: string, _manifest2: string) {
    const { name: npmName, version: npmVersion } = await getFirstNpmPackage(this.fixturePath);
    const { name: pipName, version: pipVersion } = await getFirstPipPackage(this.fixturePath);
    const body = [
      ...buildSocketNpmResponse(npmName, npmVersion, alertType1),
      ...buildSocketPipResponse(pipName, pipVersion, alertType2),
    ];
    this.socketMock = await startMockSocketServer({ body });
    this.socketMockUrl = this.socketMock.url;
  }
);

// ─── .depaudit.yml helpers ────────────────────────────────────────────────────

function futureDateStr(days = 60): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Write a full .depaudit.yml with a supplyChainAccepts section (passes linter). */
async function writeScaYml(
  ymlPath: string,
  accepts: Array<{ pkg: string; version: string; findingId: string }>
): Promise<void> {
  const expires = futureDateStr(60); // within 90-day cap
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
    lines.push(`    reason: "Test acceptance — automated BDD scenario"`);
  }
  await writeFile(ymlPath, lines.join("\n") + "\n", "utf8");
}

// ─── .depaudit.yml management ─────────────────────────────────────────────────

// Use regex to handle literal parentheses in step text: "(package, version, alertType)"
Given<DepauditWorld>(
  /the repository's \.depaudit\.yml has a valid `supplyChainAccepts` entry matching that \(package, version, alertType\) tuple/,
  async function (this: DepauditWorld) {
    const pkg = this.socketAlertPackage ?? "ms";
    const ver = this.socketAlertVersion ?? "2.1.3";
    const ymlPath = resolve(this.fixturePath, ".depaudit.yml");
    await writeScaYml(ymlPath, [{ pkg, version: ver, findingId: "install-scripts" }]);
    this.writtenFiles.push(ymlPath);
  }
);

// Use regex to handle literal parentheses in step text: "(package, version)"
Given<DepauditWorld>(
  /the repository's \.depaudit\.yml has a `supplyChainAccepts` entry for that \(package, version\) with `alertType` set to "([^"]+)"/,
  async function (this: DepauditWorld, alertType: string) {
    const pkg = this.socketAlertPackage ?? "ms";
    const ver = this.socketAlertVersion ?? "2.1.3";
    const ymlPath = resolve(this.fixturePath, ".depaudit.yml");
    await writeScaYml(ymlPath, [{ pkg, version: ver, findingId: alertType }]);
    this.writtenFiles.push(ymlPath);
  }
);

Given<DepauditWorld>(
  "the repository's .depaudit.yml has a `supplyChainAccepts` entry for that package at version {string} with the same alertType",
  async function (this: DepauditWorld, version: string) {
    const pkg = this.socketAlertPackage ?? "ms";
    const ymlPath = resolve(this.fixturePath, ".depaudit.yml");
    await writeScaYml(ymlPath, [{ pkg, version, findingId: "install-scripts" }]);
    this.writtenFiles.push(ymlPath);
  }
);

// "for a different package" — already defined in depaudit_yml_steps.ts (uses unrelated-pkg)
// "severityThreshold to {string}" — already defined in depaudit_yml_steps.ts

// ─── Then steps ──────────────────────────────────────────────────────────────

Then<DepauditWorld>(
  "stdout contains at least one finding line whose finding-ID is the supply-chain alert type {string}",
  function (this: DepauditWorld, alertType: string) {
    const lines = this.result!.stdout.trim().split("\n").filter(Boolean);
    const matched = lines.filter((l) => {
      const m = FINDING_LINE_RE.exec(l);
      return m && m[3] === alertType;
    });
    assert.ok(
      matched.length > 0,
      `expected a finding line with finding-ID "${alertType}", got stdout:\n${this.result!.stdout}\nstderr:\n${this.result!.stderr}`
    );
  }
);

Then<DepauditWorld>(
  "stdout contains at least one finding line whose finding-ID is an OSV CVE identifier",
  function (this: DepauditWorld) {
    const lines = this.result!.stdout.trim().split("\n").filter(Boolean);
    const matched = lines.filter((l) => {
      const m = FINDING_LINE_RE.exec(l);
      return m && /^(GHSA-|CVE-)/.test(m[3]);
    });
    assert.ok(
      matched.length > 0,
      `expected a finding line with a CVE/GHSA finding-ID, got stdout:\n${this.result!.stdout}`
    );
  }
);

// "stderr mentions {string}" — already in lint_steps.ts
// "the exit code is {int}", "the exit code is non-zero", "stdout contains no finding lines",
// "stdout contains exactly one finding line", "the finding line matches the pattern {string}",
// "each finding line contains a package name..." — all in scan_steps.ts

Then<DepauditWorld>(
  "stderr does not mention {string}",
  function (this: DepauditWorld, text: string) {
    assert.ok(
      !this.result!.stderr.includes(text),
      `expected stderr NOT to mention "${text}", but got:\n${this.result!.stderr}`
    );
  }
);

// ─── Ensure env forwarding is active (scan_steps.ts:runDepaudit reads world.socketMockUrl) ─
void runDepaudit;
