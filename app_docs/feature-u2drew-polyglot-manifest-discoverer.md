# Polyglot Manifest Discoverer + OSV-Scanner Adapter

## Overview

Walks a target repository to find every dependency manifest across seven ecosystems, then drives `osv-scanner` against the discovered directories and normalises its output into the internal `Finding`/`Ecosystem` model. Together `ManifestDiscoverer` and `OsvScannerAdapter` are what let `depaudit scan` work as a genuine polyglot scanner instead of an npm-only tool.

## Responsibilities

- `ManifestDiscoverer` recognises `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, and `composer.json`, emitting one `(ecosystem, path)` tuple per manifest file found (a directory with both `requirements.txt` and `pyproject.toml` emits two `pip` tuples)
- Unconditionally excludes build/vendor directories (`vendor/`, `target/`, `.venv/`, `__pycache__/`, `node_modules/`, `.git/`) before applying the scanned repo's own `.gitignore`
- `OsvScannerAdapter` (`runOsvScanner`) invokes `osv-scanner scan source --format=json --no-ignore` once per unique manifest parent directory and parses the JSON result into internal findings
- Maps OSV-Scanner's native ecosystem strings (`PyPI`, `Go`, `crates.io`, `Maven`, `RubyGems`, `Packagist`) to the internal `Ecosystem` union via `mapOsvEcosystem()`, throwing an explicit named error for anything unrecognised
- Supports an optional `overrideConfigFile` argument so callers (e.g. orphan detection) can run a second, unfiltered OSV pass independent of the accepted-CVE filter

## Contracts & Invariants

- Results from `ManifestDiscoverer` are sorted by path for deterministic ordering across platforms and Node.js `readdir` implementations
- Build-dir exclusions apply regardless of what the project's `.gitignore` says — there is no per-project opt-out
- `runOsvScanner` always passes `--no-ignore`: manifest scoping is owned entirely by `ManifestDiscoverer`. Without this flag, `osv-scanner` re-applies ignore rules — including `.gitignore` files in *ancestor* directories outside the scanned repo — and can silently report zero findings for a fully-ignored path (e.g. a checkout under a gitignored `.worktrees/`), which would turn the gate green on a real vulnerability
- `mapOsvEcosystem()` throws rather than silently dropping findings for an unmapped ecosystem string
- `ecosystem` and `manifestPath` flow through the rest of the pipeline (`discoverManifests → runOsvScanner → classifyFindings → printFindings`) as opaque tagging fields; adding a new ecosystem does not require touching downstream stages

## Configuration

`policy.ecosystems` in `.depaudit.yml` accepts any of the seven `SUPPORTED_ECOSYSTEMS` values: `npm`, `pip`, `gomod`, `cargo`, `maven`, `gem`, `composer`. No CLI flags control discovery or the adapter directly.

## Gotchas

- `vendor/` exclusion is unconditional — repos that legitimately vendor dependencies in a non-standard location cannot opt in via `.gitignore`
- `Cargo.lock` is not in the manifest discovery table; `osv-scanner` finds it automatically when scanning a directory containing `Cargo.toml`
- A directory with both `requirements.txt` and `pyproject.toml` produces two discovered manifests but `osv-scanner` dedupes when scanning the shared parent directory, so this does not produce duplicate findings
- `--no-ignore` means any file-based exclusion must happen in `ManifestDiscoverer`, not by relying on `osv-scanner`'s own gitignore handling — a new exclusion added only to a target repo's `.gitignore` will no longer suppress a scan directory unless `ManifestDiscoverer` also excludes it
