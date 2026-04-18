import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { lintOsvScannerConfig } from "../linter.js";
import { loadOsvScannerConfig } from "../configLoader.js";
import type { OsvScannerConfig } from "../../types/osvScannerConfig.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/osv-scanner-toml");
const NOW = new Date("2026-04-18T00:00:00.000Z");

function daysFromNow(n: number): string {
  const d = new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function expandAndLoad(name: string): Promise<OsvScannerConfig> {
  const raw = await readFile(join(fixturesDir, name), "utf8");
  const expanded = raw
    .replace(/\{\{IGNORE_UNTIL_30D\}\}/g, daysFromNow(30))
    .replace(/\{\{IGNORE_UNTIL_60D\}\}/g, daysFromNow(60))
    .replace(/\{\{IGNORE_UNTIL_90D\}\}/g, daysFromNow(90))
    .replace(/\{\{IGNORE_UNTIL_180D\}\}/g, daysFromNow(180))
    .replace(/\{\{IGNORE_UNTIL_PAST_1D\}\}/g, daysFromNow(-1));
  const dir = await mkdtemp(join(tmpdir(), "depaudit-linter-test-"));
  await writeFile(join(dir, "osv-scanner.toml"), expanded, "utf8");
  return loadOsvScannerConfig(dir);
}

describe("lintOsvScannerConfig", () => {
  it("empty config is clean with no errors or warnings", async () => {
    const config = await expandAndLoad("empty.toml");
    const result = lintOsvScannerConfig(config, NOW);
    expect(result.isClean).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("valid-single entry is clean", async () => {
    const config = await expandAndLoad("valid-single.toml");
    const result = lintOsvScannerConfig(config, NOW);
    expect(result.isClean).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("valid-multiple entries are clean", async () => {
    const config = await expandAndLoad("valid-multiple.toml");
    const result = lintOsvScannerConfig(config, NOW);
    expect(result.isClean).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("ignoreUntil more than 90 days out produces an error mentioning 90-day cap", async () => {
    const config = await expandAndLoad("expiry-too-far.toml");
    const result = lintOsvScannerConfig(config, NOW);
    expect(result.isClean).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/90-day cap/);
    expect(typeof result.errors[0].line).toBe("number");
  });

  it("ignoreUntil in the past produces an error mentioning already passed", async () => {
    const config = await expandAndLoad("expiry-in-past.toml");
    const result = lintOsvScannerConfig(config, NOW);
    expect(result.isClean).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/already passed/);
  });

  it("reason shorter than 20 chars produces an error mentioning 20 characters", async () => {
    const config = await expandAndLoad("reason-too-short.toml");
    const result = lintOsvScannerConfig(config, NOW);
    expect(result.isClean).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/20 characters/);
  });

  it("missing reason produces an error that is distinct from too-short message", async () => {
    const config = await expandAndLoad("missing-reason.toml");
    const result = lintOsvScannerConfig(config, NOW);
    expect(result.isClean).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/required/);
  });

  it("non-date ignoreUntil produces an error mentioning ISO-8601", async () => {
    const config = await expandAndLoad("invalid-ignoreuntil-type.toml");
    const result = lintOsvScannerConfig(config, NOW);
    expect(result.isClean).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/ISO-8601/);
  });

  it("duplicate ids produce a warning, not an error — isClean is true", async () => {
    const config = await expandAndLoad("duplicate-ids.toml");
    const result = lintOsvScannerConfig(config, NOW);
    expect(result.isClean).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toMatch(/duplicate/);
  });

  it("boundary: ignoreUntil exactly 90 days from now is valid", () => {
    const config: OsvScannerConfig = {
      filePath: "/tmp/osv-scanner.toml",
      ignoredVulns: [{
        id: "CVE-2021-23337",
        ignoreUntil: daysFromNow(90),
        reason: "upstream fix pending in 4.17.21",
        sourceLine: 1,
      }],
    };
    const result = lintOsvScannerConfig(config, NOW);
    expect(result.isClean).toBe(true);
  });

  it("boundary: ignoreUntil exactly today is valid", () => {
    const config: OsvScannerConfig = {
      filePath: "/tmp/osv-scanner.toml",
      ignoredVulns: [{
        id: "CVE-2021-23337",
        ignoreUntil: NOW.toISOString().slice(0, 10),
        reason: "upstream fix pending in 4.17.21",
        sourceLine: 1,
      }],
    };
    const result = lintOsvScannerConfig(config, NOW);
    expect(result.isClean).toBe(true);
  });

  it("combined violations: expired entry + duplicate of valid entry", async () => {
    const config: OsvScannerConfig = {
      filePath: "/tmp/osv-scanner.toml",
      ignoredVulns: [
        {
          id: "CVE-2021-23337",
          ignoreUntil: daysFromNow(-5),
          reason: "upstream fix pending in 4.17.21",
          sourceLine: 1,
        },
        {
          id: "GHSA-test",
          ignoreUntil: daysFromNow(30),
          reason: "low risk in our context here",
          sourceLine: 5,
        },
        {
          id: "GHSA-test",
          ignoreUntil: daysFromNow(30),
          reason: "low risk in our context here",
          sourceLine: 10,
        },
      ],
    };
    const result = lintOsvScannerConfig(config, NOW);
    expect(result.isClean).toBe(false);
    expect(result.errors.some((e) => e.message.includes("already passed"))).toBe(true);
    expect(result.warnings.some((w) => w.message.includes("duplicate"))).toBe(true);
  });
});
