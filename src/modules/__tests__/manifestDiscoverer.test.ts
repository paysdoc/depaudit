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
});
