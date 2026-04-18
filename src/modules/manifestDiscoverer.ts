import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import ignore from "ignore";
import type { Ecosystem } from "../types/finding.js";
import type { Manifest } from "../types/manifest.js";

const MANIFEST_FILES: Record<string, Ecosystem> = {
  "package.json": "npm",
  "requirements.txt": "pip",
  "pyproject.toml": "pip",
  "go.mod": "gomod",
  "Cargo.toml": "cargo",
  "pom.xml": "maven",
  "Gemfile": "gem",
  "composer.json": "composer",
};

export async function discoverManifests(rootPath: string): Promise<Manifest[]> {
  const absRoot = resolve(rootPath);
  const ig = ignore();

  ig.add(["node_modules/", ".git/", "vendor/", "target/", ".venv/", "__pycache__/"]);

  try {
    const gitignoreContent = await readFile(join(absRoot, ".gitignore"), "utf8");
    ig.add(gitignoreContent);
  } catch {
    // no .gitignore present — ignore rules already seeded with hard-coded entries
  }

  const results: Manifest[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && entry.name in MANIFEST_FILES) {
        results.push({ ecosystem: MANIFEST_FILES[entry.name], path: join(dir, entry.name) });
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rel = relative(absRoot, join(dir, entry.name));
      if (ig.ignores(rel) || ig.ignores(rel + "/")) continue;
      await walk(join(dir, entry.name));
    }
  }

  await walk(absRoot);
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}
