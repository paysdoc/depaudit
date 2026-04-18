# CLI Skeleton + OSV-Scanner CVE Scan

**ADW ID:** 442uul-cli-skeleton-osv-sca
**Date:** 2026-04-18
**Specification:** specs/issue-3-adw-442uul-cli-skeleton-osv-sca-sdlc_planner-cli-skeleton-osv-scan.md

## Overview

Establishes the first end-to-end tracer bullet for the `depaudit` CLI. The `depaudit scan [path]` subcommand walks a target repository for npm `package.json` manifests, delegates CVE detection to the external `osv-scanner` binary, normalizes its JSON output into an internal `Finding` type, and prints one line per finding to stdout. The process exits 0 when no findings are present and 1 otherwise.

## What Was Built

- `depaudit scan [path]` CLI subcommand (default path: `cwd`)
- `ManifestDiscoverer` — recursive directory walker honouring `.gitignore` and hard-skipping `node_modules/` / `.git/`
- `OsvScannerAdapter` — subprocess boundary that invokes `osv-scanner`, handles its exit-code-1-on-findings convention, and normalizes output to `Finding[]`
- `stdoutReporter` — formats findings as `<package> <version> <findingId> <severity>`, one line per finding
- `ScanCommand` — thin composition root wiring the pipeline
- Canonical type definitions: `Finding`, `Severity`, `Ecosystem`, `FindingSource`, `Manifest`
- Vitest unit tests for `ManifestDiscoverer` (fixture repos) and `OsvScannerAdapter` (mocked `execFile`)
- Cucumber/BDD e2e feature scenarios in `features/scan.feature`
- Package scaffold: `tsconfig.json`, `cucumber.js`, `bun.lock`, updated `.gitignore`, `.env.sample`, `README.md`, `UBIQUITOUS_LANGUAGE.md`

## Technical Implementation

### Files Modified

- `src/cli.ts`: CLI entry point with shebang, `util.parseArgs` argument parsing, `--help`/`--version` flags, `scan` dispatch, and top-level error handler
- `src/commands/scanCommand.ts`: `runScanCommand(path)` — wires `discoverManifests` → `runOsvScanner` → `printFindings`; returns exit code
- `src/modules/manifestDiscoverer.ts`: `discoverManifests(rootPath)` — recursive `readdir` walker using the `ignore` package; emits `Manifest[]` (npm only)
- `src/modules/osvScannerAdapter.ts`: `runOsvScanner(manifests, execFile?)` — dedupes parent dirs, invokes `osv-scanner scan source --format=json <dirs>`, tolerates exit code 1, maps JSON to `Finding[]` with severity derivation from `database_specific.severity` or CVSS vector heuristics
- `src/modules/stdoutReporter.ts`: `printFindings(findings, stream?)` — writes `<package> <version> <findingId> <severity>\n` per finding
- `src/types/finding.ts`: `Finding`, `Severity`, `Ecosystem`, `FindingSource` types
- `src/types/manifest.ts`: `Manifest` type
- `src/modules/__tests__/manifestDiscoverer.test.ts`: unit tests for simple, nested, gitignore, and node_modules scenarios
- `src/modules/__tests__/osvScannerAdapter.test.ts`: unit tests with mocked `execFile` for empty input, clean output, exit-1-findings, and hard errors
- `features/scan.feature` + `features/step_definitions/scan_steps.ts`: BDD e2e scenarios
- `package.json`: added `typecheck`, `postbuild` (`chmod +x`), `test:e2e` scripts; `ignore` runtime dependency
- `.gitignore`: added `dist/`, `node_modules/`, `.env`, `.depaudit/`

### Key Changes

- `OsvScannerAdapter` treats `execFile` rejection with `code === 1` + `stdout` as the findings-present success path — any other code re-throws
- `ManifestDiscoverer` tests `rel` and `rel + "/"` against the `ignore` instance so directory entries are correctly filtered
- Severity derivation prefers `database_specific.severity`; falls back to CVSS vector heuristics (`I:H`/`C:H` → HIGH, other CVSS_V3 → MEDIUM, else UNKNOWN) — never throws on unparseable severity
- `cli.ts` reads version via `createRequire(import.meta.url)("../package.json").version` to avoid a static import of JSON (ESM compatibility)
- `postbuild` script runs `chmod +x dist/cli.js` so `bun link` / `npm install -g .` installs a working binary

## How to Use

1. Install dependencies: `bun install`
2. Build: `bun run build`
3. Link globally (optional): `bun link`
4. Scan a Node project:
   ```
   depaudit scan /path/to/node-project
   # or from within the project:
   depaudit scan
   ```
5. Interpret output:
   - Exit 0 + no stdout → no findings
   - Exit 1 + one line per finding in `<package> <version> <findingId> <severity>` format

## Configuration

No configuration file is required for this slice. The following environment variables are documented in `.env.sample` for later slices:

| Variable | Purpose |
|---|---|
| `SOCKET_API_TOKEN` | Socket.dev supply-chain API (issue #5) |
| `SLACK_WEBHOOK_URL` | Slack reporter output (later slice) |

The `osv-scanner` binary must be installed and on `PATH`. No precheck is performed; a missing binary surfaces as a `spawn ENOENT` error.

## Testing

```bash
# Unit tests (Vitest)
bun run test

# Type check
bun run typecheck

# Build
bun run build

# E2E / BDD scenarios
bun run test:e2e

# Manual smoke test
node dist/cli.js --help
node dist/cli.js --version
node dist/cli.js scan fixtures/vulnerable-npm/
node dist/cli.js scan fixtures/clean-npm/
```

## Notes

- This slice is npm-only. `OsvScannerAdapter` throws an explicit error for any non-`npm` ecosystem, pointing at issue #4 where polyglot support lands.
- Severity filtering (threshold-based gate) is deferred to a later slice. Currently the process exits 1 on any finding regardless of severity.
- The `ScanCommand` does not handle the case where `osv-scanner` is not installed; callers receive a raw `ENOENT`-style error surfaced to stderr via the `cli.ts` catch block.
- Deferred: `ConfigLoader`, `Linter`, `SocketApiClient`, `FindingMatcher`, composite `Reporter`, PR comment, Slack output, `StateTracker`, `depaudit setup` command, `.depaudit/findings.json` persistence.
