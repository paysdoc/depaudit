# Orphan Auto-Prune in ScanCommand + Fail-Open Guard

**ADW ID:** 82j9dc-orphan-auto-prune-in
**Date:** 2026-04-18
**Issue:** #13

## Overview

`depaudit scan` now automatically removes orphaned accept entries — entries in `.depaudit.yml` (`supplyChainAccepts`) or `osv-scanner.toml` (`[[IgnoredVulns]]`) that no longer match any current finding — after every scan. A fail-open guard protects entries from being pruned when their source (Socket.dev or OSV) was unavailable during the run.

## What Was Built

- `src/modules/orphanDetector.ts` — pure `findOrphans(findings, depauditConfig, osvConfig)` returning `{ orphanedSupplyChain, orphanedCve }` with source-discriminated identity keys
- `src/modules/configWriter.ts` — `pruneDepauditYml(filePath, orphans)` (yaml CST API, comment-preserving) and `pruneOsvScannerToml(filePath, orphans)` (line-range delete, preserves file-header comments and non-IgnoredVulns blocks)
- `src/types/scanResult.ts` — added `osvAvailable: boolean` field for symmetric fail-open guard wiring
- `src/commands/scanCommand.ts` — wired `findOrphans` + both pruners post-classification with fail-open guards and stderr emission
- `src/modules/osvScannerAdapter.ts` — optional `overrideConfigFile` param so orphan detection can get an unfiltered CVE list from OSV independent of the accepted-CVE filter
- `src/modules/__tests__/orphanDetector.test.ts` — 9 unit tests covering all identity-key and source-discrimination cases
- `src/modules/__tests__/configWriter.test.ts` — 12 unit tests covering YAML/TOML round-trips, comment preservation, no-op shortcuts, multi-orphan removal, and loader round-trip verification
- `features/scan_orphan_prune.feature` — 13 BDD scenarios tagged `@adw-13`
- `features/step_definitions/scan_orphan_prune_steps.ts` — Before/After snapshot/restore hooks + all step defs
- 13 fixture directories under `fixtures/prune-*/` — one per scenario

## Technical Implementation

### Files Modified

- `src/types/scanResult.ts`: added `osvAvailable: boolean` after `socketAvailable`
- `src/commands/scanCommand.ts`: calls `findOrphans` after classification; gates `pruneDepauditYml` on `socketResult.available`; gates `pruneOsvScannerToml` on `osvAvailable`; emits `auto-prune: removed N…` to stderr per file pruned
- `src/modules/osvScannerAdapter.ts`: optional `overrideConfigFile` param lets `ScanCommand` run a second OSV pass with an empty temp config to get the full unfiltered CVE list for orphan detection
- `features/support/world.ts`: added `originalFileContents`, `capturedFileContent`, `fakeOsvBinDir` fields to `DepauditWorld`
- `features/step_definitions/scan_steps.ts`: forwards `fakeOsvBinDir` as PATH prefix to the spawned depaudit process

### Key Changes

- **Orphan identity keys are source-discriminated**: supply-chain orphans use composite key `${package}|${version}|${findingId}` over `source: "socket"` findings only; CVE orphans use `findingId` over `source: "osv"` findings only. A Socket finding cannot protect a `[[IgnoredVulns]]` entry and vice-versa.
- **Fail-open guard**: `pruneDepauditYml` only runs when `socketResult.available === true`. `pruneOsvScannerToml` only runs when `osvAvailable === true` (always true today since OSV throws on failure before the prune step is reached; the flag is forward-looking for a future OSV fail-soft slice).
- **YAML write strategy**: `yaml`'s `parseDocument` returns a Document whose `toString()` round-trips comments, formatting, and key order. Items are spliced from `YAMLSeq.items` in reverse to preserve indices; no reserialisation.
- **TOML write strategy**: `smol-toml`'s `stringify` does not preserve comments. The writer uses line-range deletion — it locates each `[[IgnoredVulns]]` block boundary using the same `findSourceLines` approach as `ConfigLoader`, deletes the block lines (including an immediately-preceding blank separator), and rejoins remaining lines. File-header comments and non-`[[IgnoredVulns]]` blocks are preserved verbatim.
- **No-op short-circuit**: both writers skip `writeFile` entirely when nothing was removed, avoiding spurious mtime bumps that would pollute `git diff`.
- **OSV double-pass**: `osv-scanner` suppresses accepted CVEs from its JSON output when an `osv-scanner.toml` is present. `ScanCommand` runs a second OSV pass with an empty temp config file to get the full unfiltered CVE list for orphan detection, while the first (filtered) pass results are used for classification.
- **Exit code unchanged**: prune is a side effect; the gate exit code (`0` / `1`) is determined by `newFindings.length` and `expiredAccepts.length` as before.

## How to Use

Auto-prune runs automatically on every `depaudit scan`. No configuration needed.

**Happy path (local dev):**
```
$ depaudit scan ./my-repo
auto-prune: removed 1 orphaned supplyChainAccepts entry from .depaudit.yml
```
The stale entry is removed from `.depaudit.yml` in the working tree. Commit or discard it at your discretion.

**Fail-open (Socket unavailable):**
```
$ depaudit scan ./my-repo
socket: supply-chain unavailable — scan continuing on CVE findings only
```
Supply-chain accepts are left untouched. No `auto-prune` line is emitted.

**Idempotency:**
Running `depaudit scan` a second time on the cleaned state produces no further mutations and no `auto-prune` stderr line.

## Testing

**Unit tests** (`bun test`):
- `src/modules/__tests__/orphanDetector.test.ts` — empty configs, all-orphan, all-matched, mixed, wrong-source discrimination, composite-key precision
- `src/modules/__tests__/configWriter.test.ts` — YAML: no-op empty orphans, no-op missing key, single removal with comment preservation, all-entries removal, multi-removal, loader round-trip; TOML: no-op, single removal with header comment preservation, multi-removal including EOF block, blank-line absorption, loader round-trip

**BDD scenarios** (`bun run test:e2e -- --tags "@adw-13"`):
1. Happy path (supply-chain): stale `supplyChainAccepts` entry pruned, exit 0
2. Happy path (CVE): stale `[[IgnoredVulns]]` entry pruned, exit 0
3. Both files: single scan prunes both, exit 0
4. Negative control (supply-chain): matching entry NOT pruned
5. Negative control (CVE): matching entry NOT pruned
6. Selective prune: only orphan removed from mixed `.depaudit.yml`
7. Fail-open Socket 503: stale supply-chain accept preserved
8. Fail-open Socket timeout: stale supply-chain accept preserved
9. Fail-open Socket 429: stale supply-chain accept preserved
10. Cross-source isolation: Socket 503 preserves supply-chain orphan; OSV success prunes CVE orphan
11. OSV catastrophic failure: scan aborts before prune; CVE accept preserved; exit non-zero
12. Idempotency (already clean): two scans produce byte-identical file
13. Idempotency (post-prune): second scan after prune produces byte-identical file

**Regression** (`bun run test:e2e -- --tags "@regression"`): all 102 prior scenarios pass unchanged; fixture snapshot/restore in `Before`/`After` hooks prevents prune mutations from bleeding across scenarios.

## Notes

- **No new runtime dependencies**: `yaml` and `smol-toml` were already direct deps. The TOML writer works at the line level rather than via `smol-toml` `stringify`, so no new emit path is needed.
- **`osvAvailable` is forward-looking**: always `true` at the prune site today (OSV throws before we reach it on failure). Introduced now for `ScanResult` symmetry with `socketAvailable` so a future OSV fail-soft slice can flip the flag without re-visiting the prune wiring.
- **YAML anchor/alias edge case**: if an anchor is defined on an orphaned `supplyChainAccepts` item and referenced elsewhere in the document, `doc.toString()` will emit a serialisation error. This is an acceptable edge case; document it in `.depaudit.yml` if users hit it.
- **PRD coverage**: User Story 38 (auto-prune happy path) and User Story 39 (fail-open guard). PRD lines 147-151 are the normative spec.
