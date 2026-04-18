# Feature: JsonReporter → `.depaudit/findings.json`

## Metadata
issueNumber: `8`
adwId: `a093bk-jsonreporter-depaudi`
issueJson: `{"number":8,"title":"JsonReporter → .depaudit/findings.json","body":"## Parent PRD\n\n`specs/prd/depaudit.md`\n\n## What to build\n\n`JsonReporter` writes classified scan results to `.depaudit/findings.json` (deterministic path, gitignored) as canonical JSON consumable by `/depaudit-triage` (future slice). Schema includes, per finding: package, version, ecosystem, manifest path, finding-id, severity, summary, classification (`new` / `accepted` / `whitelisted` / `expired-accept`), source (`osv` / `socket`), and — where applicable — upgrade suggestion.\n\nAlso: ensure `.gitignore` excludes `.depaudit/findings.json`; if not present, the CLI prints a warning (doesn't modify `.gitignore` in `scan` — that's `DepauditSetupCommand`'s job).\n\n## Acceptance criteria\n\n- [ ] `.depaudit/findings.json` is written on every `depaudit scan` run (stable, documented schema).\n- [ ] Schema supports every classification category from `FindingMatcher`.\n- [ ] Schema carries `sourceAvailability` (osv/socket) so the triage skill can reason about fail-open state.\n- [ ] If `.depaudit/findings.json` is not gitignored, warning to stdout (but no fatal).\n- [ ] Snapshot tests for `JsonReporter` output.\n\n## Blocked by\n\n- Blocked by #7\n\n## User stories addressed\n\n- User story 23 (prep; skill work in later ADW issue)\n","state":"OPEN","author":"paysdoc","labels":[],"createdAt":"2026-04-17T13:24:40Z","comments":[],"actionableComment":null}`

## Feature Description

Introduces a new deep module, `JsonReporter`, which materialises the output of `classifyFindings` as a canonical JSON document at `.depaudit/findings.json` on every `depaudit scan` run. The file is the contract surface for the (future) `/depaudit-triage` Claude Code skill: it must be deterministic, schema-stable, self-describing enough that the skill can walk findings one at a time and reason about which classification each finding fell into, and rich enough to explain *why* a finding was or wasn't gated (severity, source, source-availability, acceptance metadata, upgrade suggestion where available).

The schema carries every classification category the `FindingMatcher` emits (`new` / `accepted` / `whitelisted` / `expired-accept`) plus the originating source (`osv` / `socket`), the manifest path that contributed the finding, and a top-level `sourceAvailability` object keyed by source (`{ osv: "available" | "unavailable", socket: "available" | "unavailable" }`) so the triage skill can distinguish "no supply-chain findings" from "supply-chain results are missing this run because Socket was unreachable." An optional per-finding `upgradeSuggestion` field is included in the schema from day one (populated as `null` in this slice — the resolver lives in a later slice, but the shape must not churn).

`JsonReporter` is wired into `ScanCommand` as the penultimate step (after `classifyFindings`, before the stdout print and the exit-code return). `ScanCommand` itself is extended to own the filesystem I/O: it ensures `<scanPath>/.depaudit/` exists, writes `findings.json` to it, then — separately — consults `.gitignore` in the same `scanPath` and emits a one-line **stdout** warning if `.depaudit/findings.json` is not covered by an ignore rule. The warning is informational; it never flips the exit code, never modifies `.gitignore` (that's `DepauditSetupCommand`'s job per the issue body), and never appears when the path is already ignored. Lint-failure and config-parse early-exits write an *empty-but-valid* findings file so downstream triage tooling can always rely on the path existing.

No new runtime dependency; only `node:fs/promises` and `node:path` which are already in use. The module exposes a pure in-memory render (`renderFindingsJson`) so snapshot tests assert on the JSON string itself (deterministic via key-sorted object construction and `JSON.stringify(..., null, 2)`) without needing to round-trip through the filesystem.

## User Story

As a maintainer of a repository whose `depaudit scan` output will be consumed by the `/depaudit-triage` Claude Code skill (PRD user story 23 — prep slice)
I want every `depaudit scan` run to leave a canonical, schema-stable `.depaudit/findings.json` on disk
So that the triage skill — and, later, a UI wrapper — can walk the classified findings one at a time without re-running the scan, can distinguish "no findings" from "Socket was unavailable," and can surface per-finding upgrade suggestions (when the later resolver slice lands) without any schema churn.

## Problem Statement

Today the `ScanCommand` pipeline (`src/commands/scanCommand.ts:57-151`) terminates by (a) invoking `printFindings` on the `new` bucket, (b) emitting stderr annotations for expired-accepts and Socket unavailability, and (c) returning a numeric exit code. There is **no persistent artifact** of the run — every accepted, whitelisted, and expired-accepted finding is invisible to any consumer outside the process. This blocks several downstream capabilities that the PRD explicitly names:

1. **No JSON artifact exists.** `src/modules/` has `stdoutReporter.ts` and `lintReporter.ts` but no `jsonReporter.ts`. The PRD module list names `JsonReporter` alongside `MarkdownReporter` and `SlackReporter` under `Reporter` (`specs/prd/depaudit.md:204`). `.depaudit/findings.json` is already defined as a first-class in-repo artifact (`specs/prd/depaudit.md:121`, `UBIQUITOUS_LANGUAGE.md:31`). Nothing writes it yet.

2. **The `/depaudit-triage` skill is unimplementable.** The skill's contract (`specs/prd/depaudit.md:210-221`) begins "Locates `.depaudit/findings.json` in the current working directory" and "Walks findings one at a time, static snapshot (no auto re-scan …)." Without the file, the skill has nothing to read. User story 23 explicitly wants a **static snapshot** so the skill does not stall on repeated network round-trips (`specs/prd/depaudit.md:69`). This slice unblocks that story's prep work (the skill itself is a later ADW issue per the issue body).

3. **Fail-open source availability is not observable by downstream consumers.** `ScanCommand` returns `{ findings, socketAvailable, exitCode }` (`src/types/scanResult.ts:1-7`). In-process that is enough, but the triage skill runs in a separate process (a Claude Code session) and reads *only* the filesystem snapshot. Without a serialized `sourceAvailability` field in the findings file, the skill cannot tell the difference between "Socket returned zero supply-chain findings" and "Socket timed out and we fell open" — two very different states for remediation advice (in the first case, there's nothing to triage; in the second, the gate has a known blind spot this run and re-running later may surface new findings).

4. **The `.gitignore` safety net has no runtime enforcement.** `DepauditSetupCommand` is specified to append `.depaudit/findings.json` to `.gitignore` during bootstrap (`specs/prd/depaudit.md:160`). In repos that pre-date the setup command, or where a user edited `.gitignore` and dropped the line, the findings artifact could be silently committed. The `scan` command is explicitly **not** allowed to mutate `.gitignore` (issue body: *"doesn't modify `.gitignore` in `scan` — that's `DepauditSetupCommand`'s job"*), but it should notice the footgun and warn. Without this check, a user with a mis-configured repo can accidentally commit a large, churn-prone JSON file.

5. **Schema stability has no snapshot proof.** `.adw/review_proof.md` **Rule 7** specifically names `JsonReporter` alongside `MarkdownReporter` as a reporter whose output must be verified via snapshot assertions. Without an in-repo snapshot, every future edit to the reporter risks a silent contract break that downstream skill code would absorb.

6. **Classification categories other than `new` are opaque.** The current stdout reporter prints only the `new` bucket. Accepted, whitelisted, and expired-accept findings exist in the `ClassifiedFinding[]` that `classifyFindings` returns (`src/modules/findingMatcher.ts:41-92`), but they leave no trace beyond a short stderr line for expired-accepts (`scanCommand.ts:144-147`). The triage skill needs all four categories to present a "status at a glance" view to the user ("you have 3 new findings, 7 accepted, 12 whitelisted, 2 expired-accepts needing re-review").

The consequence of skipping this slice is: the dual-output (CLI gate + interactive triage) promise of the PRD stays theoretical. The gate half works; the triage half has no input file.

## Solution Statement

Introduce `JsonReporter` as a deep module that renders (in memory) and writes (to disk) the canonical findings document, and extend `ScanCommand` to call it on every run — including the lint-failure and config-parse-failure early-exits, so the artifact always exists.

Specifically:

- **New `src/modules/jsonReporter.ts`** — exports `renderFindingsJson(result)` (pure, deterministic) and `writeFindingsFile(scanPath, result)` (filesystem I/O). The pure function produces the JSON *string*; the writer ensures `<scanPath>/.depaudit/` exists and writes `<scanPath>/.depaudit/findings.json`. The separation lets snapshot tests assert on the string without mocking the filesystem and lets integration tests assert on the file on disk without re-rendering.

- **Schema (`FindingsJsonV1`)** — top-level object with an explicit `schemaVersion: 1`, a `generatedAt` ISO-8601 UTC timestamp (injected, so snapshot tests can pass a frozen date), a `sourceAvailability: { osv: "available" | "unavailable", socket: "available" | "unavailable" }` map, a `counts` summary keyed by category (`new`, `accepted`, `whitelisted`, `expiredAccept`), and a `findings: FindingRecord[]` array. Each `FindingRecord` carries `package`, `version`, `ecosystem`, `manifestPath`, `findingId`, `severity`, `summary` (the Finding's description; may be null), `classification` (one of the four `FindingCategory` values re-expressed in camelCase: `new`/`accepted`/`whitelisted`/`expiredAccept`), `source` (`"osv"` or `"socket"`), and `upgradeSuggestion: null` (reserved for the later slice; shipped as `null` today so the schema doesn't churn when the resolver lands). Keys are written in insertion order — insertion order is controlled by the reporter and is the contract surface.

- **Deterministic output.** (a) Top-level key order fixed. (b) `findings` array sorted stably by a tuple of `(classification, ecosystem, package, version, findingId, manifestPath)` — same compound ordering as the existing `stdoutReporter` would produce if it sorted (it doesn't, but the triage skill needs predictable ordering so successive scans on an unchanged tree produce a byte-identical file, making git diffs trivially reviewable *on the rare occasions a user chooses to commit the file* or inspects a CI artifact). (c) `JSON.stringify(..., null, 2)` for human-readability.

- **Category re-encoding.** `FindingCategory` is `"new" | "accepted" | "whitelisted" | "expired-accept"` (`src/types/depauditConfig.ts:38`). In the JSON output, `expired-accept` becomes `expiredAccept` so the schema is pure camelCase and JSON-consumer-ergonomic (the hyphen variant is preserved in the internal TypeScript domain but does not leak into the external contract). The mapping is a one-line helper in `jsonReporter.ts`; no types change.

- **`counts` summary.** Four integer fields (`new`, `accepted`, `whitelisted`, `expiredAccept`) for O(1) access by the triage skill. Computed in the reporter from the findings array, not threaded through from `classifyFindings` — keeps the reporter self-contained.

- **`sourceAvailability`.** Derived from the `ScanResult.socketAvailable` boolean and a new implicit OSV availability field. Today OSV-Scanner either succeeds or aborts the whole run (`osvScannerAdapter.ts`'s error re-throw arm at `:53-57` of its test file), so `osv` is always `"available"` in any JSON file we write — but including the key in the schema from day one means the field is in place for the future possibility of fail-open-on-OSV-error (out of scope here, but aligned with the PRD's general "don't ship a breaking schema change later" principle). The early-exit paths (lint failure, config parse error) also emit `{ osv: "available", socket: "available" }` because those paths exit before either source is consulted — "no information recorded" is conceptually closer to "available but no findings" than to "unavailable." This is called out in the schema doc comment so the skill author knows to read the `exitCode` alongside the `sourceAvailability`.

- **Wire into `ScanCommand`.** Call `writeFindingsFile` at three points:
  1. **Success path.** After `classifyFindings(...)` returns, before the stdout print. This is the main case.
  2. **Lint failure.** Before the early-exit at `scanCommand.ts:93` — write an empty-findings file (`findings: []`, `counts: { new: 0, accepted: 0, whitelisted: 0, expiredAccept: 0 }`, `sourceAvailability: { osv: "available", socket: "available" }`). The triage skill reading this will see an empty findings set and an `exitCode: 1`-aligned state.
  3. **Config parse error.** Before both early-exits at `scanCommand.ts:67` and `scanCommand.ts:81` — same empty-findings file as the lint-failure path.
  - Rationale: downstream tools should be able to count on the file existing whenever `depaudit scan` has been invoked at all. "File missing" should mean "scan never ran," not "scan ran but hit an error."
  - Socket auth-error early-exit (`scanCommand.ts:127-131`) also writes the empty file, with `sourceAvailability.socket = "unavailable"` to reflect that Socket specifically could not be consulted.

- **`.gitignore` detection.** After writing the file, `ScanCommand` reads `<scanPath>/.gitignore` (if it exists), feeds it to the same `ignore` library already used by `ManifestDiscoverer` (`src/modules/manifestDiscoverer.ts:25-29`), and tests whether the relative path `.depaudit/findings.json` is ignored. If not, emit **exactly one line** to stdout: `warning: .depaudit/findings.json is not gitignored — add '.depaudit/' to your .gitignore or run 'depaudit setup'`. Missing `.gitignore` file → warn (user probably wants one and definitely wants this path ignored). Empty `.gitignore` → warn. Non-existent `scanPath/.gitignore` → warn. No mutation of `.gitignore` ever. Never flips the exit code. This keeps the warning discoverable for users running locally (where `depaudit setup` may never have been invoked) while staying true to the single-responsibility split: `scan` reads; `setup` writes.

- **New `src/modules/jsonReporter.ts` exports:**
  - `interface FindingsJsonV1` — full schema type.
  - `interface FindingRecord` — per-finding sub-type.
  - `function renderFindingsJson(input: RenderInput): string` — the pure renderer.
  - `function writeFindingsFile(scanPath: string, input: RenderInput): Promise<void>` — the writer; ensures directory exists via `mkdir(..., { recursive: true })`.
  - `function checkGitignore(scanPath: string): Promise<{ ignored: boolean; reason: "missing" | "not-matched" | "ok" }>` — the detector; non-throwing.
  - `function printGitignoreWarning(check, stream?)` — the stdout emitter; called by `ScanCommand` when `ignored === false`.
  - `type RenderInput = { findings: ClassifiedFinding[]; socketAvailable: boolean; osvAvailable?: boolean; generatedAt: Date }` — explicit inputs; `generatedAt` is injected so tests can freeze time.

- **`ScanCommand` changes:**
  - Add a single pre-return block that (a) calls `writeFindingsFile(scanPath, { findings, socketAvailable, osvAvailable: true, generatedAt: new Date() })`, (b) calls `checkGitignore(scanPath)`, (c) calls `printGitignoreWarning` if needed.
  - Factor the block into a local helper `finalize(scanPath, result)` called from all six exit points (success, lint-fail, two config-parse-fail, socket-auth-fail, and — if reached — any other synchronous exit).
  - No change to the `ScanResult` shape or to the CLI.

- **Snapshot tests** (new file `src/modules/__tests__/jsonReporter.test.ts`):
  - "empty result" — no findings, both sources available → canonical empty-findings snapshot.
  - "mixed classifications" — four findings, one per category (`new`, `accepted`, `whitelisted`, `expiredAccept`), a mix of `osv` and `socket` sources, across two ecosystems (`npm`, `pip`), two manifests → canonical mixed snapshot. This is the primary schema-contract assertion.
  - "socket unavailable" — single OSV finding plus `socketAvailable: false` → snapshot shows `sourceAvailability.socket === "unavailable"` and counts match.
  - "deterministic ordering" — three findings presented in shuffled input order → output JSON byte-identical across two runs (asserts stable sort).
  - "category mapping" — a finding with internal `FindingCategory: "expired-accept"` → JSON `classification: "expiredAccept"` (regression guard for the hyphen→camelCase translation).
  - "summary field optional" — a finding whose `summary` is `undefined` in the domain → JSON field rendered as `null` (explicit null, not absent key, so the schema's field set is stable).
  - "upgradeSuggestion placeholder" — every finding carries `upgradeSuggestion: null` until the resolver slice lands → regression guard for the reserved field.
  - "counts sanity" — 3 new, 2 accepted, 1 whitelisted, 1 expired-accept → `counts === { new: 3, accepted: 2, whitelisted: 1, expiredAccept: 1 }`.
  - "generatedAt is a valid ISO-8601 UTC string" — given a fixed `Date` input, the rendered field is the input's `.toISOString()`.

- **Writer tests** (same test file, using `tmpdir()` via `node:os.tmpdir()` + a unique per-test subdir, cleaned up in a `beforeEach/afterEach`):
  - "creates `.depaudit/` if missing".
  - "overwrites the previous `findings.json` in place" (idempotency).
  - "writes the same byte sequence as `renderFindingsJson`" (round-trip).

- **Gitignore-detection tests** (same test file, using `tmpdir()` again):
  - "no `.gitignore` file → `ignored: false, reason: 'missing'`".
  - "`.gitignore` present but doesn't cover the path → `ignored: false, reason: 'not-matched'`".
  - "`.gitignore` contains `.depaudit/` → `ignored: true, reason: 'ok'`".
  - "`.gitignore` contains `.depaudit/findings.json` explicitly → `ignored: true, reason: 'ok'`".
  - "`.gitignore` contains `**/*.json` broad pattern that matches → `ignored: true, reason: 'ok'`".

- **BDD coverage** (new `features/scan_findings_json.feature`, tagged `@adw-8`). Scenarios directly derived from the issue's acceptance criteria:
  1. `.depaudit/findings.json` is written on a clean scan.
  2. `.depaudit/findings.json` is written on a vulnerable scan and its content is valid JSON with `counts.new > 0`.
  3. `.depaudit/findings.json` is written when `lint` fails (early-exit path) with `findings: []`.
  4. `.depaudit/findings.json` carries `sourceAvailability.socket === "unavailable"` when the Socket mock is a 5xx and the scan fails open (reuses the mock server infrastructure from `@adw-7`).
  5. Classification `expiredAccept` appears in the JSON when an OSV `IgnoredVulns` entry is expired (mirrors the existing `@adw-4` expired-accept scenario's setup).
  6. `depaudit scan` warns to stdout when `.depaudit/findings.json` is not gitignored.
  7. `depaudit scan` does **not** warn when `.gitignore` contains `.depaudit/`.
  8. `depaudit scan` does **not** modify `.gitignore` under any of the above conditions (assertion on file mtime or byte equality before/after).

- **Step definitions** in a new `features/step_definitions/scan_findings_json_steps.ts`. Uses the same `DepauditWorld` instance + process-env + `execFile` machinery as the other step files. New fixture repos under `fixtures/findings-json-*`.

- **UBIQUITOUS_LANGUAGE update.** Add a row to the Modules table: **`JsonReporter`** — "Deep module that renders the scan's classified Findings as `.depaudit/findings.json`, the snapshot consumed by `/depaudit-triage`." No schema changes elsewhere.

## Relevant Files
Use these files to implement the feature:

- `README.md` — Always included per `.adw/conditional_docs.md`; confirms the env-var contract and project structure. No README edit required (this slice adds a module that the structure section already anticipates — the `Reporter` slot under `src/modules/`).
- `specs/prd/depaudit.md` — Authoritative source for `JsonReporter`'s module contract (`:204`), the `.depaudit/findings.json` artifact definition (`:121`), the triage skill's contract (`:210-221`), PRD user story 23 (`:69`), and the testing decisions that call out `JsonReporter — snapshot assertions on .depaudit/findings.json` (`:241`). Referenced in the Conditional Documentation guide for architecture / module-boundary work.
- `UBIQUITOUS_LANGUAGE.md` — Has a row for `.depaudit/findings.json` already (`:31`). This slice adds a `JsonReporter` row to the Modules table (`:39-48`) so the glossary stays in sync with the code.
- `.adw/project.md` — Deep-module layout (`src/modules/`, `src/modules/__tests__/`), stack (Bun, TypeScript strict, Vitest, ESM `.js` imports). No `## Unit Tests` marker — see Notes for the override precedent (same as issues #3–#7 plans).
- `.adw/commands.md` — Validation commands: `bun install`, `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`, `bun run test:e2e`, `bun run test:e2e -- --tags "@{tag}"`.
- `.adw/review_proof.md` — **Rule 7**: "For changes to reporter output (`MarkdownReporter`, `JsonReporter`): confirm snapshot assertions are updated and match the intended output." Directly mandates snapshot tests for every schema branch. **Rule 3** (`bun test` green) applies universally.
- `.adw/conditional_docs.md` — Confirms `README.md` and `specs/prd/depaudit.md` are the always-load docs; references `app_docs/feature-*` for module history.
- `.adw/scenarios.md` — Defines the `features/` directory and the tag-based runner. New `@adw-8` tag is consistent with the existing pattern (`@adw-3`–`@adw-7`).
- `.adw/review_proof.md` — Rule 7 referenced above; Rule 4 ("confirm the code diff matches the PR description — no undeclared changes") guides the scope of the slice (one module + one file write + one CLI warning; no gratuitous refactoring of unrelated files).
- `app_docs/feature-442uul-cli-skeleton-osv-scan.md` — Documents the existing `ScanCommand` pipeline and `Finding` type; confirms the pipeline this slice's `finalize` helper attaches to.
- `app_docs/feature-5sllud-depaudit-yml-schema-finding-matcher.md` & `app_docs/feature-m8fl2v-depaudit-yml-schema-finding-matcher.md` — Document `FindingMatcher`'s four-way classification; confirm the `FindingCategory` union this slice's JSON schema enumerates.
- `app_docs/feature-ekjs2i-socketapiclient-supply-chain.md` & `app_docs/feature-kteamd-socketapiclient-supply-chain.md` — Document the `ScanResult.socketAvailable` field and the Socket mock-server infrastructure reused by `@adw-8` BDD.
- `src/commands/scanCommand.ts` — Primary change site. Inject `finalize(scanPath, result)` at each of the six exit points; add `osvAvailable` boolean (always `true` in this slice but future-proof). No change to return shape.
- `src/cli.ts` — No change. The CLI just passes the exit code through; all new behaviour is internal to `ScanCommand`.
- `src/commands/lintCommand.ts` — No change. `depaudit lint` does not produce a findings file; the JSON artifact is a `scan`-only concern.
- `src/types/finding.ts` — Reused. `FindingSource`, `Ecosystem`, `Severity` are all re-exported into the JSON schema.
- `src/types/manifest.ts` — No change; already the owner of the `Manifest` tuple.
- `src/types/depauditConfig.ts` — `FindingCategory` is read-only input to the reporter. No change.
- `src/types/scanResult.ts` — No change; the reporter takes an explicit `RenderInput` shape and does not serialize the `ScanResult` directly (avoids coupling the public JSON contract to the in-process return type).
- `src/modules/manifestDiscoverer.ts` — Source of reference for the `ignore` library usage pattern (lines `:25-29`). The `.gitignore` detector in `JsonReporter` mirrors the same initialization code.
- `src/modules/stdoutReporter.ts` — Sibling. No change; its output is unchanged; the JSON file is an additional, parallel output not a replacement.
- `src/modules/lintReporter.ts` — Sibling; same pattern of "small module, one function, one side effect." Used as a shape reference for `jsonReporter.ts`.
- `src/modules/findingMatcher.ts` — Produces the `ClassifiedFinding[]` this slice serializes. No change; the reporter is downstream-only.
- `features/step_definitions/scan_steps.ts` & `scan_accepts_steps.ts` — Reference patterns for fixture-loading and run-assertion steps. New `scan_findings_json_steps.ts` mirrors their style.
- `features/scan_socket_supply_chain.feature` & `features/step_definitions/scan_socket_supply_chain_steps.ts` — Source of the mock-Socket-server infrastructure reused by `@adw-8` scenario 4.
- `features/support/world.ts` — Already carries `fixturePath`, `socketMockUrl`, `result`, `writtenFiles`. No new field needed; fixture-specific state is local to the new step file.
- `features/support/mockSocketServer.ts` — Reused as-is.
- `fixtures/` — Reused for existing clean/vulnerable npm repos as scenario inputs; new sub-repos created for the gitignore and lint-fail scenarios.
- `.gitignore` (repo root of this project) — Already contains `.depaudit/` (`:4`). No change; this slice uses that line as evidence for the detection-matrix test, not as a target for mutation.

### New Files

- `src/modules/jsonReporter.ts` — the new deep module. Exports listed in the Solution Statement. No decorators, no classes; pure functions + one filesystem-side-effect function.

- `src/modules/__tests__/jsonReporter.test.ts` — Vitest suite. Uses `toMatchInlineSnapshot` for the small canonical snapshots (empty, single-finding) and `toMatchFileSnapshot` (or equivalent — whichever Vitest 3 prefers) for the larger mixed-classification snapshot. Covers every bullet enumerated under "Snapshot tests" and "Writer tests" and "Gitignore-detection tests" in the Solution Statement.

- `src/modules/__tests__/fixtures/jsonReporter/mixed-classifications.json` — the materialised expected file for the mixed-snapshot test (if `toMatchFileSnapshot` is used). Committed so reviewers see the contract in diff form.

- `src/modules/__tests__/fixtures/jsonReporter/empty-scan.json` — the materialised expected file for the empty-findings snapshot.

- `src/modules/__tests__/fixtures/jsonReporter/socket-unavailable.json` — the materialised expected file for the fail-open snapshot.

- `features/scan_findings_json.feature` — new `@adw-8` BDD feature file covering all 8 scenarios listed in the Solution Statement. Scenarios reuse existing fixture repos where possible (`fixtures/clean-npm`, `fixtures/vulnerable-npm`, `fixtures/socket-5xx-clean`) and add new ones for the gitignore-present/absent cases.

- `features/step_definitions/scan_findings_json_steps.ts` — step definitions for the new feature file. Reads `.depaudit/findings.json` from the fixture path after the scan, parses it, asserts on the top-level keys, `counts`, `sourceAvailability`, and representative `findings[].classification` values. Uses `node:fs/promises` + `JSON.parse` — no dependency on `jsonReporter.ts`'s types (BDD is a black-box test of the on-disk contract).

- `fixtures/findings-json-clean-no-gitignore/` — npm fixture with no `.gitignore`; drives scenario 6 (stdout warning).
- `fixtures/findings-json-clean-with-gitignore/` — npm fixture whose `.gitignore` contains `.depaudit/`; drives scenario 7 (no warning).
- `fixtures/findings-json-clean-with-explicit-gitignore/` — npm fixture whose `.gitignore` contains the exact `.depaudit/findings.json` path; drives the same-no-warning assertion for the explicit-path case.
- `fixtures/findings-json-lint-fail/` — npm fixture with a malformed `osv-scanner.toml` so the lint step fails; drives scenario 3 (empty file still written).

## Implementation Plan

### Phase 1: Foundation — types and pure renderer

Ship `renderFindingsJson` as a pure function keyed off a minimal `RenderInput` shape, with an explicit `generatedAt: Date`, so the function is trivially testable without touching the filesystem. Commit a snapshot of the empty-result case and the mixed-classifications case to establish the schema contract in source control before any `ScanCommand` wiring. This phase includes the `FindingCategory` → `"expiredAccept"` hyphen-to-camelCase translation and the deterministic `findings[]` sort.

### Phase 2: Core Implementation — filesystem writer and gitignore detector

Add `writeFindingsFile` and `checkGitignore` around the pure renderer. The writer uses `mkdir(..., { recursive: true })` + `writeFile` — no locking, no temp file (the file is a snapshot, not a mutation of a shared resource, and the scan is single-process). The detector uses the same `ignore` library already in use by `ManifestDiscoverer`. Add the writer and detector unit tests against `tmpdir()`-scoped fixtures.

### Phase 3: Integration — `ScanCommand` wiring and BDD coverage

Factor a `finalize(scanPath, renderInput)` local helper inside `ScanCommand` and call it at each of the six exit points (success, two config-parse-fail, lint-fail, socket-auth-fail, and any unexpected re-throw branch). The success-path `renderInput` carries the real `findings` and `socketAvailable`; the early-exit paths carry `[]` and appropriate source-availability. Add the `@adw-8` BDD feature file and step definitions, using fresh fixture repos for the gitignore-matrix and the lint-fail case, and the existing `@adw-7` mock-server infrastructure for the socket-unavailable case. Run the full validation suite and confirm `@adw-3` through `@adw-7` `@regression` scenarios continue to pass unchanged.

## Step by Step Tasks
Execute every step in order, top to bottom.

### 1. Read project docs and confirm preconditions

- Read `.adw/project.md`, `.adw/commands.md`, `.adw/review_proof.md`, `.adw/conditional_docs.md`, and the relevant app-docs listed in this plan's Relevant Files section.
- Read `specs/prd/depaudit.md` lines 120-125 (`.depaudit/findings.json` definition), 200-205 (`Reporter` module list), 210-221 (`/depaudit-triage` contract), 241 (snapshot testing decision).
- Confirm `.gitignore` already contains `.depaudit/` (line 4) — this project's own repo is already safe; the check we're adding is for *target repos* running `depaudit scan`.
- Confirm `src/types/depauditConfig.ts`'s `FindingCategory` union is exactly `"new" | "accepted" | "whitelisted" | "expired-accept"` — the hyphen variant is the only case we translate.

### 2. Create `src/modules/jsonReporter.ts` — types

- Add the `FindingsJsonV1`, `FindingRecord`, `SourceAvailability`, `FindingCategoryJson` (the camelCase variant), `SourceAvailabilityLabel` (`"available" | "unavailable"`), and `RenderInput` TypeScript interfaces. Keep them unexported-by-default except `FindingsJsonV1` and `FindingRecord` and `RenderInput`; everything else is a local type.
- Document the schema with a JSDoc block on `FindingsJsonV1` that names this as `.depaudit/findings.json`, names the consumer (`/depaudit-triage`), and flags `upgradeSuggestion` as reserved-for-future-resolver. Keep the JSDoc under 12 lines.
- No dependency on `node:fs` at this point — this file imports only `node:path` (for later) and the `ClassifiedFinding` / `Finding` types.

### 3. Add the pure `renderFindingsJson` function

- Signature: `export function renderFindingsJson(input: RenderInput): string`.
- Build the top-level object with keys in this explicit order: `schemaVersion`, `generatedAt`, `sourceAvailability`, `counts`, `findings`.
- `schemaVersion`: literal `1`.
- `generatedAt`: `input.generatedAt.toISOString()`.
- `sourceAvailability`: `{ osv: input.osvAvailable !== false ? "available" : "unavailable", socket: input.socketAvailable ? "available" : "unavailable" }`. `osvAvailable` defaults to `true` because today OSV fail-open is not implemented; the default preserves future flexibility without breaking callers.
- `counts`: iterate `input.findings` once, tally by `finding.category` (remembering the `"expired-accept"` → `"expiredAccept"` rename), emit `{ new, accepted, whitelisted, expiredAccept }` with zero-filled defaults.
- `findings`: map each `ClassifiedFinding` to a `FindingRecord`:
  - `package`, `version`, `ecosystem`, `manifestPath`, `findingId`, `severity`, `source`: copied verbatim.
  - `summary`: `cf.finding.summary ?? null` — explicit `null` to keep the field always present.
  - `classification`: translate `"expired-accept"` → `"expiredAccept"`, others pass through.
  - `upgradeSuggestion`: literal `null`.
- Sort `findings` in place by the compound tuple `[classification, ecosystem, package, version, findingId, manifestPath]`, ascending lexicographic on each component.
- Return `JSON.stringify(obj, null, 2) + "\n"` — trailing newline keeps diff tools happy and matches POSIX text-file convention.

### 4. Write unit tests for `renderFindingsJson` (pure renderer only)

- Create `src/modules/__tests__/jsonReporter.test.ts`. Use Vitest `describe` + `it`.
- Inline helpers: `makeOsvFinding(overrides)` and `makeSocketFinding(overrides)` mirror the style in `findingMatcher.test.ts` so tests read the same way.
- A fixed `FROZEN_DATE = new Date("2026-04-18T12:00:00.000Z")` passed to every test.
- Test "empty result returns canonical empty-findings JSON": zero findings, both sources available → `toMatchInlineSnapshot` with the exact expected string.
- Test "mixed classifications render all four categories": four findings — `new` + `accepted` + `whitelisted` + `expiredAccept` — across two sources and two ecosystems. Use `toMatchFileSnapshot("fixtures/jsonReporter/mixed-classifications.json")`.
- Test "socket unavailable maps to sourceAvailability.socket": one OSV finding + `socketAvailable: false` → `toMatchFileSnapshot("fixtures/jsonReporter/socket-unavailable.json")`.
- Test "category hyphen→camelCase translation": single finding with `category: "expired-accept"` → parse the output and assert `.findings[0].classification === "expiredAccept"`.
- Test "summary optional becomes null": finding with `summary: undefined` → parsed `.findings[0].summary === null`.
- Test "upgradeSuggestion is always null placeholder": parsed `.findings[0].upgradeSuggestion === null` for every finding.
- Test "counts match finding categories": 3 new + 2 accepted + 1 whitelisted + 1 expired-accept → `counts === { new: 3, accepted: 2, whitelisted: 1, expiredAccept: 1 }`.
- Test "generatedAt is the input Date's ISO string": assert `parsed.generatedAt === FROZEN_DATE.toISOString()`.
- Test "findings array is stably sorted": pass findings in shuffled order → assert the serialized output is byte-identical to a second call with a different shuffled input.
- Test "schemaVersion is 1": trivial regression guard.

### 5. Create the expected-JSON fixture files

- `src/modules/__tests__/fixtures/jsonReporter/empty-scan.json`: the canonical empty-result snapshot (probably redundant with the inline snapshot in step 4; create it only if the inline snapshot is too noisy). Skip if unneeded.
- `src/modules/__tests__/fixtures/jsonReporter/mixed-classifications.json`: the canonical mixed-result snapshot. Generated initially by running the failing test and copying Vitest's proposed snapshot, then reviewed by eye.
- `src/modules/__tests__/fixtures/jsonReporter/socket-unavailable.json`: the canonical socket-fail-open snapshot.

### 6. Add `writeFindingsFile(scanPath, input)` to `jsonReporter.ts`

- Signature: `export async function writeFindingsFile(scanPath: string, input: RenderInput): Promise<void>`.
- Compute `dir = join(scanPath, ".depaudit")` and `file = join(dir, "findings.json")`.
- `await mkdir(dir, { recursive: true })`.
- `await writeFile(file, renderFindingsJson(input), "utf8")`.
- No error handling beyond what `mkdir` and `writeFile` naturally surface — callers don't recover from these failures.

### 7. Add `checkGitignore(scanPath)` to `jsonReporter.ts`

- Signature: `export async function checkGitignore(scanPath: string): Promise<GitignoreCheckResult>`.
- `GitignoreCheckResult = { ignored: boolean; reason: "missing" | "not-matched" | "ok" }` — exported type.
- Read `<scanPath>/.gitignore` via `readFile`; if `ENOENT`, return `{ ignored: false, reason: "missing" }`. Any other error propagates.
- Instantiate the `ignore` library (same import pattern as `manifestDiscoverer.ts`: `import ignore from "ignore"` — confirm the exact default-vs-named-import by reading the existing file).
- Feed the file content to `ig.add(content)`.
- Check `ig.ignores(".depaudit/findings.json")`. If true, return `{ ignored: true, reason: "ok" }`. If false, return `{ ignored: false, reason: "not-matched" }`.
- **Important:** use the relative-to-scanPath path `".depaudit/findings.json"` exactly; the `ignore` library takes paths relative to the gitignore's directory.

### 8. Add `printGitignoreWarning(check, stream?)` to `jsonReporter.ts`

- Signature: `export function printGitignoreWarning(check: GitignoreCheckResult, stream: NodeJS.WritableStream = process.stdout): void`.
- If `check.ignored === true`, return immediately (no output).
- Else write exactly one line: `warning: .depaudit/findings.json is not gitignored — add '.depaudit/' to your .gitignore or run 'depaudit setup'\n`.
- No colors, no emojis (respect the project's plain-text stdout convention used by `stdoutReporter` and `lintReporter`).

### 9. Unit tests for writer and gitignore detector

- In the same `jsonReporter.test.ts` file, add `describe("writeFindingsFile")` and `describe("checkGitignore")` blocks.
- Use `mkdtempSync(join(tmpdir(), "depaudit-jsonreporter-"))` in `beforeEach` and `rmSync(..., { recursive: true })` in `afterEach` to get per-test sandboxes.
- Writer tests:
  - "creates `.depaudit/` when missing": empty tmpdir → run writer → `.depaudit/findings.json` exists.
  - "overwrites existing `findings.json`": pre-seed a dummy file → run writer → file content is the new rendered JSON.
  - "written content equals `renderFindingsJson(input)`": assert byte-equality.
- Gitignore tests:
  - "no `.gitignore` → missing": empty tmpdir → `{ ignored: false, reason: "missing" }`.
  - "`.gitignore` empty → not-matched": empty file → `{ ignored: false, reason: "not-matched" }`.
  - "`.gitignore` contains unrelated line → not-matched": `dist/` only → `{ ignored: false, reason: "not-matched" }`.
  - "`.gitignore` contains `.depaudit/` → ok": `{ ignored: true, reason: "ok" }`.
  - "`.gitignore` contains `.depaudit/findings.json` → ok": `{ ignored: true, reason: "ok" }`.
  - "`.gitignore` contains `**/*.json` → ok": `{ ignored: true, reason: "ok" }` (broad pattern also matches).
- Warning-emitter tests (no fs needed):
  - "silent when ignored": capture a `BufferStream` → zero bytes written.
  - "emits the exact warning when not ignored": capture → assert equality to the constant warning string.

### 10. Extend `ScanCommand` — factor the `finalize` helper

- In `src/commands/scanCommand.ts`, add an import: `import { writeFindingsFile, checkGitignore, printGitignoreWarning, type RenderInput } from "../modules/jsonReporter.js";`.
- Add a local helper at the top of the file (below the imports, above `runScanCommand`):
  ```ts
  async function finalize(scanPath: string, input: RenderInput): Promise<void> {
    await writeFindingsFile(scanPath, input);
    const check = await checkGitignore(scanPath);
    printGitignoreWarning(check);
  }
  ```
- No exports change on `scanCommand.ts` — this is an internal refactor.

### 11. Call `finalize` from every `ScanCommand` exit point

- **Config-parse-error on `.depaudit.yml` (line 67):** just before `return { findings: [], socketAvailable: true, exitCode: 2 };`, add `await finalize(scanPath, { findings: [], socketAvailable: true, osvAvailable: true, generatedAt: new Date() });`.
- **Config-parse-error on `osv-scanner.toml` (line 81):** same.
- **Lint-fail (line 93):** same.
- **Socket auth error (line 129):** `await finalize(scanPath, { findings: [], socketAvailable: false, osvAvailable: true, generatedAt: new Date() });`.
- **Success path (before line 150):** `await finalize(scanPath, { findings: classified, socketAvailable: socketResult.available, osvAvailable: true, generatedAt: new Date() });` — `classified` is already the full `ClassifiedFinding[]` from line 139.
- Run `bun run typecheck` to confirm no type errors.

### 12. Add a narrow unit/integration test for `ScanCommand` finalization

- Add `src/commands/__tests__/scanCommand.test.ts` if the project convention permits (check whether `commands/__tests__/` exists — if not, skip this step and rely on BDD coverage). Looking at the repo, `commands/` currently has no `__tests__` subfolder; skip the unit test and cover via BDD in step 13 to stay consistent with existing patterns.

### 13. Author the `@adw-8` BDD feature file

- Create `features/scan_findings_json.feature`. Tag the feature `@adw-8`. Mirror the style of `features/scan_socket_supply_chain.feature`.
- Scenarios (numbered as in the Solution Statement):
  1. `@adw-8 @regression` — "Clean scan writes .depaudit/findings.json with counts.new === 0" using `fixtures/clean-npm`.
  2. `@adw-8 @regression` — "Scan with a known CVE writes .depaudit/findings.json with at least one finding" using `fixtures/vulnerable-npm`.
  3. `@adw-8 @regression` — "Scan aborted by lint failure still writes an empty .depaudit/findings.json" using a new `fixtures/findings-json-lint-fail` (vulnerable-npm clone whose `osv-scanner.toml` has an expired `ignoreUntil`).
  4. `@adw-8 @regression` — "Socket fail-open is recorded as sourceAvailability.socket === 'unavailable'" reusing `fixtures/socket-5xx-clean` + its mock server.
  5. `@adw-8 @regression` — "Expired OSV accept appears in findings with classification 'expiredAccept'" using a vulnerable fixture whose `osv-scanner.toml` has an expired `[[IgnoredVulns]]`.
  6. `@adw-8 @regression` — "Clean scan with no .gitignore writes the file and warns on stdout" using `fixtures/findings-json-clean-no-gitignore`.
  7. `@adw-8 @regression` — "Clean scan with `.gitignore` covering `.depaudit/` writes the file and does NOT warn" using `fixtures/findings-json-clean-with-gitignore`.
  8. `@adw-8` — "Clean scan never modifies .gitignore" assert on file bytes-equality before/after in the `findings-json-clean-with-gitignore` fixture.

### 14. Author `scan_findings_json_steps.ts`

- Create `features/step_definitions/scan_findings_json_steps.ts`. Import Given/When/Then from Cucumber plus `readFile`, `stat`, and Node's `assert/strict`.
- New Given steps:
  - `"a fixture repository at {string} with no \\.gitignore"` — asserts the `.gitignore` does NOT exist in the fixture.
  - `"a fixture repository at {string} whose \\.gitignore contains {string}"` — reads `.gitignore` and asserts it contains the line (exact match after trim).
- New Then steps:
  - `".depaudit/findings.json exists in the fixture"` — `await stat(join(fixturePath, ".depaudit", "findings.json"))`.
  - `"the findings file parses as JSON with schemaVersion 1"` — read, parse, assert `schemaVersion === 1`.
  - `"the findings file's counts.new is {int}"` — assert integer equality.
  - `"the findings file's sourceAvailability.socket is {string}"` — assert `"available"` or `"unavailable"`.
  - `"the findings file contains a finding with classification {string}"` — assert some `finding.classification` matches.
  - `"the findings file's findings array has {int} items"`.
  - `"stdout contains the gitignore warning"` — assert `this.result.stdout` includes `"not gitignored"`.
  - `"stdout does NOT contain the gitignore warning"` — assert negation.
  - `".gitignore is unchanged from its pre-scan bytes"` — snapshot the file before the `When I run` step and compare after.
- Reuse the existing `Given` / `When` steps from `scan_steps.ts` where possible (the fixture-path-verification step, the "I run depaudit scan" step).
- Clean up `<fixturePath>/.depaudit/` in an `After` hook specific to this step file so successive runs are reproducible.

### 15. Create the new fixture repos

- `fixtures/findings-json-clean-no-gitignore/`: minimal `package.json` with no CVE deps; **no** `.gitignore`. Keep it as small as possible (3-line package.json + a `package-lock.json` with zero deps, same shape as `fixtures/clean-npm`).
- `fixtures/findings-json-clean-with-gitignore/`: copy `findings-json-clean-no-gitignore` and add a `.gitignore` whose content is `.depaudit/\nnode_modules/\n`.
- `fixtures/findings-json-clean-with-explicit-gitignore/`: same but `.gitignore` contains `.depaudit/findings.json\n`.
- `fixtures/findings-json-lint-fail/`: copy `fixtures/vulnerable-npm-bad-accept` (already exists per `@adw-4` scenario) or construct a minimal fixture with a deliberately-malformed `osv-scanner.toml`. Confirm it triggers the lint-fail exit path.

### 16. Add the `JsonReporter` row to `UBIQUITOUS_LANGUAGE.md`

- Locate the Modules table at line 43-46.
- Add a new row: `| **\`JsonReporter\`** | Deep module that renders the scan's classified Findings as \`.depaudit/findings.json\`, the snapshot consumed by \`/depaudit-triage\` | JSON reporter |`.
- Keep the alphabetical-ish ordering: insert between `FindingMatcher` and `OsvScannerAdapter`.

### 17. Run the full validation suite

- `bun install` (no-op if lockfile already satisfies dependencies).
- `bun run typecheck` — zero type errors.
- `bun run lint` — zero lint errors.
- `bun test` — all unit tests green, including new `jsonReporter.test.ts` and every pre-existing suite.
- `bun run build` — builds `dist/cli.js`.
- `bun run test:e2e -- --tags "@adw-8"` — all 8 new BDD scenarios pass.
- `bun run test:e2e -- --tags "@regression"` — every pre-existing regression scenario (`@adw-3` through `@adw-7`) continues to pass alongside the new `@adw-8` scenarios.

### 18. Final diff review against the issue's acceptance criteria

Walk the five AC bullets and confirm:

1. `.depaudit/findings.json` is written on every `depaudit scan` run — verified by scenarios 1, 2, 3 and the `finalize` helper's placement at every exit point.
2. Schema supports every classification category — verified by the mixed-classifications snapshot + scenario 5.
3. Schema carries `sourceAvailability` — verified by `sourceAvailability.socket` assertion in scenario 4 and the `socket-unavailable.json` snapshot.
4. If `.depaudit/findings.json` is not gitignored, warning to stdout — verified by scenarios 6 + 7 (positive and negative).
5. Snapshot tests for `JsonReporter` output — verified by `jsonReporter.test.ts`.

Confirm none of the changes touched `.gitignore` in any fixture (scenario 8 is the assertion).

## Testing Strategy

### Unit Tests

`.adw/project.md` lacks the `## Unit Tests: enabled` marker, but this plan includes unit-test tasks as a documented override. Justifications, listed in priority order:

1. `.adw/review_proof.md` **Rule 7** is explicit: "For changes to reporter output (`MarkdownReporter`, `JsonReporter`): confirm snapshot assertions are updated and match the intended output." Skipping the snapshot suite for `JsonReporter` would fail the review bar deterministically.
2. PRD `specs/prd/depaudit.md:229, :241` names `JsonReporter — snapshot assertions on .depaudit/findings.json` explicitly as a Tier 1 module under test.
3. The issue's AC bullet 5 (`Snapshot tests for JsonReporter output`) is an explicit user requirement.
4. The precedent of issues #3, #4, #5, #6, #7 all including unit-test tasks in their plans despite the same missing marker.

The suite covers every schema branch: the empty-result arm, the mixed-classifications arm (all four `FindingCategory` values), the `socketAvailable: false` arm, the hyphen→camelCase translation, the optional-summary-null arm, the `upgradeSuggestion: null` placeholder, the `counts` tally, the `generatedAt` ISO-string shape, and the stable-sort determinism. It also covers the writer (directory creation, overwrite, byte-equality round-trip) and the gitignore detector (missing, unmatched, and three match patterns including the broad glob). Every branch's happy and error arms are covered. No unit test for `ScanCommand` itself — the integration is covered by BDD (consistent with the existing convention: `commands/` has no `__tests__` subfolder).

### Edge Cases

- Repo with no `.gitignore` at all: writer still creates `.depaudit/findings.json`; warning fires.
- Repo with `.gitignore` but no `.depaudit/` coverage: same outcome.
- Repo with an existing `.depaudit/findings.json` from a previous run: overwritten in place, no stale fields.
- Scan path is a relative path (e.g., `"."`): `mkdir` and `writeFile` resolve correctly because `ScanCommand` already operates on whatever path the user passes.
- Lint failure before manifests are discovered: JSON file still written with `findings: []`.
- Config-parse error on `.depaudit.yml` or `osv-scanner.toml`: same empty-findings JSON file written.
- Socket auth error: empty JSON with `socket: "unavailable"` so the user can distinguish from a transient fail-open.
- Socket transient fail-open (5xx/timeout/429 exhausted retries): JSON contains whatever OSV findings came back, plus `socket: "unavailable"`.
- Finding with `summary === undefined` in the domain: JSON field is explicit `null` (never an absent key).
- Unusual ecosystems (every ecosystem the PRD supports — `npm`, `pip`, `gomod`, `cargo`, `maven`, `gem`, `composer`): each appears in the stable-sort test.
- Duplicate findings in the input (same `(package, version, findingId, manifestPath)`): the stable sort produces identical adjacent entries; they're serialised as-is (no de-dupe at reporter level; that's the matcher's job if ever needed).
- Very large result set (1000+ findings): no special handling; `JSON.stringify` handles it fine within the scan's existing wall-clock budget.
- `.gitignore` with a `!`-unignore line that overrides a broader match: let the `ignore` library handle the semantics; no special-case code.
- CRLF vs. LF line endings in `.gitignore` on a Windows fixture: the `ignore` library normalises; no special-case code.
- `generatedAt` in a non-UTC timezone: we always write `.toISOString()` which is UTC; no local-time leakage.

## Acceptance Criteria

- [ ] `src/modules/jsonReporter.ts` exists and exports `renderFindingsJson`, `writeFindingsFile`, `checkGitignore`, `printGitignoreWarning`, plus the `FindingsJsonV1`, `FindingRecord`, `RenderInput`, and `GitignoreCheckResult` types.
- [ ] `.depaudit/findings.json` is created by every `depaudit scan` invocation — success, lint-failure, config-parse-failure, and socket-auth-failure paths all call `finalize` before returning.
- [ ] The JSON schema contains `schemaVersion: 1`, `generatedAt`, `sourceAvailability.{osv,socket}`, `counts.{new,accepted,whitelisted,expiredAccept}`, and a `findings[]` array sorted by `(classification, ecosystem, package, version, findingId, manifestPath)`.
- [ ] Every `FindingCategory` from `FindingMatcher` is representable in the schema; `"expired-accept"` is translated to `"expiredAccept"`.
- [ ] `sourceAvailability.socket === "unavailable"` when the scan went fail-open on Socket (5xx/timeout/429 exhausted or auth error).
- [ ] When `.depaudit/findings.json` is not gitignored by `<scanPath>/.gitignore`, a single `warning:` line is emitted to stdout; exit code is unchanged.
- [ ] `depaudit scan` never modifies `<scanPath>/.gitignore`.
- [ ] `src/modules/__tests__/jsonReporter.test.ts` covers every schema branch, writer branch, and gitignore-detector branch with snapshot or explicit-value assertions.
- [ ] `features/scan_findings_json.feature` covers 8 scenarios tagged `@adw-8`; at least 7 carry `@regression`.
- [ ] All existing `@adw-3` … `@adw-7` `@regression` BDD scenarios continue to pass unchanged.
- [ ] `bun run typecheck`, `bun run lint`, `bun test`, `bun run build` all exit 0.
- [ ] `UBIQUITOUS_LANGUAGE.md` has a new `JsonReporter` row in the Modules table.
- [ ] No unrelated modules modified; no runtime dependency added.

## Validation Commands
Execute every command to validate the feature works correctly with zero regressions.

From `.adw/commands.md`:

- `bun install` — ensure dependencies are up to date (no new dep expected).
- `bun run typecheck` — zero type errors; validates the new `FindingsJsonV1` / `FindingRecord` / `RenderInput` types and the `ScanCommand` call-site updates.
- `bun run lint` — zero lint errors.
- `bun test` — all Vitest suites green, including the new `jsonReporter.test.ts`; the existing `findingMatcher.test.ts`, `socketApiClient.test.ts`, `osvScannerAdapter.test.ts`, `configLoader.test.ts`, `linter.test.ts`, `manifestDiscoverer.test.ts` all continue to pass.
- `bun run build` — builds `dist/cli.js` without errors.
- `bun run test:e2e -- --tags "@adw-8"` — every new BDD scenario passes.
- `bun run test:e2e -- --tags "@regression"` — the full regression suite (all prior slices + the new slice's `@regression`-tagged scenarios) passes.
- Manual verification (one-liner, optional but recommended): `cd fixtures/vulnerable-npm && node ../../dist/cli.js scan . && cat .depaudit/findings.json | head -40 && grep -q "\.depaudit/" .gitignore 2>/dev/null || echo "(fixture intentionally has no .gitignore warning expected)"` — eyeball the JSON shape.

## Notes

- **Unit tests override**: `.adw/project.md` lacks `## Unit Tests: enabled`. This plan includes unit-test tasks because `.adw/review_proof.md` Rule 7, `specs/prd/depaudit.md:241`, and the issue's own acceptance-criteria bullet 5 all independently require snapshot tests for `JsonReporter`. Same precedent as issues #3–#7.
- **No new libraries required.** `node:fs/promises`, `node:path`, `node:os` are built-in. `ignore` is already a direct dependency (`package.json:27`). Per `.adw/commands.md` a new library would use `bun add <name>`; none is needed for this slice.
- **No `guidelines/` directory** exists in this repo; no guideline-specific refactoring obligations apply.
- **Schema stability contract.** `schemaVersion: 1` is intentional — a future breaking change (removing or renaming a top-level key) MUST bump this field and the triage skill MUST reject unknown major-version schemas. This plan does not introduce a version-check in the skill (out of scope), but the field is there from day one.
- **`upgradeSuggestion` placeholder.** Shipped as `null` on every finding in this slice. The resolver that populates it lives in a later ADW issue (see PRD remediation policy `:168-174`). Committing the field now avoids a schema churn when the resolver lands — the skill author can code against the final shape today.
- **`sourceAvailability.osv` is always `"available"` today.** This reflects that OSV-Scanner currently aborts the whole run on error rather than failing open. A future fail-open-on-OSV slice would flip the field; no schema change needed.
- **Warning goes to `stdout`, not `stderr`.** The issue body is explicit: "warning to stdout (but no fatal)". `stdoutReporter` and `printFindings` are the only other stdout writers; this keeps the warning where the finding lines are so a human glancing at `depaudit scan` output sees it with the rest of the run's output. Machine consumers already read the JSON file, not the stdout.
- **No mutation of `.gitignore`.** Enforced by never importing or calling `writeFile` with a `.gitignore` path anywhere in `ScanCommand` or `JsonReporter`. The BDD scenario 8 asserts byte-equality before/after as the regression guard.
- **Trailing newline.** `renderFindingsJson` returns `JSON.stringify(...) + "\n"`. Standard POSIX text-file convention; matches most Prettier-formatted JSON. Snapshot files in `fixtures/jsonReporter/` are committed with the trailing newline.
- **Determinism.** The stable sort on `findings[]` is the contract that lets a CI system with flaky ordering (e.g., OSV returning findings in a slightly different order run-to-run) still produce a byte-identical artifact across equivalent runs. This is a property the triage skill and any future diff-based tooling depends on.
- **`finalize` helper is local, not exported.** Keeping it private to `scanCommand.ts` avoids premature abstraction; if a second command ever needs the same sequence, we can promote it to `jsonReporter.ts` at that point.
- **Pre-existing limitation retained.** `ManifestDiscoverer` only reads the root `.gitignore`; nested `.gitignore` files are not respected. This slice's `checkGitignore` inherits that limitation — nested ignores are not walked. If a user has a `<scanPath>/foo/.gitignore` that ignores the parent `.depaudit/` via a weird pattern, the check will incorrectly warn. The right answer is the root `.gitignore`; this is a one-line doc-comment in `checkGitignore` and not a code change.
- **Early-exit empty-findings contract.** On lint-fail / config-parse-fail, the JSON file is written with `findings: []` and `exitCode` is non-zero. The triage skill reading this sees "no findings to triage" and should defer to the user to fix the config first (the CLI stderr will have already surfaced the lint/parse error). This is documented via a sentence in the `FindingsJsonV1` JSDoc so skill authors know to cross-check the CLI's stderr / exit code.
- **UBIQUITOUS_LANGUAGE glossary update** is in-scope; this slice introduces the `JsonReporter` term and the glossary is the source of truth for module names.
