# JsonReporter — `.depaudit/findings.json`

**ADW ID:** a093bk-jsonreporter-depaudi
**Date:** 2026-04-18
**Specification:** specs/issue-8-adw-a093bk-jsonreporter-depaudi-sdlc_planner-jsonreporter-findings-json.md

## Overview

`JsonReporter` writes the classified output of every `depaudit scan` run to `.depaudit/findings.json` — a schema-stable, deterministic JSON snapshot. The file is the contract surface for the (future) `/depaudit-triage` Claude Code skill, which reads it as a static artifact without re-running the scan.

## What Was Built

- **`src/modules/jsonReporter.ts`** — pure renderer (`renderFindingsJson`), filesystem writer (`writeFindingsFile`), `.gitignore` detector (`checkGitignore`), and warning emitter (`printGitignoreWarning`)
- **`ScanCommand` wiring** — a local `finalize(scanPath, input)` helper called at every exit point (success, lint-fail, two config-parse-fail, socket-auth-fail)
- **`Finding.fixedIn?`** — new optional field on the `Finding` type; populated by `OsvScannerAdapter` from OSV fix metadata; drives `upgrade.suggestedVersion` in the JSON output
- **Unit tests** — `src/modules/__tests__/jsonReporter.test.ts` with snapshot, writer, and gitignore-detector coverage
- **BDD feature** — `features/scan_json_reporter.feature` (`@adw-8`, 16 scenarios)
- **16 fixture repos** under `fixtures/json-*` for BDD scenarios
- **`UBIQUITOUS_LANGUAGE.md`** — new `JsonReporter` row in the Modules table

## Technical Implementation

### Files Modified

- `src/modules/jsonReporter.ts`: new deep module; four exported functions, five exported types
- `src/commands/scanCommand.ts`: imports `jsonReporter`; adds `finalize` helper; calls it at all five exit points
- `src/types/finding.ts`: adds `fixedIn?: string` (OSV fix version; absent for Socket findings)
- `src/modules/__tests__/jsonReporter.test.ts`: new Vitest suite (snapshot, writer, gitignore tests)
- `src/modules/__tests__/fixtures/jsonReporter/mixed-classifications.json`: committed schema snapshot
- `src/modules/__tests__/fixtures/jsonReporter/socket-unavailable.json`: committed fail-open snapshot
- `features/scan_json_reporter.feature`: 16 `@adw-8` BDD scenarios
- `features/step_definitions/scan_json_reporter_steps.ts`: BDD step definitions
- `fixtures/json-*/`: 16 minimal fixture repos

### Key Changes

- **Schema** (`FindingsJsonV1`): top-level `version: 1`, `scannedAt` (ISO-8601 UTC), `sourceAvailability: { osv, socket }`, `classifications: ["new","accepted","whitelisted","expired-accept"]`, `counts`, `findings[]`.
- **`upgrade` field**: present only for OSV findings with a known resolving version (`fixedIn`); omitted entirely (not `null`) for Socket findings and OSV findings with no fix.
- **`sourceAvailability.socket`** is `"unavailable"` whenever Socket was fail-open (5xx, timeout, auth error); `osv` is always `"available"` in this slice (OSV aborts the run on error).
- **Deterministic sort**: `findings[]` sorted by `(classification, ecosystem, package, version, findingId, manifestPath)` so successive scans on an unchanged tree produce a byte-identical file.
- **`.gitignore` check**: after writing, `ScanCommand` warns to stderr if `.depaudit/findings.json` is not gitignored — never mutates `.gitignore`.

## How to Use

1. Run `depaudit scan <path>` (or `depaudit scan .`).
2. Find `.depaudit/findings.json` in the scanned directory.
3. Parse the JSON to inspect findings by classification, source, and severity.

```jsonc
// .depaudit/findings.json (abridged)
{
  "version": 1,
  "scannedAt": "2026-04-18T12:00:00.000Z",
  "sourceAvailability": { "osv": "available", "socket": "available" },
  "classifications": ["new", "accepted", "whitelisted", "expired-accept"],
  "counts": { "new": 1, "accepted": 0, "whitelisted": 0, "expired-accept": 0 },
  "findings": [
    {
      "package": "lodash",
      "version": "4.17.11",
      "ecosystem": "npm",
      "manifestPath": "package-lock.json",
      "findingId": "GHSA-p6mc-m468-83gw",
      "severity": "high",
      "summary": "Prototype Pollution in lodash",
      "classification": "new",
      "source": "osv",
      "upgrade": { "suggestedVersion": "4.17.21" }
    }
  ]
}
```

## Configuration

No new environment variables. Existing variables continue to apply:

| Variable | Purpose |
|---|---|
| `SOCKET_API_TOKEN` | Socket.dev API key; controls `sourceAvailability.socket` |

The file is always written to `<scanPath>/.depaudit/findings.json`. Ensure `.depaudit/` (or `.depaudit/findings.json`) is listed in `<scanPath>/.gitignore`; run `depaudit setup` to add it automatically.

## Testing

```sh
bun test                                          # unit + snapshot tests
bun run test:e2e -- --tags "@adw-8"               # BDD scenarios (16)
bun run test:e2e -- --tags "@regression"          # full regression suite
```

Snapshot fixtures committed at `src/modules/__tests__/fixtures/jsonReporter/`.

## Notes

- **Early-exit paths write an empty-findings file** so downstream tooling can always rely on the file existing — a missing file means the scan never ran at all.
- **`version: 1`** is the schema contract field; a future breaking schema change must bump it.
- **`upgrade` key is omitted, not `null`**, when no resolving version is known — downstream consumers should use `"upgrade" in finding` to detect presence.
- **Warning goes to stderr** (not stdout) to keep it separate from finding lines; exit code is never changed by the warning.
- **Only the root `.gitignore` is read**; nested `.gitignore` files are not walked (same limitation as `ManifestDiscoverer`).
