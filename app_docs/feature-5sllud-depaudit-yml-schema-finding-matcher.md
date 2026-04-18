# `.depaudit.yml` Schema, FindingMatcher, and Severity Threshold

**ADW ID:** 5sllud-depaudit-yml-schema
**Date:** 2026-04-18
**Specification:** specs/issue-5-adw-5sllud-depaudit-yml-schema-sdlc_planner-depaudit-yml-schema-finding-matcher.md

## Overview

Introduces `.depaudit.yml` as the master per-repo config file for depaudit, adds a `FindingMatcher` module that classifies every finding into one of four categories (`new`, `accepted`, `whitelisted`, `expired-accept`), and wires a configurable severity threshold (`medium` / `high` / `critical`) into the scan gate. Replaces the one-dimensional `findingFilter` with a unified classification engine that all future consumers (reporter, triage skill, auto-prune) can build on.

## What Was Built

- `src/types/depauditConfig.ts` — new canonical types: `DepauditConfig`, `DepauditPolicy`, `CommonAndFineEntry`, `SupplyChainAccept`, `SeverityThreshold`, `FindingCategory`, `ClassifiedFinding`, `DEFAULT_DEPAUDIT_CONFIG`, `SUPPORTED_ECOSYSTEMS`, `SEVERITY_RANK`
- `src/modules/configLoader.ts` — extended with `loadDepauditConfig(repoRoot)`: parses `.depaudit.yml` via the `yaml` library with `LineCounter` for per-node source positions; returns defaults on `ENOENT`; throws `ConfigParseError` with line/col on parse failure
- `src/modules/linter.ts` — extended with `lintDepauditConfig(config, now?)`: enforces all PRD YAML rules (schema version, threshold enum, ecosystems enum, maxAcceptDays ≤ 90, maxCommonAndFineDays ≤ 365, 90/365-day expiry caps, not-in-past, reason ≥ 20 chars, duplicate warnings)
- `src/modules/findingMatcher.ts` — new deep module implementing `classifyFindings(findings, depauditConfig, osvConfig, now?)` with first-match-wins ordering: CVE accept → supply-chain accept → common-and-fine whitelist → severity-threshold gate
- `src/commands/scanCommand.ts` — updated to load and lint both configs, call `classifyFindings`, print `new` bucket to stdout, emit `expired accept:` lines to stderr
- `src/commands/lintCommand.ts` — updated to lint both `.depaudit.yml` and `osv-scanner.toml` in a single pass
- `src/modules/findingFilter.ts` — deleted; subsumed by `FindingMatcher`
- BDD feature `features/lint_depaudit_yml.feature` + `features/scan_severity_threshold.feature` + `features/scan_yml_accepts.feature` (`@adw-5`) with step definitions in `features/step_definitions/depaudit_yml_steps.ts`
- 30+ test fixture directories under `fixtures/` and 16 YAML unit-test fixtures under `src/modules/__tests__/fixtures/depaudit-yml/`

## Technical Implementation

### Files Modified

- `src/types/depauditConfig.ts`: new file — all `.depaudit.yml` types, constants, and defaults
- `src/modules/findingMatcher.ts`: new file — four-way classifier, O(1) per-finding lookup tables, severity threshold applied only to the `new` bucket
- `src/modules/configLoader.ts`: added `loadDepauditConfig`; YAML parsed with `parseDocument` + `LineCounter`; entries carry `sourceLine` from AST range positions
- `src/modules/linter.ts`: added `lintDepauditConfig`; one helper function per rule; pure, date-injectable
- `src/commands/scanCommand.ts`: replaced `filterAcceptedFindings` with `classifyFindings`; dual-config load/lint; expired-accept stderr surface
- `src/commands/lintCommand.ts`: dual-config load/lint; combined exit code
- `src/modules/findingFilter.ts`: deleted
- `src/modules/__tests__/findingFilter.test.ts`: deleted; coverage migrated to `findingMatcher.test.ts`
- `src/modules/__tests__/findingMatcher.test.ts`: new — 13 unit tests covering all four categories, severity-threshold behaviour per threshold value, first-match-wins ordering, UNKNOWN severity, and order preservation
- `src/modules/__tests__/configLoader.test.ts`: extended with `describe("loadDepauditConfig")` — absent file, empty, full, malformed, partial, shape tests
- `src/modules/__tests__/linter.test.ts`: extended with `describe("lintDepauditConfig")` — one test per PRD rule plus boundary cases

### Key Changes

- **Four-way classification** (`new | accepted | whitelisted | expired-accept`) replaces the boolean `filterAcceptedFindings`. All four categories are always surfaced; only `new` and `expired-accept` contribute to a non-zero exit code.
- **First-match-wins ordering**: CVE accept (from `osv-scanner.toml`) wins over supply-chain accept, which wins over `commonAndFine`, which wins over the severity-threshold gate. An expired-but-accepted finding stays `expired-accept` even if a `commonAndFine` rule also matches.
- **Severity threshold filters `new` only**: `accepted`, `whitelisted`, and `expired-accept` findings are always returned regardless of severity so downstream reporters and the triage skill see them. UNKNOWN severity is treated as below all thresholds.
- **Expired-accept stderr format**: `expired accept: <package> <version> <findingId>` — one line per finding, designed for future reporters to parse.
- **Source-line tracking**: each `commonAndFine` and `supplyChainAccepts` entry in the parsed config carries a `sourceLine` derived from the YAML AST, enabling precise lint messages and future editor integrations.

## How to Use

### `.depaudit.yml` schema

Create `.depaudit.yml` at the repo root:

```yaml
version: 1
policy:
  severityThreshold: medium   # medium | high | critical (default: medium)
  ecosystems: auto            # auto | [npm] (default: auto)
  maxAcceptDays: 90           # hard ceiling enforced by linter
  maxCommonAndFineDays: 365   # hard ceiling enforced by linter

commonAndFine:
  - package: lodash
    alertType: envVars
    expires: "2026-10-01"
    reason: "Known false-positive in CI environment"  # optional

supplyChainAccepts:
  - package: some-pkg
    version: "1.2.3"
    findingId: "installScripts"
    expires: "2026-07-01"
    reason: "Reviewed by security team on 2026-04-18; install script is benign"  # required, ≥ 20 chars
    upstreamIssue: "https://github.com/org/repo/issues/42"  # optional
```

Absent `.depaudit.yml` is valid — defaults apply (`severityThreshold: medium`, `ecosystems: auto`, empty registers).

### Running lint

```sh
depaudit lint [path]
```

Lints both `.depaudit.yml` and `osv-scanner.toml`. Exit `0` on clean or warnings-only; `1` on any fatal error; `2` on parse error.

### Running scan

```sh
depaudit scan [path]
```

Loads both configs, lints both (aborts on fatal), runs OSV Scanner, classifies findings via `FindingMatcher`, and prints the `new` bucket to stdout. Expired accepts appear on stderr. Exit `0` if `new` and `expired-accept` buckets are both empty; `1` otherwise; `2` on config parse error.

## Configuration

| Field | Default | Valid values | Hard ceiling |
|---|---|---|---|
| `policy.severityThreshold` | `medium` | `medium`, `high`, `critical` | — |
| `policy.ecosystems` | `auto` | `auto`, `["npm"]` | — |
| `policy.maxAcceptDays` | `90` | positive integer | 90 |
| `policy.maxCommonAndFineDays` | `365` | positive integer | 365 |
| `supplyChainAccepts[].expires` | — | ISO-8601 date | today + 90 days |
| `supplyChainAccepts[].reason` | — | string | — (min 20 chars) |
| `commonAndFine[].expires` | — | ISO-8601 date | today + 365 days |

## Testing

```sh
bun test                         # unit tests (configLoader, linter, findingMatcher)
bun run test:e2e                 # BDD scenarios @adw-3, @adw-4, @adw-5
bun run typecheck                # zero type errors
bun run build                    # produces dist/modules/findingMatcher.js, dist/types/depauditConfig.js
```

The `@adw-5` BDD suite covers: clean `.depaudit.yml`, missing file treated as clean, malformed YAML with line/col, bad schema version, invalid `severityThreshold`, `commonAndFine` 365-day cap, `supplyChainAccepts` 90-day cap, severity-threshold-high drops MEDIUM finding, severity-threshold-medium keeps MEDIUM finding.

## Notes

- **`findingFilter.ts` removed**: `FindingMatcher` fully subsumes it. No deprecation period — the codebase is pre-release and there is only one call site.
- **Severity threshold semantics**: `≥` (not `>`). A `MEDIUM` finding under `severityThreshold: medium` is kept as `new`. UNKNOWN is treated as below all thresholds and dropped.
- **`yaml` library**: added as a direct runtime dependency (`bun add yaml`). Already present as a transitive dev-dep via Cucumber; promoted to `dependencies` for explicit semver pinning. Its `parseDocument` + `LineCounter` APIs provide both parse-error line/col and per-node AST positions for `sourceLine` on register entries.
- **Deferred**: Socket.dev API integration (supply-chain findings are exercised only via synthetic unit-test fixtures in this slice), orphan auto-prune, `MarkdownReporter` / `SlackReporter`, `.depaudit/findings.json` persistence, `depaudit setup`, ecosystem expansion beyond `npm`.
