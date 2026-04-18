# Feature: .depaudit.yml schema + FindingMatcher + severity threshold

## Metadata
issueNumber: `5`
adwId: `m8fl2v-depaudit-yml-schema`
issueJson: `{"number":5,"title":".depaudit.yml schema + FindingMatcher + severity threshold","body":"## Parent PRD\n\n`specs/prd/depaudit.md`\n\n## What to build\n\nIntroduces `.depaudit.yml` as the master config. Schema includes `version`, `policy` (with `severityThreshold` defaulting to `medium`, `ecosystems`, `maxAcceptDays`, `maxCommonAndFineDays`), `commonAndFine` (category whitelist with 365-day cap), and `supplyChainAccepts` (stub for now; filled in #5). `FindingMatcher` classifies each finding as `new`, `accepted`, `whitelisted`, or `expired-accept` against the loaded config, applying the severity threshold as a filter.\n\nExtends `ConfigLoader` to parse YAML alongside TOML and extends `Linter` to enforce the YAML schema (all rules from PRD, including the 365-day cap on `commonAndFine`).\n\n## Acceptance criteria\n\n- [ ] YAML schema for `.depaudit.yml` matches PRD exactly (version, policy, commonAndFine, supplyChainAccepts).\n- [ ] `severityThreshold` default is `medium`; enum validation allows `medium` / `high` / `critical`.\n- [ ] `FindingMatcher` returns a four-way classification.\n- [ ] Severity threshold drops findings below the configured level from the \"new\" bucket.\n- [ ] `Linter` enforces all YAML rules (90d, 365d, enums, reason length, duplicates).\n- [ ] Unit tests for `FindingMatcher` (synthetic findings + accepts) and extended `Linter`.\n\n## Blocked by\n\n- Blocked by #4\n\n## User stories addressed\n\n- User story 33\n","state":"OPEN","author":"paysdoc","labels":[],"createdAt":"2026-04-17T13:24:37Z","comments":[],"actionableComment":null}`

## Feature Description

Layers the second half of the Acceptance Register machinery onto the CLI. Introduces `.depaudit.yml` as the master depaudit config — a YAML artifact owning `policy` (severity threshold, ecosystems, expiry caps), `commonAndFine` (category whitelists for expected-and-harmless `(package, alertType)` pairs with a 365-day cap), and `supplyChainAccepts` (per-finding acceptances for Socket supply-chain signals). Extends `ConfigLoader` to parse the YAML alongside the existing `osv-scanner.toml`. Extends `Linter` with the YAML-applicable rules from the PRD (90-day cap on `supplyChainAccepts`, 365-day cap on `commonAndFine`, enum validation for `severityThreshold` / `ecosystems`, reason length, duplicate detection, schema version pinning).

Introduces `FindingMatcher` — a pure classifier deep module that folds findings plus the full Acceptance Register (both TOML `IgnoredVulns` and YAML `supplyChainAccepts` / `commonAndFine`) into a four-way classification: `new` / `accepted` / `whitelisted` / `expired-accept`. Applies `policy.severityThreshold` as an up-front filter: findings below the configured level are dropped before classification (they do not land in any bucket).

Wires the loader, linter, and matcher into `ScanCommand` so `depaudit scan` now reads both config files, lints both, classifies all findings (OSV from this slice, Socket deferred), and reports only the `new` + `expired-accept` buckets as gate failures. `depaudit lint` is extended to include `.depaudit.yml` in its pre-flight and in its standalone invocation.

## User Story

As a maintainer (PRD user story 33 plus supporting stories 4, 5, 7, 17, 30)
I want to configure my severity threshold per repository (`medium`, `high`, or `critical`) via `.depaudit.yml`, register per-`(package, alertType)` `commonAndFine` whitelists for expected-and-harmless install scripts, and have every finding classified into one of four buckets against the loaded config
So that I can tune gating to the risk profile of each repo, stop install-script flags from churning, and get a single authoritative four-way classification the Reporter and Gate can consume.

## Problem Statement

Issue #4 landed `ConfigLoader` for `osv-scanner.toml` and a minimal inline `filterAcceptedFindings`. Everything beyond CVE acceptances is unaddressed:

1. There is no way to configure a per-repo severity threshold. The gate currently fails on any finding regardless of severity, which is too aggressive for compliance-light codebases and not aggressive enough for production services (PRD user story 33).
2. There is no way to register a `(package, alertType)` whitelist for legitimate install scripts like TypeScript, esbuild, tsx, Prisma, Playwright — every scan flags them (PRD user story 17).
3. There is no way to record a supply-chain acceptance — the existing suppression only covers OSV-Scanner's `[[IgnoredVulns]]` (PRD user stories 4, 5, 6 for supply-chain findings).
4. There is no classifier producing the four buckets the Reporter, Gate, and `/depaudit-triage` skill will consume (`new`, `accepted`, `whitelisted`, `expired-accept`). Without it, an expired acceptance is indistinguishable from no acceptance, and a `commonAndFine`-matched finding is indistinguishable from an accepted one.
5. There is no YAML parsing or validation — `.depaudit.yml` is documented in the PRD but has no runtime support.

The user-facing consequence: repos that install depaudit today can only accept CVEs (one-line TOML edits). They cannot configure severity, cannot whitelist install scripts, and cannot cleanly see which findings are "new unknowns" versus "accepted" versus "expired and need re-review."

## Solution Statement

Introduce one new deep module, one new type module, one new YAML runtime dependency, and extend three existing modules:

- **`src/types/depauditConfig.ts`** (new) — Canonical types for the YAML schema: `DepauditConfig`, `DepauditPolicy`, `CommonAndFineEntry`, `SupplyChainAccept`, `SeverityThreshold`, plus a `Classification` enum (`new | accepted | whitelisted | expired-accept`) and a `ClassifiedFinding` tuple `{ finding: Finding; classification: Classification; match?: AcceptanceMatch }`.
- **`src/modules/configLoader.ts`** (extended) — Adds `async function loadDepauditConfig(repoRoot: string): Promise<DepauditConfig>` alongside the existing `loadOsvScannerConfig`. Reads `.depaudit.yml` from the repo root, returns a typed default when absent (empty `commonAndFine`, empty `supplyChainAccepts`, `policy` with `severityThreshold: "medium"`). Uses `yaml` (v2) via `parseDocument` so parse failures carry `{ line, col }` that we surface as a `ConfigParseError` (reusing the existing class). Attaches `sourceLine` to each `commonAndFine` / `supplyChainAccepts` entry for lint-message positioning.
- **`src/modules/linter.ts`** (extended) — Adds `function lintDepauditConfig(config: DepauditConfig, now?: Date): LintResult`. Enforces every PRD rule applicable to the YAML: schema `version` must equal `1` (halt with migration guidance on mismatch); `policy.severityThreshold` must be in `{"medium","high","critical"}`; `policy.ecosystems` must be `"auto"` or an array of known ecosystem strings; `policy.maxAcceptDays` ≤ 90 and `policy.maxCommonAndFineDays` ≤ 365 when present; `supplyChainAccepts[].expires` ≤ today + `maxAcceptDays` (90 cap), not in the past; `supplyChainAccepts[].reason` ≥ 20 chars; `commonAndFine[].expires` ≤ today + `maxCommonAndFineDays` (365 cap), not in the past; duplicate `(package, version, alertType)` in `supplyChainAccepts` → warning; duplicate `(package, alertType)` in `commonAndFine` → warning. Each message carries `line` / `column` from the source map. The existing `lintOsvScannerConfig` is unchanged.
- **`src/modules/findingMatcher.ts`** (new, deep and pure) — Exports `function classifyFindings(findings: Finding[], depauditConfig: DepauditConfig, osvConfig: OsvScannerConfig, now?: Date): ClassifiedFinding[]`. For each finding:
  1. If `severityRank(finding.severity) < severityRank(policy.severityThreshold)`, drop it (excluded from all buckets).
  2. Else try each match rule in order:
     - **Whitelisted**: `commonAndFine` entry matches on `(package, alertType)` and is non-expired — classification `whitelisted`.
     - **Accepted**: `supplyChainAccepts` entry matches on `(package, version, alertType)` (Socket signals) OR `IgnoredVulns` entry matches on `findingId` (OSV CVEs), and the entry is non-expired — classification `accepted`.
     - **Expired-accept**: the same matches as above but the entry's `expires` / `ignoreUntil` is in the past — classification `expired-accept`.
     - **New** (default): no match — classification `new`.
  3. Attach the matching `AcceptanceMatch` (the entry that matched, for downstream Reporter use) except for `new`.
- **`src/commands/scanCommand.ts`** (extended) — Loads both configs, lints both, and replaces the inline `filterAcceptedFindings` call with `classifyFindings`. Emits findings whose classification is `new` or `expired-accept` (these are the "must-fix before merge" bucket for Gate semantics). Exit code is `0` iff no such findings remain. `accepted` and `whitelisted` findings are silently excluded from stdout at this slice (the richer Reporter that groups them by bucket lands in a later slice).
- **`src/commands/lintCommand.ts`** (extended) — Runs both linters and emits a combined `LintResult`. Exits `2` on parse error from either file, `1` on fatal from either, `0` on clean/warnings-only.

YAML parsing uses the `yaml` package (v2), added via `bun add yaml`. The v2 API's `parseDocument(text)` produces a `Document` whose `errors` array carries `{ code, message, pos: [start, end], linePos: [{line, col}] }`, giving us the line/col pair `ConfigLoader` needs. It is ISC-licensed, zero-dep, and already present as a transitive dependency (making the direct dependency add essentially free).

`src/cli.ts` is unchanged at the dispatch level — `lint` and `scan` already dispatch to their composition roots, which internally pick up the new pipeline.

`UBIQUITOUS_LANGUAGE.md` canonical terms preserved: **Acceptance**, **Acceptance Register**, **Common-and-fine entry**, **Severity threshold**, **`ConfigLoader`**, **`Linter`**, **`FindingMatcher`**. New types use these names; no "allowlist" except where PRD uses it for `commonAndFine`; no "ignore"/"suppress" except where wrapping OSV-Scanner's native field names.

## Relevant Files
Use these files to implement the feature:

- `README.md` — Always include; project overview and status.
- `specs/prd/depaudit.md` — Authoritative source for the `.depaudit.yml` schema (section "In-repo artifacts"), the Linter rules (section "Linter rules"), the four-way classification (section "Modules" → `FindingMatcher`), Gate semantics (section "Gate semantics"), and the severity threshold user story (user story 33).
- `UBIQUITOUS_LANGUAGE.md` — Canonical terms: **Acceptance**, **Acceptance Register**, **Common-and-fine entry**, **Severity threshold**, **`ConfigLoader`**, **`Linter`**, **`FindingMatcher`**. New code uses these; avoid "allowlist" except for `commonAndFine`; avoid "ignore"/"suppress" except where tied to OSV-Scanner's native `IgnoredVulns`.
- `.adw/project.md` — Declares deep-module layout (`src/commands/`, `src/modules/`, `src/modules/__tests__/`), runtime stack (Bun, TypeScript strict, Vitest, ESM `.js` import suffixes), `Library Install Command: bun add {library}`.
- `.adw/commands.md` — Authoritative validation commands.
- `.adw/conditional_docs.md` — Confirms `specs/prd/depaudit.md` and `app_docs/feature-oowire-configloader-linter-cve-ignores.md` should be read for this task (new feature + `ConfigLoader`/`Linter`/`FindingMatcher` extension).
- `.adw/review_proof.md` — Rule 6: "For changes to `Linter`, `FindingMatcher`, or `ConfigLoader`: confirm fixture-driven unit tests cover all new rules or branches." Binding for the unit-test acceptance criterion.
- `app_docs/feature-oowire-configloader-linter-cve-ignores.md` — Documents the existing `ConfigLoader` / `Linter` / `FindingFilter` / `LintCommand` shapes. This slice extends them without breaking their contracts.
- `specs/issue-4-adw-oowire-configloader-linter-sdlc_planner-config-loader-linter-cve-ignores.md` — Reference plan from the preceding slice; the module shapes, fixture-handling approach (date placeholders + `mkdtemp`), and the "extend don't rewrite" pattern are established there.
- `specs/prd/depaudit.md` section "Modules" — `FindingMatcher` contract: "Pure function that classifies each `Finding` against `supplyChainAccepts`, `commonAndFine`, and OSV `IgnoredVulns`; output categories are `new`, `accepted`, `whitelisted`, `expired-accept`."
- `src/cli.ts` — Unchanged at the dispatch level; all new wiring is inside `scanCommand.ts` and `lintCommand.ts`.
- `src/commands/scanCommand.ts` — Extended: loads both configs, invokes both linters, calls `classifyFindings` in place of `filterAcceptedFindings`, emits only `new` + `expired-accept` findings, exits `0` iff that list is empty.
- `src/commands/lintCommand.ts` — Extended: loads both configs, runs both linters, emits a combined `LintResult`, exits `2` on parse error from either file, `1` on fatal from either, `0` on clean/warnings-only.
- `src/modules/configLoader.ts` — Extended: gains `loadDepauditConfig(repoRoot)`. Existing `loadOsvScannerConfig` is unchanged.
- `src/modules/linter.ts` — Extended: gains `lintDepauditConfig(config, now?)`. Existing `lintOsvScannerConfig` is unchanged.
- `src/modules/findingFilter.ts` — Superseded by `findingMatcher.ts`'s `accepted` category; keep the module in place for this slice (used by no callers after the scan rewrite, but its unit tests document the expected filter behavior that `findingMatcher` subsumes). DO NOT delete — its tests continue to act as contract tests for the accepted-match logic. A future slice may remove it once `findingMatcher` has feature parity documented by tests.
- `src/modules/lintReporter.ts` — Unchanged; already accepts any `LintResult` and any file path. We will call it twice from `lintCommand.ts` (once for the TOML result, once for the YAML result) rather than extending it to handle multiple files, to keep the formatter single-responsibility.
- `src/types/osvScannerConfig.ts` — Reused unchanged. The `LintMessage`, `LintResult`, `ConfigParseError` types are generic enough to cover the new YAML lint path. Consider adding a `file` field to `LintMessage` if needed for multi-file output, but at this slice `lintCommand.ts` prints each file's result with its own file path argument, so `LintMessage` itself does not need to carry a file.
- `src/types/finding.ts` — `Severity` is the enum used by the severity threshold comparator. `Finding` shape (carrying `source`, `package`, `version`, `findingId`, `severity`) is the classifier's input — unchanged.
- `src/modules/osvScannerAdapter.ts` — Unchanged; `Finding.findingId` remains the key `findingMatcher` uses for OSV-side matching.
- `src/modules/manifestDiscoverer.ts` — Unchanged.
- `src/modules/stdoutReporter.ts` — Unchanged; we still call `printFindings` on the `new + expired-accept` subset.
- `src/modules/__tests__/configLoader.test.ts` — Extended with a `describe("loadDepauditConfig", ...)` block covering empty-file default, single-`commonAndFine`, single-`supplyChainAccepts`, malformed YAML (parse-error line/col), and `sourceLine` attachment.
- `src/modules/__tests__/linter.test.ts` — Extended with a `describe("lintDepauditConfig", ...)` block covering one test per YAML rule plus boundary and combined cases.
- `src/modules/__tests__/fixtures/depaudit-yml/` — New directory of `.depaudit.yml` fixtures analogous to `osv-scanner-toml/`. Uses the same `{{EXPIRES_xxx}}` date-placeholder convention as the TOML fixtures.
- `features/lint.feature` — Existing `@adw-4` feature file. Extended with `@adw-5` scenarios for `.depaudit.yml` lint behavior.
- `features/scan.feature` — Existing `@adw-3` feature file. Existing scenarios must continue to pass (no regression from the new YAML pre-flight when `.depaudit.yml` is absent).
- `features/scan_accepts.feature` — Existing `@adw-4` feature file. Existing scenarios must continue to pass.
- `features/step_definitions/lint_steps.ts` — Extended with `Given` steps that materialize `.depaudit.yml` into fixture directories, mirroring the existing `writeTomL` helper.
- `features/step_definitions/scan_accepts_steps.ts` — Existing. New `@adw-5` scan scenarios may need new `Given` steps here or in a new `scan_classify_steps.ts` file if the count grows.
- `features/support/world.ts` — Reused unchanged; the `writtenFiles` cleanup covers both `osv-scanner.toml` and `.depaudit.yml` generically.
- `package.json` — Needs `yaml` added to `dependencies` via `bun add yaml`.
- `bun.lock` — Will be updated by the `bun add` step.
- `tsconfig.json` — Unchanged; `strict` + ESM settings already compatible.

### New Files

- `src/types/depauditConfig.ts` — Exports the canonical YAML types and classifier output types:
  - `type SeverityThreshold = "medium" | "high" | "critical"`
  - `type EcosystemsOption = "auto" | Ecosystem[]` (where `Ecosystem` is the existing enum from `finding.ts`; for this slice only `"npm"`)
  - `interface DepauditPolicy { severityThreshold: SeverityThreshold; ecosystems: EcosystemsOption; maxAcceptDays: number; maxCommonAndFineDays: number }`
  - `interface CommonAndFineEntry { package: string; alertType: string; expires: string; reason?: string; sourceLine?: number }`
  - `interface SupplyChainAccept { package: string; version: string; alertType: string; expires: string; reason: string; upstreamIssue?: string; sourceLine?: number }`
  - `interface DepauditConfig { version: number; policy: DepauditPolicy; commonAndFine: CommonAndFineEntry[]; supplyChainAccepts: SupplyChainAccept[]; filePath: string | null }`
  - `type Classification = "new" | "accepted" | "whitelisted" | "expired-accept"`
  - `interface AcceptanceMatch { kind: "ignored-vuln" | "supply-chain-accept" | "common-and-fine"; expires: string; reason?: string; sourceLine?: number }`
  - `interface ClassifiedFinding { finding: Finding; classification: Classification; match?: AcceptanceMatch }`
  - `const DEFAULT_POLICY: DepauditPolicy = { severityThreshold: "medium", ecosystems: "auto", maxAcceptDays: 90, maxCommonAndFineDays: 365 }` — the defaults applied when fields are absent; also used by `lintDepauditConfig` when enforcing caps.
- `src/modules/findingMatcher.ts` — Deep module exporting `function classifyFindings(findings: Finding[], depauditConfig: DepauditConfig, osvConfig: OsvScannerConfig, now?: Date): ClassifiedFinding[]` and a helper `function severityRank(sev: Severity): number` mapping `"UNKNOWN" → 0`, `"LOW" → 1`, `"MEDIUM" → 2`, `"HIGH" → 3`, `"CRITICAL" → 4`. Pure function, `now` injectable.
- `src/modules/__tests__/findingMatcher.test.ts` — Vitest unit tests (see Testing Strategy for the full list: severity threshold filter, each classification, match-precedence, boundary cases, mixed-expiry cases).
- `src/modules/__tests__/fixtures/depaudit-yml/empty.yml` — Minimal `.depaudit.yml` with just `version: 1` and default policy.
- `src/modules/__tests__/fixtures/depaudit-yml/valid-full.yml` — Complete `.depaudit.yml` with policy, one `commonAndFine` entry, one `supplyChainAccepts` entry, all fields valid; `expires` fields via `{{EXPIRES_xxx}}` placeholders.
- `src/modules/__tests__/fixtures/depaudit-yml/malformed.yml` — Syntactically invalid YAML (e.g., bad indent or unterminated block) to exercise parse-error line/col.
- `src/modules/__tests__/fixtures/depaudit-yml/bad-severity.yml` — `policy.severityThreshold: "low"` (not in enum) to exercise the enum rule.
- `src/modules/__tests__/fixtures/depaudit-yml/accept-over-90d.yml` — `supplyChainAccepts[0].expires` > today + 90d.
- `src/modules/__tests__/fixtures/depaudit-yml/accept-expired.yml` — `supplyChainAccepts[0].expires` in the past.
- `src/modules/__tests__/fixtures/depaudit-yml/accept-short-reason.yml` — `supplyChainAccepts[0].reason` < 20 chars.
- `src/modules/__tests__/fixtures/depaudit-yml/accept-missing-reason.yml` — `supplyChainAccepts[0].reason` absent.
- `src/modules/__tests__/fixtures/depaudit-yml/accept-duplicate.yml` — Two `supplyChainAccepts` entries with identical `(package, version, alertType)`.
- `src/modules/__tests__/fixtures/depaudit-yml/common-over-365d.yml` — `commonAndFine[0].expires` > today + 365d.
- `src/modules/__tests__/fixtures/depaudit-yml/common-expired.yml` — `commonAndFine[0].expires` in the past.
- `src/modules/__tests__/fixtures/depaudit-yml/common-duplicate.yml` — Two `commonAndFine` entries with identical `(package, alertType)`.
- `src/modules/__tests__/fixtures/depaudit-yml/bad-version.yml` — `version: 99` (unsupported; halt with migration guidance).
- `src/modules/__tests__/fixtures/depaudit-yml/bad-ecosystems.yml` — `policy.ecosystems: "nonsense"` (not `"auto"` or an array).

## Implementation Plan

### Phase 1: Foundation

Bring the project to a state that can parse YAML, represent the `.depaudit.yml` shape as typed data, and describe the four-way classification. Concretely: add `yaml` as a runtime dependency via `bun add yaml`, create `src/types/depauditConfig.ts` with all new types and the `DEFAULT_POLICY` constant, and confirm `bun run typecheck` and `bun run build` still pass. No domain logic yet.

### Phase 2: Core Implementation

Extend `ConfigLoader` with `loadDepauditConfig`, extend `Linter` with `lintDepauditConfig`, then create `FindingMatcher`. Each module gets its own unit tests with fixtures. Implement in order:

1. `loadDepauditConfig` — uses `yaml.parseDocument` for line/col on errors; returns a `DepauditConfig` with `DEFAULT_POLICY` fields merged in for absent keys (so callers never have to handle `undefined` policy fields); attaches `sourceLine` per entry by scanning the `yaml.Document` node positions.
2. `lintDepauditConfig` — one helper per rule; pure; `now` injectable. Produces `LintMessage[]` with `line`/`column` from the source map.
3. `classifyFindings` — pure fold over the inputs; applies severity threshold first, then match-precedence rules (whitelisted → accepted/expired-accept → new).

Unit-test each module against its own fixture family before moving on.

### Phase 3: Integration

Wire the new modules into the two composition roots:

1. `ScanCommand` — loads both configs (TOML + YAML), runs both linters (halt on any parse error or fatal lint error), calls `classifyFindings` over the OSV findings, filters to `new` + `expired-accept`, prints via `stdoutReporter`. Exit `0` iff the filtered bucket is empty.
2. `LintCommand` — loads both configs, runs both linters, prints each file's result with `printLintResult`, exits `0` / `1` / `2` by the same rules as issue #4 but over the combined result.

### Phase 4: BDD Coverage

Add `@adw-5`-tagged scenarios to `features/lint.feature` for `.depaudit.yml` lint behavior and create a small new `features/scan_classify.feature` for the severity-threshold filter + classification-driven stdout behavior. Extend `features/step_definitions/lint_steps.ts` with `Given` steps that materialize `.depaudit.yml` into fixtures (mirroring the existing `writeTomL` helper). Reuse shared `Then` assertions where phrasing matches. Run `bun run test:e2e` and confirm every `@adw-3`, `@adw-4`, and `@adw-5` scenario passes with zero pendings.

## Step by Step Tasks
Execute every step in order, top to bottom.

### Add `yaml` runtime dependency

- Run `bun add yaml` from the worktree root. Confirm `package.json` now has `yaml` under `dependencies` (not `devDependencies`) and `bun.lock` has been updated.
- Confirm `bun install` exits cleanly with no warnings.

### Create canonical types in `src/types/depauditConfig.ts`

- Create `src/types/depauditConfig.ts` exporting:
  - `type SeverityThreshold = "medium" | "high" | "critical"`
  - `type EcosystemsOption = "auto" | Ecosystem[]` (import `Ecosystem` from `./finding.js`)
  - `interface DepauditPolicy { severityThreshold: SeverityThreshold; ecosystems: EcosystemsOption; maxAcceptDays: number; maxCommonAndFineDays: number }`
  - `interface CommonAndFineEntry { package: string; alertType: string; expires: string; reason?: string; sourceLine?: number }`
  - `interface SupplyChainAccept { package: string; version: string; alertType: string; expires: string; reason: string; upstreamIssue?: string; sourceLine?: number }`
  - `interface DepauditConfig { version: number; policy: DepauditPolicy; commonAndFine: CommonAndFineEntry[]; supplyChainAccepts: SupplyChainAccept[]; filePath: string | null }`
  - `type Classification = "new" | "accepted" | "whitelisted" | "expired-accept"`
  - `interface AcceptanceMatch { kind: "ignored-vuln" | "supply-chain-accept" | "common-and-fine"; expires: string; reason?: string; sourceLine?: number }`
  - `interface ClassifiedFinding { finding: Finding; classification: Classification; match?: AcceptanceMatch }` (import `Finding` from `./finding.js`)
  - `export const DEFAULT_POLICY: DepauditPolicy = { severityThreshold: "medium", ecosystems: "auto", maxAcceptDays: 90, maxCommonAndFineDays: 365 }`
- Run `bun run typecheck` — must exit 0.

### Extend `ConfigLoader` with `loadDepauditConfig`

- Edit `src/modules/configLoader.ts`:
  - Add `import { parseDocument } from "yaml";` and imports for the new types.
  - Add `export async function loadDepauditConfig(repoRoot: string): Promise<DepauditConfig>`:
    1. Resolve `.depaudit.yml` relative to `repoRoot`.
    2. `readFile(..., "utf8")`. On `ENOENT`, return `{ version: 1, policy: { ...DEFAULT_POLICY }, commonAndFine: [], supplyChainAccepts: [], filePath: null }` — absent file is valid (defaults apply).
    3. Call `parseDocument(raw)`. If `doc.errors.length > 0`, take the first error and throw `new ConfigParseError(absPath, err.linePos?.[0]?.line ?? 1, err.linePos?.[0]?.col ?? 1, err.message)`.
    4. Convert the `Document` to plain JS via `doc.toJS()`. Merge with `DEFAULT_POLICY` so callers see a fully-populated policy even when the YAML omits fields (explicit values in the YAML win).
    5. Attach `sourceLine` to each entry by mapping the YAML node positions (`yaml` v2 exposes `.range` on nodes; convert byte-offsets to line numbers by counting `\n` up to `range[0]`). Keeping this approximate is fine; same philosophy as `loadOsvScannerConfig`.
    6. Return the shaped `DepauditConfig`.
- Do NOT enforce rules in `ConfigLoader` — that is `Linter`'s job. If `version` is missing, default to `1` but do not throw; `lintDepauditConfig` will flag mismatches. If `commonAndFine` or `supplyChainAccepts` is absent, default to `[]`.
- Export the function. Keep `loadOsvScannerConfig` unchanged.

### Create `.depaudit.yml` fixtures

- Create `src/modules/__tests__/fixtures/depaudit-yml/` and populate with the 14 fixtures listed in "New Files" above. Fixtures use `{{EXPIRES_30D}}`, `{{EXPIRES_90D}}`, `{{EXPIRES_180D}}`, `{{EXPIRES_365D}}`, `{{EXPIRES_PAST_1D}}`, `{{EXPIRES_500D}}` placeholders — expanded at test runtime into a `tmpdir()` copy, same approach as the TOML fixtures.
- `malformed.yml` is committed already-broken (no placeholders). Example content: a dangling `policy:` with a value on the same line plus a `-` bullet below it at the wrong indent — whatever triggers `yaml`'s parser to emit an error with non-null `linePos`.

### Extend `ConfigLoader` unit tests

- Edit `src/modules/__tests__/configLoader.test.ts`:
  - Add a new `describe("loadDepauditConfig", ...)` block with tests asserting:
    1. Absent `.depaudit.yml` → `{ version: 1, policy: DEFAULT_POLICY, commonAndFine: [], supplyChainAccepts: [], filePath: null }`; no throw.
    2. `empty.yml` (just `version: 1`) → parses with `DEFAULT_POLICY` merged in, empty arrays, non-null `filePath`.
    3. `valid-full.yml` → one `commonAndFine` entry, one `supplyChainAccepts` entry, policy fields explicit in YAML override defaults where applicable.
    4. `malformed.yml` → throws `ConfigParseError` with `filePath`, `line`, `column`, and non-empty `message`.
    5. `sourceLine` attached to each `commonAndFine` and `supplyChainAccepts` entry is a positive integer.
- Use the same `expandFixture` + `mkdtemp` helper approach as the existing TOML tests (factor it if duplication becomes awkward; one-line copy is fine at this scale).

### Extend `Linter` with `lintDepauditConfig`

- Edit `src/modules/linter.ts`:
  - Add `import { DEFAULT_POLICY } from "../types/depauditConfig.js";` and the needed YAML type imports.
  - Add `export function lintDepauditConfig(config: DepauditConfig, now: Date = new Date()): LintResult`.
  - Local helpers, one per rule:
    - `checkVersion(config)` — if `config.version !== 1`, push fatal `"schema version <v> is not supported; expected 1; manual migration required"`.
    - `checkSeverityThreshold(policy)` — if not in `{"medium","high","critical"}`, push fatal `"policy.severityThreshold must be one of medium | high | critical (got: <v>)"`.
    - `checkEcosystems(policy)` — if not `"auto"` and not an array of known ecosystem strings, push fatal `"policy.ecosystems must be \"auto\" or an array of ecosystems (got: <v>)"`.
    - `checkMaxAcceptDays(policy)` — if `> 90`, push fatal `"policy.maxAcceptDays must not exceed 90 (got: <v>)"`.
    - `checkMaxCommonAndFineDays(policy)` — if `> 365`, push fatal `"policy.maxCommonAndFineDays must not exceed 365 (got: <v>)"`.
    - `checkSupplyChainAccept(entry, now, cap)` — four sub-rules producing fatal messages:
      - `expires` parseable (ISO-8601).
      - `expires` not in the past.
      - `expires` ≤ today + `cap` (policy's resolved `maxAcceptDays`, min'd against hard 90 cap).
      - `reason` present and ≥ 20 chars.
    - `checkSupplyChainDuplicates(entries)` — group by `(package, version, alertType)`; each duplicate is a warning.
    - `checkCommonAndFineEntry(entry, now, cap)` — sub-rules:
      - `expires` parseable (ISO-8601).
      - `expires` not in the past.
      - `expires` ≤ today + `cap` (policy's resolved `maxCommonAndFineDays`, min'd against hard 365 cap).
      - `reason` is optional (per PRD) — no min-length rule.
    - `checkCommonAndFineDuplicates(entries)` — group by `(package, alertType)`; each duplicate is a warning.
  - Produce `LintMessage[]` with `line`/`column` from the entry's `sourceLine`.
  - Return `{ errors, warnings, isClean: errors.length === 0 }`.
- Keep `lintOsvScannerConfig` unchanged.

### Extend `Linter` unit tests

- Edit `src/modules/__tests__/linter.test.ts`:
  - Add a new `describe("lintDepauditConfig", ...)` block:
    1. `empty.yml` (just `version: 1` with default policy merged in) → `isClean: true`.
    2. `valid-full.yml` → `isClean: true`.
    3. `bad-version.yml` → one fatal mentioning "migration".
    4. `bad-severity.yml` → one fatal mentioning "severityThreshold" + "medium | high | critical".
    5. `bad-ecosystems.yml` → one fatal mentioning "ecosystems".
    6. `accept-over-90d.yml` → one fatal mentioning "90" + "exceed" or "cap".
    7. `accept-expired.yml` → one fatal mentioning "past" or "already passed".
    8. `accept-short-reason.yml` → one fatal mentioning "20 characters".
    9. `accept-missing-reason.yml` → one fatal mentioning "required".
    10. `accept-duplicate.yml` → one warning mentioning "duplicate"; `isClean: true`.
    11. `common-over-365d.yml` → one fatal mentioning "365" + "exceed" or "cap".
    12. `common-expired.yml` → one fatal mentioning "past" or "already passed".
    13. `common-duplicate.yml` → one warning; `isClean: true`.
    14. Boundary: `expires` exactly 90d (supplyChainAccept) → clean.
    15. Boundary: `expires` exactly 365d (commonAndFine) → clean.
    16. Boundary: `expires` === today → clean.
    17. Combined: one expired `supplyChainAccepts` + one duplicate `commonAndFine` → one fatal, one warning, distinct messages.
  - Use the same `expandAndLoad` helper approach as the existing TOML tests.

### Implement `FindingMatcher`

- Create `src/modules/findingMatcher.ts`:
  - Imports from `./osvScannerConfig.js`, `./depauditConfig.js`, `./finding.js`.
  - `function severityRank(sev: Severity): number` returns `{UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4}[sev]`. Treat `UNKNOWN` as below `MEDIUM` — always dropped when threshold is `medium` or higher.
  - `function classifyFindings(findings: Finding[], depauditConfig: DepauditConfig, osvConfig: OsvScannerConfig, now: Date = new Date()): ClassifiedFinding[]`:
    1. `const threshold = severityRank(severityThresholdToRank(depauditConfig.policy.severityThreshold))`. (A local helper maps `"medium" → 2`, `"high" → 3`, `"critical" → 4`.)
    2. For each `finding`:
       - If `severityRank(finding.severity) < threshold`, skip it (not in the output).
       - Check `commonAndFine`: find an entry where `entry.package === finding.package && entry.alertType === finding.findingId` (for Socket-alert-style finding IDs; OSV CVEs won't match `commonAndFine` since `alertType` is a Socket concept, but the check is safe — it simply won't match). If the entry's `expires` is parseable and ≥ `now`, classify as `whitelisted` with `match: { kind: "common-and-fine", expires, reason, sourceLine }`.
       - Else check `supplyChainAccepts`: find an entry where `entry.package === finding.package && entry.version === finding.version && entry.alertType === finding.findingId` (Socket matches) — if found and non-expired, classify as `accepted`; if found but expired, classify as `expired-accept`.
       - Else check `osvConfig.ignoredVulns`: find an entry where `entry.id === finding.findingId` — if found and non-expired, classify as `accepted` with `match.kind === "ignored-vuln"`; if found but expired, classify as `expired-accept`.
       - Else, classify as `new` with `match` undefined.
    3. Return the accumulated `ClassifiedFinding[]` in input order.
  - Purely functional; `now` injectable.

### Write `FindingMatcher` unit tests

- Create `src/modules/__tests__/findingMatcher.test.ts` asserting (using in-memory `Finding` / `DepauditConfig` / `OsvScannerConfig` literals; no fixture files needed — the matcher is pure):
  1. Empty findings → `[]`.
  2. Empty configs + one finding → `[ { finding, classification: "new" } ]`.
  3. Severity threshold filter: `policy.severityThreshold === "high"`, finding of severity `"MEDIUM"` → finding is dropped (not in output at all).
  4. Severity threshold boundary: `policy.severityThreshold === "medium"`, finding of severity `"MEDIUM"` → finding is classified (retained; equality passes threshold).
  5. Severity threshold: `policy.severityThreshold === "critical"`, finding of severity `"HIGH"` → dropped.
  6. `UNKNOWN` severity: always dropped when threshold is `medium`+ (rank 0 < 2).
  7. Match precedence: an entry matches both `commonAndFine` and `supplyChainAccepts` → `whitelisted` wins over `accepted`. (This is a matter of policy — the PRD's listing order strongly implies common-and-fine is a category rule applied before specific-version accepts; we match that.)
  8. Accepted via OSV `[[IgnoredVulns]]`: finding with `findingId === "CVE-…"` and a non-expired matching `ignoredVulns[].id` → `classification: "accepted"`, `match.kind: "ignored-vuln"`.
  9. Accepted via `supplyChainAccepts`: finding with matching `(package, version, alertType)` and a non-expired entry → `classification: "accepted"`, `match.kind: "supply-chain-accept"`.
  10. Whitelisted via `commonAndFine`: finding matching `(package, alertType)` with non-expired entry (regardless of version) → `classification: "whitelisted"`.
  11. Expired accept: finding matching an `[[IgnoredVulns]]` entry whose `ignoreUntil` is in the past → `classification: "expired-accept"`.
  12. Expired whitelisted: finding matching a `commonAndFine` entry whose `expires` is in the past → NOT whitelisted — falls through to `supplyChainAccepts` / `ignoredVulns` / `new`. An expired `commonAndFine` entry does NOT produce `expired-accept` (per PRD semantics: `expired-accept` is specific to acceptances, not category whitelists). Assert this explicitly.
  13. Unrelated finding (no match anywhere, above threshold) → `"new"`, `match: undefined`.
  14. Multiple findings, mixed classifications → each finding classified independently, output preserves input order.
  15. `now` injection: construct a finding + accept where "expired" depends on `now`; pass two different `now` values and assert classification flips.

### Rewire `ScanCommand`

- Edit `src/commands/scanCommand.ts`:
  1. Load both configs: `const osvConfig = await loadOsvScannerConfig(scanPath); const depauditConfig = await loadDepauditConfig(scanPath);` (in parallel is fine via `Promise.all` but sequential is clearer and the cost is trivial).
  2. If either throws `ConfigParseError`, print the error via `printLintResult` with the right file path and return `2`.
  3. Lint both: `const osvLint = lintOsvScannerConfig(osvConfig); const yamlLint = lintDepauditConfig(depauditConfig);`. Merge fatals: if either `!isClean`, write `"Lint failed — aborting scan"` to stderr, print both results (only the non-clean ones), return `1`. If both have only warnings, print warnings and continue.
  4. Continue with `discoverManifests(scanPath)` → `runOsvScanner(manifests)`.
  5. Replace `filterAcceptedFindings(findings, osvConfig)` with `classifyFindings(findings, depauditConfig, osvConfig)`.
  6. Emit only the `new` + `expired-accept` classifications via `stdoutReporter.printFindings(classified.filter(c => c.classification === "new" || c.classification === "expired-accept").map(c => c.finding))`. (A richer Reporter that prints classification bucket headers lands in a later slice.)
  7. Return `0` iff that emitted list is empty, `1` otherwise.
- Keep `stdoutReporter.printFindings` unchanged — it still takes a `Finding[]` and prints one line per finding. The classification label is not yet part of stdout output (that is Reporter-level polish, next slice).

### Rewire `LintCommand`

- Edit `src/commands/lintCommand.ts`:
  1. Keep the path-exists check unchanged.
  2. Load both configs with the same try/catch pattern as before, but now two files (either one's `ConfigParseError` returns `2`).
  3. Run both linters.
  4. `printLintResult(osvLint, osvConfig.filePath ?? "osv-scanner.toml")` and `printLintResult(yamlLint, depauditConfig.filePath ?? ".depaudit.yml")`.
  5. Return `1` if either `!isClean`, else `0`.

### Add `@adw-5` BDD scenarios

- Extend `features/lint.feature` with an `@adw-5` section containing scenarios for the YAML rules:
  - Clean `.depaudit.yml` → exit 0.
  - Missing `.depaudit.yml` is treated as clean (just defaults).
  - Malformed `.depaudit.yml` → exit non-zero, stderr mentions `.depaudit.yml` with line/col.
  - `policy.severityThreshold: "low"` → exit non-zero, stderr mentions "severityThreshold".
  - `supplyChainAccepts[0].expires` > today + 90 days → exit non-zero, stderr mentions "90".
  - `supplyChainAccepts[0].reason` shorter than 20 chars → exit non-zero, stderr mentions "reason" + "20".
  - `commonAndFine[0].expires` > today + 365 days → exit non-zero, stderr mentions "365".
  - Duplicate `supplyChainAccepts` on `(package, version, alertType)` → exit 0, stderr mentions "duplicate".
  - `version: 99` → exit non-zero, stderr mentions "migration" or "version".
- Create `features/scan_classify.feature` (new file, all `@adw-5`) with focused scenarios for the severity threshold + classification-driven stdout:
  - Repo with one `HIGH`-severity finding, `policy.severityThreshold: "high"` → finding is reported (exit 1).
  - Repo with one `HIGH`-severity finding, `policy.severityThreshold: "critical"` → finding is dropped (exit 0, no stdout lines).
  - Repo with one finding accepted in `supplyChainAccepts` (valid non-expired) → stdout empty, exit 0.
  - Repo with one finding whose accept is in `supplyChainAccepts` but expired → stdout contains the finding (classified `expired-accept`, still reported), exit 1.
  - Repo with `commonAndFine` matching the finding → stdout empty, exit 0.
- Extend `features/step_definitions/lint_steps.ts` with:
  - `writeDepauditYaml(world, fixturePath, content)` helper (mirror of the existing `writeTomL`).
  - `Given` steps for each YAML scenario (one per scenario above — copy the existing TOML-style phrasing with "depaudit.yml" substituted).
- Create the scan-classify fixtures (`fixtures/vulnerable-npm-threshold-high/`, `fixtures/vulnerable-npm-threshold-critical/`, `fixtures/vulnerable-npm-commonfine/`, `fixtures/vulnerable-npm-supplychain-accept/`, `fixtures/vulnerable-npm-expired-supplychain/`) — all copies of `fixtures/vulnerable-npm/` with an added `.depaudit.yml` materialized at step-definition time from placeholders.
- Extend `features/step_definitions/scan_accepts_steps.ts` (or add a new `scan_classify_steps.ts`) with `Given` steps that materialize the `.depaudit.yml` for each classify scenario.
- Run `bun run test:e2e` — all `@adw-3`, `@adw-4`, and `@adw-5` scenarios must pass; no pendings.

### Smoke-test end-to-end

- From the worktree root: `bun install && bun run build`.
- Run `node dist/cli.js lint fixtures/clean-npm/`: exit 0 (no `.depaudit.yml`, no `osv-scanner.toml` — both absent, both treated as clean).
- Create a temporary `.depaudit.yml` in `fixtures/vulnerable-npm/` with `policy.severityThreshold: "critical"` and all other fields valid. Run `node dist/cli.js scan fixtures/vulnerable-npm/`: confirm stdout is empty (the `HIGH`-severity `GHSA-c2qf-rxjj-qqgw` finding from `semver 5.7.1` is below threshold) and exit is `0`.
- Change `severityThreshold` to `"high"`. Run `node dist/cli.js scan fixtures/vulnerable-npm/`: confirm stdout contains the finding, exit `1`.
- Change `severityThreshold` to `"low"` (invalid). Run `node dist/cli.js scan fixtures/vulnerable-npm/`: confirm exit `1`, stderr contains `"Lint failed"` plus the severityThreshold error.
- Delete the temporary `.depaudit.yml`.

### Run full validation

- Execute every command in the Validation Commands section below and confirm each exits 0.

## Testing Strategy

### Unit Tests

`.adw/project.md` lacks the `## Unit Tests: enabled` marker, but this plan includes unit-test tasks as a documented override — matching the precedent set by the issue #3 and issue #4 plans. Justification: (a) the GitHub issue's acceptance criteria explicitly require `Unit tests for FindingMatcher (synthetic findings + accepts) and extended Linter`, and (b) `.adw/review_proof.md` Rule 6 mandates fixture-driven unit tests covering all new rules or branches for `Linter`, `FindingMatcher`, or `ConfigLoader`. Skipping would fail both bars.

Concrete test suites:

- **`ConfigLoader` — extended `configLoader.test.ts`**: new `describe("loadDepauditConfig")` block with 5 fixture-driven cases: absent file → defaults, `empty.yml` → defaults + `version: 1`, `valid-full.yml` → fully populated, `malformed.yml` → `ConfigParseError` with `line`/`column`/`filePath`/`message`, `sourceLine` attached per entry.
- **`Linter` — extended `linter.test.ts`**: new `describe("lintDepauditConfig")` block with 17 cases: one per rule (13 rules listed in the Linter section), three boundary cases (90d / 365d / today), one combined-violations case.
- **`FindingMatcher` — new `findingMatcher.test.ts`**: 15 cases listed above. Purely in-memory — matcher is pure, no fixture files needed.

All unit tests run under `bun test` (Vitest). Date logic is deterministic via injected `now` values.

### BDD Scenarios (`@adw-5`)

- **`features/lint.feature` `@adw-5` additions** (9 scenarios): one per YAML lint rule + clean/missing/malformed baseline.
- **`features/scan_classify.feature` `@adw-5`** (5 scenarios): severity-threshold filter, supplyChainAccept suppression, expired-supplyChainAccept still-reported, commonAndFine whitelisting.
- All `@adw-5` scenarios plus the existing `@adw-3` / `@adw-4` suites must pass under `bun run test:e2e` with zero pendings.

### Edge Cases

- `loadDepauditConfig` on a `.depaudit.yml` that is present but contains only a comment — `yaml.parseDocument` returns an empty doc; `toJS()` returns `null`/`undefined`; our normalizer treats it identically to absent-file and returns defaults. Assert in a dedicated test.
- `loadDepauditConfig` on a `.depaudit.yml` whose `policy` field is present but a subset of fields is missing — merge with `DEFAULT_POLICY` so every field is populated. Assert that fields specified in YAML win over defaults.
- `lintDepauditConfig` called on a config whose `version` is `2` — schema version mismatch, emit a fatal mentioning "migration required; manual action needed" rather than attempting auto-migration (per PRD rule 8).
- `lintDepauditConfig` boundary: `expires` exactly `now + 90 days` for `supplyChainAccepts` → valid. `expires` exactly `now + 365 days` for `commonAndFine` → valid. Both `expires === today` → valid (day has not ended).
- `classifyFindings` severity boundary: finding `severity === "MEDIUM"` with threshold `"medium"` → classified (rank equality passes). With threshold `"high"` → dropped.
- `classifyFindings` with `UNKNOWN` severity → treated as rank 0, always below any non-trivial threshold, always dropped.
- `classifyFindings` when the same finding is both in `commonAndFine` and `ignoredVulns` — `whitelisted` wins (category rules applied first). Assert explicitly.
- `classifyFindings` when `commonAndFine` entry is expired and `ignoredVulns` entry matches (and is not expired) — the expired `commonAndFine` must NOT short-circuit. Falls through to the `accepted` classification via the OSV match. The PRD's "expired-accept" category is specifically for expired *acceptances*; expired `commonAndFine` entries are silently disregarded by the matcher (though `Linter` separately flags them as fatal at lint time, so in practice the scan would have aborted before classification).
- `ScanCommand` with a valid empty `.depaudit.yml` (just `version: 1`) — behaves exactly as without the file; all defaults apply. Assert via the existing `features/scan.feature` tests still passing.
- `.depaudit.yml` with unknown top-level fields (e.g., `foo: bar`) — `ConfigLoader` ignores them (forward-compat); `Linter` does not flag them. Assert with a fixture.

## Acceptance Criteria

- `bun add yaml` has run; `yaml` appears in `package.json` `dependencies`; `bun.lock` is committed with the resolution.
- `src/types/depauditConfig.ts` exists with all canonical YAML-schema and classifier types plus `DEFAULT_POLICY`.
- `ConfigLoader` gains `loadDepauditConfig(repoRoot)` returning a typed `DepauditConfig`; parse errors throw `ConfigParseError` carrying `filePath`, `line`, `column`, `message`; absent file returns a fully-populated default config; `sourceLine` attached per entry.
- `Linter` gains `lintDepauditConfig(config, now?)`, pure, returning `{ errors, warnings, isClean }`. Every PRD rule applicable to the YAML is implemented: schema version (halt on mismatch with migration guidance), `severityThreshold` enum, `ecosystems` enum/array, `maxAcceptDays` ≤ 90 cap, `maxCommonAndFineDays` ≤ 365 cap, `supplyChainAccepts.expires` 90d cap / not-past / ISO-8601, `supplyChainAccepts.reason` ≥ 20 chars, `commonAndFine.expires` 365d cap / not-past / ISO-8601, duplicate detection on both arrays (as warnings).
- `FindingMatcher` (`src/modules/findingMatcher.ts`) exports `classifyFindings(findings, depauditConfig, osvConfig, now?)` returning `ClassifiedFinding[]` with the four-way classification `new | accepted | whitelisted | expired-accept`. Severity threshold filter drops findings below `policy.severityThreshold` from the output entirely (they do not become `new`).
- `depaudit scan` loads and lints both config files; aborts on parse error (exit 2) or fatal lint (exit 1) from either; on success, classifies findings and emits only the `new` + `expired-accept` subset; exits `0` iff that subset is empty.
- `depaudit lint` loads and lints both config files; prints each result; exits `0` (clean/warnings-only), `1` (fatal from either), `2` (parse error from either).
- Vitest unit tests exist for `loadDepauditConfig`, `lintDepauditConfig`, and `classifyFindings`, all passing under `bun test`. Existing `configLoader`, `linter`, and `findingFilter` tests continue to pass unchanged.
- `bun run typecheck` exits 0.
- `bun run build` exits 0 and produces `dist/modules/findingMatcher.js`, `dist/types/depauditConfig.js`, and the extended `dist/modules/configLoader.js` / `dist/modules/linter.js`.
- `UBIQUITOUS_LANGUAGE.md` terms preserved: new code uses **`FindingMatcher`**, **Common-and-fine entry**, **Severity threshold**, **Acceptance**, **Acceptance Register**; avoids "allowlist" except for `commonAndFine`; avoids "classifier" outside the module's internal documentation.
- Existing `features/scan.feature` (`@adw-3`) and `features/lint.feature` / `features/scan_accepts.feature` (`@adw-4`) scenarios all continue to pass — the new YAML pre-flight is a no-op when `.depaudit.yml` is absent (the case for the `@adw-3` / `@adw-4` fixtures that predate this slice).
- New `@adw-5` scenarios in `features/lint.feature` and `features/scan_classify.feature` pass via `bun run test:e2e`, backed by the new `fixtures/vulnerable-npm-threshold-*` / `fixtures/vulnerable-npm-commonfine/` / `fixtures/vulnerable-npm-supplychain-accept/` / `fixtures/vulnerable-npm-expired-supplychain/` fixture families.
- `depaudit scan` on a repo with `.depaudit.yml` declaring `policy.severityThreshold: "critical"` produces no stdout findings for a `HIGH`-severity finding and exits `0` — manually verifiable via the smoke-test step.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions. Project-specific entries sourced from `.adw/commands.md`.

- `bun install` — resolves and installs all dependencies including the new `yaml`.
- `bun run typecheck` — `tsc --noEmit`; must report zero type errors across `src/`.
- `bun run build` — `tsc`; produces `dist/` with all new modules; exit 0.
- `test -x dist/cli.js` — confirms the compiled CLI entry remains executable after `postbuild`.
- `bun test` — runs Vitest; all unit tests pass, including the new `loadDepauditConfig`, `lintDepauditConfig`, and `findingMatcher` suites. No pre-existing tests fail.
- `node dist/cli.js --help` — USAGE output remains well-formed; exit 0.
- `node dist/cli.js lint fixtures/clean-npm/` — exit 0, no stderr (no `.depaudit.yml` and no `osv-scanner.toml` — both treated as clean).
- `bun run test:e2e` — all Cucumber scenarios pass: `@adw-3` (`features/scan.feature`), `@adw-4` (`features/lint.feature`, `features/scan_accepts.feature`), and new `@adw-5` (`features/lint.feature` extensions and `features/scan_classify.feature`). No scenarios skipped or pending.

> Note: `bun run lint` (JS/TS code linter) is listed in `.adw/commands.md` but no tool is configured in `package.json`. Per the issue #3 and issue #4 plan notes, this command is deliberately excluded until a follow-up chore adds a JS/TS linter (Biome or oxlint). Validation here relies on `typecheck` + `test` + `build` + `test:e2e`.

## Notes

- No `guidelines/` directory exists in this repository, so coding-style adherence falls back to the deep-module conventions documented in `.adw/project.md` and the PRD.
- **Library install**: per `.adw/commands.md` Library Install Command (`bun add {library}`), the new runtime dependency `yaml` is added via `bun add yaml`. Rationale for `yaml` v2 over alternatives: zero-dep, ISC-licensed, modern TypeScript-native, already a transitive dependency (add is effectively free), and `parseDocument(text).errors[i].linePos[0]` supplies `{ line, col }` required by the PRD's "surfaces parse errors with line/col" requirement. `js-yaml` was considered but its error objects do not surface line/col as cleanly; migration back would be trivial if needed.
- **Unit tests override**: `.adw/project.md` lacks `## Unit Tests: enabled`. This plan includes unit-test tasks because the GitHub issue's acceptance criteria and `.adw/review_proof.md` Rule 6 both require them — same precedent established in the issue #3 and #4 plans.
- **Issue body typo**: the issue body says `supplyChainAccepts` is "stub for now; filled in #5" — this is self-referential and appears to be a typo (likely meant issue #6, or meant to say "fully wired alongside Socket integration later"). This plan implements `supplyChainAccepts` fully in the YAML schema, `ConfigLoader`, `Linter`, and `FindingMatcher`. End-to-end `supplyChainAccepts` exercise against real Socket findings is not possible at this slice (there is no `SocketApiClient` yet), but the matcher's `supply-chain-accept` path is fully unit-tested with synthetic `Finding` objects of `source: "socket"`. The existing `Finding` type's `source: "osv" | "socket"` union already accommodates synthetic Socket findings in tests.
- **`findingFilter` retention**: `src/modules/findingFilter.ts` is not deleted by this slice even though `classifyFindings` subsumes its logic. The rationale: the matcher is larger and its test surface is independently valuable; deleting `findingFilter` would force its tests to be rewritten against `classifyFindings` with more setup. Keeping both is strictly additive and costs one line of dead code that a future cleanup slice can remove once the matcher has full coverage-parity documented in the review transcript. `ScanCommand` now calls `classifyFindings`, not `filterAcceptedFindings` — the filter module is purely there for its tests to keep documenting the contract `classifyFindings` maintains on the OSV-accept branch.
- **Classification-driven stdout is deferred**: at this slice, `stdoutReporter.printFindings` still emits one line per `Finding` with no classification label. The richer Reporter that groups output by bucket (`New findings`, `Expired accepts`, etc.) lands alongside `MarkdownReporter` / `JsonReporter` in a later slice. For now, `ScanCommand` simply filters to `new` + `expired-accept` before handing to the existing reporter.
- **No scan-time mutation added**: per the PRD, `depaudit scan` auto-prunes orphaned accept entries. That logic needs `.depaudit.yml` write capability and the Socket adapter's availability signal (fail-open guard) — both out of scope for this slice. `ScanCommand` remains read-only against both config files at this point.
- **Severity comparator**: severity ranks map as `UNKNOWN:0 < LOW:1 < MEDIUM:2 < HIGH:3 < CRITICAL:4`. Threshold comparison uses `>=` so a finding at exactly the threshold level is included. `UNKNOWN` is always below any non-trivial threshold (`medium` is the default lowest permitted threshold per the `SeverityThreshold` enum) so `UNKNOWN` findings are always dropped. This matches user intuition: "I set the threshold to medium" means "I want medium and above."
- **Precedence when multiple matches apply**: `commonAndFine` → `supplyChainAccepts`/`ignoredVulns` → `new`. Category-wide whitelists win over per-version acceptances because they represent a conscious "this is always fine" decision across versions; specific-version acceptances represent temporary exceptions. A finding matching both is unambiguously `whitelisted`.
- **Expired `commonAndFine`**: does NOT produce `expired-accept`. The `expired-accept` category is specifically for *acceptances* (`supplyChainAccepts` and `ignoredVulns`) whose expiry has lapsed, flagging them for re-review. Expired `commonAndFine` entries are caught by the `Linter` as fatal before any classification runs — so in practice the scan aborts. The classifier still handles the theoretical case (if a caller skipped linting) by ignoring the expired entry and falling through to the next match rule.
- **Deferred (explicitly left for later slices)**: `SocketApiClient`, `StateTracker`, `Reporter` composite (`MarkdownReporter`/`JsonReporter`/`SlackReporter`), `DepauditSetupCommand`, `.depaudit/findings.json` persistence, auto-prune of orphaned entries, GitHub Actions workflow scaffolding, ADW integration hooks, classification-labeled stdout, polyglot ecosystems beyond `npm`, the `/depaudit-triage` Claude Code skill.
