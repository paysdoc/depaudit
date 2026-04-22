# JsonReporter → .depaudit/findings.json

**ADW ID:** 2rdowb-jsonreporter-depaudi
**Date:** 2026-04-22
**Specification:** specs/issue-8-adw-2rdowb-jsonreporter-depaudi-sdlc_planner-json-reporter-findings-output.md

## Overview

`depaudit scan` now writes a structured `.depaudit/findings.json` artifact after every run that reaches classification. The file is the canonical handoff point between `scan` (which generates) and `/depaudit-triage` (which consumes). It carries one entry per classified finding with a stable schema, per-source availability flags, and a `schemaVersion` pin for forward-compatibility.

A gitignore sanity check runs alongside the write: if `.depaudit/findings.json` isn't covered by the scan-root `.gitignore`, `JsonReporter` emits a single warning line to stdout — no fatal, no auto-edit.

## What Was Built

- `src/types/findingsJson.ts` — `FindingsJsonSchema`, `FindingsJsonEntry`, `SourceAvailability`, `CURRENT_SCHEMA_VERSION = 1`
- `src/modules/jsonReporter.ts` — `writeFindingsJson(scanPath, result, options?)` + `buildFindingsJsonSchema(result)` (exported pure helper)
- `src/modules/__tests__/jsonReporter.test.ts` — 32 snapshot + unit tests covering all classification categories, both sources, sort stability, availability permutations, gitignore edge cases
- `src/modules/__tests__/fixtures/json-output/` — 6 expected-JSON fixture files: `empty`, `mixed-classifications`, `socket-unavailable`, `osv-unavailable`, `deterministic-order`, `all-categories-both-sources`
- `features/scan_json_reporter.feature` — 24 BDD scenarios tagged `@adw-8`
- `features/step_definitions/scan_json_reporter_steps.ts` — file-existence, JSON-shape, `sourceAvailability`, and gitignore-warning assertions
- 24 `fixtures/json-*/` directories — one per BDD scenario
- `src/commands/scanCommand.ts` — wired `writeFindingsJson` after classification + prune block; OSV catastrophic failure no longer returns early but continues to classification with available data
- `features/step_definitions/scan_steps.ts` — tightened `stdout contains no finding lines` to filter by finding pattern, allowing gitignore warnings to pass through
- `features/step_definitions/scan_json_reporter_steps.ts` — Before/After hooks for `@adw-8` cleanup

## Technical Implementation

### Files Modified

- `src/commands/scanCommand.ts`: added `writeFindingsJson` call after the prune block; removed early return on OSV catastrophic failure (now continues to classification and reporter with `osvAvailable: false`); exit code also reflects OSV failure
- `features/step_definitions/scan_steps.ts`: `stdout contains no finding lines` step now filters lines by `FINDING_LINE_RE` instead of asserting zero total lines — semantics-preserving, allows non-finding stdout like gitignore warnings

### Key Changes

- **`buildFindingsJsonSchema`** is a pure function: same input → byte-identical output. Sort key is `(manifestPath, source, findingId, package, version)` via `localeCompare`, deterministic tiebreaker.
- **`isFindingsJsonGitignored`** mirrors `ManifestDiscoverer`'s `.gitignore` read pattern using the `ignore` package. Gitignore semantics apply: a negation inside an ignored parent directory has no effect (the path is still covered).
- **OSV catastrophic failure path** no longer returns early. The file is written with `sourceAvailability.osv: false` so `/depaudit-triage` can reason about fail-open state. Exit code is non-zero when OSV was unavailable.
- **Pre-classification aborts** (lint error, config parse error, `SocketAuthError`) do NOT invoke the reporter — any prior `.depaudit/findings.json` is preserved.
- **`upgradeSuggestion`** is always `null` in this slice — reserved for a future upgrade-resolver slice.
- **Gitignore warning goes to stdout** (not stderr), per issue spec. The step relaxation handles this.

## How to Use

`.depaudit/findings.json` is written automatically on every `depaudit scan` run that reaches classification.

**Clean repo, properly gitignored:**
```
$ depaudit scan ./my-repo
# (no stdout output for clean repo)
# .depaudit/findings.json written with findings: []
```

**Repo without .depaudit/ in .gitignore:**
```
$ depaudit scan ./my-repo
warning: .depaudit/findings.json is not gitignored — run 'depaudit setup' or add '.depaudit/' to your .gitignore
```

**OSV catastrophic failure:**
```
$ depaudit scan ./my-repo
osv: CVE scan failed catastrophically — continuing on available data
# .depaudit/findings.json written with sourceAvailability.osv: false
# exit code non-zero
```

**Schema (schemaVersion: 1):**
```json
{
  "schemaVersion": 1,
  "sourceAvailability": { "osv": true, "socket": true },
  "findings": [
    {
      "package": "semver",
      "version": "5.7.1",
      "ecosystem": "npm",
      "manifestPath": "/abs/path/to/package-lock.json",
      "findingId": "GHSA-c2qf-rxjj-qqgw",
      "severity": "MEDIUM",
      "summary": "",
      "classification": "new",
      "source": "osv",
      "upgradeSuggestion": null
    }
  ]
}
```

## Configuration

No new configuration options. `JsonReporter` is invoked automatically on every `depaudit scan` run that reaches classification — no flags or env vars required.

- **Output path:** always `.depaudit/findings.json` relative to the scan root (non-configurable by design; deterministic path is the contract for `/depaudit-triage`).
- **Gitignore warning:** emitted to stdout (not stderr) when `.depaudit/findings.json` is not covered by `<scanRoot>/.gitignore`. Run `depaudit setup` or manually add `.depaudit/` to your `.gitignore` to suppress it.
- **Pre-classification aborts** (lint error, config parse error, `SocketAuthError`): reporter is not invoked; any prior `.depaudit/findings.json` is left untouched.

## Testing

**Unit tests** (`bun test`):
- `src/modules/__tests__/jsonReporter.test.ts` — 32 tests covering: empty findings, all four classifications, both sources, sort stability (shuffled input = sorted output), sort key correctness (manifestPath → source → findingId → package → version), all four `sourceAvailability` permutations, file write (temp dir), directory creation, overwrite semantics, byte-for-byte fixture match for 5 output shapes, gitignore detection for 7 cases

**BDD scenarios** (`bun run test:e2e -- --tags "@adw-8"`):
1. Clean scan → `findings: []`, both sources `true`
2. `.depaudit/` dir created when absent
3. Overwrite (not append) on re-run
4. New CVE entry carries all required schema fields (source: osv)
5. New Socket entry carries all required schema fields (source: socket, findingId: install-scripts)
6. `manifestPath` matches originating manifest
7. `ecosystem` matches manifest ecosystem (pip)
8–11. All four classification categories: new, accepted, whitelisted, expired-accept
12–16. `sourceAvailability` reflects run's fail-open state (socket timeout/503/429, both up, OSV catastrophic)
17–22. Gitignore warning behaviour: warn when uncovered, no warn for `.depaudit/` or `.depaudit/findings.json`, non-fatal with CVE present, no mutation of `.gitignore`, no `.gitignore` file at all
23–24. Polyglot (npm+pip) and mixed-sources (osv+socket) round-trip into one JSON

## Notes

- **No new runtime dependencies**: `ignore` was already a direct dep via `ManifestDiscoverer`.
- **`schemaVersion: 1`** is hard-coded. Future bumps require an explicit code change and migration note.
- **Gitignore check is scoped to `<scanPath>/.gitignore`** only. Ancestor `.gitignore` files are not consulted — if scanning a subdirectory, a spurious warning may fire. Acceptable for MVP.
- **Stdout vs stderr for the warning**: the issue explicitly specifies stdout. Other metadata lines go to stderr. This slice follows the issue literally.
- **OSV stderr message**: changed from "scan aborted" to "continuing on available data" since the scan no longer aborts — it continues with available Socket findings and writes the JSON.
- **`expired-accept` via timing trick**: the `json-class-expired` scenario writes an `ignoreUntil` ISO timestamp 2 seconds in the future. The linter sees it as valid (future date); the OSV scan takes 3–5 seconds; FindingMatcher then sees it as expired. This is timing-sensitive but reliable in practice given the OSV scan latency.
