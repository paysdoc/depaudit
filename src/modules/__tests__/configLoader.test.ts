import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { loadOsvScannerConfig, ConfigParseError } from "../configLoader.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/osv-scanner-toml");

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

async function expandFixture(name: string): Promise<string> {
  const raw = await readFile(join(fixturesDir, name), "utf8");
  const expanded = raw
    .replace(/\{\{IGNORE_UNTIL_30D\}\}/g, isoDate(30))
    .replace(/\{\{IGNORE_UNTIL_60D\}\}/g, isoDate(60))
    .replace(/\{\{IGNORE_UNTIL_90D\}\}/g, isoDate(90))
    .replace(/\{\{IGNORE_UNTIL_180D\}\}/g, isoDate(180))
    .replace(/\{\{IGNORE_UNTIL_PAST_1D\}\}/g, isoDate(-1));
  const dir = await mkdtemp(join(tmpdir(), "depaudit-test-"));
  const path = join(dir, "osv-scanner.toml");
  await writeFile(path, expanded, "utf8");
  return dir;
}

describe("loadOsvScannerConfig", () => {
  it("returns empty config when osv-scanner.toml is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depaudit-test-"));
    const config = await loadOsvScannerConfig(dir);
    expect(config.filePath).toBeNull();
    expect(config.ignoredVulns).toEqual([]);
  });

  it("parses empty.toml as zero entries", async () => {
    const dir = await expandFixture("empty.toml");
    const config = await loadOsvScannerConfig(dir);
    expect(config.filePath).not.toBeNull();
    expect(config.ignoredVulns).toHaveLength(0);
  });

  it("parses valid-single.toml as one entry with expected fields", async () => {
    const dir = await expandFixture("valid-single.toml");
    const config = await loadOsvScannerConfig(dir);
    expect(config.ignoredVulns).toHaveLength(1);
    const entry = config.ignoredVulns[0];
    expect(entry.id).toBe("CVE-2021-23337");
    expect(entry.ignoreUntil).toBe(isoDate(30));
    expect(entry.reason).toBe("upstream fix pending in 4.17.21");
  });

  it("parses valid-multiple.toml as two entries with distinct ids", async () => {
    const dir = await expandFixture("valid-multiple.toml");
    const config = await loadOsvScannerConfig(dir);
    expect(config.ignoredVulns).toHaveLength(2);
    const ids = config.ignoredVulns.map((e) => e.id);
    expect(ids[0]).toBe("CVE-2021-23337");
    expect(ids[1]).toBe("GHSA-vh95-rmgr-6w4m");
  });

  it("throws ConfigParseError with line and column for malformed.toml", async () => {
    const dir = await expandFixture("malformed.toml");
    const err = await loadOsvScannerConfig(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigParseError);
    const parseErr = err as ConfigParseError;
    expect(parseErr.line).toBeGreaterThan(0);
    expect(parseErr.column).toBeGreaterThan(0);
    expect(parseErr.filePath).toMatch(/osv-scanner\.toml$/);
    expect(parseErr.message.length).toBeGreaterThan(0);
  });

  it("parses missing-reason.toml and leaves reason as undefined", async () => {
    const dir = await expandFixture("missing-reason.toml");
    const config = await loadOsvScannerConfig(dir);
    expect(config.ignoredVulns).toHaveLength(1);
    expect(config.ignoredVulns[0].reason).toBeUndefined();
  });

  it("attaches a positive sourceLine to each entry", async () => {
    const dir = await expandFixture("valid-multiple.toml");
    const config = await loadOsvScannerConfig(dir);
    for (const entry of config.ignoredVulns) {
      expect(typeof entry.sourceLine).toBe("number");
      expect(entry.sourceLine!).toBeGreaterThan(0);
    }
    expect(config.ignoredVulns[0].sourceLine!).toBeLessThan(config.ignoredVulns[1].sourceLine!);
  });
});
