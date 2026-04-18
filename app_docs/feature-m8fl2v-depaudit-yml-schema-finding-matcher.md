# `.depaudit.yml` Schema, FindingMatcher, and Severity Threshold

**ADW ID:** m8fl2v-depaudit-yml-schema
**Date:** 2026-04-18
**Specification:** specs/issue-5-adw-5sllud-depaudit-yml-schema-sdlc_planner-depaudit-yml-schema-finding-matcher.md

## Overview

Introduces `.depaudit.yml` as depaudit's master config file and adds a four-way finding classification engine (`FindingMatcher`). Extends `ConfigLoader` to parse YAML, extends `Linter` to enforce all YAML schema rules, and wires both into `scanCommand` and `lintCommand`. Removes the old `findingFilter` module, which `FindingMatcher` fully supersedes.

## What Was Built

- **`src/types/depauditConfig.ts`** — New canonical types: `DepauditConfig`, `DepauditPolicy`, `CommonAndFineEntry`, `SupplyChainAccept`, `SeverityThreshold`, `FindingCategory`, `ClassifiedFinding`, `DEFAULT_DEPAUDIT_CONFIG`, `SUPPORTED_ECOSYSTEMS`, `SEVERITY_RANK`
- **`ConfigLoader` extension** — `loadDepauditConfig(repoRoot)`: parses `.depaudit.yml` with YAML `LineCounter` for line/col error reporting; returns `DEFAULT_DEPAUDIT_CONFIG` when the file is absent; throws `ConfigParseError` on malformed YAML
- **`Linter` extension** — `lintDepauditConfig(config, now?)`: pure function enforcing all PRD YAML rules (version, severity threshold enum, ecosystems enum, `maxAcceptDays` ≤ 90, `maxCommonAndFineDays` ≤ 365, expiry caps, reason length ≥ 20 chars, duplicate warnings)
- **`FindingMatcher` deep module** — `classifyFindings(findings, depauditConfig, osvConfig, now?)`: four-way classifier returning `ClassifiedFinding[]` with categories `new | accepted | whitelisted | expired-accept`
- **`ScanCommand` update** — loads and lints both configs, classifies findings via `FindingMatcher`, prints only `new` bucket to stdout; surfaces `expired-accept` findings to stderr
- **`LintCommand` update** — lints both `.depaudit.yml` and `osv-scanner.toml` in a single pass
- **`findingFilter.ts` removal** — deleted; all call sites migrated to `FindingMatcher`
- **BDD suite `@adw-5`** — `features/depaudit_yml.feature`, `features/scan_severity_threshold.feature`, `features/scan_yml_accepts.feature` with 30+ scenarios covering YAML lint rules and severity-threshold gate behaviour
- **Fixture directories** — 15+ new fixtures for threshold, malformed YAML, expiry, and accept scenarios
- **Unit tests** — `findingMatcher.test.ts` (13 cases), extended `configLoader.test.ts`, extended `linter.test.ts`

## Technical Implementation

### Files Modified

- `src/modules/configLoader.ts`: added `loadDepauditConfig`, imports `yaml` `parseDocument`/`LineCounter`/`YAMLParseError`
- `src/modules/linter.ts`: added `lintDepauditConfig` with one helper function per lint rule
- `src/commands/scanCommand.ts`: load + lint both configs; use `classifyFindings` instead of `filterAcceptedFindings`; emit `expired accept:` lines to stderr
- `src/commands/lintCommand.ts`: lint both YAML and TOML in a single run
- `package.json` / `bun.lock`: promoted `yaml` from transitive to direct dependency

### New Files

- `src/types/depauditConfig.ts`: all new types and shared constants (`SUPPORTED_ECOSYSTEMS`, `SEVERITY_RANK`, `DEFAULT_DEPAUDIT_CONFIG`)
- `src/modules/findingMatcher.ts`: `classifyFindings` — builds O(1) lookup maps then applies first-match-wins classification per finding
- `src/modules/__tests__/findingMatcher.test.ts`: 13 synthetic unit tests covering all four categories, severity threshold per level, ordering, UNKNOWN severity handling
- `src/modules/__tests__/fixtures/depaudit-yml/`: 15 fixture YAMLs (empty, valid-full, bad-version, bad-threshold, bad-ecosystems, cf/sca overcap, expired, short-reason, missing-reason, duplicate, malformed, maxdays-overcap, combined-errors)
- `features/lint_depaudit_yml.feature`, `features/scan_severity_threshold.feature`, `features/scan_yml_accepts.feature`: `@adw-5` BDD scenarios
- `features/step_definitions/depaudit_yml_steps.ts`: Cucumber step definitions for `@adw-5`

### Key Changes

- **Classification order (first-match-wins):** CVE accept → supply-chain accept → common-and-fine → severity threshold. An expired-accept always wins over a whitelisted category match to preserve intent.
- **Severity threshold applies only to the `new` bucket.** Accepted/whitelisted/expired-accept findings are always returned regardless of severity so the triage skill and auto-prune logic can consume them.
- **`UNKNOWN` severity** is below all thresholds and dropped from `new` unless an accept/whitelist rule matches.
- **Default policy** when `.depaudit.yml` is absent: `severityThreshold: medium`, `ecosystems: auto`, `maxAcceptDays: 90`, `maxCommonAndFineDays: 365`, empty registers. Existing `@adw-3`/`@adw-4` behaviour is preserved.
- **`expired-accept` stderr format:** `expired accept: <package> <version> <findingId>` — one line per finding, for future reporters to consume.

## How to Use

### `.depaudit.yml` schema

Create `.depaudit.yml` at the repo root:

```yaml
version: 1
policy:
  severityThreshold: medium   # medium | high | critical (default: medium)
  ecosystems: auto             # auto or list e.g. [npm]
  maxAcceptDays: 90            # hard ceiling for supplyChainAccepts expiry
  maxCommonAndFineDays: 365    # hard ceiling for commonAndFine expiry

commonAndFine:
  - package: lodash
    alertType: "Fs.access"
    expires: "2026-12-31"
    reason: "Category-wide suppression for internal tooling"  # optional

supplyChainAccepts:
  - package: lodash
    version: "4.17.21"
    findingId: "sca-1234"
    expires: "2026-07-01"
    reason: "Tracked upstream, no exploit vector in our usage"  # required, ≥ 20 chars
```

### Running lint

```bash
depaudit lint .           # lints both .depaudit.yml and osv-scanner.toml
```

Exit codes: `0` clean/warnings-only, `1` fatal lint errors, `2` parse error.

### Running scan

```bash
depaudit scan .           # load + lint both configs, classify findings, print new bucket
```

Exit codes: `0` no `new` or `expired-accept` findings, `1` findings present or lint fatal, `2` parse error.

## Configuration

| Field | Default | Description |
|---|---|---|
| `version` | — | Must be `1` |
| `policy.severityThreshold` | `medium` | Minimum severity to include in `new` bucket |
| `policy.ecosystems` | `auto` | `auto` or explicit list (currently only `npm` supported) |
| `policy.maxAcceptDays` | `90` | Maximum days allowed for `supplyChainAccepts` expiry |
| `policy.maxCommonAndFineDays` | `365` | Maximum days allowed for `commonAndFine` expiry |

**Environment variables:** none new; `SOCKET_API_TOKEN` and `SLACK_WEBHOOK_URL` are unchanged.

## Testing

```bash
bun test                    # unit tests (configLoader, linter, findingMatcher)
bun run test:e2e            # all BDD suites: @adw-3, @adw-4, @adw-5
bun run typecheck           # zero type errors
bun run build               # produces dist/modules/findingMatcher.js, dist/types/depauditConfig.js
```

## Notes

- `findingFilter.ts` is deleted; if upgrading from an earlier build, remove any import of `filterAcceptedFindings`.
- `yaml` (v2.x, ISC-licensed) is now a direct runtime dependency. It was already present as a transitive dep via `cucumber`; this promotes it to a semver-pinned direct dep.
- Date-relative fixture YAMLs use `{{EXPIRES_xxx}}` placeholders expanded at test time — fixtures remain date-stable across the project lifetime.
- Supply-chain findings (`source === "socket"`) are exercised via synthetic unit-test fixtures only in this slice; the Socket.dev API integration lands in a later slice.
- Schema version bumps require an explicit migration step; `version: 2` (or any non-`1` value) is a fatal lint error.
