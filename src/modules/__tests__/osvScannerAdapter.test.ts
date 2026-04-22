import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { runOsvScanner, type ExecFileFn } from "../osvScannerAdapter.js";
import type { Manifest } from "../../types/manifest.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/osv-output");

async function loadFixture(name: string): Promise<string> {
  return readFile(join(fixturesDir, name), "utf8");
}

describe("runOsvScanner", () => {
  it("returns [] immediately without calling execFile when manifests is empty", async () => {
    const execFile = vi.fn<ExecFileFn>();
    const result = await runOsvScanner([], execFile);
    expect(result).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("returns [] when execFile resolves with clean.json (no vulnerabilities)", async () => {
    const cleanJson = await loadFixture("clean.json");
    const execFile = vi.fn<ExecFileFn>().mockResolvedValue({ stdout: cleanJson, stderr: "" });
    const manifests: Manifest[] = [{ ecosystem: "npm", path: "/tmp/proj/package.json" }];
    const result = await runOsvScanner(manifests, execFile);
    expect(result).toEqual([]);
  });

  it("parses findings when execFile rejects with code 1 and stdout contains with-findings.json", async () => {
    const withFindingsJson = await loadFixture("with-findings.json");
    const execFile = vi.fn<ExecFileFn>().mockRejectedValue({ code: 1, stdout: withFindingsJson, stderr: "" });
    const manifests: Manifest[] = [{ ecosystem: "npm", path: "/tmp/proj/package.json" }];

    const findings = await runOsvScanner(manifests, execFile);

    expect(findings).toHaveLength(2);

    const lodash = findings.find((f) => f.package === "lodash");
    expect(lodash).toBeDefined();
    expect(lodash!.version).toBe("4.17.20");
    expect(lodash!.findingId).toBe("CVE-2021-23337");
    expect(lodash!.severity).toBe("HIGH");
    expect(lodash!.source).toBe("osv");
    expect(lodash!.ecosystem).toBe("npm");

    const minimist = findings.find((f) => f.package === "minimist");
    expect(minimist).toBeDefined();
    expect(minimist!.findingId).toBe("GHSA-vh95-rmgr-6w4m");
    expect(minimist!.severity).toBe("HIGH");
  });

  it("re-throws when execFile rejects with code other than 1", async () => {
    const execFile = vi.fn<ExecFileFn>().mockRejectedValue({ code: 127, stderr: "not found" });
    const manifests: Manifest[] = [{ ecosystem: "npm", path: "/tmp/proj/package.json" }];
    await expect(runOsvScanner(manifests, execFile)).rejects.toMatchObject({ code: 127 });
  });

  it("deduplicates parent directories and passes them to osv-scanner", async () => {
    const cleanJson = await loadFixture("clean.json");
    const execFile = vi.fn<ExecFileFn>().mockResolvedValue({ stdout: cleanJson, stderr: "" });
    const manifests: Manifest[] = [
      { ecosystem: "npm", path: "/proj/packages/a/package.json" },
      { ecosystem: "npm", path: "/proj/packages/a/package.json" },
      { ecosystem: "npm", path: "/proj/packages/b/package.json" },
    ];

    await runOsvScanner(manifests, execFile);

    expect(execFile).toHaveBeenCalledWith("osv-scanner", [
      "scan",
      "source",
      "--format=json",
      "/proj/packages/a",
      "/proj/packages/b",
    ]);
  });

  it("maps OSV ecosystem strings to internal Ecosystem values across the full polyglot set", async () => {
    const polyglotJson = await loadFixture("polyglot.json");
    const execFile = vi.fn<ExecFileFn>().mockResolvedValue({ stdout: polyglotJson, stderr: "" });
    const manifests: Manifest[] = [{ ecosystem: "npm", path: "/proj/package.json" }];

    const findings = await runOsvScanner(manifests, execFile);

    expect(findings).toHaveLength(7);

    const byPkg = Object.fromEntries(findings.map((f) => [f.package, f.ecosystem]));
    expect(byPkg["test-npm-pkg"]).toBe("npm");
    expect(byPkg["test-pypi-pkg"]).toBe("pip");
    expect(byPkg["example.com/gomod-pkg"]).toBe("gomod");
    expect(byPkg["test-cargo-pkg"]).toBe("cargo");
    expect(byPkg["com.example:maven-pkg"]).toBe("maven");
    expect(byPkg["test-gem-pkg"]).toBe("gem");
    expect(byPkg["example/composer-pkg"]).toBe("composer");
  });

  it("throws a clear error on an unknown OSV ecosystem string", async () => {
    const unknownJson = await loadFixture("unknown-ecosystem.json");
    const execFile = vi.fn<ExecFileFn>().mockResolvedValue({ stdout: unknownJson, stderr: "" });
    const manifests: Manifest[] = [{ ecosystem: "npm", path: "/proj/package.json" }];

    await expect(runOsvScanner(manifests, execFile)).rejects.toThrow(/unknown ecosystem/);
    await expect(runOsvScanner(manifests, execFile)).rejects.toThrow(/NuGet/);
  });

  describe("fixedVersion derivation", () => {
    it("populates fixedVersion from affected.ranges.events when OSV publishes a fix", async () => {
      const json = await loadFixture("with-fixes.json");
      const execFile = vi.fn<ExecFileFn>().mockRejectedValue({ code: 1, stdout: json, stderr: "" });
      const manifests: Manifest[] = [{ ecosystem: "npm", path: "/tmp/proj/package.json" }];

      const findings = await runOsvScanner(manifests, execFile);
      const lodash = findings.find((f) => f.package === "lodash");
      expect(lodash?.fixedVersion).toBe("4.17.21");
    });

    it("selects the LOWEST fixed version strictly greater than the installed version when multiple ranges publish different fixes", async () => {
      const json = await loadFixture("with-fixes.json");
      const execFile = vi.fn<ExecFileFn>().mockRejectedValue({ code: 1, stdout: json, stderr: "" });
      const manifests: Manifest[] = [{ ecosystem: "npm", path: "/tmp/proj/package.json" }];

      const findings = await runOsvScanner(manifests, execFile);
      const axios = findings.find((f) => f.package === "axios");
      // 0.21.0 installed; fixes are 0.21.1 and 0.24.0 — lowest qualifying is 0.21.1
      expect(axios?.fixedVersion).toBe("0.21.1");
    });

    it("leaves fixedVersion undefined when no fixed event is published (only introduced)", async () => {
      const json = await loadFixture("with-fixes.json");
      const execFile = vi.fn<ExecFileFn>().mockRejectedValue({ code: 1, stdout: json, stderr: "" });
      const manifests: Manifest[] = [{ ecosystem: "npm", path: "/tmp/proj/package.json" }];

      const findings = await runOsvScanner(manifests, execFile);
      const minimist = findings.find((f) => f.package === "minimist");
      expect(minimist?.fixedVersion).toBeUndefined();
    });

    it("leaves fixedVersion undefined when installed version is already >= all published fixes", async () => {
      const json: string = JSON.stringify({
        results: [{
          source: { path: "/tmp/proj/package-lock.json", type: "lockfile" },
          packages: [{
            package: { name: "lodash", version: "4.17.21", ecosystem: "npm" },
            vulnerabilities: [{
              id: "CVE-2021-23337",
              summary: "test",
              database_specific: { severity: "HIGH" },
              severity: [],
              affected: [{
                package: { name: "lodash", ecosystem: "npm" },
                ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
              }],
            }],
          }],
        }],
      });
      const execFile = vi.fn<ExecFileFn>().mockRejectedValue({ code: 1, stdout: json, stderr: "" });
      const manifests: Manifest[] = [{ ecosystem: "npm", path: "/tmp/proj/package.json" }];

      const findings = await runOsvScanner(manifests, execFile);
      expect(findings[0]?.fixedVersion).toBeUndefined();
    });

    it("leaves fixedVersion undefined when no affected array is present (original with-findings.json)", async () => {
      const json = await loadFixture("with-findings.json");
      const execFile = vi.fn<ExecFileFn>().mockRejectedValue({ code: 1, stdout: json, stderr: "" });
      const manifests: Manifest[] = [{ ecosystem: "npm", path: "/tmp/proj/package.json" }];

      const findings = await runOsvScanner(manifests, execFile);
      for (const f of findings) {
        expect(f.fixedVersion).toBeUndefined();
      }
    });
  });
});
