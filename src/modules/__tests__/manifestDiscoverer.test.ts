import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { discoverManifests } from "../manifestDiscoverer.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("discoverManifests", () => {
  it("finds the single root package.json in simple-npm", async () => {
    const manifests = await discoverManifests(join(fixturesDir, "simple-npm"));
    expect(manifests).toHaveLength(1);
    expect(manifests[0].ecosystem).toBe("npm");
    expect(manifests[0].path).toMatch(/simple-npm[/\\]package\.json$/);
  });

  it("finds two nested manifests in nested-npm monorepo", async () => {
    const manifests = await discoverManifests(join(fixturesDir, "nested-npm"));
    const paths = manifests.map((m) => m.path).sort();
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/packages[/\\]a[/\\]package\.json$/);
    expect(paths[1]).toMatch(/packages[/\\]b[/\\]package\.json$/);
    expect(manifests.every((m) => m.ecosystem === "npm")).toBe(true);
  });

  it("respects .gitignore — excludes the excluded/ subtree", async () => {
    const manifests = await discoverManifests(join(fixturesDir, "with-gitignore"));
    expect(manifests).toHaveLength(1);
    expect(manifests[0].path).toMatch(/included[/\\]package\.json$/);
  });

  it("hard-skips node_modules/ even without a .gitignore", async () => {
    const manifests = await discoverManifests(join(fixturesDir, "with-node-modules"));
    expect(manifests).toHaveLength(1);
    expect(manifests[0].path).toMatch(/with-node-modules[/\\]package\.json$/);
    expect(manifests[0].path).not.toMatch(/node_modules/);
  });

  it("throws ENOENT for a non-existent root path", async () => {
    await expect(discoverManifests("/tmp/does-not-exist-depaudit-test-xyz")).rejects.toThrow(/ENOENT/);
  });

  it("finds every supported manifest type in polyglot-repo", async () => {
    const manifests = await discoverManifests(join(fixturesDir, "polyglot-repo"));
    const byPath = Object.fromEntries(manifests.map((m) => [m.path.replace(/.*polyglot-repo[/\\]/, "").replace(/\\/g, "/"), m.ecosystem]));

    expect(byPath["package.json"]).toBe("npm");
    expect(byPath["requirements.txt"]).toBe("pip");
    expect(byPath["services/api/go.mod"]).toBe("gomod");
    expect(byPath["services/ml/pyproject.toml"]).toBe("pip");
    expect(byPath["tools/Cargo.toml"]).toBe("cargo");
    expect(byPath["vendor-libs/pom.xml"]).toBe("maven");
    expect(byPath["cli/Gemfile"]).toBe("gem");
    expect(byPath["web/composer.json"]).toBe("composer");
    expect(manifests).toHaveLength(8);
  });

  it("emits multiple tuples for a directory with multiple manifests", async () => {
    const manifests = await discoverManifests(join(fixturesDir, "polyglot-repo"));
    const rootManifests = manifests.filter((m) => !m.path.replace(/.*polyglot-repo[/\\]/, "").includes("/") && !m.path.replace(/.*polyglot-repo[/\\]/, "").includes("\\"));
    expect(rootManifests).toHaveLength(2);
    const ecosystems = rootManifests.map((m) => m.ecosystem).sort();
    expect(ecosystems).toEqual(["npm", "pip"]);
  });

  it("results are sorted by path", async () => {
    const manifests = await discoverManifests(join(fixturesDir, "polyglot-repo"));
    const paths = manifests.map((m) => m.path);
    const sorted = [...paths].sort((a, b) => a.localeCompare(b));
    expect(paths).toEqual(sorted);
  });

  it("hard-skips vendor/, target/, .venv/, __pycache__/ even without a .gitignore", async () => {
    const manifests = await discoverManifests(join(fixturesDir, "with-build-dirs"));
    expect(manifests).toHaveLength(1);
    expect(manifests[0].path).toMatch(/with-build-dirs[/\\]package\.json$/);
    const paths = manifests.map((m) => m.path);
    expect(paths.some((p) => p.includes("vendor"))).toBe(false);
    expect(paths.some((p) => p.includes("target"))).toBe(false);
    expect(paths.some((p) => p.includes(".venv"))).toBe(false);
    expect(paths.some((p) => p.includes("__pycache__"))).toBe(false);
  });

  it("vendor-libs/ (not vendor/) is NOT skipped by the vendor seed", async () => {
    const manifests = await discoverManifests(join(fixturesDir, "polyglot-repo"));
    const vendorLibs = manifests.find((m) => m.path.includes("vendor-libs"));
    expect(vendorLibs).toBeDefined();
    expect(vendorLibs!.ecosystem).toBe("maven");
  });
});
