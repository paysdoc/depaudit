import { readFile, writeFile, rm, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Given, When, Then, Before, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { DepauditWorld, PROJECT_ROOT } from "../support/world.js";
import { startMockSocketServer } from "../support/mockSocketServer.js";
import { runDepaudit } from "./scan_steps.js";

// Known CVE for semver@5.7.1 (used by expired-accept and CVE fixtures)
const KNOWN_CVE_ID = "GHSA-c2qf-rxjj-qqgw";

function futureDateStr(days = 60): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Lifecycle hooks ──────────────────────────────────────────────────────────

Before<DepauditWorld>({ tags: "@adw-9" }, function (this: DepauditWorld) {
  this.socketToken = undefined;
  this.socketMockUrl = undefined;
  this.socketMock = undefined;
  this.socketAlertPackage = undefined;
  this.socketAlertVersion = undefined;
  this.socketRequestTimeoutMs = undefined;
  this.capturedStdout = {};
  this.originalFileContents ??= new Map<string, string>();
});

After<DepauditWorld>({ tags: "@adw-9" }, async function (this: DepauditWorld) {
  if (this.socketMock) {
    await this.socketMock.stop();
    this.socketMock = undefined;
  }
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
  // Clean up .depaudit/findings.json written during the scenario
  if (this.fixturePath && this.fixturePath !== PROJECT_ROOT) {
    const findingsPath = join(this.fixturePath, ".depaudit", "findings.json");
    try { await rm(findingsPath); } catch { /* didn't get written */ }
  }
  for (const filePath of this.writtenFiles) {
    try { await rm(filePath); } catch { /* already gone */ }
  }
  this.writtenFiles = [];
});

// ─── Given: fixture setup ─────────────────────────────────────────────────────

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose manifest pins a package with a known OSV CVE that has a published fixed version {string}",
  async function (this: DepauditWorld, fixturePath: string, _version: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose manifest pins a package with a known OSV CVE that has no published fixed version",
  async function (this: DepauditWorld, fixturePath: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose manifest pins a package with a known OSV CVE and declares two additional packages",
  async function (this: DepauditWorld, fixturePath: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

// ─── Given: Socket mock setup (mixed-counts specific) ─────────────────────────

Given<DepauditWorld>(
  "a mock Socket API that responds with an {string} alert for the second declared package and a {string} alert for the third declared package",
  async function (this: DepauditWorld, alertType2: string, alertType3: string) {
    const pkgJson = JSON.parse(await readFile(join(this.fixturePath, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.entries(pkgJson.dependencies ?? {});
    if (deps.length < 3) throw new Error(`Expected at least 3 dependencies, got ${deps.length}`);

    const [pkg2Name, pkg2Range] = deps[1];
    const [pkg3Name, pkg3Range] = deps[2];
    const pkg2Version = String(pkg2Range).replace(/^[^0-9]*/, "");
    const pkg3Version = String(pkg3Range).replace(/^[^0-9]*/, "");

    // Store for later use by yml-writing steps
    this.socketAlertPackage = pkg2Name;
    this.socketAlertVersion = pkg2Version;

    const body = [
      {
        purl: `pkg:npm/${encodeURIComponent(pkg2Name)}@${encodeURIComponent(pkg2Version)}`,
        alerts: [{ type: alertType2, severity: "high", props: { title: `${alertType2} detected` } }],
      },
      {
        purl: `pkg:npm/${encodeURIComponent(pkg3Name)}@${encodeURIComponent(pkg3Version)}`,
        alerts: [{ type: alertType3, severity: "high", props: { title: `${alertType3} detected` } }],
      },
    ];

    this.socketMock = await startMockSocketServer({ body });
    this.socketMockUrl = this.socketMock.url;
  }
);

// ─── Given: .depaudit.yml management (mixed-counts) ──────────────────────────

Given<DepauditWorld>(
  "the repository's .depaudit.yml has a valid `supplyChainAccepts` entry matching the second package's \\(package, version, alertType={string}\\) tuple",
  async function (this: DepauditWorld, alertType: string) {
    // socketAlertPackage and socketAlertVersion were set by the Socket mock step
    const pkg = this.socketAlertPackage!;
    const version = this.socketAlertVersion!;
    const ymlPath = join(this.fixturePath, ".depaudit.yml");

    this.originalFileContents ??= new Map();
    try { this.originalFileContents.set(ymlPath, await readFile(ymlPath, "utf8")); } catch { this.originalFileContents.set(ymlPath, ""); }

    const expires = futureDateStr(60);
    const content = [
      "version: 1",
      "policy:",
      "  severityThreshold: medium",
      "  ecosystems: auto",
      "  maxAcceptDays: 90",
      "  maxCommonAndFineDays: 365",
      "commonAndFine: []",
      "supplyChainAccepts:",
      `  - package: "${pkg}"`,
      `    version: "${version}"`,
      `    findingId: "${alertType}"`,
      `    expires: "${expires}"`,
      `    reason: "Test acceptance — automated BDD scenario"`,
    ].join("\n") + "\n";

    await writeFile(ymlPath, content, "utf8");
    this.writtenFiles.push(ymlPath);
  }
);

Given<DepauditWorld>(
  "the repository's .depaudit.yml has a `commonAndFine` entry matching the third package's \\(package, alertType={string}\\) tuple with a valid expiry",
  async function (this: DepauditWorld, alertType: string) {
    const pkgJson = JSON.parse(await readFile(join(this.fixturePath, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.entries(pkgJson.dependencies ?? {});
    const [pkg3Name] = deps[2];

    const ymlPath = join(this.fixturePath, ".depaudit.yml");
    const existing = await readFile(ymlPath, "utf8");
    const expires = futureDateStr(60);

    const commonAndFineEntry = [
      "commonAndFine:",
      `  - package: "${pkg3Name}"`,
      `    alertType: "${alertType}"`,
      `    expires: "${expires}"`,
      `    reason: "commonAndFine BDD scenario — whitelisted"`,
    ].join("\n");

    const updated = existing.replace("commonAndFine: []", commonAndFineEntry);
    await writeFile(ymlPath, updated, "utf8");
  }
);

// ─── When: run with stdout capture ───────────────────────────────────────────

When<DepauditWorld>(
  "I run {string} and capture the markdown stdout as {string}",
  async function (this: DepauditWorld, commandStr: string, label: string) {
    // Refresh any timing-based osv-scanner.toml entries whose ignoreUntil window
    // may have expired since the previous capture — the linter rejects past dates.
    for (const filePath of this.writtenFiles) {
      if (filePath.endsWith("osv-scanner.toml")) {
        try {
          const content = await readFile(filePath, "utf8");
          if (content.includes("ignoreUntil")) {
            const newDate = new Date(Date.now() + 500).toISOString();
            const refreshed = content.replace(/ignoreUntil = "[^"]*"/, `ignoreUntil = "${newDate}"`);
            await writeFile(filePath, refreshed, "utf8");
          }
        } catch { /* file may not exist yet */ }
      }
    }
    const parts = commandStr.trim().split(/\s+/);
    if (parts[0] === "depaudit") parts.shift();
    await runDepaudit(this, parts);
    this.capturedStdout[label] = this.result!.stdout;
  }
);

// ─── Markdown table helpers ───────────────────────────────────────────────────

function getTableSection(stdout: string, tableName: string): string {
  const idx = stdout.indexOf(`### ${tableName}`);
  if (idx === -1) return "";
  return stdout.slice(idx);
}

function getTableHeaders(stdout: string, tableName: string): string[] {
  const section = getTableSection(stdout, tableName);
  if (!section) return [];
  for (const line of section.split("\n")) {
    if (line.startsWith("|") && !line.includes("---")) {
      return line.split("|").filter((_, i, arr) => i > 0 && i < arr.length - 1).map((s) => s.trim());
    }
  }
  return [];
}

function getTableRows(stdout: string, tableName: string): string[][] {
  const section = getTableSection(stdout, tableName);
  if (!section) return [];
  const lines = section.split("\n");
  const tableLines: string[] = [];
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith("|")) {
      tableLines.push(line);
      inTable = true;
    } else if (inTable) {
      break;
    }
  }
  // Skip header row (0) and separator row (1); remaining are data rows
  return tableLines.slice(2).map((row) =>
    row.split("|").filter((_, i, arr) => i > 0 && i < arr.length - 1).map((s) => s.trim())
  );
}

// ─── Then: marker and header ──────────────────────────────────────────────────

Then<DepauditWorld>(
  "stdout contains the HTML marker {string}",
  function (this: DepauditWorld, marker: string) {
    assert.ok(
      this.result!.stdout.includes(marker),
      `expected stdout to contain "${marker}"\nstdout:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "stdout contains a markdown header indicating a passing gate",
  function (this: DepauditWorld) {
    assert.ok(
      this.result!.stdout.includes("## depaudit gate: PASS"),
      `expected stdout to contain "## depaudit gate: PASS"\nstdout:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "stdout contains a markdown header indicating a failing gate",
  function (this: DepauditWorld) {
    assert.ok(
      this.result!.stdout.includes("## depaudit gate: FAIL"),
      `expected stdout to contain "## depaudit gate: FAIL"\nstdout:\n${this.result!.stdout}`
    );
  }
);

// ─── Then: per-category counts ────────────────────────────────────────────────

Then<DepauditWorld>(
  /^the markdown header reports counts of (.+)$/,
  function (this: DepauditWorld, countsStr: string) {
    const matches = [...countsStr.matchAll(/`([^=`]+)=(\d+)`/g)];
    assert.ok(matches.length > 0, `could not parse counts from: ${countsStr}`);
    for (const m of matches) {
      const [, key, value] = m;
      const line = `- ${key}: ${value}`;
      assert.ok(
        this.result!.stdout.includes(line),
        `expected stdout to contain "${line}"\nstdout:\n${this.result!.stdout}`
      );
    }
  }
);

Then<DepauditWorld>(
  /^the markdown header reports a count of `([^=`]+)=(\d+)`$/,
  function (this: DepauditWorld, key: string, value: string) {
    const line = `- ${key}: ${value}`;
    assert.ok(
      this.result!.stdout.includes(line),
      `expected stdout to contain "${line}"\nstdout:\n${this.result!.stdout}`
    );
  }
);

// ─── Then: table / section presence ──────────────────────────────────────────

Then<DepauditWorld>(
  "stdout contains a markdown table titled {string}",
  function (this: DepauditWorld, title: string) {
    assert.ok(
      this.result!.stdout.includes(`### ${title}`),
      `expected stdout to contain "### ${title}"\nstdout:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "stdout does not contain a markdown table titled {string}",
  function (this: DepauditWorld, title: string) {
    assert.ok(
      !this.result!.stdout.includes(`### ${title}`),
      `expected stdout NOT to contain "### ${title}"\nstdout:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "stdout contains a markdown section titled {string}",
  function (this: DepauditWorld, title: string) {
    assert.ok(
      this.result!.stdout.includes(`### ${title}`),
      `expected stdout to contain "### ${title}"\nstdout:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "stdout does not contain a markdown section titled {string}",
  function (this: DepauditWorld, title: string) {
    assert.ok(
      !this.result!.stdout.includes(`### ${title}`),
      `expected stdout NOT to contain "### ${title}"\nstdout:\n${this.result!.stdout}`
    );
  }
);

// ─── Then: table structure ────────────────────────────────────────────────────

Then<DepauditWorld>(
  "the {string} markdown table has the column headers {string}, {string}, {string}, {string}, {string}",
  function (this: DepauditWorld, tableName: string, h1: string, h2: string, h3: string, h4: string, h5: string) {
    const headers = getTableHeaders(this.result!.stdout, tableName);
    assert.deepEqual(
      headers,
      [h1, h2, h3, h4, h5],
      `table "${tableName}" headers mismatch\nstdout:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "the {string} markdown table has exactly one data row",
  function (this: DepauditWorld, tableName: string) {
    const rows = getTableRows(this.result!.stdout, tableName);
    assert.equal(
      rows.length,
      1,
      `expected exactly 1 data row in "${tableName}" table, got ${rows.length}\nstdout:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "that row contains the finding's package name, version, finding-id, and severity",
  async function (this: DepauditWorld) {
    const rows = getTableRows(this.result!.stdout, "New findings");
    assert.equal(rows.length, 1, "expected exactly one data row in New findings table");
    const row = rows[0];
    // Read fixture package info
    const pkgJson = JSON.parse(await readFile(join(this.fixturePath, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.entries(pkgJson.dependencies ?? {});
    const [pkgName, pkgVersionRange] = deps[0];
    const pkgVersion = String(pkgVersionRange).replace(/^[^0-9]*/, "");
    const rowText = row.join("|");
    assert.ok(rowText.includes(pkgName), `expected package "${pkgName}" in row: ${rowText}`);
    assert.ok(rowText.includes(pkgVersion), `expected version "${pkgVersion}" in row: ${rowText}`);
    // severity (col 0) and finding-id (col 3) must be non-empty
    assert.ok(row[0]?.trim(), `expected non-empty severity in row: ${rowText}`);
    assert.ok(row[3]?.trim(), `expected non-empty finding-id in row: ${rowText}`);
  }
);

// ─── Then: finding-id assertions ──────────────────────────────────────────────

Then<DepauditWorld>(
  "the {string} markdown table contains a row whose finding-id is {string}",
  function (this: DepauditWorld, tableName: string, findingId: string) {
    const rows = getTableRows(this.result!.stdout, tableName);
    const found = rows.some((row) => row[3]?.includes(findingId) ?? false);
    assert.ok(
      found,
      `expected "${findingId}" in finding-id column of "${tableName}" table\nRows: ${JSON.stringify(rows)}\nstdout:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "the {string} markdown table contains a row whose finding-id is the supply-chain alert type {string}",
  function (this: DepauditWorld, tableName: string, alertType: string) {
    const rows = getTableRows(this.result!.stdout, tableName);
    const found = rows.some((row) => row[3]?.includes(alertType) ?? false);
    assert.ok(
      found,
      `expected alert type "${alertType}" in finding-id column of "${tableName}" table\nRows: ${JSON.stringify(rows)}\nstdout:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "the {string} markdown table contains a row whose finding-id is the expired CVE's id",
  function (this: DepauditWorld, tableName: string) {
    const rows = getTableRows(this.result!.stdout, tableName);
    const found = rows.some((row) => row[3]?.includes(KNOWN_CVE_ID) ?? false);
    assert.ok(
      found,
      `expected "${KNOWN_CVE_ID}" in finding-id column of "${tableName}" table\nRows: ${JSON.stringify(rows)}\nstdout:\n${this.result!.stdout}`
    );
  }
);

// ─── Then: suggested-action assertions ───────────────────────────────────────

Then<DepauditWorld>(
  "the {string} markdown table row's \"suggested action\" cell mentions the fixed version {string}",
  function (this: DepauditWorld, tableName: string, version: string) {
    const rows = getTableRows(this.result!.stdout, tableName);
    assert.ok(rows.length > 0, `expected at least one row in "${tableName}" table`);
    const found = rows.some((row) => (row[4] ?? "").includes(version));
    assert.ok(
      found,
      `expected version "${version}" in "suggested action" cell of "${tableName}" table\nRows: ${JSON.stringify(rows)}\nstdout:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "the {string} markdown table row's \"suggested action\" cell contains the text {string}",
  function (this: DepauditWorld, tableName: string, text: string) {
    const rows = getTableRows(this.result!.stdout, tableName);
    assert.ok(rows.length > 0, `expected at least one row in "${tableName}" table`);
    const found = rows.some((row) => (row[4] ?? "").includes(text));
    assert.ok(
      found,
      `expected text "${text}" in "suggested action" cell of "${tableName}" table\nRows: ${JSON.stringify(rows)}\nstdout:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "the {string} markdown table row whose finding-id is {string} has a \"suggested action\" cell containing the text {string}",
  function (this: DepauditWorld, tableName: string, findingId: string, text: string) {
    const rows = getTableRows(this.result!.stdout, tableName);
    const matchingRow = rows.find((row) => row[3]?.includes(findingId));
    assert.ok(
      matchingRow,
      `expected row with finding-id "${findingId}" in "${tableName}" table\nRows: ${JSON.stringify(rows)}`
    );
    assert.ok(
      (matchingRow[4] ?? "").includes(text),
      `expected text "${text}" in suggested-action cell for finding-id "${findingId}"\nCell: ${matchingRow[4]}`
    );
  }
);

// ─── Then: annotations ────────────────────────────────────────────────────────

Then<DepauditWorld>(
  "stdout contains a markdown annotation indicating supply-chain coverage is unavailable",
  function (this: DepauditWorld) {
    assert.ok(
      this.result!.stdout.includes("> supply-chain unavailable"),
      `expected stdout to contain "> supply-chain unavailable"\nstdout:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "stdout does not contain a markdown annotation indicating supply-chain coverage is unavailable",
  function (this: DepauditWorld) {
    assert.ok(
      !this.result!.stdout.includes("> supply-chain unavailable"),
      `expected stdout NOT to contain "> supply-chain unavailable"\nstdout:\n${this.result!.stdout}`
    );
  }
);

// ─── Then: snapshot reproducibility ──────────────────────────────────────────

Then<DepauditWorld>(
  "the markdown stdout captured as {string} is byte-identical to the markdown stdout captured as {string}",
  function (this: DepauditWorld, labelA: string, labelB: string) {
    const a = this.capturedStdout[labelA];
    const b = this.capturedStdout[labelB];
    assert.ok(a !== undefined, `no captured stdout for label "${labelA}"`);
    assert.ok(b !== undefined, `no captured stdout for label "${labelB}"`);
    assert.strictEqual(a, b, `stdout captured as "${labelA}" differs from "${labelB}"`);
  }
);

// ─── Then: polyglot assertions ────────────────────────────────────────────────

Then<DepauditWorld>(
  "the {string} markdown table contains at least one row whose package is declared in {string}",
  async function (this: DepauditWorld, tableName: string, manifestPath: string) {
    const rows = getTableRows(this.result!.stdout, tableName);
    assert.ok(rows.length > 0, `expected at least one row in "${tableName}" table`);
    const fullPath = join(this.fixturePath, manifestPath);
    let packageNames: string[] = [];

    if (manifestPath.endsWith("package.json")) {
      const pkg = JSON.parse(await readFile(fullPath, "utf8")) as { dependencies?: Record<string, string> };
      packageNames = Object.keys(pkg.dependencies ?? {});
    } else if (manifestPath.endsWith("requirements.txt")) {
      const content = await readFile(fullPath, "utf8");
      packageNames = content.trim().split("\n")
        .filter((l) => /^[A-Za-z0-9_-].*==/.test(l.trim()))
        .map((l) => l.trim().split("==")[0].trim().toLowerCase());
    }

    const found = rows.some((row) =>
      packageNames.some((pkg) => (row[1] ?? "").toLowerCase().includes(pkg.toLowerCase()))
    );
    assert.ok(
      found,
      `expected at least one row for a package from "${manifestPath}"\nPackages: ${packageNames.join(", ")}\nRows: ${JSON.stringify(rows)}`
    );
  }
);

// stderr mentions {string} is already defined in lint_steps.ts — no duplicate needed here.
