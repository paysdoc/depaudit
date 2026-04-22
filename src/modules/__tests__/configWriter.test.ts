import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, writeFile, mkdtemp, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { pruneDepauditYml, pruneOsvScannerToml, appendDepauditYmlBaseline, appendOsvScannerTomlBaseline } from "../configWriter.js";
import type { SupplyChainAccept } from "../../types/depauditConfig.js";
import type { IgnoredVuln } from "../../types/osvScannerConfig.js";
import { loadDepauditConfig, loadOsvScannerConfig } from "../configLoader.js";
import { lintDepauditConfig, lintOsvScannerConfig } from "../linter.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/auto-prune");

async function copyFixture(name: string, targetFileName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "depaudit-configwriter-test-"));
  const src = join(fixturesDir, name);
  const dest = join(dir, targetFileName);
  await cp(src, dest);
  return dest;
}

function makeSca(pkg: string, version: string, findingId: string): SupplyChainAccept {
  return {
    package: pkg,
    version,
    findingId,
    expires: "2027-01-01",
    reason: "test entry",
  };
}

function makeVuln(id: string): IgnoredVuln {
  return {
    id,
    ignoreUntil: "2027-01-01",
    reason: "test entry",
  };
}

// ─── pruneDepauditYml ─────────────────────────────────────────────────────────

describe("pruneDepauditYml", () => {
  it("no-op when orphans empty", async () => {
    const filePath = await copyFixture("with-orphan.yml", ".depaudit.yml");
    const originalContent = await readFile(filePath, "utf8");
    const removed = await pruneDepauditYml(filePath, []);
    const afterContent = await readFile(filePath, "utf8");
    expect(removed).toBe(0);
    expect(afterContent).toBe(originalContent);
  });

  it("no-op when supplyChainAccepts key missing", async () => {
    const filePath = await copyFixture("no-accepts.yml", ".depaudit.yml");
    const originalContent = await readFile(filePath, "utf8");
    const removed = await pruneDepauditYml(filePath, [makeSca("ghost-pkg", "9.9.9", "malware")]);
    const afterContent = await readFile(filePath, "utf8");
    expect(removed).toBe(0);
    expect(afterContent).toBe(originalContent);
  });

  it("removes single orphan, preserves others", async () => {
    const filePath = await copyFixture("with-orphan.yml", ".depaudit.yml");
    const removed = await pruneDepauditYml(filePath, [makeSca("ghost-pkg", "9.9.9", "malware")]);
    const afterContent = await readFile(filePath, "utf8");
    expect(removed).toBe(1);
    expect(afterContent).not.toContain("ghost-pkg");
    expect(afterContent).toContain("lodash");
    expect(afterContent).toContain("ms");
  });

  it("all entries removed → empty list", async () => {
    const filePath = await copyFixture("with-orphan.yml", ".depaudit.yml");
    const removed = await pruneDepauditYml(filePath, [
      makeSca("lodash", "4.17.21", "install-scripts"),
      makeSca("ghost-pkg", "9.9.9", "malware"),
      makeSca("ms", "2.1.3", "deprecated"),
    ]);
    const afterContent = await readFile(filePath, "utf8");
    expect(removed).toBe(3);
    expect(afterContent).not.toContain("ghost-pkg");
    expect(afterContent).not.toContain("lodash");
    // "ms" appears in policy section, so check specific package entry instead
    expect(afterContent).not.toContain('package: "ms"');
  });

  it("multiple orphans removed", async () => {
    const filePath = await copyFixture("with-orphan.yml", ".depaudit.yml");
    const removed = await pruneDepauditYml(filePath, [
      makeSca("ghost-pkg", "9.9.9", "malware"),
      makeSca("ms", "2.1.3", "deprecated"),
    ]);
    const afterContent = await readFile(filePath, "utf8");
    expect(removed).toBe(2);
    expect(afterContent).toContain("lodash");
    expect(afterContent).not.toContain("ghost-pkg");
    // "ms" appears in policy section, check specific package entry
    expect(afterContent).not.toContain('package: "ms"');
  });

  it("returns 0 when orphan key does not match any entry", async () => {
    const filePath = await copyFixture("with-orphan.yml", ".depaudit.yml");
    const removed = await pruneDepauditYml(filePath, [makeSca("nonexistent-pkg", "0.0.1", "unknown")]);
    expect(removed).toBe(0);
  });
});

// ─── pruneOsvScannerToml ──────────────────────────────────────────────────────

describe("pruneOsvScannerToml", () => {
  it("no-op when orphans empty", async () => {
    const filePath = await copyFixture("with-orphan.toml", "osv-scanner.toml");
    const originalContent = await readFile(filePath, "utf8");
    const removed = await pruneOsvScannerToml(filePath, []);
    const afterContent = await readFile(filePath, "utf8");
    expect(removed).toBe(0);
    expect(afterContent).toBe(originalContent);
  });

  it("removes single block, preserves others", async () => {
    const filePath = await copyFixture("with-orphan.toml", "osv-scanner.toml");
    const removed = await pruneOsvScannerToml(filePath, [makeVuln("CVE-ORPHAN-0001")]);
    const afterContent = await readFile(filePath, "utf8");
    expect(removed).toBe(1);
    expect(afterContent).not.toContain("CVE-ORPHAN-0001");
    expect(afterContent).toContain("CVE-2021-23337");
    expect(afterContent).toContain("GHSA-abc-def-0001");
  });

  it("preserves header comments", async () => {
    const filePath = await copyFixture("header-comment.toml", "osv-scanner.toml");
    const removed = await pruneOsvScannerToml(filePath, [makeVuln("CVE-ORPHAN-0002")]);
    const afterContent = await readFile(filePath, "utf8");
    expect(removed).toBe(1);
    expect(afterContent).toContain("# OSV Scanner configuration");
    expect(afterContent).toContain("# Managed by depaudit");
    expect(afterContent).not.toContain("CVE-ORPHAN-0002");
    expect(afterContent).toContain("CVE-2021-23337");
  });

  it("handles last block (EOF boundary)", async () => {
    const filePath = await copyFixture("with-orphan.toml", "osv-scanner.toml");
    const removed = await pruneOsvScannerToml(filePath, [makeVuln("GHSA-abc-def-0001")]);
    const afterContent = await readFile(filePath, "utf8");
    expect(removed).toBe(1);
    expect(afterContent).not.toContain("GHSA-abc-def-0001");
    expect(afterContent).toContain("CVE-2021-23337");
    expect(afterContent).toContain("CVE-ORPHAN-0001");
  });

  it("no blank-line accumulation after removal", async () => {
    const filePath = await copyFixture("with-orphan.toml", "osv-scanner.toml");
    await pruneOsvScannerToml(filePath, [makeVuln("CVE-ORPHAN-0001")]);
    const afterContent = await readFile(filePath, "utf8");
    // Should not have more than 1 consecutive blank line
    expect(afterContent).not.toMatch(/\n\n\n/);
  });

  it("returns 0 when orphan id does not match any block", async () => {
    const filePath = await copyFixture("with-orphan.toml", "osv-scanner.toml");
    const removed = await pruneOsvScannerToml(filePath, [makeVuln("CVE-NONEXISTENT-9999")]);
    expect(removed).toBe(0);
  });

  it("removing all blocks leaves only header comments", async () => {
    const filePath = await copyFixture("header-comment.toml", "osv-scanner.toml");
    const removed = await pruneOsvScannerToml(filePath, [
      makeVuln("CVE-ORPHAN-0002"),
      makeVuln("CVE-2021-23337"),
    ]);
    const afterContent = await readFile(filePath, "utf8");
    expect(removed).toBe(2);
    expect(afterContent).toContain("# OSV Scanner configuration");
    expect(afterContent).not.toContain("[[IgnoredVulns]]");
  });
});

// ─── appendDepauditYmlBaseline ────────────────────────────────────────────────

const BASELINE_EXPIRES = "2026-07-21";
const BASELINE_REASON = "baselined at install";

describe("appendDepauditYmlBaseline", () => {
  async function makeEmptyDepauditYml(dir: string): Promise<string> {
    const path = join(dir, ".depaudit.yml");
    await writeFile(path, `version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine: []\nsupplyChainAccepts: []\n`, "utf8");
    return path;
  }

  it("appends to a file with empty supplyChainAccepts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depaudit-cw-test-"));
    const path = await makeEmptyDepauditYml(dir);
    const n = await appendDepauditYmlBaseline(path, [
      { package: "lodash", version: "4.17.21", findingId: "install-scripts", expires: BASELINE_EXPIRES, reason: BASELINE_REASON },
    ]);
    expect(n).toBe(1);
    const content = await readFile(path, "utf8");
    expect(content).toContain("lodash");
    expect(content).toContain(BASELINE_REASON);
  });

  it("returns 0 and does not write when entries is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depaudit-cw-test-"));
    const path = await makeEmptyDepauditYml(dir);
    const original = await readFile(path, "utf8");
    const n = await appendDepauditYmlBaseline(path, []);
    expect(n).toBe(0);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("is idempotent: appending same entry twice returns 0 on second call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depaudit-cw-test-"));
    const path = await makeEmptyDepauditYml(dir);
    const entry = { package: "ms", version: "2.1.3", findingId: "malware", expires: BASELINE_EXPIRES, reason: BASELINE_REASON };
    await appendDepauditYmlBaseline(path, [entry]);
    const contentAfterFirst = await readFile(path, "utf8");
    const n = await appendDepauditYmlBaseline(path, [entry]);
    expect(n).toBe(0);
    expect(await readFile(path, "utf8")).toBe(contentAfterFirst);
  });

  it("auto-creates supplyChainAccepts if key is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depaudit-cw-test-"));
    const path = join(dir, ".depaudit.yml");
    await writeFile(path, `version: 1\npolicy:\n  severityThreshold: medium\n  ecosystems: auto\n  maxAcceptDays: 90\n  maxCommonAndFineDays: 365\ncommonAndFine: []\n`, "utf8");
    const n = await appendDepauditYmlBaseline(path, [
      { package: "pkg", version: "1.0.0", findingId: "vuln", expires: BASELINE_EXPIRES, reason: BASELINE_REASON },
    ]);
    expect(n).toBe(1);
    const content = await readFile(path, "utf8");
    expect(content).toContain("pkg");
  });

  it("round-trips: post-write file parses and lints clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depaudit-cw-test-"));
    const path = await makeEmptyDepauditYml(dir);
    await appendDepauditYmlBaseline(path, [
      { package: "lodash", version: "4.17.21", findingId: "install-scripts", expires: BASELINE_EXPIRES, reason: BASELINE_REASON },
    ]);
    // loadDepauditConfig expects a repoRoot not a file path
    const config = await loadDepauditConfig(dir);
    const lint = lintDepauditConfig(config);
    expect(lint.errors).toHaveLength(0);
  });
});

// ─── appendOsvScannerTomlBaseline ─────────────────────────────────────────────

describe("appendOsvScannerTomlBaseline", () => {
  async function makeEmptyToml(dir: string): Promise<string> {
    const path = join(dir, "osv-scanner.toml");
    await writeFile(path, "# OSV Scanner config managed by depaudit\n", "utf8");
    return path;
  }

  it("appends a single block to an empty file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depaudit-cw-test-"));
    const path = await makeEmptyToml(dir);
    const n = await appendOsvScannerTomlBaseline(path, [
      { id: "CVE-2024-0001", ignoreUntil: "2026-07-21", reason: BASELINE_REASON },
    ]);
    expect(n).toBe(1);
    const content = await readFile(path, "utf8");
    expect(content).toContain("[[IgnoredVulns]]");
    expect(content).toContain("CVE-2024-0001");
    expect(content).toContain(BASELINE_REASON);
  });

  it("appends multiple blocks with correct newline separation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depaudit-cw-test-"));
    const path = await makeEmptyToml(dir);
    const n = await appendOsvScannerTomlBaseline(path, [
      { id: "CVE-A", ignoreUntil: "2026-07-21", reason: BASELINE_REASON },
      { id: "CVE-B", ignoreUntil: "2026-07-21", reason: BASELINE_REASON },
    ]);
    expect(n).toBe(2);
    const content = await readFile(path, "utf8");
    expect(content).toContain("CVE-A");
    expect(content).toContain("CVE-B");
    // Should not have 3+ consecutive newlines
    expect(content).not.toMatch(/\n\n\n\n/);
  });

  it("is idempotent: appending same id twice returns 0 on second call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depaudit-cw-test-"));
    const path = await makeEmptyToml(dir);
    const entry = { id: "CVE-2024-0002", ignoreUntil: "2026-07-21", reason: BASELINE_REASON };
    await appendOsvScannerTomlBaseline(path, [entry]);
    const contentAfterFirst = await readFile(path, "utf8");
    const n = await appendOsvScannerTomlBaseline(path, [entry]);
    expect(n).toBe(0);
    expect(await readFile(path, "utf8")).toBe(contentAfterFirst);
  });

  it("returns 0 and does not write when entries is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depaudit-cw-test-"));
    const path = await makeEmptyToml(dir);
    const original = await readFile(path, "utf8");
    const n = await appendOsvScannerTomlBaseline(path, []);
    expect(n).toBe(0);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("round-trips: post-write file parses cleanly via loadOsvScannerConfig", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depaudit-cw-test-"));
    const path = await makeEmptyToml(dir);
    await appendOsvScannerTomlBaseline(path, [
      { id: "CVE-2024-ROUND", ignoreUntil: "2026-07-21", reason: BASELINE_REASON },
    ]);
    const config = await loadOsvScannerConfig(dir);
    expect(config.ignoredVulns).toHaveLength(1);
    expect(config.ignoredVulns[0].id).toBe("CVE-2024-ROUND");
    const lint = lintOsvScannerConfig(config);
    expect(lint.errors).toHaveLength(0);
  });
});
