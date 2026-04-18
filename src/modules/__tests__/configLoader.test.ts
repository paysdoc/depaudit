import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { loadOsvScannerConfig, loadDepauditConfig, ConfigParseError } from "../configLoader.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/osv-scanner-toml");
const ymlFixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/depaudit-yml");

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

async function expandYmlFixture(name: string): Promise<string> {
  const raw = await readFile(join(ymlFixturesDir, name), "utf8");
  const expanded = raw
    .replace(/\{\{EXPIRES_30D\}\}/g, isoDate(30))
    .replace(/\{\{EXPIRES_60D\}\}/g, isoDate(60))
    .replace(/\{\{EXPIRES_90D\}\}/g, isoDate(90))
    .replace(/\{\{EXPIRES_120D\}\}/g, isoDate(120))
    .replace(/\{\{EXPIRES_400D\}\}/g, isoDate(400))
    .replace(/\{\{EXPIRES_PAST_1D\}\}/g, isoDate(-1));
  const dir = await mkdtemp(join(tmpdir(), "depaudit-yml-test-"));
  await writeFile(join(dir, ".depaudit.yml"), expanded, "utf8");
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

describe("loadDepauditConfig", () => {
  it("returns DEFAULT_DEPAUDIT_CONFIG when .depaudit.yml is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depaudit-yml-test-"));
    const config = await loadDepauditConfig(dir);
    expect(config.filePath).toBeNull();
    expect(config.version).toBe(1);
    expect(config.policy.severityThreshold).toBe("medium");
    expect(config.policy.maxAcceptDays).toBe(90);
    expect(config.commonAndFine).toEqual([]);
    expect(config.supplyChainAccepts).toEqual([]);
  });

  it("parses empty.yml with defaults and absolute filePath", async () => {
    const dir = await expandYmlFixture("empty.yml");
    const config = await loadDepauditConfig(dir);
    expect(config.version).toBe(1);
    expect(config.policy.severityThreshold).toBe("medium");
    expect(config.policy.ecosystems).toBe("auto");
    expect(config.commonAndFine).toHaveLength(0);
    expect(config.supplyChainAccepts).toHaveLength(0);
    expect(config.filePath).toMatch(/\.depaudit\.yml$/);
  });

  it("parses valid-full.yml with all sections populated", async () => {
    const dir = await expandYmlFixture("valid-full.yml");
    const config = await loadDepauditConfig(dir);
    expect(config.commonAndFine).toHaveLength(1);
    expect(config.commonAndFine[0].package).toBe("lodash");
    expect(config.commonAndFine[0].alertType).toBe("protestware");
    expect(config.supplyChainAccepts).toHaveLength(1);
    expect(config.supplyChainAccepts[0].package).toBe("lodash");
    expect(config.supplyChainAccepts[0].findingId).toBe("GHSA-test-1234");
    expect(config.supplyChainAccepts[0].sourceLine).toBeGreaterThan(0);
  });

  it("throws ConfigParseError with line > 0 and column > 0 for malformed.yml", async () => {
    const dir = await expandYmlFixture("malformed.yml");
    const err = await loadDepauditConfig(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigParseError);
    const parseErr = err as ConfigParseError;
    expect(parseErr.line).toBeGreaterThan(0);
    expect(parseErr.column).toBeGreaterThan(0);
    expect(parseErr.filePath).toMatch(/\.depaudit\.yml$/);
    expect(parseErr.message.length).toBeGreaterThan(0);
  });

  it("fills in defaults for partial .depaudit.yml (version only)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "depaudit-yml-test-"));
    await writeFile(join(dir, ".depaudit.yml"), "version: 1\n", "utf8");
    const config = await loadDepauditConfig(dir);
    expect(config.version).toBe(1);
    expect(config.policy.severityThreshold).toBe("medium");
    expect(config.policy.maxAcceptDays).toBe(90);
    expect(config.commonAndFine).toEqual([]);
    expect(config.supplyChainAccepts).toEqual([]);
  });

  it("parses sca-missing-reason.yml and leaves reason as undefined", async () => {
    const dir = await expandYmlFixture("sca-missing-reason.yml");
    const config = await loadDepauditConfig(dir);
    expect(config.supplyChainAccepts).toHaveLength(1);
    expect(config.supplyChainAccepts[0].reason).toBeUndefined();
  });
});
