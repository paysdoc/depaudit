# Feature: Orphan Auto-Prune in ScanCommand + Fail-Open Guard

## Metadata
issueNumber: `13`
adwId: `82j9dc-orphan-auto-prune-in`
issueJson: `{"number":13,"title":"Orphan auto-prune in ScanCommand + fail-open guard","body":"## Parent PRD\n\n`specs/prd/depaudit.md`\n\n## What to build\n\n`ScanCommand` gains an auto-prune behavior per PRD \"Auto-prune of orphaned accept entries\": after classification, any accept entry with no matching current finding is removed from its file (`.depaudit.yml` or `osv-scanner.toml`) in place. The scan mutates on-disk config — the only `scan`-time mutation.\n\nFail-open guard: do NOT prune entries whose corresponding finding source was unavailable this run (e.g., if Socket failed and we went fail-open, supply-chain accepts are left untouched regardless of what `FindingMatcher` says).\n\n## Acceptance criteria\n\n- [ ] After a scan, accept entries with no matching current finding are removed from their file.\n- [ ] `.depaudit.yml` and `osv-scanner.toml` are both updated as needed.\n- [ ] When `socketAvailable: false`, supply-chain accepts are **never** pruned even if they appear orphaned.\n- [ ] When OSV itself fails catastrophically, CVE accepts are similarly protected.\n- [ ] Integration test (happy path): fixture with stale accept, scan removes it, gate passes.\n- [ ] Integration test (fail-open guard): same fixture with Socket mocked unavailable, stale supply-chain accept is preserved, PR comment notes \"supply-chain unavailable\".\n- [ ] Idempotency: re-running scan on the cleaned state produces no further mutations.\n\n## Blocked by\n\n- Blocked by #7\n\n## User stories addressed\n\n- User story 38\n- User story 39\n","state":"OPEN","author":"paysdoc","labels":[],"createdAt":"2026-04-17T13:24:45Z","comments":[],"actionableComment":null}`

## Feature Description

Once an upgrade PR lands and a previously-accepted finding vanishes from the tree, the accept entry that covered it becomes an *orphan*: it no longer matches any current finding, but it still sits in `.depaudit.yml` (`supplyChainAccepts`) or `osv-scanner.toml` (`[[IgnoredVulns]]`). `depaudit scan` now detects these orphans after classification and removes them from the source file in place — the only mutation `scan` performs on committed files. Running locally leaves the cleanup in the developer's working tree to commit or discard; running under CI the mutation is ephemeral because nothing commits it back.

A fail-open guard protects orphan detection from transient-outage false positives. Socket.dev is allowed to fail open (`socketAvailable: false` on `ScanResult`): when that happens, `supplyChainAccepts` entries are considered un-knowable this run and must not be pruned. OSV-Scanner has no fail-open path today — if `runOsvScanner` throws, the scan aborts before the prune step, which naturally protects `[[IgnoredVulns]]` from being pruned on OSV outages. This slice keeps that invariant explicit and documented, and extends `ScanResult` with a new `osvAvailable: boolean` flag so the guard reads symmetrically and so a future slice can introduce OSV fail-soft behaviour without revisiting the prune wiring.

Idempotency falls out for free: once cleaned, re-running `scan` produces no new orphans and therefore no further mutations.

## User Story

As a developer, once an upgrade PR lands and the corresponding finding disappears from my tree
I want `depaudit scan` to automatically prune the now-orphaned accept entry from the config file
So that I don't have to open a cleanup PR just to delete stale YAML.

As a maintainer
I want `depaudit scan` to NOT auto-prune accept entries when the corresponding finding source (OSV or Socket) was unavailable during the scan
So that a transient outage doesn't erase legitimate acceptances that my team took the time to write.

## Problem Statement

Today, an accepted finding that has been remediated leaves a stale entry in config forever:

1. **Accept entries persist past the finding's lifetime.** `FindingMatcher.classifyFindings` (`src/modules/findingMatcher.ts:43-90`) iterates over current findings and asks, for each, "which accept entry covers this?" It never asks the inverse question: "which accept entries no longer cover any finding?" The only cleanup path is a human opening a PR that deletes the YAML/TOML by hand — friction that the PRD explicitly calls out as the point of auto-prune (User Story 38).

2. **No `scan`-time write path exists.** `ScanCommand` (`src/commands/scanCommand.ts`) is purely read-only today: load configs, run OSV, run Socket, classify, print. `ConfigLoader` (`src/modules/configLoader.ts`) has no write counterpart; there is no module that can safely mutate `.depaudit.yml` or `osv-scanner.toml` in place. The PRD's "only mutation `scan` performs on committed files" (`specs/prd/depaudit.md:149`) has no code home yet.

3. **Fail-open data is not surfaced symmetrically.** `SocketApiClient` returns `{ findings, available }` (`src/modules/socketApiClient.ts:12-15`) and `ScanCommand` forwards `socketAvailable` on the `ScanResult` (`src/types/scanResult.ts:3-7`). `OsvScannerAdapter` has no `available` analogue — it throws on failure, so any OSV unavailability aborts the whole scan. The orphan-prune step needs per-source availability to decide which class of accepts is safe to touch, so the asymmetry needs to be reconciled either by adding `osvAvailable` as a symmetric-but-always-true-for-now flag or by a larger refactor. Without the flag, the prune-step guard has to hard-code "OSV always trustworthy when we got here," which is correct today but brittle.

4. **Comment-preserving in-place writes are non-trivial.** Users write reasons, `upstreamIssue` pointers, and general comments next to their accept entries. Auto-prune must not destroy the surrounding structure. YAML's `yaml` library already powers `ConfigLoader` via `parseDocument` — a CST-preserving API — so YAML mutations can round-trip cleanly. TOML is harder: `smol-toml` parses but its `stringify` won't preserve comments, formatting, or key order. A dedicated writer strategy for each file format is required.

5. **No integration tests for any end-to-end `ScanCommand` flow exist.** `src/commands/__tests__/` is empty; coverage lives at the module level (`findingMatcher.test.ts`, `socketApiClient.test.ts`, etc.) and at the BDD layer (`features/*.feature`). This slice's "happy path" and "fail-open guard" acceptance tests naturally land as new BDD scenarios rather than a brand-new integration-test harness.

Collectively the result is: a developer who lands an upgrade PR watches `depaudit scan` pass (the finding is gone), but the accept entry that used to cover it now lints clean forever, occupying a slot in their YAML until someone notices and opens a dead-YAML-cleanup PR. The ergonomic promise of "low-touch acceptance registers" in the PRD isn't met.

## Solution Statement

Introduce an orphan detector that runs **after** classification, a CST-preserving writer module that mutates `.depaudit.yml` and `osv-scanner.toml` in place, and a fail-open guard that consults per-source availability flags on `ScanResult` before deciding which orphans are safe to prune.

Specifically:

- **New `src/modules/orphanDetector.ts`** — deep module exporting `findOrphans(findings, depauditConfig, osvConfig, now?)`. Takes the same inputs as `classifyFindings` plus the current wall clock. Iterates both accept registers and reports, for each entry, whether *any* current finding matches its identity tuple:
  - `supplyChainAccepts` orphan: no current `source: "socket"` finding matches `(package, version, findingId)`.
  - `[[IgnoredVulns]]` orphan: no current `source: "osv"` finding matches `findingId`.
  - Expired entries are still reported as orphans if they have no match — their expiry is a separate lint concern and the matcher already emits `expired-accept` for the "finding still exists but accept expired" case.
  - Returns `{ orphanedSupplyChain: SupplyChainAccept[], orphanedCve: IgnoredVuln[] }`. Pure function; no I/O.

- **New `src/modules/configWriter.ts`** — deep module with two exports:
  - `pruneDepauditYml(filePath, orphans): Promise<number>` — reads the file, parses it with `yaml`'s `parseDocument` (same as `ConfigLoader`), finds the `supplyChainAccepts` sequence, deletes every item whose `(package, version, findingId)` matches an orphan, writes the document back via `doc.toString()` (which preserves comments, formatting, anchors, and key order). Returns the count of pruned entries. If no orphans match or the sequence is missing, the file is left byte-identical (no-op write).
  - `pruneOsvScannerToml(filePath, orphans): Promise<number>` — reads the file, identifies each `[[IgnoredVulns]]` table's line range using the line-tracking approach already in `ConfigLoader` (`findSourceLines` at `src/modules/configLoader.ts:12-21`), deletes the lines belonging to orphaned blocks, and writes the remaining text back. A table's range is `[sourceLine, nextTableStartLine)` or `[sourceLine, EOF]` for the last one; blank separator lines immediately above the deleted block are also dropped to avoid a pile-up of empty lines. Comments on lines outside any `[[IgnoredVulns]]` block (e.g., a file header) are preserved verbatim.

- **Extend `ScanResult`** (`src/types/scanResult.ts`) to include `osvAvailable: boolean`. Populated by `ScanCommand` as `true` on every successful OSV run. When a future slice gives `OsvScannerAdapter` a fail-soft path, that slice flips the flag without touching `ScanCommand` or the prune step.

- **Wire into `ScanCommand`** (`src/commands/scanCommand.ts`). After `classifyFindings` and the `printFindings` / expired-accept stderr emission, and **only when** `newFindings.length === 0` semantics do not change (the prune step is additive and runs regardless of exit code — an orphaned accept should be cleaned whether or not there are new findings elsewhere):
  1. Call `findOrphans(allFindings, depauditConfig, osvConfig)`.
  2. If `socketAvailable && depauditConfig.filePath`, call `pruneDepauditYml(depauditConfig.filePath, orphans.orphanedSupplyChain)`.
  3. If `osvAvailable && osvConfig.filePath`, call `pruneOsvScannerToml(osvConfig.filePath, orphans.orphanedCve)`.
  4. Emit one stderr line per pruned file of the form `auto-prune: removed N orphaned accept entries from .depaudit.yml`. Visible both to local runs and CI log scraping; follows the existing stderr-for-metadata pattern (`expired accept: …`, `socket: supply-chain unavailable …`).
  5. Return `ScanResult` unchanged in shape — auto-prune does not affect the exit code. Acceptance criterion "gate passes" in the happy path is satisfied by the matcher already producing zero `new` findings (the fixture was already passing); prune is a side effect.

- **Fail-open guard is literally the two `if` conditions above.** Socket unavailability → the `supplyChainAccepts` prune branch is skipped entirely (no file read, no file write). OSV unavailability → today impossible to reach the prune step (scan aborts); tomorrow (if OSV gains fail-soft behaviour) the `osvAvailable` gate protects `[[IgnoredVulns]]`. The existing PRD requirement "when OSV itself fails catastrophically, CVE accepts are similarly protected" is satisfied by the `runOsvScanner` throw-on-failure contract plus the `osvAvailable` gate; a stderr message is added on the thrown path so users understand why nothing was pruned.

- **Idempotency** is guaranteed by construction: a cleaned register has zero orphans on the next run, so both prune functions are no-ops. The writer uses its own "no-op write" short-circuit (skip `writeFile` when nothing was removed) to avoid gratuitous mtime bumps that would confuse `git diff`.

- **Unit tests** mirror the module boundaries: `orphanDetector.test.ts` (pure, fixture-driven), `configWriter.test.ts` (round-trips YAML and TOML fixtures, asserts mutation and comment preservation).

- **BDD scenarios** (`features/scan_orphan_prune.feature`, tag `@adw-13`) cover the acceptance scenarios named in the issue plus negative-control and cross-source-isolation cases: happy-path prune (supply-chain, CVE, both), matching-accept preservation, selective prune in mixed state, Socket fail-open triggers (HTTP 503, HTTP 429, timeout), cross-source isolation (Socket down does not protect CVE accepts), OSV catastrophic-failure guard, and two idempotency cases. Each uses a dedicated fixture under `fixtures/prune-*/` alongside the existing pattern.

## Relevant Files

Use these files to implement the feature:

- `specs/prd/depaudit.md` — parent PRD. Section "Auto-prune of orphaned accept entries" (lines 147-151) is the normative spec; user stories 38 and 39 (lines 99-101) are the acceptance targets. Integration-test-coverage expectations (lines 251-252) explicitly describe the happy-path and fail-open-guard scenarios.
- `README.md` — project overview; confirms target deliverables and pre-release status.
- `src/commands/scanCommand.ts` — composition root to extend. The post-classification block (`:139-151`) is where the new prune step and stderr emission are inserted. `ConfigParseError` and `SocketAuthError` handling patterns (`:61-84, :124-133`) show how to propagate file-I/O errors without regressing the existing exit-code contract.
- `src/modules/findingMatcher.ts` — reference for the lookup-table key shapes (`:12-25` build `cveAcceptByIdMap` and `scaAcceptByKey`). The orphan detector inverts these maps: each accept key that never appears in a finding is an orphan.
- `src/modules/configLoader.ts` — pattern source for the writer. `findSourceLines` (`:12-21`) and the `sourceLine` population in `loadOsvScannerConfig` (`:23-64`) already do the block-boundary math that `pruneOsvScannerToml` needs. `loadDepauditConfig` uses `parseDocument` + `LineCounter` (`:80-88`) — the same `Document` handle supports round-trip mutation via `doc.toString()`.
- `src/modules/socketApiClient.ts` — reference for the fail-open semantics. `SocketApiResult.available` (`:12-15`) is the flag the prune guard reads. `SocketAuthError` (`:26-31`) is the fail-loud counterpart; auto-prune never runs when auth fails because `ScanCommand` already returns early.
- `src/modules/osvScannerAdapter.ts` — confirms today's OSV throw-on-failure contract (`:98-105`). The new `osvAvailable` flag defaults to `true` while this contract holds.
- `src/types/scanResult.ts` — extend with `osvAvailable: boolean`.
- `src/types/depauditConfig.ts` — `SupplyChainAccept` (`:20-28`) is the orphan identity carrier for supply-chain.
- `src/types/osvScannerConfig.ts` — `IgnoredVuln` (`:1-6`) is the CVE orphan identity carrier; `sourceLine` is already populated by the loader and is what the TOML writer uses to locate blocks.
- `src/types/finding.ts` — `Finding.source` discriminates which accept register to compare against.
- `src/modules/__tests__/configLoader.test.ts` — fixture-loading idiom used by the writer tests.
- `src/modules/__tests__/findingMatcher.test.ts` — pure-function test idiom used by the orphan-detector tests.
- `src/modules/__tests__/fixtures/` — existing fixture root for unit tests.
- `features/scan_socket_supply_chain.feature` and `features/step_definitions/scan_socket_supply_chain_steps.ts` — precedent for `@adw-*` tagged scenarios that spin up a mock Socket server, write `.depaudit.yml` fixtures at runtime, and assert on stdout/stderr. The new `@adw-13` scenarios (in `features/scan_orphan_prune.feature`) mirror the mock-Socket-server pattern for the fail-open guard.
- `features/support/mockSocketServer.ts` — reusable mock server helper; the fail-open scenario configures it with `transientKind: "500"` or similar.
- `features/support/world.ts` — already carries `socketMockUrl`, `socketToken`, `writtenFiles`. A new field `prunedFilesBeforeScan?: Record<string, string>` stores pre-scan file contents so teardown can restore fixtures across runs (since prune mutates fixtures in place).
- `features/step_definitions/scan_steps.ts` — reuse `runDepaudit` and stdout/stderr assertions.
- `app_docs/feature-5sllud-depaudit-yml-schema-finding-matcher.md` — authoritative reference for the classification semantics the orphan detector inverts.
- `app_docs/feature-ekjs2i-socketapiclient-supply-chain.md` — authoritative reference for the fail-open contract the guard relies on.
- `.adw/project.md` — confirms deep-module layout and `bun` tooling.
- `.adw/commands.md` — validation commands (`bun run lint`, `bun run typecheck`, `bun run build`, `bun test`, `bun run test:e2e`).

### New Files

- `src/modules/orphanDetector.ts` — new deep module: `findOrphans(findings, depauditConfig, osvConfig)` returning `{ orphanedSupplyChain, orphanedCve }`.
- `src/modules/configWriter.ts` — new deep module: `pruneDepauditYml(filePath, orphans)`, `pruneOsvScannerToml(filePath, orphans)`.
- `src/modules/__tests__/orphanDetector.test.ts` — unit tests for the detector.
- `src/modules/__tests__/configWriter.test.ts` — unit tests covering YAML round-trip, TOML round-trip, comment preservation, no-op behaviour, multi-orphan removal, and file-path absence.
- `src/modules/__tests__/fixtures/auto-prune/*.yml` — fixture YAML files for writer round-trip tests.
- `src/modules/__tests__/fixtures/auto-prune/*.toml` — fixture TOML files for writer round-trip tests.
- `features/scan_orphan_prune.feature` — new BDD feature file tagged `@adw-13`.
- `features/step_definitions/scan_orphan_prune_steps.ts` — step definitions for the above scenarios (pre-scan file snapshot, post-scan assertions on file contents, byte-identity checks).
- `fixtures/prune-sca-orphan/` — npm repo with `.depaudit.yml` carrying a stale `supplyChainAccepts` entry (package `ghost-pkg@9.9.9`) not surfaced by the mock Socket server.
- `fixtures/prune-cve-orphan/` — npm repo with `osv-scanner.toml` carrying a stale `[[IgnoredVulns]]` entry (id `CVE-ORPHAN-0001`) not surfaced by OSV.
- `fixtures/prune-both-files/` — npm repo carrying both a stale supply-chain accept and a stale CVE accept; both must be pruned in a single scan.
- `fixtures/prune-sca-matching/` — npm repo whose `.depaudit.yml` entry matches a Socket alert emitted by the mock server; entry must be preserved (negative control).
- `fixtures/prune-cve-matching/` — npm repo whose `osv-scanner.toml` entry matches a CVE surfaced by OSV; entry must be preserved (negative control).
- `fixtures/prune-sca-mixed/` — npm repo with two `supplyChainAccepts` entries (one matching the Socket alert, one orphan); only the orphan is removed.
- `fixtures/prune-sca-socket-503/` — fail-open fixture: Socket mock returns HTTP 503; stale supply-chain accept must be preserved.
- `fixtures/prune-sca-socket-timeout/` — fail-open fixture: Socket mock never responds within client timeout; stale supply-chain accept must be preserved.
- `fixtures/prune-sca-socket-429/` — fail-open fixture: Socket mock returns HTTP 429; stale supply-chain accept must be preserved.
- `fixtures/prune-cve-socket-down/` — cross-source-isolation fixture: Socket mock 503s but OSV succeeds; CVE orphan is pruned while supply-chain orphan is preserved.
- `fixtures/prune-osv-fails/` — fixture whose OSV scan fails catastrophically; stale CVE accept must be preserved and scan exits non-zero.
- `fixtures/prune-idempotent/` — repo whose `.depaudit.yml` has empty `commonAndFine` and `supplyChainAccepts`; re-running scan produces byte-identical file.
- `fixtures/prune-idempotent-post/` — repo with a CVE orphan; after one prune, a second scan produces byte-identical `osv-scanner.toml`.

## Implementation Plan

### Phase 1: Foundation

Introduce the pure detector and the per-source availability plumbing so the prune step has the exact data it needs to make a safe decision.

- Extend `ScanResult` with `osvAvailable: boolean`.
- Populate `osvAvailable: true` in every return path of `runScanCommand` that reaches classification (OSV always succeeded if we got this far). Early-return paths (`ConfigParseError`, `SocketAuthError`, lint failure) set `osvAvailable: true` for consistency — they never reach the prune step either way.
- Create `src/modules/orphanDetector.ts` with `findOrphans(findings, depauditConfig, osvConfig)` — pure, no I/O, no writes. Mirrors the lookup-table construction in `findingMatcher.ts` but iterates accepts rather than findings.

### Phase 2: Core Implementation

Build the config writer module for the two file formats, each with a round-trip test harness.

- Create `src/modules/configWriter.ts`:
  - `pruneDepauditYml(filePath, orphans)` uses `parseDocument` + `LineCounter` (same as the loader), walks `doc.get("supplyChainAccepts")` as a `YAMLSeq`, drops items whose `(package, version, findingId)` matches an orphan, writes back via `doc.toString()`.
  - `pruneOsvScannerToml(filePath, orphans)` re-parses with `smol-toml` to enumerate `[[IgnoredVulns]]` entries, computes each block's `[start, end)` line range via the existing `findSourceLines` idiom, builds a "keep-mask" over the original line array, and reassembles.
  - Both functions skip `writeFile` entirely when the orphan list is empty or no matches exist (no mtime bump).

### Phase 3: Integration

Wire the detector + writer into `ScanCommand` and cover the end-to-end behaviour with BDD scenarios.

- Extend `runScanCommand` to call `findOrphans` after classification, gate each file's prune on the corresponding per-source availability flag, emit a stderr line per file pruned.
- Write the BDD feature file and step definitions with a robust pre-scan snapshot / post-scenario restore discipline so the mutation does not leak across scenarios.
- Run full validation suite.

## Step by Step Tasks

Execute every step in order, top to bottom.

### Task 1 — Extend `ScanResult` with `osvAvailable`

- Modify `src/types/scanResult.ts`:
  - Add `osvAvailable: boolean` after `socketAvailable`.
- Update every `ScanResult` literal in `src/commands/scanCommand.ts` to include `osvAvailable: true`:
  - Early-return after depaudit `ConfigParseError` (exit 2).
  - Early-return after osv `ConfigParseError` (exit 2).
  - Early-return after lint failure (exit 1).
  - Early-return after `SocketAuthError` (exit 2).
  - Final return at end of `runScanCommand`.
- Keep the existing `socketAvailable` semantics unchanged.

### Task 2 — Create `src/modules/orphanDetector.ts`

- New file. Exports `findOrphans(findings: Finding[], depauditConfig: DepauditConfig, osvConfig: OsvScannerConfig): { orphanedSupplyChain: SupplyChainAccept[]; orphanedCve: IgnoredVuln[] }`.
- Build two "seen" sets from `findings`:
  - Socket finding identity: `${package}|${version}|${findingId}` for every `source: "socket"` finding.
  - OSV finding identity: `findingId` for every `source: "osv"` finding. (OSV accepts key off `id` alone, matching the matcher's `cveAcceptByIdMap` semantics.)
- Iterate `depauditConfig.supplyChainAccepts`; entries whose key is NOT in the Socket seen-set are orphans.
- Iterate `osvConfig.ignoredVulns`; entries whose `id` is NOT in the OSV seen-set are orphans.
- Preserve input ordering in the returned arrays.
- Pure function; no `now` parameter needed (expiry is irrelevant to orphan status).

### Task 3 — Unit-test the orphan detector

- `src/modules/__tests__/orphanDetector.test.ts`. Cover:
  - Empty configs → empty orphan sets.
  - Empty findings + populated accepts → every accept is an orphan.
  - Populated findings matching every accept → zero orphans.
  - Mixed: some accepts match, others don't → only unmatched are returned.
  - Socket finding with same `(package, version)` but different `findingId` → supply-chain accept still orphaned.
  - CVE finding identity: two accepts with same `id` both orphan or both present (seen-set is id-keyed).
  - `source: "osv"` finding does not satisfy a `supplyChainAccepts` entry (and vice-versa).

### Task 4 — Create `src/modules/configWriter.ts`

- New file. Exports:
  - `pruneDepauditYml(filePath: string, orphans: SupplyChainAccept[]): Promise<number>`.
  - `pruneOsvScannerToml(filePath: string, orphans: IgnoredVuln[]): Promise<number>`.
- `pruneDepauditYml`:
  - If `orphans.length === 0` return 0.
  - Read file, `parseDocument(raw)` (same `yaml` import as loader).
  - Get `supplyChainAccepts` sequence via `doc.get("supplyChainAccepts", true)` as `YAMLSeq`; if missing, return 0.
  - Build a `Set<string>` of orphan keys `${package}|${version}|${findingId}`.
  - Iterate `seq.items` in reverse, `splice` out any item whose `(package, version, findingId)` matches.
  - If no items removed, return 0 (no write).
  - `await writeFile(filePath, doc.toString())`. Return removed count.
- `pruneOsvScannerToml`:
  - If `orphans.length === 0` return 0.
  - Read file, parse with `smol-toml` (matches loader).
  - Use the same line-search as `findSourceLines` in `configLoader.ts` to find every `[[IgnoredVulns]]` opening line.
  - For each parsed entry `i`: compute `blockStart = sourceLines[i]` and `blockEnd = sourceLines[i+1] ?? totalLines + 1` (exclusive).
  - Mark blocks whose `id` matches an orphan for removal; collect their line ranges.
  - Optionally extend deleted ranges upward by one line to absorb an immediately-preceding blank separator, so the file does not accumulate blank lines.
  - Rebuild the file by joining the kept lines.
  - If nothing was removed, return 0 (no write).
  - `await writeFile(filePath, joined)`. Return removed count.

### Task 5 — Unit-test the config writer

- `src/modules/__tests__/configWriter.test.ts`. Cover both writers via fixture files under `src/modules/__tests__/fixtures/auto-prune/`.
- YAML (`pruneDepauditYml`) cases:
  - No-op when `orphans` is empty (no write).
  - No-op when file exists but `supplyChainAccepts` key is missing.
  - Single orphan removed from a multi-entry sequence; surrounding commentary preserved.
  - All entries orphan → sequence becomes an empty list (`[]`).
  - Multiple orphans removed at once; ordering of remaining entries preserved.
  - Round-trip: parse the post-write YAML with `loadDepauditConfig` to confirm it still lints clean.
- TOML (`pruneOsvScannerToml`) cases:
  - No-op when `orphans` is empty.
  - Single orphan block removed; file header comments above the first block preserved.
  - Multiple orphan blocks removed including the last block (EOF boundary).
  - Blank-line separators between blocks do not accumulate (delete the preceding blank line if present).
  - Round-trip: parse the post-write TOML with `loadOsvScannerConfig` to confirm it still lints clean.
- Use `bun test` naming convention (`.test.ts`) and import helpers from existing test utilities where applicable.

### Task 6 — Wire auto-prune into `ScanCommand`

- Modify `src/commands/scanCommand.ts`. Just before the final `return { findings: classified, socketAvailable, exitCode, osvAvailable: true }`:
  - Import `findOrphans` from `../modules/orphanDetector.js` and `pruneDepauditYml`, `pruneOsvScannerToml` from `../modules/configWriter.js`.
  - Compute `const orphans = findOrphans(allFindings, depauditConfig, osvConfig)`.
  - If `socketResult.available && depauditConfig.filePath && orphans.orphanedSupplyChain.length > 0`:
    - `const n = await pruneDepauditYml(depauditConfig.filePath, orphans.orphanedSupplyChain)`.
    - On `n > 0`, write `auto-prune: removed ${n} orphaned supplyChainAccepts entr${n === 1 ? "y" : "ies"} from .depaudit.yml\n` to stderr.
  - If `osvConfig.filePath && orphans.orphanedCve.length > 0`:
    - `const n = await pruneOsvScannerToml(osvConfig.filePath, orphans.orphanedCve)`.
    - On `n > 0`, write `auto-prune: removed ${n} orphaned IgnoredVulns entr${n === 1 ? "y" : "ies"} from osv-scanner.toml\n` to stderr.
  - `osvAvailable` is always `true` here (guaranteed by having reached this code path). Wire the symmetric gate (`if (osvAvailable && ...)`) even so — the future OSV fail-soft slice will flip the flag without another edit.
  - Auto-prune does not affect `exitCode`: re-use the same `newFindings.length === 0 && expiredAccepts.length === 0 ? 0 : 1` calculation.
- Leave `ScanResult.findings` unchanged: it still carries the pre-prune classification, since that is what downstream reporters should render for *this* run.

### Task 7 — Create BDD fixtures for auto-prune scenarios

- `fixtures/prune-sca-orphan/`:
  - `package.json` declaring an innocuous npm dependency (e.g., `lodash@4.17.21`) with no known CVE.
  - `.depaudit.yml` with version 1, default policy, one `supplyChainAccepts` entry for a `(package, version, findingId)` tuple for package `ghost-pkg@9.9.9` that will not be surfaced by the mock Socket server (i.e., orphan).
  - Any `package-lock.json` or equivalent needed to satisfy `extractPackagesFromManifests`.
- `fixtures/prune-cve-orphan/`:
  - `package.json` with a clean-npm dependency.
  - `osv-scanner.toml` with a single `[[IgnoredVulns]]` block for id `CVE-ORPHAN-0001` that OSV will not emit.
  - `.depaudit.yml` minimal.
- `fixtures/prune-both-files/`:
  - `package.json` with a clean-npm dependency.
  - `.depaudit.yml` with a stale `supplyChainAccepts` entry for `ghost-pkg@9.9.9`.
  - `osv-scanner.toml` with a stale `[[IgnoredVulns]]` entry for `CVE-ORPHAN-0010`.
- `fixtures/prune-sca-matching/`:
  - `package.json` with a dependency that the mock Socket server will emit an `install-scripts` alert for.
  - `.depaudit.yml` with a valid `supplyChainAccepts` entry whose `(package, version, findingId)` matches that alert.
- `fixtures/prune-cve-matching/`:
  - `package.json` pinning a dependency with a known OSV CVE.
  - `osv-scanner.toml` with an `[[IgnoredVulns]]` entry for that CVE's id with a valid `ignoreUntil` and a `reason` of at least 20 characters.
- `fixtures/prune-sca-mixed/`:
  - `package.json` whose dependency the mock Socket server will emit an `install-scripts` alert for.
  - `.depaudit.yml` with two `supplyChainAccepts` entries: one matching the Socket alert (must be preserved) and one for `ghost-pkg@9.9.9` (must be pruned).
- `fixtures/prune-sca-socket-503/`, `fixtures/prune-sca-socket-timeout/`, `fixtures/prune-sca-socket-429/`:
  - Each mirrors `fixtures/prune-sca-orphan/` but is consumed by a distinct Socket-failure scenario. Scenarios configure the mock Socket server to 503, never-respond, or 429 respectively; the stale supply-chain accept must be preserved in all three cases.
- `fixtures/prune-cve-socket-down/`:
  - Cross-source-isolation fixture. `package.json` with a clean-npm dependency.
  - `.depaudit.yml` with a stale `supplyChainAccepts` entry for `ghost-pkg@9.9.9` (must be preserved because Socket is unavailable).
  - `osv-scanner.toml` with a stale `[[IgnoredVulns]]` entry for `CVE-ORPHAN-0020` (must be pruned because OSV succeeded).
- `fixtures/prune-osv-fails/`:
  - Fixture whose manifest/config causes OSV to fail catastrophically (e.g., a malformed `osv-scanner.toml` that OSV itself rejects, or a trigger recognised by the test harness).
  - `osv-scanner.toml` with a stale `[[IgnoredVulns]]` entry for `CVE-ORPHAN-0030`. Scan exits non-zero; no prune occurs.
- `fixtures/prune-idempotent/`:
  - Repo with `.depaudit.yml` at version 1, default policy, and empty `commonAndFine` and `supplyChainAccepts`. Two scans in succession produce byte-identical files.
- `fixtures/prune-idempotent-post/`:
  - Repo with a CVE orphan in `osv-scanner.toml` (`CVE-ORPHAN-0040`). First scan prunes it; the second scan on the cleaned state produces a byte-identical `osv-scanner.toml`.

### Task 8 — BDD feature + step definitions

- `features/scan_orphan_prune.feature`, `@adw-13`. Scenarios (all tagged `@regression` except where noted):
  1. **Happy path (supply-chain)**: stale `supplyChainAccepts` entry removed from `.depaudit.yml` after a clean scan. Exit 0; stdout has no finding lines; `.depaudit.yml` no longer contains the orphan.
  2. **Happy path (CVE)**: stale `[[IgnoredVulns]]` entry removed from `osv-scanner.toml` after a clean scan. Exit 0; stdout has no finding lines; `osv-scanner.toml` no longer contains the orphan.
  3. **Both files**: single scan prunes a stale supply-chain accept and a stale CVE accept in the same repo. Exit 0; both files no longer contain their respective orphan.
  4. **Negative control (supply-chain)**: matching `supplyChainAccepts` entry is NOT pruned when Socket emits the corresponding alert. File still contains the entry.
  5. **Negative control (CVE)**: matching `[[IgnoredVulns]]` entry is NOT pruned when OSV emits the corresponding CVE. File still contains the entry.
  6. **Selective prune**: `.depaudit.yml` with two `supplyChainAccepts` entries (one matching, one orphan) has only the orphan removed; the matching entry is preserved.
  7. **Fail-open (Socket 503)**: stale supply-chain accept is PRESERVED when Socket returns 503. Exit 0; stderr mentions `supply-chain unavailable`; file still contains the entry.
  8. **Fail-open (Socket timeout)**: same as (7) but mock Socket never responds within client timeout.
  9. **Fail-open (Socket 429)**: same as (7) but mock Socket returns 429.
  10. **Cross-source isolation**: when Socket is down but OSV succeeded, the CVE orphan is pruned while the supply-chain orphan is preserved. Exit 0; stderr mentions `supply-chain unavailable`.
  11. **OSV catastrophic failure**: when `runOsvScanner` throws, scan exits non-zero and the stale `[[IgnoredVulns]]` entry is preserved (scan aborts before the prune step).
  12. **Idempotency (already clean)**: `.depaudit.yml` with empty `commonAndFine` and `supplyChainAccepts`; two back-to-back scans produce byte-identical file.
  13. **Idempotency (post-prune)** *(not tagged `@regression`)*: CVE orphan is pruned on the first scan; the second scan on the cleaned state produces a byte-identical `osv-scanner.toml`.
- `features/step_definitions/scan_orphan_prune_steps.ts`:
  - `Before({ tags: "@adw-13" })` hook snapshots the fixture's `.depaudit.yml` and `osv-scanner.toml` (if present) to `world.originalFileContents: Record<string, string>`.
  - `After({ tags: "@adw-13" })` restores the snapshotted files so scenarios do not bleed state. This is critical because prune mutates fixtures in place.
  - New `Given` steps:
    - `Given("the repository's .depaudit.yml has a \`supplyChainAccepts\` entry for package {string} at version {string} that matches no current finding", ...)`.
    - `Given("the repository's .depaudit.yml has a valid \`supplyChainAccepts\` entry matching that (package, version, alertType) tuple", ...)`.
    - `Given("the repository's .depaudit.yml has two \`supplyChainAccepts\` entries: one matching the Socket alert and one for package {string} at version {string} that matches no current finding", ...)`.
    - `Given("the repository's osv-scanner.toml has an \`[[IgnoredVulns]]\` entry for id {string} that matches no current finding", ...)`.
    - `Given("the repository's osv-scanner.toml has an \`[[IgnoredVulns]]\` entry for that CVE's id with a valid \`ignoreUntil\` and a \`reason\` of at least 20 characters", ...)`.
    - `Given("the repository's .depaudit.yml has version 1, default policy, and empty \`commonAndFine\` and \`supplyChainAccepts\`", ...)`.
    - `Given("a fixture Node repository at {string} whose OSV scan fails catastrophically", ...)` — configures the harness to trigger an OSV throw.
    - `Given("a mock Socket API that never responds within the client timeout", ...)`.
    - `Given("a mock Socket API that returns HTTP 429 for every request", ...)` (HTTP 503 already exists).
  - New `When` steps:
    - `When("I capture the content of .depaudit.yml in {string}", ...)` — reads and stores file bytes into `world.capturedContent`.
    - `When("I capture the content of osv-scanner.toml in {string}", ...)` — same for TOML.
  - New `Then` steps:
    - `Then("the .depaudit.yml in {string} no longer contains a \`supplyChainAccepts\` entry for package {string}", ...)`.
    - `Then("the .depaudit.yml in {string} still contains a \`supplyChainAccepts\` entry for package {string}", ...)`.
    - `Then("the .depaudit.yml in {string} still contains the matching \`supplyChainAccepts\` entry", ...)`.
    - `Then("the .depaudit.yml in {string} still contains a \`supplyChainAccepts\` entry matching the Socket alert", ...)`.
    - `Then("the osv-scanner.toml in {string} no longer contains an \`[[IgnoredVulns]]\` entry for id {string}", ...)`.
    - `Then("the osv-scanner.toml in {string} still contains an \`[[IgnoredVulns]]\` entry for id {string}", ...)`.
    - `Then("the osv-scanner.toml in {string} still contains an \`[[IgnoredVulns]]\` entry for that CVE", ...)`.
    - `Then("the .depaudit.yml content in {string} is byte-identical to the captured content", ...)`.
    - `Then("the osv-scanner.toml content in {string} is byte-identical to the captured content", ...)`.
  - Reuse existing `stderr mentions {string}`, `stdout contains no finding lines`, `exit code is 0`, and `exit code is non-zero` steps.

### Task 9 — Update documentation

- Add a new `app_docs/feature-82j9dc-orphan-auto-prune.md` summarising the slice in the same house style as `app_docs/feature-ekjs2i-socketapiclient-supply-chain.md`. Sections: Overview, What Was Built, Technical Implementation (Files Modified / Key Changes), How to Use, Testing, Notes.
- Append a line to `.adw/conditional_docs.md` so future sessions pick up the new doc when auto-prune topics arise.

### Task 10 — Run the validation suite

- Execute every command in **Validation Commands** below. All must pass with zero regressions.

## Testing Strategy

### Unit Tests

`.adw/project.md` lacks the `## Unit Tests: enabled` marker. This plan includes unit-test tasks as a documented override, following the same precedent as issues #3, #4, #5, #6, and #7 (see their plan files and issue-7 plan Notes section). Justifications, in priority order:

1. **Pure module discipline.** `orphanDetector.ts` and `configWriter.ts` are deep modules with pure or near-pure interfaces; the project's `.adw/project.md` Framework Notes explicitly mandate Vitest unit coverage for deep modules.
2. **Round-trip correctness for file mutations.** In-place mutation of committed user config is higher stakes than most depaudit operations — regressions can silently corrupt YAML or TOML. Unit tests are the fastest and cheapest way to prove round-trip preservation on every change.
3. **BDD alone is insufficient.** E2E scenarios exercise the happy paths but can't efficiently cover the matrix of TOML block-boundary edge cases (first block, last block, consecutive blocks, blank-line separators, file header comments).

Unit tests to build:

- **`src/modules/__tests__/orphanDetector.test.ts`** — purity, identity-key correctness, source-discrimination, empty-input cases; covered in Task 3.
- **`src/modules/__tests__/configWriter.test.ts`** — YAML and TOML round-trip fixtures, comment preservation, no-op shortcut, post-write loader round-trip; covered in Task 5.

### Edge Cases

- `.depaudit.yml` absent (`filePath: null` from loader). Prune step is a no-op — the guard `depauditConfig.filePath` falsy-check skips the whole branch. No crash.
- `osv-scanner.toml` absent. Same no-op behaviour.
- `.depaudit.yml` present with `supplyChainAccepts: []` (empty sequence). Orphan detector returns zero orphans; writer is never called.
- Config file present but contains zero orphans. Writer's early `orphans.length === 0` shortcut avoids any read/parse/write; no mtime bump.
- Multiple orphans across both files in the same scan. Both writers fire; two stderr lines emitted.
- A supply-chain orphan's `findingId` is identical to a *different* package's current finding. Key is composite `(package, version, findingId)` → only exact-tuple matches protect; the lookalike does not block the prune.
- A CVE accept whose id is referenced by a Socket finding (different source). OSV seen-set only tracks `source === "osv"` findings, so the Socket finding does not protect the CVE accept. Correct behaviour: source-discriminated identity.
- An accept entry is *expired* AND orphaned. Still orphaned — expiry is orthogonal to orphan status. The matcher emits `expired-accept` only when a finding matches the expired accept; no finding matches here, so there is no `expired-accept` emission either. Purely pruned.
- Writer hit on a file with CRLF line endings (Windows-checked-out repos). The TOML writer uses `split("\n")` which leaves `\r` attached to each line; rejoining with `\n` preserves the endings. Verify via a CRLF fixture in the unit test.
- Comment on the same line as a `[[IgnoredVulns]]` opener or inside a block. The writer deletes the whole block including inline comments; this is acceptable per PRD since the block is being removed. Comments on neighbouring non-block lines are preserved (unit-test this explicitly).
- YAML anchor / alias inside `supplyChainAccepts`. `doc.toString()` preserves anchors; items removed via `splice` do not affect other items' anchor references. If an anchor is defined on an orphan and referenced elsewhere, `doc.toString()` will emit an error — acceptable edge case, document in Notes.
- Two separate scans racing on the same file (local + IDE save). Out of scope; writer is not atomic, but collisions surface as a loader parse error on the next run (same as today for manual edits).
- File is read-only / permission denied. `writeFile` throws; surfaces as an unhandled error. Same failure mode as any other I/O error in depaudit; logs to the CLI top-level error handler. Out of scope for auto-prune-specific handling.

## Acceptance Criteria

- [ ] `ScanResult` carries both `socketAvailable` and `osvAvailable` boolean flags.
- [ ] Running `depaudit scan` on a fixture repo whose `.depaudit.yml` contains an orphaned `supplyChainAccepts` entry and whose Socket API returns cleanly removes the entry from the file on disk, preserves surrounding formatting and comments, exits 0, and prints an `auto-prune: removed 1 orphaned supplyChainAccepts entry from .depaudit.yml` stderr line.
- [ ] Running `depaudit scan` on the same fixture with Socket mocked to return HTTP 503 leaves the file byte-identical, emits `socket: supply-chain unavailable — scan continuing on CVE findings only` to stderr, does NOT emit `auto-prune` to stderr, and does not call the writer.
- [ ] Running `depaudit scan` on a fixture repo whose `osv-scanner.toml` contains an orphaned `[[IgnoredVulns]]` entry (CVE not surfaced by OSV) and whose OSV succeeds removes the block, preserves surrounding comments and other blocks, exits 0, and emits an `auto-prune: …osv-scanner.toml` stderr line.
- [ ] When `runOsvScanner` throws, the scan aborts before reaching the prune step; `osv-scanner.toml` is byte-identical. No OSV-fail-soft behaviour is introduced in this slice — the existing throw-on-failure contract satisfies "CVE accepts protected" by construction.
- [ ] Re-running `depaudit scan` on the post-prune state produces identical `.depaudit.yml` and `osv-scanner.toml` contents (same hash); no further mutations.
- [ ] `findOrphans` treats supply-chain and CVE accepts as source-discriminated: a `source: "osv"` finding does not protect a `supplyChainAccepts` entry and vice-versa.
- [ ] Unit tests cover `orphanDetector` and `configWriter` with at least the scenarios in Tasks 3 and 5.
- [ ] BDD scenarios in `features/scan_orphan_prune.feature` cover happy path (supply-chain, CVE, both-files), matching-entry negative controls, selective prune, Socket fail-open guards (503, timeout, 429), cross-source isolation, OSV catastrophic-failure guard, and two idempotency cases; all pass under `bun run test:e2e -- --tags "@adw-13"`.
- [ ] Regression: all previously passing BDD scenarios (`bun run test:e2e -- --tags "@regression"`) continue to pass unchanged.
- [ ] `bun run lint`, `bun run typecheck`, `bun run build`, and `bun test` all pass with no new warnings or errors.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `bun install` — ensure dependencies resolved (no new runtime deps expected; `yaml` and `smol-toml` already present).
- `bun run lint` — lint the entire codebase; must pass.
- `bun run typecheck` — TypeScript strict mode must pass with zero errors across the new modules, the extended `ScanResult`, and the wired `ScanCommand`.
- `bun test` — full Vitest suite, including new `orphanDetector.test.ts` and `configWriter.test.ts`. Zero failures.
- `bun run build` — emits `dist/modules/orphanDetector.js`, `dist/modules/configWriter.js`, updated `dist/types/scanResult.js`, and `dist/commands/scanCommand.js`.
- `bun run test:e2e -- --tags "@adw-13"` — the new BDD scenarios pass end-to-end.
- `bun run test:e2e -- --tags "@regression"` — every prior scenario (tagged `@adw-3` through `@adw-7`, plus `@regression` aliases) continues to pass unchanged; no mtime or prune side-effects leak across fixtures because the `@adw-13` step hooks snapshot-and-restore.
- `bun run test:e2e` — run the entire Cucumber suite as a final smoke test.

## Notes

- **No new runtime dependencies.** The `yaml` library is already a direct dep and supports CST-preserving round-trips; `smol-toml` is already a direct dep and the TOML writer works at the line level rather than via `stringify`, so we inherit its parser without depending on an emit path.
- **Unit tests override.** `.adw/project.md` lacks `## Unit Tests: enabled`. This plan includes unit-test tasks because in-place mutation of committed user config is higher-risk than read-only operations and because BDD alone cannot cost-effectively cover the TOML boundary-line matrix. Same precedent as issues #3–#7.
- **`osvAvailable` is a forward-looking flag.** Today it is always `true` at the prune site (since OSV throws on failure and we wouldn't reach the prune step otherwise). Introducing it now keeps `ScanResult` symmetric with `socketAvailable` and lets a future OSV fail-soft slice flip the semantics without re-visiting the prune wiring.
- **TOML writer strategy.** `smol-toml` has a `stringify` function but does not preserve comments, blank lines, or key order. The plan's line-range delete approach works because the existing `ConfigLoader.findSourceLines` already tells us where each `[[IgnoredVulns]]` block starts; a table's body is the lines between successive table openers (or to EOF), and we drop full block ranges rather than re-serialising. This preserves file-header comments and any non-IgnoredVulns tables verbatim.
- **YAML writer strategy.** `yaml`'s `parseDocument` returns a Document whose `toString()` emits YAML that is textually close to the input (comments, formatting, key order). Mutating `supplyChainAccepts` items via `splice` on the underlying `YAMLSeq.items` is supported by the library's public API.
- **File snapshot discipline in BDD.** Because prune mutates fixture files in place, scenarios must snapshot `.depaudit.yml` and `osv-scanner.toml` before `depaudit scan` runs and restore them in an `After` hook. Otherwise later scenario runs (and later developer invocations of `bun run test:e2e`) see a mutated fixture and fail spuriously. The existing `writtenFiles` cleanup in `depaudit_yml_steps.ts` does not handle this because it deletes written files; prune *edits* fixture files that are tracked in git, so a deletion-based cleanup is the wrong tool.
- **Exit-code contract unchanged.** Auto-prune is a side effect. A scan with zero `new` findings still exits 0 whether or not orphans were pruned; a scan with `new` findings exits 1 whether or not orphans were pruned. Decoupling prune from the gate semantics keeps CI behaviour predictable.
- **Pre-prune findings remain in `ScanResult.findings`.** Downstream reporters should render the classification for *this* run, which is computed before prune. Prune is a housekeeping step for the *next* run.
- **Local vs. CI.** Running locally leaves the cleanup in the developer's working tree; the developer commits or discards it at their discretion. Under CI, no job commits the mutation back, so the cleanup is ephemeral — which is fine, because the next CI run is idempotent and the mutation re-runs against the same source tree. This matches PRD intent (lines 149-151).
- **Future extension: patches and comments.** If users add comments inside a `supplyChainAccepts` entry (e.g., `# reviewed by security team`), the YAML writer preserves them as part of the node's CST. A future slice that wants to annotate pruned items (e.g., "pruned by auto-prune on 2026-04-30") would need to add a change-tracking log — out of scope here.
- **PRD coverage mapping.** User Story 38 is satisfied by Task 6 (happy path) and Task 8 (BDD coverage). User Story 39 is satisfied by the guard in Task 6 (skip the supply-chain branch when `socketAvailable === false`) and Task 8's fail-open scenario.
