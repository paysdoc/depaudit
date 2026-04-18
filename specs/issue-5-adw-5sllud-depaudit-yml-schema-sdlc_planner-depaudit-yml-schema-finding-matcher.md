# Feature: `.depaudit.yml` Schema + FindingMatcher + Severity Threshold

## Metadata
issueNumber: `5`
adwId: `5sllud-depaudit-yml-schema`
issueJson: `{"number":5,"title":".depaudit.yml schema + FindingMatcher + severity threshold","body":"## Parent PRD\n\n`specs/prd/depaudit.md`\n\n## What to build\n\nIntroduces `.depaudit.yml` as the master config. Schema includes `version`, `policy` (with `severityThreshold` defaulting to `medium`, `ecosystems`, `maxAcceptDays`, `maxCommonAndFineDays`), `commonAndFine` (category whitelist with 365-day cap), and `supplyChainAccepts` (stub for now; filled in #5). `FindingMatcher` classifies each finding as `new`, `accepted`, `whitelisted`, or `expired-accept` against the loaded config, applying the severity threshold as a filter.\n\nExtends `ConfigLoader` to parse YAML alongside TOML and extends `Linter` to enforce the YAML schema (all rules from PRD, including the 365-day cap on `commonAndFine`).\n\n## Acceptance criteria\n\n- [ ] YAML schema for `.depaudit.yml` matches PRD exactly (version, policy, commonAndFine, supplyChainAccepts).\n- [ ] `severityThreshold` default is `medium`; enum validation allows `medium` / `high` / `critical`.\n- [ ] `FindingMatcher` returns a four-way classification.\n- [ ] Severity threshold drops findings below the configured level from the \"new\" bucket.\n- [ ] `Linter` enforces all YAML rules (90d, 365d, enums, reason length, duplicates).\n- [ ] Unit tests for `FindingMatcher` (synthetic findings + accepts) and extended `Linter`.\n\n## Blocked by\n\n- Blocked by #4\n\n## User stories addressed\n\n- User story 33\n","state":"OPEN","author":"paysdoc","labels":[],"createdAt":"2026-04-17T13:24:37Z","comments":[],"actionableComment":null}`

## Feature Description

Layers the second half of the Acceptance Register machinery onto the CLI. Issue #4 landed the `osv-scanner.toml`/CVE-accept path with `ConfigLoader`, `Linter`, and a tiny `findingFilter`. This slice introduces `.depaudit.yml` — depaudit's master config — and the richer four-way classification engine the PRD calls for.

Concretely it adds three things:

1. **`.depaudit.yml` schema + parser.** A new YAML file format carrying `version`, `policy` (with `severityThreshold`, `ecosystems`, `maxAcceptDays`, `maxCommonAndFineDays`), `commonAndFine` (category-wide whitelist, 365-day cap), and `supplyChainAccepts` (per-finding acceptance, 90-day cap). `ConfigLoader` grows a `loadDepauditConfig(repoRoot)` function that parses the YAML with line/col error reporting (via the `yaml` library's `LineCounter`) and normalises the result into a typed `DepauditConfig`. Absence is valid — fresh repos use the default policy (severity threshold `medium`, ecosystems `auto`, empty whitelists).
2. **Extended `Linter`.** A `lintDepauditConfig(config, now?)` function enforces every PRD Linter rule applicable to YAML: schema `version` must equal `1`; `severityThreshold` must be one of `medium`/`high`/`critical`; `ecosystems` must be `auto` or a list of supported strings; `maxAcceptDays` ≤ 90; `maxCommonAndFineDays` ≤ 365; `commonAndFine[].expires` ≤ today + 365d and not in past; `supplyChainAccepts[].expires` ≤ today + 90d and not in past; `supplyChainAccepts[].reason` ≥ 20 chars; duplicate `(package, version, findingId)` entries emit warnings. The function is pure and date-injectable, matching the existing `lintOsvScannerConfig` contract.
3. **`FindingMatcher`.** A new deep module implementing `classifyFindings(findings, depauditConfig, osvConfig, now?)` — the canonical classifier the PRD describes. Outputs `{ finding, category }[]` where category is one of `new | accepted | whitelisted | expired-accept`. Matches CVE findings against `osv-scanner.toml`'s `[[IgnoredVulns]]`; supply-chain findings against `.depaudit.yml`'s `supplyChainAccepts` (by `(package, version, findingId)` identity); both against `commonAndFine` (by `(package, alertType)` pair, category-wide regardless of version); applies the severity threshold to drop below-threshold findings **from the `new` bucket only** — accepted/whitelisted/expired-accept are always surfaced regardless of severity so the future triage skill and auto-prune logic can see them.

`ScanCommand` is updated to load both configs, lint both, and use `FindingMatcher` instead of the inline `filterAcceptedFindings` step. `depaudit lint` is updated to lint both files in a single run. Exit code semantics stay consistent: lint fatal → `1`; parse error → `2`; scan exits `1` if any `new` or `expired-accept` findings are present after classification, `0` otherwise.

## User Story

As a maintainer (PRD user story 33)
I want to configure the severity threshold per repository (`medium`, `high`, or `critical`, defaulting to `medium`) in `.depaudit.yml`, and have `depaudit` classify every finding into `new`/`accepted`/`whitelisted`/`expired-accept` against the full Acceptance Register (CVE accepts + supply-chain accepts + common-and-fine whitelist)
So that I can apply stricter gating to high-risk repositories and looser gating where the cost of a blocked PR outweighs low-severity risk — and so that the classification layer is unified enough that the future `/depaudit-triage` skill, PR-comment reporter, and auto-prune logic can all consume the same `ClassifiedFinding[]` output.

## Problem Statement

Issue #4's pipeline reads `osv-scanner.toml` only, filters accepted CVEs with a one-line `findingFilter`, and has no notion of `.depaudit.yml`, supply-chain accepts, category-wide whitelisting, or severity thresholds. The `FindingMatcher` module the PRD names in its Modules section does not exist. Specifically, the current code cannot:

1. Parse or validate `.depaudit.yml` — so the PRD's `policy`, `commonAndFine`, and `supplyChainAccepts` fields have no representation in the codebase.
2. Enforce the 365-day cap on `commonAndFine` entries, the 90-day cap on `supplyChainAccepts`, or the `severityThreshold` / `ecosystems` enums — all PRD Linter rules that are currently silently unimplemented.
3. Classify findings into the four PRD categories (`new`, `accepted`, `whitelisted`, `expired-accept`) — the current "accepted" concept is a boolean (suppressed or not) with no distinction for expired acceptances or whitelisted categories.
4. Apply a configurable severity threshold — every finding is surfaced regardless of severity, which (per user story 33) does not match the need of maintainers who want to gate only `high`/`critical` on some repos.

Without these pieces, every upstream consumer the PRD describes (Socket.dev integration, `commonAndFine` category suppression, the triage skill's "expired-accept" surface, the PR-comment reporter's per-category sections, the auto-prune step's "`expired-accept` but still-matching" detection) has no foundation to build on. The shape of the `FindingMatcher` is also the shape of the scan's "what counts as a failure" contract — defining it explicitly unblocks every subsequent slice.

## Solution Statement

Introduce one new deep module, extend two existing ones, and update two composition roots:

- **New `DepauditConfig` types** (`src/types/depauditConfig.ts`) — `DepauditConfig`, `DepauditPolicy`, `CommonAndFineEntry`, `SupplyChainAccept`, `SeverityThreshold`, `FindingCategory = "new" | "accepted" | "whitelisted" | "expired-accept"`, `ClassifiedFinding = { finding: Finding; category: FindingCategory }`. Defaults for an absent `.depaudit.yml`: `{ version: 1, policy: { severityThreshold: "medium", ecosystems: "auto", maxAcceptDays: 90, maxCommonAndFineDays: 365 }, commonAndFine: [], supplyChainAccepts: [], filePath: null }`.
- **`ConfigLoader` extension** (`src/modules/configLoader.ts`) — add `async function loadDepauditConfig(repoRoot: string): Promise<DepauditConfig>`. Reads `.depaudit.yml` via `fs/promises.readFile`; returns the default config on `ENOENT`. Parses with `yaml`'s `parseDocument(raw, { lineCounter: new LineCounter() })` so line/col is available for both parse errors and downstream Linter messages. Surfaces parse errors as `ConfigParseError` (reusing the existing class from issue #4). Normalises `policy.severityThreshold` to lowercase string; normalises `policy.ecosystems` to either the literal `"auto"` or a string array; leaves `commonAndFine` and `supplyChainAccepts` as typed arrays (empty arrays if fields are absent). Each entry in those arrays carries a `sourceLine` pulled from the parsed document's AST node ranges via the `LineCounter`, mirroring the existing `IgnoredVuln.sourceLine` pattern.
- **`Linter` extension** (`src/modules/linter.ts`) — add `function lintDepauditConfig(config: DepauditConfig, now?: Date): LintResult`. Enforces, one well-named local helper per rule:
  1. `version` must equal `1` (schema version mismatch → error with migration-guidance hint).
  2. `policy.severityThreshold` must be in `{"medium", "high", "critical"}` (enum error).
  3. `policy.ecosystems` must be `"auto"` or a string array with values drawn from the supported-ecosystem allowlist (currently `{"npm"}`; list lives in the types module as a constant so future slices can extend it).
  4. `policy.maxAcceptDays` must be a positive integer ≤ 90.
  5. `policy.maxCommonAndFineDays` must be a positive integer ≤ 365.
  6. Each `commonAndFine[]` entry's `expires` must parse as ISO-8601, not be in the past, and be ≤ today + 365 days. `reason` is optional (per PRD), but if present must be a string.
  7. Each `supplyChainAccepts[]` entry's `expires` must parse as ISO-8601, not be in the past, and be ≤ today + 90 days. `reason` is required and ≥ 20 chars. `package`, `version`, `findingId` are required non-empty strings.
  8. Duplicate `(package, version, findingId)` across `supplyChainAccepts` produces a warning (one per duplicate, not fatal) — same pattern as the existing `IgnoredVulns` duplicate rule.
  9. Duplicate `(package, alertType)` across `commonAndFine` produces a warning.
  Pure function, no I/O, deterministic under injected `now`.
- **New `FindingMatcher` deep module** (`src/modules/findingMatcher.ts`) — exports:
  ```ts
  function classifyFindings(
    findings: Finding[],
    depauditConfig: DepauditConfig,
    osvConfig: OsvScannerConfig,
    now?: Date
  ): ClassifiedFinding[];
  ```
  Classification rules (first match wins, in this order — so an accepted-but-expired CVE is `expired-accept`, not `whitelisted`, even if a `commonAndFine` rule also matches):
  1. **CVE finding** (`source === "osv"`) whose `findingId` matches an `IgnoredVulns[].id` in `osvConfig`:
     - If that entry's `ignoreUntil` is ≥ `now` → `accepted`.
     - If `ignoreUntil` is past `now` → `expired-accept`.
  2. **Supply-chain finding** (`source === "socket"`) whose `(package, version, findingId)` matches a `supplyChainAccepts[]` entry:
     - If `expires` ≥ `now` → `accepted`.
     - If `expires` is past → `expired-accept`.
  3. **Any finding** whose `(package, findingId)` matches a `commonAndFine[]` entry's `(package, alertType)` and that entry is non-expired → `whitelisted`.
  4. Otherwise, apply the severity threshold: if `finding.severity` (normalised to `UNKNOWN | LOW | MEDIUM | HIGH | CRITICAL`) meets or exceeds `policy.severityThreshold` (with `UNKNOWN` treated as below-all-thresholds per the PRD's "above the severity threshold" language, and `LOW` always below `medium`) → `new`. Otherwise → drop (not returned at all).
  Pure function. Returns findings in the same order as input (modulo drops). Each returned `ClassifiedFinding` includes the original `Finding` plus its category for downstream reporters, auto-prune detectors, and the triage skill.
- **`ScanCommand` update** (`src/commands/scanCommand.ts`) — the pipeline becomes:
  1. `loadDepauditConfig(scanPath)` + `loadOsvScannerConfig(scanPath)`. On `ConfigParseError` from either, emit the lint-formatted parse error to stderr and exit `2`.
  2. `lintDepauditConfig(depauditConfig)` + `lintOsvScannerConfig(osvConfig)`. If either has errors, emit both results via `printLintResult`, write `"Lint failed — aborting scan"` to stderr, exit `1`. If either has warnings only, print them and continue.
  3. `discoverManifests(scanPath)` → `runOsvScanner(manifests)` — unchanged.
  4. `classifyFindings(findings, depauditConfig, osvConfig)` → `ClassifiedFinding[]`.
  5. For the MVP, stdout continues to show only the `new` findings (the external contract covered by existing BDD scenarios). Exit code is `1` if any `new` or `expired-accept` category findings exist, `0` otherwise. Keeping the stdout filter to `new` preserves behaviour expected by the `@adw-3` and `@adw-4` BDD suites; the `expired-accept` surface lives in stderr as a dedicated section (format: `expired accept: <package> <version> <findingId>`) so future reporters can pick it up without us having to re-design stdout now.
- **`LintCommand` update** (`src/commands/lintCommand.ts`) — path/existence check stays. Then load both configs (catch `ConfigParseError` from either, exit `2`), lint both, print combined results, exit `0` on clean or warnings-only / `1` on any fatal.
- **`findingFilter.ts` removal** — `FindingMatcher` subsumes the concern. The three call-sites currently using `filterAcceptedFindings` collapse into the new classifier; the existing `findingFilter.test.ts` migrates into a broader `findingMatcher.test.ts` covering the four categories. This keeps the codebase small (YAGNI) and avoids a deprecation-in-place phase. `findingFilter.ts` and its test file are deleted.

YAML parsing uses the `yaml` library (v2.x; already present as a transitive devDep via `cucumber`). The library's `YAMLParseError` exposes `linePos` and a `LineCounter` object lets us compute line/col for both parse failures and per-node positions (for `sourceLine` on each `commonAndFine` / `supplyChainAccepts` entry). It is ISC-licensed, dependency-free, and the most widely used YAML parser in the Node ecosystem. Added as a direct dependency via `bun add yaml` per `.adw/commands.md`.

## Relevant Files
Use these files to implement the feature:

- `README.md` — Always include; project overview and status. Needs a mention of `.depaudit.yml` in the "Config files" mini-table that issue #4 added.
- `specs/prd/depaudit.md` — Authoritative source for the `.depaudit.yml` schema (section "In-repo artifacts"), the full Linter rule list, the `FindingMatcher` module contract (Modules section), and the four-way classification categories (Modules section). User story 33 anchors the severity-threshold feature.
- `UBIQUITOUS_LANGUAGE.md` — Canonical terms: **Acceptance**, **Acceptance Register**, **Common-and-fine entry**, **Expiry**, **Severity threshold**, **`.depaudit.yml`**, **`ConfigLoader`**, **`Linter`**, **`FindingMatcher`**. New code/comments must use these; avoid "whitelist" except when referring to `commonAndFine` specifically.
- `.adw/project.md` — Deep-module layout (`src/commands/`, `src/modules/`, `src/modules/__tests__/`), runtime stack (Bun, TypeScript strict, Vitest, ESM `.js` imports).
- `.adw/commands.md` — Validation commands. Library install syntax: `bun add {library}`.
- `.adw/review_proof.md` — Rule 6: "For changes to `Linter`, `FindingMatcher`, or `ConfigLoader`: confirm fixture-driven unit tests cover all new rules or branches." Directly mandates unit-test coverage for this slice's modules.
- `.adw/conditional_docs.md` — Confirms `specs/prd/depaudit.md` and the issue-#4 `app_docs/` note should be consulted for module-boundary work.
- `app_docs/feature-oowire-configloader-linter-cve-ignores.md` — Documents the existing `ConfigLoader`, `Linter`, `FindingFilter`, and `LintCommand`; this slice extends `ConfigLoader` and `Linter`, removes `FindingFilter`, and updates `LintCommand` — all backwards-compatible at the CLI boundary.
- `features/scan.feature` — `@adw-3` scenarios. Must continue to pass unchanged; severity-threshold filtering only activates when a `.depaudit.yml` exists, and existing fixtures don't commit one.
- `features/lint.feature` — `@adw-4` scenarios. Must continue to pass; new `.depaudit.yml`-focused scenarios are added under `@adw-5` rather than mutating these.
- `features/scan_accepts.feature` — `@adw-4` scenarios. Must continue to pass; same rationale.
- `features/step_definitions/scan_steps.ts`, `features/step_definitions/lint_steps.ts`, `features/step_definitions/scan_accepts_steps.ts` — Existing Cucumber step definitions. The new `@adw-5` suite adds `depaudit_yml_steps.ts`; shared steps (exit codes, stderr substrings, `I run "…"`) are reused from `scan_steps.ts`.
- `features/support/world.ts` — `DepauditWorld`, `PROJECT_ROOT`, `CLI_PATH`, `writtenFiles` cleanup. Reused unchanged.
- `src/cli.ts` — Existing entry. No change required — `scan` and `lint` both just dispatch to their composition roots; the new behaviour is purely inside those composition roots.
- `src/commands/scanCommand.ts` — Update to load both configs, lint both, and use `classifyFindings` in place of `filterAcceptedFindings`.
- `src/commands/lintCommand.ts` — Update to lint both TOML and YAML in one pass.
- `src/modules/configLoader.ts` — Extend with `loadDepauditConfig`.
- `src/modules/linter.ts` — Extend with `lintDepauditConfig`.
- `src/modules/findingFilter.ts` — Delete. Subsumed by `FindingMatcher`.
- `src/modules/__tests__/findingFilter.test.ts` — Delete. Coverage migrates into `findingMatcher.test.ts`.
- `src/modules/__tests__/configLoader.test.ts` — Add `describe("loadDepauditConfig")` alongside the existing TOML tests.
- `src/modules/__tests__/linter.test.ts` — Add `describe("lintDepauditConfig")` alongside the existing TOML tests.
- `src/modules/lintReporter.ts` — Unchanged; already file-path-agnostic, so it prints YAML lint messages with the same format.
- `src/modules/manifestDiscoverer.ts` — Unchanged reference for the "deep module with async function export" pattern.
- `src/modules/osvScannerAdapter.ts` — Unchanged reference for the `Finding` shape; `FindingMatcher` consumes its output.
- `src/modules/stdoutReporter.ts` — Unchanged reference for the "tiny formatter" pattern the `expired-accept` stderr writer follows.
- `src/types/finding.ts` — Existing. `FindingMatcher` uses `Finding.source`, `Finding.package`, `Finding.version`, `Finding.findingId`, `Finding.severity`. No schema change required.
- `src/types/osvScannerConfig.ts` — Existing. Reused unchanged; `FindingMatcher` reads `IgnoredVulns[]` from it.
- `package.json` — Add `yaml` to `dependencies` via `bun add yaml`.
- `bun.lock` — Updated by the `bun add` step.
- `tsconfig.json` — Unchanged.

### New Files

- `src/types/depauditConfig.ts` — Exports `DepauditConfig`, `DepauditPolicy`, `CommonAndFineEntry`, `SupplyChainAccept`, `SeverityThreshold`, `FindingCategory`, `ClassifiedFinding`, and the `SUPPORTED_ECOSYSTEMS` / `SEVERITY_RANK` constants the Linter and FindingMatcher read.
- `src/modules/findingMatcher.ts` — New deep module. `export function classifyFindings(findings, depauditConfig, osvConfig, now?): ClassifiedFinding[]`. Pure. `now` defaults to `new Date()`; injectable for tests.
- `src/modules/__tests__/findingMatcher.test.ts` — Vitest unit tests: one test per classification branch, plus severity-threshold and ordering assertions.
- `src/modules/__tests__/fixtures/depaudit-yml/empty.yml` — `version: 1` with default policy and empty registers. Clean.
- `src/modules/__tests__/fixtures/depaudit-yml/valid-full.yml` — All sections populated with valid entries (one `commonAndFine` under 365d, one `supplyChainAccepts` under 90d with 20+ char reason).
- `src/modules/__tests__/fixtures/depaudit-yml/bad-version.yml` — `version: 2` (unsupported; error path).
- `src/modules/__tests__/fixtures/depaudit-yml/bad-threshold.yml` — `policy.severityThreshold: low` (enum violation).
- `src/modules/__tests__/fixtures/depaudit-yml/bad-ecosystems.yml` — `policy.ecosystems: cargo` (unsupported single value).
- `src/modules/__tests__/fixtures/depaudit-yml/cf-overcap.yml` — One `commonAndFine` entry with `expires` 400 days out.
- `src/modules/__tests__/fixtures/depaudit-yml/cf-expired.yml` — One `commonAndFine` entry with `expires` in the past.
- `src/modules/__tests__/fixtures/depaudit-yml/sca-overcap.yml` — One `supplyChainAccepts` entry with `expires` 120 days out.
- `src/modules/__tests__/fixtures/depaudit-yml/sca-expired.yml` — One `supplyChainAccepts` entry with `expires` in the past.
- `src/modules/__tests__/fixtures/depaudit-yml/sca-short-reason.yml` — One `supplyChainAccepts` entry with `reason` 10 chars.
- `src/modules/__tests__/fixtures/depaudit-yml/sca-missing-reason.yml` — One `supplyChainAccepts` entry with no `reason` field.
- `src/modules/__tests__/fixtures/depaudit-yml/sca-duplicate.yml` — Two `supplyChainAccepts` entries with identical `(package, version, findingId)`.
- `src/modules/__tests__/fixtures/depaudit-yml/cf-duplicate.yml` — Two `commonAndFine` entries with identical `(package, alertType)`.
- `src/modules/__tests__/fixtures/depaudit-yml/malformed.yml` — Syntactically broken YAML (bad indent / unclosed bracket) for `ConfigParseError` line/col assertion.
- `src/modules/__tests__/fixtures/depaudit-yml/maxdays-overcap.yml` — `policy.maxAcceptDays: 120` (exceeds hard ceiling of 90).
- `src/modules/__tests__/fixtures/depaudit-yml/combined-errors.yml` — One schema error + one expired `commonAndFine` + one short-reason `supplyChainAccepts` in a single file, to assert error aggregation.
- `features/depaudit_yml.feature` — `@adw-5` BDD scenarios for `depaudit lint` on `.depaudit.yml` and for `depaudit scan` honoring `severityThreshold` + `supplyChainAccepts` + `commonAndFine`. Scenarios: clean `.depaudit.yml`, missing `.depaudit.yml` treated as clean, malformed YAML (parse error with line/col), bad `severityThreshold` value, bad `version`, `commonAndFine` 365-day cap, `supplyChainAccepts` 90-day cap + 20-char reason boundaries, duplicate-entry warning, severity threshold `high` drops a MEDIUM finding from the `new` bucket, severity threshold `medium` (default) keeps a MEDIUM finding in the `new` bucket.
- `features/step_definitions/depaudit_yml_steps.ts` — Cucumber step definitions for `@adw-5`. Materialises `.depaudit.yml` files into fixture dirs (using `writtenFiles` cleanup), with placeholders for date-relative `expires` values expanded via the same `isoDate(days)` helper used by `lint_steps.ts`. Reuses `stderr mentions …`, `the exit code is …`, and `I run "…"` steps.
- `fixtures/depaudit-yml-clean/` — Node fixture with a committed valid `.depaudit.yml` and no OSV-scanner.toml / no manifests with CVEs. Bootstrap for the clean-path scenario.
- `fixtures/depaudit-yml-bad-version/` — Node fixture with a `.depaudit.yml` that has `version: 2`.
- `fixtures/depaudit-yml-bad-threshold/` — Node fixture with `policy.severityThreshold: low`.
- `fixtures/depaudit-yml-malformed/` — Node fixture with a syntactically broken `.depaudit.yml`.
- `fixtures/depaudit-yml-cf-overcap/` — Node fixture with a `commonAndFine` entry exceeding the 365-day cap (placeholder-expanded at step-definition time).
- `fixtures/depaudit-yml-sca-overcap/` — Node fixture with a `supplyChainAccepts` entry exceeding the 90-day cap (placeholder-expanded).
- `fixtures/severity-threshold-high/` — Copy of `vulnerable-npm/` (so OSV-Scanner produces the same known finding) plus a `.depaudit.yml` setting `severityThreshold: high`. Used to assert the MEDIUM-severity `semver` finding is dropped from the `new` bucket.
- `fixtures/severity-threshold-medium/` — Copy of `vulnerable-npm/` plus a `.depaudit.yml` setting `severityThreshold: medium`. Used to assert the same MEDIUM-severity finding is kept in the `new` bucket (default behavior).

For date-relative YAML fixtures (`cf-overcap.yml`, `cf-expired.yml`, `sca-overcap.yml`, `sca-expired.yml`, `sca-duplicate.yml`, `cf-duplicate.yml`, `valid-full.yml`, `combined-errors.yml`, and the fixture-dir `depaudit-yml-cf-overcap` / `depaudit-yml-sca-overcap`), commit the YAML with `{{EXPIRES_xxx}}` placeholders (e.g. `{{EXPIRES_30D}}`, `{{EXPIRES_PAST_1D}}`, `{{EXPIRES_400D}}`, `{{EXPIRES_120D}}`) and expand at test / step-definition time into a scratch copy under `tmpdir()` (unit tests) or via `writtenFiles` cleanup (BDD steps), mirroring the issue #4 approach. This keeps committed fixtures date-stable across the project's lifetime.

## Implementation Plan

### Phase 1: Foundation

Bring the codebase to a state that can parse YAML and represent the new schema as typed data. Concretely: add `yaml` as a runtime dependency, create `src/types/depauditConfig.ts` with all new types and shared constants (`SUPPORTED_ECOSYSTEMS`, `SEVERITY_RANK`), and confirm `bun run typecheck` and `bun run build` still pass. No domain logic yet — subsequent phases layer behaviour onto these types.

### Phase 2: Core Implementation — ConfigLoader + Linter extensions

Extend `configLoader.ts` with `loadDepauditConfig` (read, ENOENT→defaults, `YAMLParseError`→`ConfigParseError`, normalise each entry with `sourceLine` from the AST). Extend `linter.ts` with `lintDepauditConfig` (one helper per rule, pure, date-injectable). Create fixture YAML files (one per rule) and write unit tests — one test per rule for the Linter, plus loader tests for the absent-file / default-policy / parse-error paths.

### Phase 3: Core Implementation — FindingMatcher

Create `src/modules/findingMatcher.ts` implementing the four-way classifier with first-match-wins ordering and severity-threshold filtering of the `new` bucket. Write `findingMatcher.test.ts` — one test per category, plus severity-threshold behaviour (`new` drops below-threshold; `accepted`/`whitelisted`/`expired-accept` always surface), plus the expired-accept-vs-whitelisted ordering test.

### Phase 4: Integration

Update `scanCommand.ts` to load both configs, lint both (abort on fatal), and use `classifyFindings` in place of `filterAcceptedFindings`. Update `lintCommand.ts` to lint both YAML and TOML in one pass. Delete `findingFilter.ts` and `findingFilter.test.ts`. Smoke-test end-to-end against the `vulnerable-npm` fixture with a temporary `.depaudit.yml` exercising `severityThreshold: high` (drops the MEDIUM finding) and `severityThreshold: medium` (keeps it).

### Phase 5: BDD Coverage

Create `fixtures/depaudit-yml-*` fixture directories and `features/depaudit_yml.feature` with `@adw-5`-tagged scenarios covering the YAML lint rules and severity-threshold gate behaviour. Add `features/step_definitions/depaudit_yml_steps.ts` with the new `Given` / `Then` steps, reusing shared assertions from `scan_steps.ts`. Run `bun run test:e2e` and confirm all `@adw-3`, `@adw-4`, and `@adw-5` scenarios pass with zero pendings.

## Step by Step Tasks
Execute every step in order, top to bottom.

### Add `yaml` runtime dependency

- Run `bun add yaml` from the worktree root. Confirm `package.json` now has `yaml` under `dependencies` (not `devDependencies`) and `bun.lock` has been updated. (It is already present as a transitive dep via `cucumber`; this step promotes it to a direct, semver-pinned dep so the runtime code does not rely on cucumber's resolution.)
- Run `bun install` to confirm the lockfile resolves cleanly.

### Create canonical types in `src/types/depauditConfig.ts`

- Create `src/types/depauditConfig.ts` exporting:
  - `type SeverityThreshold = "medium" | "high" | "critical";`
  - `interface DepauditPolicy { severityThreshold: SeverityThreshold; ecosystems: "auto" | string[]; maxAcceptDays: number; maxCommonAndFineDays: number; }`
  - `interface CommonAndFineEntry { package: string; alertType: string; expires: string; reason?: string; sourceLine?: number; }`
  - `interface SupplyChainAccept { package: string; version: string; findingId: string; expires: string; reason?: string; upstreamIssue?: string; sourceLine?: number; }`
  - `interface DepauditConfig { version: number; policy: DepauditPolicy; commonAndFine: CommonAndFineEntry[]; supplyChainAccepts: SupplyChainAccept[]; filePath: string | null; }`
  - `type FindingCategory = "new" | "accepted" | "whitelisted" | "expired-accept";`
  - `interface ClassifiedFinding { finding: Finding; category: FindingCategory; }` (imports `Finding` from `./finding.js`).
  - `const DEFAULT_DEPAUDIT_CONFIG: DepauditConfig = { version: 1, policy: { severityThreshold: "medium", ecosystems: "auto", maxAcceptDays: 90, maxCommonAndFineDays: 365 }, commonAndFine: [], supplyChainAccepts: [], filePath: null };` — returned by `loadDepauditConfig` when the file is absent.
  - `const SUPPORTED_ECOSYSTEMS = ["npm"] as const;` — referenced by the Linter's ecosystems-enum rule.
  - `const SEVERITY_RANK: Record<Severity, number> = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };` — referenced by `FindingMatcher`. `SeverityThreshold` maps to `MEDIUM/HIGH/CRITICAL` via a local helper.

### Extend `ConfigLoader` with `loadDepauditConfig`

- Modify `src/modules/configLoader.ts`:
  - Import `parseDocument`, `LineCounter`, `YAMLParseError` from `yaml`.
  - Import the new types and `DEFAULT_DEPAUDIT_CONFIG` from `../types/depauditConfig.js`.
  - Add `export async function loadDepauditConfig(repoRoot: string): Promise<DepauditConfig>`:
    1. Resolve `.depaudit.yml` relative to `repoRoot`.
    2. `readFile(..., "utf8")`. On `ENOENT`, return `{ ...DEFAULT_DEPAUDIT_CONFIG, filePath: null }`.
    3. Create a `LineCounter`, call `parseDocument(raw, { lineCounter })`. If `doc.errors.length > 0`, take the first `YAMLParseError`, extract `linePos` (or fall back to `lineCounter.linePos(pos[0])`), and throw `new ConfigParseError(absPath, line, col, message)`.
    4. On success, call `doc.toJS()` to materialise a plain-JS shape. Normalise:
       - `version`: coerce to number; default to the parsed integer or `1` if missing (the Linter enforces `version === 1`).
       - `policy`: merge over `DEFAULT_DEPAUDIT_CONFIG.policy` so unspecified fields fall through to defaults. Normalise `severityThreshold` to lowercase string; leave `ecosystems` as-is (Linter validates).
       - `commonAndFine`: for each entry, extract `package`, `alertType`, `expires` (stringify if Date), `reason`. Attach `sourceLine` using `doc.get("commonAndFine", true)` → `YAMLSeq` → `items[i].range[0]` → `lineCounter.linePos(...)`.
       - `supplyChainAccepts`: same pattern; extract `package`, `version`, `findingId`, `expires`, `reason`, `upstreamIssue`; attach `sourceLine`.
    5. Return `{ version, policy, commonAndFine, supplyChainAccepts, filePath: absPath }`.
  - Do not enforce any schema rules here — that is the `Linter`'s job.
- The existing `loadOsvScannerConfig` remains unchanged; the module now exports both loaders and the `ConfigParseError` class.

### Create `.depaudit.yml` fixtures

- Create directory `src/modules/__tests__/fixtures/depaudit-yml/`.
- Populate with the 15 fixtures listed in New Files. Concrete file contents:
  - `empty.yml`:
    ```yaml
    version: 1
    policy:
      severityThreshold: medium
      ecosystems: auto
      maxAcceptDays: 90
      maxCommonAndFineDays: 365
    commonAndFine: []
    supplyChainAccepts: []
    ```
  - `valid-full.yml` — all sections populated with one valid entry each; `expires: "{{EXPIRES_30D}}"` on supplyChainAccepts, `expires: "{{EXPIRES_60D}}"` on commonAndFine.
  - `bad-version.yml` — same as `empty.yml` but `version: 2`.
  - `bad-threshold.yml` — `policy.severityThreshold: low`.
  - `bad-ecosystems.yml` — `policy.ecosystems: cargo`.
  - `cf-overcap.yml` — one `commonAndFine` entry with `expires: "{{EXPIRES_400D}}"`.
  - `cf-expired.yml` — one `commonAndFine` entry with `expires: "{{EXPIRES_PAST_1D}}"`.
  - `sca-overcap.yml` — one `supplyChainAccepts` entry with `expires: "{{EXPIRES_120D}}"`, valid reason/package/version/findingId.
  - `sca-expired.yml` — one `supplyChainAccepts` entry with `expires: "{{EXPIRES_PAST_1D}}"`, valid everything else.
  - `sca-short-reason.yml` — one `supplyChainAccepts` entry with `reason: "too short"` (9 chars), valid `expires`.
  - `sca-missing-reason.yml` — one `supplyChainAccepts` entry with no `reason` field.
  - `sca-duplicate.yml` — two `supplyChainAccepts` entries with identical `(package, version, findingId)`, both `expires: "{{EXPIRES_30D}}"`.
  - `cf-duplicate.yml` — two `commonAndFine` entries with identical `(package, alertType)`, both `expires: "{{EXPIRES_60D}}"`.
  - `malformed.yml` — intentionally broken YAML (mismatched indent and an unclosed flow mapping) so `YAMLParseError` surfaces a line/col > 0.
  - `maxdays-overcap.yml` — `policy.maxAcceptDays: 120` (exceeds hard 90 ceiling).
  - `combined-errors.yml` — `version: 1`, `policy.severityThreshold: bogus` (enum error), one expired `commonAndFine` entry (`{{EXPIRES_PAST_1D}}`), one short-reason `supplyChainAccepts` entry (valid `expires`).

### Write `loadDepauditConfig` unit tests

- Extend `src/modules/__tests__/configLoader.test.ts` with `describe("loadDepauditConfig", () => { ... })` asserting:
  1. Absent `.depaudit.yml` at `repoRoot` → `DEFAULT_DEPAUDIT_CONFIG` (with `filePath: null`). No throw.
  2. `empty.yml` parsed → `version: 1`, `policy.severityThreshold: "medium"`, empty registers, `filePath` is the absolute path.
  3. `valid-full.yml` parsed → all sections populated, each entry has `package`/`version`/`findingId`/`expires` (for sca) and `package`/`alertType`/`expires` (for cf), plus `sourceLine` pointing at the right line number in the file.
  4. `malformed.yml` → `ConfigParseError` with `filePath`, `line > 0`, `column > 0`, and a non-empty `message`.
  5. Partial `.depaudit.yml` (e.g. only `version: 1` with no `policy` block) → defaults fill in for `policy` / `commonAndFine` / `supplyChainAccepts`. Confirms the "merge over defaults" behaviour.
  6. `sca-missing-reason.yml` → `reason` is `undefined` (not coerced); Linter is responsible for judgment.
- Fixtures with date placeholders are expanded at test setup time via the existing `daysFromNow` / `expandAndLoad` helper pattern; extend that helper to also replace `{{EXPIRES_xxx}}` tokens and write to a scratch `tmpdir()` before calling `loadDepauditConfig`.

### Extend `Linter` with `lintDepauditConfig`

- Modify `src/modules/linter.ts`:
  - Import the new types and constants from `../types/depauditConfig.js`.
  - Add `export function lintDepauditConfig(config: DepauditConfig, now: Date = new Date()): LintResult`.
  - Implementation — one well-named local helper per rule, all pushing to the outer `errors` / `warnings` arrays:
    - `checkVersion(config)` — `version === 1` or error `"schema version ${v} is not supported (expected: 1). See migration guide."` with `line: 1` (schema errors don't have per-entry positions).
    - `checkSeverityThreshold(policy)` — `["medium","high","critical"].includes(policy.severityThreshold)` or error `"policy.severityThreshold must be one of: medium, high, critical (got: '${...}')"`.
    - `checkEcosystems(policy)` — `"auto"` or an array whose every value is in `SUPPORTED_ECOSYSTEMS` or error per unsupported value.
    - `checkMaxAcceptDays(policy)` — integer, ≥ 1, ≤ 90 or error.
    - `checkMaxCommonAndFineDays(policy)` — integer, ≥ 1, ≤ 365 or error.
    - `checkCommonAndFineEntry(entry, now)` — `expires` ISO-8601 parseable, not in past, ≤ today + 365d; required `package` and `alertType`; emit errors with `line: entry.sourceLine`.
    - `checkSupplyChainEntry(entry, now)` — `expires` ISO-8601 parseable, not in past, ≤ today + 90d; required `package`/`version`/`findingId`; `reason` required, ≥ 20 chars; emit errors with `line: entry.sourceLine`.
    - `checkSupplyChainDuplicates(entries)` — group by `(package, version, findingId)`; warn per duplicate with `line: entry.sourceLine`.
    - `checkCommonAndFineDuplicates(entries)` — group by `(package, alertType)`; warn per duplicate.
  - Use messages that contain the PRD-specified substrings so BDD `stderr mentions …` steps match: `"365-day cap"`, `"90-day cap"`, `"already passed"`, `"at least 20 characters"`, `"severityThreshold"`, `"ecosystems"`, `"schema version"`, `"duplicate"`.
  - `return { errors, warnings, isClean: errors.length === 0 };`
- The function is pure: given the same `config` and `now`, it returns the same `LintResult`.

### Write `lintDepauditConfig` unit tests

- Extend `src/modules/__tests__/linter.test.ts` with `describe("lintDepauditConfig", () => { ... })` asserting, one test per rule:
  1. `empty.yml` → `isClean: true`, no errors, no warnings.
  2. `valid-full.yml` → `isClean: true`.
  3. `bad-version.yml` → one error mentioning "schema version".
  4. `bad-threshold.yml` → one error mentioning "severityThreshold".
  5. `bad-ecosystems.yml` → one error mentioning "ecosystems".
  6. `maxdays-overcap.yml` → one error mentioning "maxAcceptDays".
  7. `cf-overcap.yml` → one error mentioning "365-day cap".
  8. `cf-expired.yml` → one error mentioning "already passed".
  9. `sca-overcap.yml` → one error mentioning "90-day cap".
  10. `sca-expired.yml` → one error mentioning "already passed".
  11. `sca-short-reason.yml` → one error mentioning "20 character".
  12. `sca-missing-reason.yml` → one error mentioning "reason" (distinct from the too-short message).
  13. `sca-duplicate.yml` → one warning mentioning "duplicate"; `isClean: true` (warnings alone are not fatal).
  14. `cf-duplicate.yml` → one warning mentioning "duplicate"; `isClean: true`.
  15. `combined-errors.yml` → multiple errors; assert each target substring is present in some message.
  16. Boundary: `commonAndFine.expires` exactly today + 365 → valid. `supplyChainAccepts.expires` exactly today + 90 → valid. `reason` exactly 20 chars → valid.
- Each test uses an injected `now = new Date("2026-04-18T00:00:00.000Z")` (same as existing tests) to keep date logic deterministic.

### Implement `FindingMatcher`

- Create `src/modules/findingMatcher.ts`:
  - Import `Finding`, `Severity` from `../types/finding.js`; `OsvScannerConfig`, `IgnoredVuln` from `../types/osvScannerConfig.js`; `DepauditConfig`, `FindingCategory`, `ClassifiedFinding`, `SeverityThreshold`, `SEVERITY_RANK` from `../types/depauditConfig.js`.
  - `export function classifyFindings(findings: Finding[], depauditConfig: DepauditConfig, osvConfig: OsvScannerConfig, now: Date = new Date()): ClassifiedFinding[]`.
  - Build helper lookup tables once at the top of the function to keep the per-finding loop O(1):
    - `cveAcceptByIdMap: Map<string, IgnoredVuln[]>` keyed on `IgnoredVuln.id`.
    - `scaAcceptByKey: Map<string, SupplyChainAccept[]>` keyed on `${package}|${version}|${findingId}`.
    - `cfByPkgAlert: Map<string, CommonAndFineEntry[]>` keyed on `${package}|${alertType}`.
  - Thresholds map: `SeverityThreshold → minimum SEVERITY_RANK`:
    - `"medium" → SEVERITY_RANK.MEDIUM`
    - `"high" → SEVERITY_RANK.HIGH`
    - `"critical" → SEVERITY_RANK.CRITICAL`
  - Per-finding classification — first match wins:
    1. If `finding.source === "osv"` and a CVE accept exists for `finding.findingId`:
       - Pick the first matching `IgnoredVuln` with `ignoreUntil ≥ now` → category `accepted`.
       - Else if all matching `IgnoredVuln`s are expired → category `expired-accept`.
    2. Else if `finding.source === "socket"` and an `SupplyChainAccept` exists for the `(package, version, findingId)` tuple:
       - Non-expired → `accepted`; else `expired-accept`.
    3. Else if a `CommonAndFineEntry` exists for `(finding.package, finding.findingId)` whose `expires ≥ now` → `whitelisted`.
    4. Else apply severity threshold: if `SEVERITY_RANK[finding.severity] ≥ threshold` → `new`; else drop.
  - Return `ClassifiedFinding[]` in input order (drops produce gaps — but since findings are mutated into a new array, the result simply has fewer entries where drops occurred).
- Pure, no I/O. `now` injectable.

### Write `FindingMatcher` unit tests

- Create `src/modules/__tests__/findingMatcher.test.ts` asserting:
  1. Empty findings, any config → `[]`.
  2. OSV finding whose `findingId` matches a non-expired `IgnoredVulns.id` → one `ClassifiedFinding` with `category: "accepted"`.
  3. OSV finding whose `findingId` matches an `IgnoredVulns.id` with `ignoreUntil` in past → `category: "expired-accept"`.
  4. Socket finding whose `(package, version, findingId)` matches a non-expired `supplyChainAccepts` entry → `accepted`.
  5. Socket finding whose `(package, version, findingId)` matches an expired `supplyChainAccepts` entry → `expired-accept`.
  6. OSV/Socket finding whose `(package, findingId)` matches a non-expired `commonAndFine` entry → `whitelisted`.
  7. Ordering — an OSV finding that has BOTH an expired `IgnoredVulns` match AND a valid `commonAndFine` match → `expired-accept` (rule 1 wins, not rule 3). Asserts the first-match-wins contract.
  8. Severity threshold `medium` (default): MEDIUM-severity finding with no accepts → `new`. LOW-severity finding with no accepts → dropped (not returned).
  9. Severity threshold `high`: MEDIUM-severity finding with no accepts → dropped. HIGH-severity finding → `new`.
  10. Severity threshold `critical`: HIGH-severity finding with no accepts → dropped. CRITICAL → `new`.
  11. Severity threshold DOES NOT drop accepted/whitelisted/expired-accept findings — a LOW-severity finding that matches a `commonAndFine` rule is still returned as `whitelisted` regardless of threshold. (Guards the "only from the `new` bucket" language.)
  12. UNKNOWN severity — treated as below all thresholds; UNKNOWN findings with no accept match are dropped. (Guards against the PRD's "above the severity threshold" wording; UNKNOWN has no rank to compare to.)
  13. Order preservation — given an input `[finding-a, finding-b-dropped, finding-c]`, the output is `[classified-a, classified-c]` in that order.
- Synthetic `Finding[]` and `DepauditConfig` / `OsvScannerConfig` objects are built inline; no fixture files needed since the matcher's contract is purely logical.

### Delete `findingFilter.ts` and its tests

- Delete `src/modules/findingFilter.ts`.
- Delete `src/modules/__tests__/findingFilter.test.ts`.
- Confirm no other files reference `filterAcceptedFindings` by grepping the repo — the only reference should be `scanCommand.ts`, which will be updated in the next step.

### Update `ScanCommand` to use `FindingMatcher`

- Modify `src/commands/scanCommand.ts`:
  - Import `loadDepauditConfig` alongside `loadOsvScannerConfig` from `../modules/configLoader.js`.
  - Import `lintDepauditConfig` alongside `lintOsvScannerConfig` from `../modules/linter.js`.
  - Import `classifyFindings` from `../modules/findingMatcher.js`.
  - Remove the `filterAcceptedFindings` import.
  - New pipeline:
    1. `depauditConfig = await loadDepauditConfig(scanPath)` — catch `ConfigParseError`, emit formatted parse error, return `2`.
    2. `osvConfig = await loadOsvScannerConfig(scanPath)` — same handling.
    3. `depauditLint = lintDepauditConfig(depauditConfig)` and `osvLint = lintOsvScannerConfig(osvConfig)`.
    4. If either has errors, write `"Lint failed — aborting scan"`, call `printLintResult(depauditLint, depauditConfig.filePath ?? ".depaudit.yml")` and `printLintResult(osvLint, osvConfig.filePath ?? "osv-scanner.toml")`, return `1`.
    5. If either has warnings only, print them and continue.
    6. `manifests = await discoverManifests(scanPath)`; `findings = await runOsvScanner(manifests)`.
    7. `classified = classifyFindings(findings, depauditConfig, osvConfig)`.
    8. `newFindings = classified.filter(c => c.category === "new").map(c => c.finding)`.
    9. `printFindings(newFindings)` — existing stdout contract preserved.
    10. `expiredAccepts = classified.filter(c => c.category === "expired-accept")`. For each, write `expired accept: <package> <version> <findingId>\n` to stderr (new stderr line; future reporters can pick it up).
    11. Return `(newFindings.length === 0 && expiredAccepts.length === 0) ? 0 : 1`.
- Behaviour compatibility: existing `@adw-3` and `@adw-4` BDD scenarios should continue to pass because: (a) absent `.depaudit.yml` yields the default config (severity threshold `medium` — a MEDIUM finding would still pass through as `new`, matching prior behaviour where all findings were surfaced); (b) the MEDIUM finding from `fixtures/vulnerable-npm` stays in the `new` bucket under the default threshold; (c) the CVE-accept suppression path still works because OSV findings hitting a valid `IgnoredVulns` become `accepted` (not `new`) and drop out of stdout; (d) expired `IgnoredVulns` entries now produce `expired-accept` + a stderr line but, per the existing `@adw-4` `scan_accepts.feature` scenario "Scan aborts when lint fails on an expired ignoreUntil", the lint pre-flight catches the expired entry before classification runs — so the `expired-accept` branch is reached only for findings whose CVE has an `IgnoredVulns` entry that somehow survived linting (e.g., freshly-expired between lint and scan — edge case, intentional surface).

### Update `LintCommand` to lint both files

- Modify `src/commands/lintCommand.ts`:
  - Import `loadDepauditConfig` and `lintDepauditConfig`.
  - New pipeline (after the existing path-exists check):
    1. Load `depauditConfig` and `osvConfig` (each wrapped in a try/catch for `ConfigParseError` → exit `2`, printing a compiler-format parse-error line).
    2. `depauditLint = lintDepauditConfig(depauditConfig)`; `osvLint = lintOsvScannerConfig(osvConfig)`.
    3. `printLintResult(depauditLint, depauditConfig.filePath ?? ".depaudit.yml")`.
    4. `printLintResult(osvLint, osvConfig.filePath ?? "osv-scanner.toml")`.
    5. Return `0` if both are clean or warnings-only; `1` if either has errors.
  - Exit-code semantics preserved: `0`/`1`/`2` carry the same meanings as before.

### Smoke-test end-to-end

- From the worktree root: `bun install && bun run build`.
- Create a temporary `.depaudit.yml` inside `fixtures/vulnerable-npm/`:
  ```yaml
  version: 1
  policy:
    severityThreshold: high
    ecosystems: auto
    maxAcceptDays: 90
    maxCommonAndFineDays: 365
  commonAndFine: []
  supplyChainAccepts: []
  ```
  Run `node dist/cli.js scan fixtures/vulnerable-npm/`. The MEDIUM-severity `semver` finding should be dropped (severity threshold high); stdout empty; exit code `0`.
- Change `severityThreshold: medium` in the same file. Re-run. The finding should reappear; exit code `1`.
- Create a malformed `.depaudit.yml` (missing `:` or a stray tab). Re-run. Exit `2`; stderr contains `.depaudit.yml:<line>:<col>: error: …`.
- Delete the temporary `.depaudit.yml` to restore `fixtures/vulnerable-npm/` to its original state.

### Create `@adw-5` BDD fixtures

- Create the `fixtures/depaudit-yml-*` and `fixtures/severity-threshold-*` directories listed in New Files.
- `depaudit-yml-clean/` has a committed valid `.depaudit.yml`, an empty `package.json`, and an empty `package-lock.json` so `depaudit lint` runs standalone without needing OSV-Scanner.
- `severity-threshold-high/` and `severity-threshold-medium/` each contain a copy of `fixtures/vulnerable-npm/package.json` + `package-lock.json` (verbatim so OSV-Scanner emits the same finding) plus a `.depaudit.yml` with the respective `severityThreshold`.
- Date-relative YAML fixtures (`depaudit-yml-cf-overcap`, `depaudit-yml-sca-overcap`) use `{{EXPIRES_xxx}}` placeholders, expanded at step-definition time into a scratch copy via `writtenFiles` cleanup.

### Write `features/depaudit_yml.feature`

- Create `features/depaudit_yml.feature` tagged `@adw-5`. Scenarios:
  - `Clean .depaudit.yml exits 0` — fixture `depaudit-yml-clean`, invoke `depaudit lint …`, exit `0`.
  - `Missing .depaudit.yml is treated as clean` — fixture `clean-npm` (no `.depaudit.yml`), invoke `depaudit lint`, exit `0`.
  - `Malformed .depaudit.yml fails with parse error and line/col` — fixture `depaudit-yml-malformed`, invoke `depaudit lint`, exit non-zero, stderr mentions `.depaudit.yml` and `:<line>:<col>:`.
  - `Unsupported schema version fails lint` — fixture `depaudit-yml-bad-version`, invoke `depaudit lint`, exit non-zero, stderr mentions `schema version`.
  - `Invalid severityThreshold fails lint` — fixture `depaudit-yml-bad-threshold`, invoke `depaudit lint`, exit non-zero, stderr mentions `severityThreshold`.
  - `commonAndFine entry exceeding 365-day cap fails lint` — placeholder-expanded fixture, exit non-zero, stderr mentions `365-day cap`.
  - `supplyChainAccepts entry exceeding 90-day cap fails lint` — placeholder-expanded fixture, exit non-zero, stderr mentions `90-day cap`.
  - `severityThreshold high drops a MEDIUM-severity finding from the new bucket` — fixture `severity-threshold-high`, invoke `depaudit scan`, exit `0`, stdout contains no finding lines.
  - `severityThreshold medium (default) keeps a MEDIUM-severity finding in the new bucket` — fixture `severity-threshold-medium`, invoke `depaudit scan`, exit non-zero, stdout contains at least one finding line.

### Write `depaudit_yml_steps.ts`

- Create `features/step_definitions/depaudit_yml_steps.ts`.
- Implement `Given` steps for fixture-preparing `.depaudit.yml` variants (valid, bad-version, bad-threshold, malformed, cf-overcap, sca-overcap, severity-threshold high, severity-threshold medium). Each step writes the YAML into the fixture directory via `writeFile`, appends the path to `world.writtenFiles` for cleanup, and sets `world.fixturePath`.
- Date placeholders expand via the shared `isoDate(daysFromNow)` helper.
- Reuse all generic `Then` steps from `scan_steps.ts` (exit codes, stderr substrings, "stdout contains no finding lines", "stdout contains at least one finding line").
- Register `Then stderr mentions "365-day cap"` and similar substring assertions via the generic `stderr mentions {string}` step already registered in `lint_steps.ts` (reused, not redeclared).

### Run full validation

- Execute every command in the Validation Commands section below and confirm each exits 0.

## Testing Strategy

### Unit Tests

`.adw/project.md` lacks the `## Unit Tests: enabled` marker, but this plan includes unit-test tasks as a documented override — matching the precedent set by the issue #3 and issue #4 plans. Justification: (a) the GitHub issue's acceptance criteria explicitly require `Unit tests for FindingMatcher (synthetic findings + accepts) and extended Linter`; (b) `.adw/review_proof.md` Rule 6 mandates fixture-driven unit tests covering all new rules or branches for `Linter`, `FindingMatcher`, or `ConfigLoader` — every one of which this slice touches. Skipping would fail both the issue's acceptance bar and the PR review bar.

Concrete test suites:

- **`loadDepauditConfig` tests** (extending `src/modules/__tests__/configLoader.test.ts`) — six fixture-driven cases: absent file, empty YAML, full valid YAML, malformed YAML (parse-error line/col), partial YAML (defaults merge), missing-reason (shape only, not judgment).
- **`lintDepauditConfig` tests** (extending `src/modules/__tests__/linter.test.ts`) — one test per PRD rule: schema version, `severityThreshold` enum, `ecosystems` enum, `maxAcceptDays`, `maxCommonAndFineDays`, `commonAndFine` 365-day cap, `commonAndFine` in-past, `supplyChainAccepts` 90-day cap, `supplyChainAccepts` in-past, `supplyChainAccepts` short-reason, `supplyChainAccepts` missing-reason, `supplyChainAccepts` duplicate (warning), `commonAndFine` duplicate (warning), combined-errors aggregation, plus three boundary cases (exactly today+365, today+90, 20-char reason).
- **`FindingMatcher` tests** (`src/modules/__tests__/findingMatcher.test.ts`) — 13 cases as listed above, covering each classification branch, the severity-threshold behaviour per threshold value, the first-match-wins ordering, the "never drop accepted/whitelisted/expired-accept" invariant, and UNKNOWN-severity handling.

### BDD Scenarios (`@adw-5`)

- `features/depaudit_yml.feature` — 9 scenarios tagged `@adw-5` covering YAML lint (clean, missing, malformed, bad-version, bad-threshold, cf-overcap, sca-overcap) and severity-threshold gate behaviour (high drops MEDIUM, medium keeps MEDIUM).
- All `@adw-3`, `@adw-4`, and `@adw-5` scenarios must pass under `bun run test:e2e`.

### Edge Cases

- **Absent `.depaudit.yml`** — `loadDepauditConfig` returns `DEFAULT_DEPAUDIT_CONFIG` with `filePath: null`. `Linter` treats it as clean (defaults are always valid). `ScanCommand` behaves identically to the issue-#4 baseline. Explicitly tested.
- **Empty but valid `.depaudit.yml`** (only `version: 1`) — defaults fill in for `policy`, `commonAndFine`, `supplyChainAccepts`. Linter clean.
- **Severity boundary** — a finding with severity exactly matching `severityThreshold` (e.g., `MEDIUM` under `severityThreshold: medium`) is classified as `new` (threshold is ≥, not >). Explicit test.
- **`policy.ecosystems`** as `"auto"` vs explicit array — both valid; both exercised.
- **`commonAndFine` match** when the finding's source is Socket vs OSV — should match either way since `commonAndFine` is keyed on `(package, alertType)` not `(package, source)`. Explicit test.
- **Duplicate `supplyChainAccepts` where one is expired and one isn't** — `FindingMatcher` uses the non-expired entry (classifies as `accepted`, not `expired-accept`). The duplicate warning is emitted independently by the Linter. Explicit test.
- **`.depaudit.yml` present but `osv-scanner.toml` absent** (and vice versa) — both loaders operate independently; Linter reports on whichever configs exist. No cross-dependency between the two files.
- **`.depaudit.yml` with extra unknown fields** — tolerated (forward-compat); `ConfigLoader` ignores them, `Linter` does not flag. Future schema-version bumps are the mechanism for breaking changes.
- **UNKNOWN severity** — dropped from `new` bucket regardless of threshold (UNKNOWN < all thresholds). Acceptance/whitelist categories still surface UNKNOWN findings since the skill must still see them. Explicit test.
- **Maximum-size `maxAcceptDays`** — user can set it to any integer ≤ 90; if they set it to e.g. 30, it's their choice, but the hard ceiling of 90 is enforced by the Linter (a `maxAcceptDays: 100` is a lint error). The `supplyChainAccepts.expires` check uses the literal 90d (the hard cap), not the user-configured `maxAcceptDays` — the latter is a *policy* bound, the former is the system bound. Both are enforced.
- **YAML duplicate keys** — the `yaml` library surfaces `DUPLICATE_KEY` as a `YAMLParseError`; `ConfigLoader` surfaces it as a `ConfigParseError` with line/col. Explicit test.

## Acceptance Criteria

- `bun add yaml` has run; `yaml` appears in `package.json` `dependencies`; `bun.lock` is committed with the resolution.
- `src/types/depauditConfig.ts` exports all new types plus the `DEFAULT_DEPAUDIT_CONFIG`, `SUPPORTED_ECOSYSTEMS`, and `SEVERITY_RANK` constants.
- `ConfigLoader` (`src/modules/configLoader.ts`) exports `loadDepauditConfig(repoRoot)` returning a typed `DepauditConfig`. Parse errors throw `ConfigParseError` carrying `filePath`, `line`, `column`, `message`. Absent file returns `DEFAULT_DEPAUDIT_CONFIG` with `filePath: null`. Each `commonAndFine` / `supplyChainAccepts` entry carries a `sourceLine` derived from the AST.
- `Linter` (`src/modules/linter.ts`) exports `lintDepauditConfig(config, now?)`, a pure function returning `{ errors, warnings, isClean }`. All PRD YAML rules are implemented: schema version mismatch (rule 8), `severityThreshold` / `ecosystems` enums (rule 6), `maxAcceptDays` / `maxCommonAndFineDays` bounds, `commonAndFine` 365-day cap (rule 3), `supplyChainAccepts` 90-day cap (rule 3), not-in-past (rule 4), reason ≥ 20 chars for `supplyChainAccepts` (rule 5), duplicate warnings for both registers (rule 7). Each rule is independently testable.
- `FindingMatcher` (`src/modules/findingMatcher.ts`) exports `classifyFindings(findings, depauditConfig, osvConfig, now?)` returning `ClassifiedFinding[]`. Four categories are exercised; first-match-wins ordering holds; severity threshold filters only the `new` bucket.
- `depaudit lint [path]` lints both `.depaudit.yml` and `osv-scanner.toml` in a single run; prints lint messages to stderr in `<file>:<line>:<col>: <severity>: <message>` format; exits `0` on clean/warnings-only, `1` on any fatal, `2` on parse error or bad path.
- `depaudit scan [path]` loads both configs, lints both, classifies findings via `FindingMatcher`, and prints only the `new` bucket to stdout. Expired-accept findings surface on stderr as `expired accept: <package> <version> <findingId>` lines. Exit code is `0` if both `new` and `expired-accept` buckets are empty; `1` otherwise. Scan aborts with exit code `1` if either lint fails fatally; exit `2` if either config has a parse error.
- `findingFilter.ts` and `findingFilter.test.ts` are deleted; no references remain.
- Default `.depaudit.yml` policy is `{ severityThreshold: "medium", ecosystems: "auto", maxAcceptDays: 90, maxCommonAndFineDays: 365 }` when the file is absent.
- Vitest unit tests exist for `loadDepauditConfig` (absent/empty/full/malformed/partial/shape), `lintDepauditConfig` (one per rule + boundaries + combined), and `FindingMatcher` (all four categories, severity-threshold behaviour per threshold, ordering, UNKNOWN). All pass via `bun test`.
- `bun run typecheck` exits 0.
- `bun run build` exits 0 and produces `dist/modules/findingMatcher.js`, `dist/types/depauditConfig.js`.
- `UBIQUITOUS_LANGUAGE.md` terms preserved: new code uses **`FindingMatcher`**, **Severity threshold**, **`.depaudit.yml`**, **Common-and-fine entry**, **Acceptance**, **Acceptance Register**, **Expiry**; does not introduce new synonyms.
- Existing `features/scan.feature` (`@adw-3`) and `features/lint.feature` + `features/scan_accepts.feature` (`@adw-4`) BDD scenarios still pass — absent `.depaudit.yml` defaults preserve the issue-#4 behaviour.
- New `features/depaudit_yml.feature` (`@adw-5`) BDD scenarios pass end-to-end via `bun run test:e2e`.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions. Project-specific entries sourced from `.adw/commands.md`.

- `bun install` — resolves and installs all dependencies including the new `yaml` direct dep.
- `bun run typecheck` — `tsc --noEmit`; must report zero type errors across `src/`.
- `bun run build` — `tsc`; produces `dist/` with all new modules; exit 0.
- `test -x dist/cli.js` — confirms the compiled CLI entry remains executable after `postbuild`.
- `bun test` — runs Vitest; all unit tests pass, including the extended `configLoader`, extended `linter`, and new `findingMatcher` suites; the deleted `findingFilter.test.ts` is gone without leaving a broken import.
- `node dist/cli.js --help` — USAGE mentions both `scan [path]` and `lint [path]`; exit 0.
- `node dist/cli.js lint fixtures/clean-npm/` — exit 0, no stderr (no `.depaudit.yml` nor `osv-scanner.toml` in fixture → defaults, clean lint).
- `node dist/cli.js lint fixtures/depaudit-yml-clean/` — exit 0 (valid `.depaudit.yml` lints clean).
- `bun run test:e2e` — all Cucumber/BDD scenarios pass: the existing `@adw-3` suite, the existing `@adw-4` suites, and the new `@adw-5` suite in `features/depaudit_yml.feature`. No scenarios are skipped or marked pending.

> Note: `bun run lint` (JS/TS code linter) is listed in `.adw/commands.md` but no tool is configured in `package.json` (the script is undefined). Per the issue #3 / #4 plans' "Lint deferral" note, this command is deliberately excluded until a follow-up chore adds a JS/TS linter. Validation here relies on `typecheck` + `test` + `build` + `test:e2e`.

## Notes

- **No `guidelines/` directory** exists in this repository; coding-style adherence falls back to the deep-module conventions documented in `.adw/project.md` and the PRD's Modules section.
- **Library install**: per `.adw/commands.md` Library Install Command (`bun add {library}`), the new direct runtime dependency `yaml` is added via `bun add yaml`. Rationale for `yaml` over alternatives: it's already present as a transitive dep (via cucumber), it's ISC-licensed, zero-dep, TypeScript-native, the de-facto standard in the Node ecosystem (~30M weekly downloads), and crucially its `parseDocument` + `LineCounter` APIs give us both `YAMLParseError.linePos` for parse failures and per-node `range` positions for the `sourceLine` attachment on each register entry. `js-yaml` is CommonJS-first and does not expose per-node positions; `yaml` is the clear match for our line/col needs.
- **Unit tests override**: `.adw/project.md` lacks `## Unit Tests: enabled`. This plan includes unit-test tasks because the GitHub issue's acceptance criteria and `.adw/review_proof.md` Rule 6 both require them — same precedent as issue #3 and issue #4.
- **`findingFilter` removal**: since `FindingMatcher` subsumes it and the codebase is pre-release, removing it outright is the YAGNI move. No deprecation period. No backwards-compat shim. The one call site in `scanCommand.ts` is updated atomically in the same slice.
- **Severity threshold semantics**: "drops findings below the configured level from the `new` bucket" — the PRD and the issue both use "above the severity threshold" language (user stories 1 and 33). I read this as ≥ (`medium` threshold → MEDIUM is kept). Below-threshold findings are dropped from the classifier's output entirely — they are not returned as some separate "below-threshold" category. This matches the PRD gate semantics: "No current finding above the severity threshold is un-accepted." Findings below threshold that match an accepted entry still surface as `accepted`/`whitelisted`/`expired-accept` so the triage skill and auto-prune logic can see them.
- **`expired-accept` stderr surface**: a new stderr line format `expired accept: <package> <version> <findingId>` is introduced. This is deliberately scoped to one line per entry — future reporters (`MarkdownReporter`, `SlackReporter`) will format this richly. Today it exists so the contract is visible and a downstream reporter slice can consume it without having to first re-do the classification.
- **Classification ordering**: first-match-wins, rule order: CVE accept > supply-chain accept > common-and-fine > severity threshold. The PRD does not explicitly specify this order; I've chosen it because (a) CVE and supply-chain accepts are per-finding decisions made deliberately by the maintainer and should take precedence over category-wide rules, and (b) among accepts, expired entries are still accepts — they shouldn't silently fall through to `whitelisted` just because a `commonAndFine` rule happens to match. This is the shape the PRD's "expired-accept" category implies.
- **Deferred (explicitly left for later slices, per the PRD slice breakdown)**: Socket.dev API integration (Supply-chain findings stop being theoretical — this slice only exercises the `source === "socket"` code path via synthetic unit-test fixtures), orphan auto-prune, `MarkdownReporter` / `JsonReporter` / `SlackReporter` output of classified findings, `.depaudit/findings.json` persistence, `depaudit setup` bootstrap, PR-comment plumbing, Ecosystem expansion beyond `npm`.
- **Schema version is `1`**: The Linter rejects any other version. Future schema bumps require an explicit migration step — not in scope for this slice.
- **Scan-time mutation deliberately NOT added**: the PRD's auto-prune behaviour is out of scope; `depaudit scan` still only reads config files, never writes. Auto-prune lands alongside the orphan-detection slice.
