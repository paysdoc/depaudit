import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import ignore from "ignore";
import type { Manifest } from "../types/manifest.js";

export async function discoverManifests(rootPath: string): Promise<Manifest[]> {
  const absRoot = resolve(rootPath);
  const ig = ignore();

  ig.add(["node_modules/", ".git/"]);

  try {
    const gitignoreContent = await readFile(join(absRoot, ".gitignore"), "utf8");
    ig.add(gitignoreContent);
  } catch {
    // no .gitignore present — ignore rules already seeded with hard-coded entries
  }

  const results: Manifest[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    let hasPackageJson = false;

    for (const entry of entries) {
      if (entry.name === "package.json" && entry.isFile()) {
        hasPackageJson = true;
      }
    }

    if (hasPackageJson) {
      results.push({ ecosystem: "npm", path: join(dir, "package.json") });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rel = relative(absRoot, join(dir, entry.name));
      if (ig.ignores(rel) || ig.ignores(rel + "/")) continue;
      await walk(join(dir, entry.name));
    }
  }

  await walk(absRoot);
  return results;
}
