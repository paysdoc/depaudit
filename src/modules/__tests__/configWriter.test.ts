import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, writeFile, mkdtemp, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { pruneDepauditYml, pruneOsvScannerToml } from "../configWriter.js";
import type { SupplyChainAccept } from "../../types/depauditConfig.js";
import type { IgnoredVuln } from "../../types/osvScannerConfig.js";

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
