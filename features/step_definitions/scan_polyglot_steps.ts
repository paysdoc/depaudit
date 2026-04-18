import { readFile, access } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { DepauditWorld, PROJECT_ROOT } from "../support/world.js";

// ─── Fixture setup ────────────────────────────────────────────────────────────

Given<DepauditWorld>(
  "a fixture repository at {string} whose {string} pins a package with a known OSV CVE",
  async function (this: DepauditWorld, fixturePath: string, _manifest: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture repository at {string} whose {string} has no known CVEs",
  async function (this: DepauditWorld, fixturePath: string, _manifest: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture repository at {string} with the following files:",
  async function (this: DepauditWorld, fixturePath: string, _table: unknown) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture repository at {string} with the following manifests:",
  async function (this: DepauditWorld, fixturePath: string, _table: unknown) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture repository at {string} containing only non-manifest files",
  async function (this: DepauditWorld, fixturePath: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "each listed manifest pins a package with a known OSV CVE",
  function () {
    // declared by fixture structure — no runtime check needed
  }
);

Given<DepauditWorld>(
  "no listed manifest pins a package with a known OSV CVE",
  function () {
    // declared by fixture structure — no runtime check needed
  }
);

Given<DepauditWorld>(
  "{string} pins a package with a known of OSV CVE",
  function (_manifestPath: string) {
    // declared by fixture structure — no runtime check needed
  }
);

Given<DepauditWorld>(
  "{string} has no known CVEs",
  function (_manifestPath: string) {
    // declared by fixture structure — no runtime check needed
  }
);

// ─── Manifest-specific finding assertions ─────────────────────────────────────

async function readDepsFromManifest(manifestAbsPath: string): Promise<string[]> {
  const name = basename(manifestAbsPath);
  const content = await readFile(manifestAbsPath, "utf8");

  if (name === "package.json") {
    const pkg = JSON.parse(content) as { dependencies?: Record<string, string> };
    return Object.keys(pkg.dependencies ?? {});
  }

  if (name === "requirements.txt") {
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split(/[=><!@]/)[0].trim().toLowerCase());
  }

  if (name === "go.mod") {
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("require ") || (l.includes("/") && !l.startsWith("module") && !l.startsWith("go ")))
      .map((l) => l.replace(/^require\s+/, "").split(/\s+/)[0]);
  }

  if (name === "Cargo.toml") {
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("=") && !l.startsWith("[") && !l.startsWith("#"))
      .map((l) => l.split("=")[0].trim());
  }

  if (name === "pom.xml") {
    const artifactIds = [...content.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map((m) => m[1]);
    return artifactIds.filter((id) => id !== "vulnerable-maven");
  }

  if (name === "Gemfile") {
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("gem "))
      .map((l) => {
        const m = l.match(/gem ['"]([^'"]+)['"]/);
        return m ? m[1] : "";
      })
      .filter(Boolean);
  }

  if (name === "composer.json") {
    const pkg = JSON.parse(content) as { require?: Record<string, string> };
    return Object.keys(pkg.require ?? {}).filter((k) => k !== "php");
  }

  return [];
}

Then<DepauditWorld>(
  "stdout contains at least one finding line whose package name is declared in {string}",
  async function (this: DepauditWorld, manifestRelPath: string) {
    const manifestAbsPath = join(this.fixturePath, manifestRelPath);
    const deps = await readDepsFromManifest(manifestAbsPath);

    const lines = this.result!.stdout.trim().split("\n").filter(Boolean);
    assert.ok(lines.length > 0, `expected at least one finding line, got empty stdout\nstderr: ${this.result!.stderr}`);

    const foundPkgs = lines.map((l) => l.split(" ")[0].toLowerCase());
    const match = foundPkgs.some((p) => deps.some((d) => p.includes(d) || d.includes(p)));
    assert.ok(
      match,
      `no finding line matched a dependency from ${manifestRelPath}.\n` +
      `Dependencies: ${deps.join(", ")}\n` +
      `Finding packages: ${foundPkgs.join(", ")}\n` +
      `stdout:\n${this.result!.stdout}`
    );
  }
);

Then<DepauditWorld>(
  "no finding line's package name is declared in {string}",
  async function (this: DepauditWorld, manifestRelPath: string) {
    const manifestAbsPath = join(this.fixturePath, manifestRelPath);
    const deps = await readDepsFromManifest(manifestAbsPath);

    const lines = this.result!.stdout.trim().split("\n").filter(Boolean);
    const foundPkgs = lines.map((l) => l.split(" ")[0].toLowerCase());
    const match = foundPkgs.some((p) => deps.some((d) => p.includes(d) || d.includes(p)));
    assert.ok(
      !match,
      `expected no finding lines from ${manifestRelPath} but found one.\n` +
      `Dependencies: ${deps.join(", ")}\n` +
      `Finding packages: ${foundPkgs.join(", ")}`
    );
  }
);
