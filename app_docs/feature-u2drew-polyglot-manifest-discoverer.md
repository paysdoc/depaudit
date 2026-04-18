# Polyglot Manifest Discoverer + OSV Ecosystem Mapping

**ADW ID:** u2drew-polyglot-ecosystem-s
**Date:** 2026-04-18
**Specification:** specs/issue-6-adw-u2drew-polyglot-ecosystem-s-sdlc_planner-polyglot-manifest-discoverer.md

## Overview

Expands `depaudit scan` from an npm-only tool into a genuine polyglot scanner supporting eight manifest types across seven ecosystems: npm, pip, gomod, cargo, maven, gem, and composer. The `ManifestDiscoverer` now walks an entire repository and emits one `(ecosystem, path)` tuple per manifest file found; the `OsvScannerAdapter` maps OSV-Scanner's native ecosystem strings to the internal `Ecosystem` type instead of throwing for anything non-npm.

## What Was Built

- `ManifestDiscoverer` recognises `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, and `composer.json`
- Multi-manifest directories emit one tuple per file (e.g. a dir with both `requirements.txt` and `pyproject.toml` emits two `pip` tuples)
- Hard-coded exclusions for build directories: `vendor/`, `target/`, `.venv/`, `__pycache__/` (in addition to existing `node_modules/`, `.git/`)
- `OsvScannerAdapter` maps OSV ecosystem strings (`PyPI`, `Go`, `crates.io`, `Maven`, `RubyGems`, `Packagist`) to internal `Ecosystem` values
- `Ecosystem` type widened from `"npm"` to a seven-value union
- `SUPPORTED_ECOSYSTEMS` constant updated to the full seven-value tuple
- BDD scenarios in `features/scan_polyglot.feature` covering all supported manifest types, monorepo layouts, partial findings, and build-dir exclusion
- Fixture repos for all new ecosystems and edge cases

## Technical Implementation

### Files Modified

- `src/types/finding.ts`: `Ecosystem` type widened to `"npm" | "pip" | "gomod" | "cargo" | "maven" | "gem" | "composer"`
- `src/types/depauditConfig.ts`: `SUPPORTED_ECOSYSTEMS` updated to match the full seven-value tuple
- `src/modules/manifestDiscoverer.ts`: Replaced `hasPackageJson` boolean pattern with `MANIFEST_FILES` lookup table; added build-dir exclusions to `ig.add()`; results sorted by path for deterministic output
- `src/modules/osvScannerAdapter.ts`: Added `OSV_ECOSYSTEM_MAP` and `mapOsvEcosystem()` function; removed npm-only guard; removed dead `extractCvssScore` function and comments
- `src/modules/__tests__/manifestDiscoverer.test.ts`: Unit tests for polyglot discovery and build-dir exclusion
- `src/modules/__tests__/osvScannerAdapter.test.ts`: Unit tests for OSV ecosystem mapping including unknown-ecosystem error path
- `features/scan_polyglot.feature`: BDD scenarios tagged `@adw-6` covering all ecosystems and edge cases
- `features/step_definitions/scan_polyglot_steps.ts`: Step definitions for polyglot BDD scenarios

### Key Changes

- **`MANIFEST_FILES` lookup table** in `manifestDiscoverer.ts` drives discovery: any file whose name is a key in the table is emitted as a manifest tuple — no per-ecosystem branching needed
- **Build-dir exclusions are unconditional**: `vendor/`, `target/`, `.venv/`, `__pycache__/` are seeded into the `ignore` instance before `.gitignore` is loaded, ensuring they are always skipped regardless of what the project's `.gitignore` says
- **`mapOsvEcosystem()`** throws an explicit, named error for any OSV ecosystem string not in the map, so an unsupported ecosystem surfaces immediately rather than silently dropping findings
- **Results sorted by path** ensures deterministic ordering across platforms and Node.js readdir implementations
- All changes are **non-breaking**: the downstream `ScanCommand` pipeline (`discoverManifests → runOsvScanner → classifyFindings → printFindings`) is unchanged; `ecosystem` and `manifestPath` continue to flow through as opaque tagging fields

## How to Use

No configuration changes required. Running `depaudit scan` in any polyglot repository now automatically discovers all supported manifest types:

1. Place a `.depaudit.yml` at the repo root (required by `ConfigLoader`)
2. Run `depaudit scan` — the discoverer walks the tree and finds all supported manifests
3. OSV-Scanner is invoked once per unique parent directory; findings from all manifests surface in one merged result
4. Each finding is tagged with its originating `ecosystem` and `manifestPath` in the stdout report

To scan a repo with `go.mod`, `requirements.txt`, and `package.json`, no extra flags or config are needed — all three are discovered and scanned automatically.

## Configuration

No new configuration knobs. The existing `policy.ecosystems` field in `.depaudit.yml` now accepts any of the seven values: `npm`, `pip`, `gomod`, `cargo`, `maven`, `gem`, `composer`. The `SUPPORTED_ECOSYSTEMS` tuple used by the `lintDepauditConfig` validator has been updated accordingly.

## Testing

```bash
# Run unit tests
bun test src/modules/__tests__/manifestDiscoverer.test.ts
bun test src/modules/__tests__/osvScannerAdapter.test.ts

# Run BDD scenarios for this slice
bun run cucumber --tags @adw-6
```

Fixture repos covering each ecosystem and edge case (monorepo, partial findings, build-dir exclusion, `.gitignore` interaction) are in `fixtures/` and `src/modules/__tests__/fixtures/`.

## Notes

- A directory with both `requirements.txt` and `pyproject.toml` emits two `pip` manifests; OSV-Scanner deduplicates when scanning the parent directory, so this does not produce duplicate findings
- `vendor/` exclusion is unconditional — repos that legitimately vendor dependencies in a non-standard way cannot opt in via `.gitignore`; a future `.depaudit.yml` override can be added if needed
- The `Cargo.lock` file is not in the discovery table; OSV-Scanner finds it automatically when scanning a directory containing `Cargo.toml`
