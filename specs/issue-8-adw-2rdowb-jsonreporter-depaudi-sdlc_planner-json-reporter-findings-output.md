# Feature: JsonReporter → .depaudit/findings.json

## Metadata
issueNumber: `8`
adwId: `2rdowb-jsonreporter-depaudi`
issueJson: `{"number":8,"title":"JsonReporter → .depaudit/findings.json","body":"## Parent PRD\n\n`specs/prd/depaudit.md`\n\n## What to build\n\n`JsonReporter` writes classified scan results to `.depaudit/findings.json` (deterministic path, gitignored) as canonical JSON consumable by `/depaudit-triage` (future slice). Schema includes, per finding: package, version, ecosystem, manifest path, finding-id, severity, summary, classification (`new` / `accepted` / `whitelisted` / `expired-accept`), source (`osv` / `socket`), and — where applicable — upgrade suggestion.\n\nAlso: ensure `.gitignore` excludes `.depaudit/findings.json`; if not present, the CLI prints a warning (doesn't modify `.gitignore` in `scan` — that's `DepauditSetupCommand`'s job).\n\n## Acceptance criteria\n\n- [ ] `.depaudit/findings.json` is written on every `depaudit scan` run (stable, documented schema).\n- [ ] Schema supports every classification category from `FindingMatcher`.\n- [ ] Schema carries `sourceAvailability` (osv/socket) so the triage skill can reason about fail-open state.\n- [ ] If `.depaudit/findings.json` is not gitignored, warning to stdout (but no fatal).\n- [ ] Snapshot tests for `JsonReporter` output.\n\n## Blocked by\n\n- Blocked by #7\n\n## User stories addressed\n\n- User story 23 (prep; skill work in later ADW issue)\n","state":"OPEN","author":"paysdoc","labels":[],"createdAt":"2026-04-17T13:24:40Z","comments":[{"author":"paysdoc","createdAt":"2026-04-22T15:50:09Z","body":"## Take action"}],"actionableComment":null}`

## Feature Description

`depaudit scan` today produces two outputs: stdout finding lines for humans reading a terminal or CI log, and stderr metadata lines (expired accepts, Socket unavailability, auto-prune notices). Neither is consumable by the future `/depaudit-triage` Claude Code skill, which needs a structured artifact it can parse and walk.

This slice introduces `JsonReporter`: a deep module that renders the classified `ScanResult` into `.depaudit/findings.json` — a deterministic, gitignored artifact under the repo root. The schema is the canonical handoff point between `scan` (which generates) and `/depaudit-triage` (which consumes) and carries everything the skill needs for a self-contained triage session: one entry per classified finding (`new`, `accepted`, `whitelisted`, or `expired-accept`), per-source availability flags so the skill can reason about fail-open state, and a `schemaVersion` pin for forward-compatibility. Where a future slice can compute an upgrade suggestion, the schema reserves a field for it; this slice leaves it `null` since upgrade resolution is out of scope here.

A gitignore check runs alongside the write: if `.depaudit/findings.json` isn't covered by the scan-root `.gitignore`, `JsonReporter` emits a single warning line to stdout — no fatal, no auto-edit. The PRD assigns the write-to-`.gitignore` responsibility to `DepauditSetupCommand` (issue #10); this slice stays in its lane and just flags the misconfiguration.

The artifact is written on every `scan` run that reaches classification. Runs that abort earlier (lint failure, config parse error, `SocketAuthError`, catastrophic OSV failure) do not touch `.depaudit/findings.json` — the stale file is left for the developer to notice via the preceding error output.

## User Story

As a maintainer running `depaudit scan`
I want the classified findings for this run persisted to `.depaudit/findings.json` in a stable schema
So that the `/depaudit-triage` skill (and any future UI) can walk them deterministically without re-running the scan.

As a maintainer setting up depaudit in a repo for the first time outside of `depaudit setup`
I want a warning when `.depaudit/findings.json` is not already gitignored
So that I don't accidentally commit a scan artifact full of finding metadata.

## Problem Statement

Today `ScanCommand` ends with `printFindings(newFindings)` to stdout (`src/modules/stdoutReporter.ts:3-10`) and `return { findings: classified, ... }` to its caller (`src/commands/scanCommand.ts:211-212`). The classified result exists in memory during the run and then evaporates — the CLI's process exits and nothing else consumes the `ClassifiedFinding[]`. Specifically:

1. **No handoff artifact for the triage skill.** The PRD (`specs/prd/depaudit.md:121, :204, :212, :241, :250`) names `.depaudit/findings.json` as the input contract for `/depaudit-triage`, but no code writes that file today. The skill cannot be built until the artifact exists.

2. **Stdout is lossy.** `stdoutReporter.printFindings` emits only `new` findings and collapses each to four fields (`package version id severity`). `accepted`, `whitelisted`, and `expired-accept` categories never leave the process. A structured consumer cannot reconstruct the full classification from stdout.

3. **Fail-open state isn't externalised.** `ScanCommand` propagates `socketAvailable` and `osvAvailable` on its return value (`src/types/scanResult.ts:3-8`), but those booleans die with the process. The triage skill needs to know — after a scan — whether supply-chain data was available this run so it can reason about whether a silent absence of supply-chain findings means "clean" or "Socket was down". Without this, the skill cannot safely auto-close supply-chain orphan entries.

4. **No gitignore sanity check.** The PRD assigns `.depaudit/findings.json` write-to-`.gitignore` to `DepauditSetupCommand` (`specs/prd/depaudit.md:160`). Outside that flow (e.g., a user who copied a `.depaudit.yml` from another repo but never ran `depaudit setup`, or a user scanning from a subdirectory), the artifact may be written into a tree that doesn't ignore it — committing it to the repo by accident. Nothing warns them.

5. **No deterministic shape for snapshot testing.** `printFindings` iterates an input array order-sensitive with no sorting, so tests that compare stdout need to be order-tolerant. A structured JSON artifact consumed by a future skill must be deterministic — same input produces byte-identical output — for snapshot tests to be usable as a regression guard (per PRD `specs/prd/depaudit.md:229, :241`).

Collectively: the information the triage skill needs exists in `ScanCommand`'s local scope, but there's no code writing it anywhere the skill can pick it up, no shape the skill can parse, and no guard against the UX pitfall of an un-gitignored artifact.

## Solution Statement

Add a deep `JsonReporter` module that renders the post-classification `ClassifiedFinding[]` plus per-source availability into `.depaudit/findings.json` under the scan root, checks whether that path is covered by the scan-root `.gitignore`, and emits a one-line stdout warning when it isn't. Wire it into `ScanCommand` as a post-classification side effect. Cover its output with fixture-driven snapshot tests and its integration into `ScanCommand` with BDD scenarios.

Specifically:

- **New `src/types/findingsJson.ts`** — exports the canonical output types so `JsonReporter` and any future consumer share one definition. `FindingsJsonSchema` wraps a top-level object with:
  - `schemaVersion: 1` (hard-coded integer; bumps are explicit).
  - `sourceAvailability: { osv: boolean; socket: boolean }` (mirrors `ScanResult`).
  - `findings: FindingsJsonEntry[]` (deterministic order; see below).

  Each `FindingsJsonEntry` carries: `package`, `version`, `ecosystem`, `manifestPath`, `findingId`, `severity`, `summary` (string — empty string when absent rather than omitted, so downstream JSON consumers have a fixed shape), `classification` (`"new" | "accepted" | "whitelisted" | "expired-accept"`), `source` (`"osv" | "socket"`), `upgradeSuggestion` (`string | null`; always `null` in this slice — wired for the future upgrade-resolver slice).

- **New `src/modules/jsonReporter.ts`** — deep module with the single entry point `writeFindingsJson(scanPath, result, options?)`. Internally:
  1. Serialises `result.findings` + `sourceAvailability` into a `FindingsJsonSchema` object. Sorts entries by `(manifestPath, source, findingId, package, version)` using `localeCompare` with a stable tiebreaker — identical classified inputs always produce byte-identical JSON.
  2. Writes `.depaudit/findings.json` under `scanPath` with `mkdir({ recursive: true })` on the parent directory, UTF-8, `JSON.stringify(..., null, 2)` plus a trailing newline.
  3. Runs a gitignore check against the scan root's `.gitignore`: reads the file (silently treats absence as "not gitignored"), parses with the `ignore` package (already a dep, same pattern as `ManifestDiscoverer`), and queries `.ignores(".depaudit/findings.json")`. When false, writes `warning: .depaudit/findings.json is not gitignored — run 'depaudit setup' or add '.depaudit/' to your .gitignore\n` to stdout. Exactly one warning per scan; no modification of any file on disk.
  4. Returns `Promise<void>`. No throw on write failure short of an actual I/O error (permission denied, read-only filesystem). Write failures propagate to `ScanCommand` which surfaces them via the top-level error handler, same as any unhandled I/O failure in depaudit today.
  5. `options` parameter admits `stdoutStream?: NodeJS.WritableStream` (defaults to `process.stdout`) so tests can capture the warning without touching the real stdout.

- **Extend `ScanCommand`** (`src/commands/scanCommand.ts`) with a single call to `writeFindingsJson(scanPath, { findings: classified, socketAvailable: socketResult.available, osvAvailable, exitCode })` inserted **after** classification, after the auto-prune block, and **before** the final `return`. Early-abort paths (lint fail, config parse error, `SocketAuthError`, OSV catastrophic failure) do not invoke the reporter: in all those cases we do not have a meaningful `ClassifiedFinding[]` to serialise, and skipping the write preserves any prior `.depaudit/findings.json` from being overwritten with a sentinel empty-or-error value. Documented behaviour: the file is only overwritten on runs that reached classification.

- **Adjust the "stdout contains no finding lines" step** (`features/step_definitions/scan_steps.ts:179-182`) so existing `@regression` scenarios tolerate the new gitignore warning line on fixtures that don't (yet) carry `.gitignore` entries for `.depaudit/`. The step currently asserts "no non-empty lines on stdout"; its name promises "no **finding** lines". Tighten the assertion to its namesake semantics: no lines matching the `FINDING_LINE_RE` pattern (`<package> <version> <finding-id> <severity>`). Warning lines don't match this regex and therefore don't break the assertion. This is a semantics-preserving tighten — every existing `@regression` scenario that passes today with zero stdout lines continues to pass because zero lines ⊂ zero-matching-finding-lines.

- **Add `.gitignore` entries for `.depaudit/` to fixtures** used by new `@adw-8` scenarios so the "no warning on a properly-configured repo" scenario has a real fixture to assert against. Existing regression fixtures are NOT updated because the step relaxation above handles the cross-suite impact.

- **Snapshot tests for `JsonReporter` output** (`src/modules/__tests__/jsonReporter.test.ts`): drive the reporter with fixture classification results and assert against checked-in expected-JSON files under `src/modules/__tests__/fixtures/json-output/`. Cover every classification category, both sources, availability permutations, empty-findings case, and gitignore-present vs. gitignore-absent cases. Use file-based snapshot assertions (read expected file, compare to written output) rather than a snapshot library to keep the test output diffable and reviewable in PRs.

- **BDD scenarios (`features/scan_findings_json.feature`, tag `@adw-8`)** cover the end-to-end behaviour: file is created after a scan, schema matches expected shape, `sourceAvailability` reflects Socket/OSV availability for the run, classifications span `new`/`accepted`/`whitelisted`/`expired-accept`, warning fires when un-gitignored, no warning when gitignored, no file written when scan aborts early. Scenarios use existing fixtures where possible and introduce dedicated ones for the gitignore assertion cases.

## Relevant Files

Use these files to implement the feature:

- `specs/prd/depaudit.md` — parent PRD. Lines `:121` (artifact location), `:160` (setup writes `.depaudit/findings.json` to `.gitignore`), `:204` (`Reporter` composes `JsonReporter`), `:212` (skill reads `.depaudit/findings.json`), `:229` and `:241` (snapshot tests for renderer output), `:250` (integration tests assert `.depaudit/findings.json` content). User story 23 (triage skill context) motivates the slice.
- `README.md` — project overview; confirms target deliverables and pre-release status.
- `src/commands/scanCommand.ts` — composition root to extend. The post-classification / post-prune block (`:176-209`) is where the `writeFindingsJson` call is inserted. Early-abort paths (`:61-97`, `:124-133`, `:156-168`) are documented non-invocation sites.
- `src/types/scanResult.ts` — `ScanResult` already carries `findings: ClassifiedFinding[]`, `socketAvailable`, `osvAvailable`. Input shape for `JsonReporter` is the same object; no extension needed.
- `src/types/depauditConfig.ts` — `ClassifiedFinding` (`:40-43`) and `FindingCategory` (`:38`) are the classification types the reporter serialises.
- `src/types/finding.ts` — `Finding`, `Severity`, `Ecosystem`, `FindingSource` are the per-entry fields.
- `src/modules/stdoutReporter.ts` — existing stdout reporter; shows the writable-stream injection pattern (`:3-6`). The new reporter extends the pattern (stream for warning, file path for output).
- `src/modules/manifestDiscoverer.ts` — reference for reading `.gitignore` and feeding it into the `ignore` library (`:20-29`). `JsonReporter`'s gitignore check reuses the exact same idiom.
- `src/modules/__tests__/findingMatcher.test.ts` — pure-function test idiom used by the snapshot-test harness.
- `src/modules/__tests__/manifestDiscoverer.test.ts` — fixture-driven test idiom (reads files under `src/modules/__tests__/fixtures/`).
- `features/step_definitions/scan_steps.ts` — `runDepaudit` helper, `stdout contains no finding lines` assertion (`:179-182`) to tighten.
- `features/step_definitions/scan_orphan_prune_steps.ts` — precedent for `@Before` / `@After` snapshot-and-restore hooks; new `@adw-8` fixtures that ship a `.gitignore` don't need restore (no fixture mutation), but the file-output assertion pattern is reused.
- `features/support/world.ts` — `DepauditWorld` carries the per-scenario world; a new field `findingsJsonPath?: string` would let step definitions assert against a known path. Or simpler: derive it from `fixturePath` + `.depaudit/findings.json` at assertion time.
- `features/support/mockSocketServer.ts` — reused for fail-open scenarios so `sourceAvailability.socket: false` is observable in the written JSON.
- `app_docs/feature-82j9dc-orphan-auto-prune.md` — house-style reference for the new `app_docs/feature-2rdowb-json-reporter.md`.
- `.adw/project.md` — confirms deep-module layout, `bun` tooling, test runner choice.
- `.adw/commands.md` — validation commands (`bun run lint`, `bun run typecheck`, `bun run build`, `bun test`, `bun run test:e2e`).
- `.adw/conditional_docs.md` — append the new `app_docs/feature-2rdowb-json-reporter.md` entry.
- `.gitignore` (repo root) — already contains `.depaudit/`; the fixture hunt confirms this is the blessed pattern.

### New Files

- `src/types/findingsJson.ts` — new types: `FindingsJsonSchema`, `FindingsJsonEntry`, `SourceAvailability`.
- `src/modules/jsonReporter.ts` — new deep module: `writeFindingsJson(scanPath, result, options?)`.
- `src/modules/__tests__/jsonReporter.test.ts` — snapshot tests for rendered output and gitignore-warning behaviour.
- `src/modules/__tests__/fixtures/json-output/` — expected-JSON fixture files:
  - `empty.expected.json` — zero findings, both sources available.
  - `mixed-classifications.expected.json` — one of each `new`/`accepted`/`whitelisted`/`expired-accept`, both sources.
  - `socket-unavailable.expected.json` — OSV findings only, `sourceAvailability.socket: false`.
  - `osv-unavailable.expected.json` — Socket findings only, `sourceAvailability.osv: false`.
  - `deterministic-order.expected.json` — shuffled input produces sorted output; tests sort key stability.
  - `all-categories-both-sources.expected.json` — every category × every source combination rendered.
- `features/scan_findings_json.feature` — new BDD feature file tagged `@adw-8`.
- `features/step_definitions/scan_findings_json_steps.ts` — step definitions for file-existence, JSON-shape, `sourceAvailability`, and gitignore-warning assertions.
- `fixtures/findings-json-clean-gitignored/` — npm repo with `.gitignore` containing `.depaudit/`; asserts no warning emitted.
- `fixtures/findings-json-clean-not-gitignored/` — npm repo without `.depaudit/` in `.gitignore` (no `.gitignore` at all); asserts warning emitted.
- `fixtures/findings-json-mixed/` — npm repo with one CVE and one Socket alert, exercising every classification bucket via a tailored `.depaudit.yml` + `osv-scanner.toml` so a single scan produces all four categories.
- `app_docs/feature-2rdowb-json-reporter.md` — implementation summary in the house style.

## Implementation Plan

### Phase 1: Foundation

Define the on-disk schema as a first-class type and introduce the deep reporter module with a pure rendering pass plus I/O at the edges.

- Create `src/types/findingsJson.ts` with the canonical `FindingsJsonSchema` and `FindingsJsonEntry` types plus a `CURRENT_SCHEMA_VERSION = 1` constant so bumps are explicit and greppable.
- Create `src/modules/jsonReporter.ts` with:
  - A pure `buildFindingsJsonSchema(result: ScanResult): FindingsJsonSchema` helper that sorts and maps `ClassifiedFinding[]` → `FindingsJsonEntry[]`, wraps with `sourceAvailability` and `schemaVersion`.
  - A `writeFindingsJson(scanPath, result, options?): Promise<void>` entry point that invokes the pure helper, writes to `.depaudit/findings.json`, and runs the gitignore check.
  - An internal `isFindingsJsonGitignored(scanPath): Promise<boolean>` that mirrors `ManifestDiscoverer`'s `.gitignore` read pattern.

### Phase 2: Core Implementation

Lock down the snapshot-test harness so the output schema is covered before it is wired into `ScanCommand`.

- Build fixture expected-JSON files under `src/modules/__tests__/fixtures/json-output/` for the cases enumerated above.
- Unit-test the pure helper (sort stability, schema version, `upgradeSuggestion: null` invariant) and the write path (via a writable-stream injection + temp-dir write).
- Unit-test the gitignore check (matches, no-match, absent `.gitignore`, `.gitignore` with unrelated rules, `.gitignore` with negation that re-allows `.depaudit/`).

### Phase 3: Integration

Wire `writeFindingsJson` into `ScanCommand`, relax the stdout assertion step, add BDD scenarios and fixtures, and document.

- Import `writeFindingsJson` into `src/commands/scanCommand.ts` and call it after the prune block and before the final `return`.
- Tighten `Then stdout contains no finding lines` to assert "no lines matching the finding pattern" rather than "no lines at all".
- Author `features/scan_findings_json.feature` with the scenarios enumerated in Task 7.
- Author `features/step_definitions/scan_findings_json_steps.ts` with file-existence, JSON-shape, and gitignore-warning assertions.
- Create the three BDD fixtures under `fixtures/findings-json-*/`.
- Author `app_docs/feature-2rdowb-json-reporter.md` and append to `.adw/conditional_docs.md`.
- Run the full validation suite.

## Step by Step Tasks

Execute every step in order, top to bottom.

### Task 1 — Define the findings.json schema types

- Create `src/types/findingsJson.ts`.
- Export `export const CURRENT_SCHEMA_VERSION = 1 as const;`.
- Export interface `SourceAvailability { osv: boolean; socket: boolean }`.
- Export interface `FindingsJsonEntry` with fields (in the order they should appear in output JSON):
  - `package: string`
  - `version: string`
  - `ecosystem: Ecosystem` (imported from `./finding.js`)
  - `manifestPath: string`
  - `findingId: string`
  - `severity: Severity` (imported from `./finding.js`)
  - `summary: string` (empty string when source finding has no summary; never omitted)
  - `classification: FindingCategory` (imported from `./depauditConfig.js`)
  - `source: FindingSource` (imported from `./finding.js`)
  - `upgradeSuggestion: string | null` (always `null` in this slice)
- Export interface `FindingsJsonSchema { schemaVersion: 1; sourceAvailability: SourceAvailability; findings: FindingsJsonEntry[] }`.
- No behaviour; pure type definitions.

### Task 2 — Implement `src/modules/jsonReporter.ts`

- New file.
- Imports: `writeFile`, `mkdir`, `readFile` from `node:fs/promises`; `join`, `resolve`, `dirname` from `node:path`; `ignore` from `ignore`; types from `../types/*`.
- Internal pure helper:
  ```ts
  export function buildFindingsJsonSchema(result: ScanResult): FindingsJsonSchema
  ```
  - Maps each `ClassifiedFinding` to a `FindingsJsonEntry` by projection:
    - `package`, `version`, `ecosystem`, `manifestPath`, `findingId`, `severity`, `source` come from `cf.finding`.
    - `summary` = `cf.finding.summary ?? ""`.
    - `classification` = `cf.category`.
    - `upgradeSuggestion` = `null` (hard-coded this slice).
  - Sorts the resulting array with a comparator that compares, in order: `manifestPath`, `source`, `findingId`, `package`, `version` (each via `localeCompare`). Deterministic tiebreaker even for pathological identical entries.
  - Returns `{ schemaVersion: CURRENT_SCHEMA_VERSION, sourceAvailability: { osv: result.osvAvailable, socket: result.socketAvailable }, findings: [...] }`.
- Internal helper:
  ```ts
  async function isFindingsJsonGitignored(scanPath: string): Promise<boolean>
  ```
  - Absolute scan path via `resolve(scanPath)`.
  - Try to read `<scanPath>/.gitignore` via `readFile(..., "utf8")`.
  - On read failure (ENOENT or any other error): return `false`.
  - On success: `const ig = ignore(); ig.add(raw); return ig.ignores(".depaudit/findings.json")`.
  - The `ignore` package's `ignores` treats a dir pattern (`.depaudit/`) as matching children (`.depaudit/findings.json`); this is tested explicitly in the unit tests.
- Main entry:
  ```ts
  export async function writeFindingsJson(
    scanPath: string,
    result: ScanResult,
    options: { stdoutStream?: NodeJS.WritableStream } = {}
  ): Promise<void>
  ```
  - `const stream = options.stdoutStream ?? process.stdout;`
  - Build schema object via the pure helper.
  - Resolve output path: `const outPath = resolve(scanPath, ".depaudit", "findings.json");`
  - `await mkdir(dirname(outPath), { recursive: true });`
  - `await writeFile(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");`
  - `const covered = await isFindingsJsonGitignored(scanPath);`
  - If `!covered`: `stream.write("warning: .depaudit/findings.json is not gitignored — run 'depaudit setup' or add '.depaudit/' to your .gitignore\n");`
  - Return.
- No top-level side effects; reporter is invocation-scoped.

### Task 3 — Snapshot-test `JsonReporter`

- New file: `src/modules/__tests__/jsonReporter.test.ts`.
- Use Vitest (matches `bun test` + existing pattern in `findingMatcher.test.ts`).
- Test group 1 — `buildFindingsJsonSchema` pure helper:
  - Empty `findings` array produces `{ schemaVersion: 1, sourceAvailability: {osv:true,socket:true}, findings: [] }`.
  - A single `new` / `osv` finding round-trips through the mapper with `summary` defaulted to `""` and `upgradeSuggestion: null`.
  - Each of the four classification categories (`new`, `accepted`, `whitelisted`, `expired-accept`) is carried through verbatim.
  - Both `osv` and `socket` sources map correctly.
  - Input order irrelevant: shuffled input yields the same output as sorted input.
  - Sort key correctness: two findings differing only by `findingId` sort ascending by `findingId`; by `manifestPath` first when manifest paths differ; stable tiebreaker across all five keys.
  - `sourceAvailability` mirrors `ScanResult.osvAvailable` / `socketAvailable` across all four permutations (`true/true`, `true/false`, `false/true`, `false/false`).
- Test group 2 — `writeFindingsJson` write path:
  - Writes `.depaudit/findings.json` under the provided scan root (use a temp dir via `mkdtemp(join(tmpdir(), "depaudit-json-"))`).
  - Creates the `.depaudit/` directory if absent.
  - Overwrites an existing file on rerun with no append or corruption.
  - Output JSON equals a checked-in fixture `src/modules/__tests__/fixtures/json-output/*.expected.json` — one fixture per scenario below. Each fixture is the *full* expected stringified content including the trailing newline.
    - `empty.expected.json` — 0 findings, both sources available.
    - `mixed-classifications.expected.json` — one finding per category, spread across sources.
    - `socket-unavailable.expected.json` — two `osv` `new` findings only, `sourceAvailability.socket: false`.
    - `osv-unavailable.expected.json` — two `socket` `new` findings only, `sourceAvailability.osv: false`.
    - `deterministic-order.expected.json` — three findings input in reverse-alphabetical order, asserts output is in ascending order.
    - `all-categories-both-sources.expected.json` — eight findings (4 categories × 2 sources), asserts full matrix.
- Test group 3 — Gitignore check:
  - `isFindingsJsonGitignored(<path with .gitignore containing ".depaudit/">)` returns `true`.
  - `isFindingsJsonGitignored(<path with .gitignore containing ".depaudit/findings.json">)` returns `true`.
  - `isFindingsJsonGitignored(<path without .gitignore>)` returns `false`.
  - `isFindingsJsonGitignored(<path with .gitignore but unrelated rules>)` returns `false`.
  - `isFindingsJsonGitignored(<path with .gitignore that ignores .depaudit/ then negates findings.json via !>)` returns `false` (honours negation; reporter warns).
  - Warning is emitted to the injected `stdoutStream` when not covered; not emitted when covered. Exactly one warning per call.
  - Warning text matches the specified prefix `"warning: .depaudit/findings.json is not gitignored"` (don't lock the full sentence in order to allow later copy tweaks, but pin the prefix).
- Use `fs.mkdtemp` + `rm` teardown so tests are hermetic and parallel-safe.

### Task 4 — Wire `writeFindingsJson` into `ScanCommand`

- Modify `src/commands/scanCommand.ts`:
  - Add `import { writeFindingsJson } from "../modules/jsonReporter.js";` alongside the existing reporter imports.
  - After the auto-prune block (currently ending around `src/commands/scanCommand.ts:209`) and *before* the final `const exitCode = ... return { ... };`, insert:
    ```ts
    await writeFindingsJson(scanPath, {
      findings: classified,
      socketAvailable: socketResult.available,
      osvAvailable,
      exitCode: 0, // placeholder — exitCode is derived below; the reporter doesn't read it
    });
    ```
    (If introducing a dead placeholder is ugly, thread `exitCode` computation above the call. Either is acceptable; prefer the variant that keeps the prune block contiguous with the reporter call. Recommended: compute `exitCode` first, then call the reporter, then `return`.)
  - Do NOT invoke `writeFindingsJson` from the early-abort paths:
    - `ConfigParseError` for `.depaudit.yml` (`:66-72`).
    - `ConfigParseError` for `osv-scanner.toml` (`:79-85`).
    - Lint-failure exit (`:92-97`).
    - `SocketAuthError` (`:166-169`).
    - OSV catastrophic failure (`:156-159`).
  - Rationale: those paths return before classification; there is no meaningful `findings` array to serialise, and preserving a prior `.depaudit/findings.json` is more useful than overwriting it with a sentinel.
- `ScanResult` shape is unchanged; this is a pure side effect.

### Task 5 — Relax the "stdout contains no finding lines" step

- Modify `features/step_definitions/scan_steps.ts:179-182`:
  ```ts
  Then<DepauditWorld>("stdout contains no finding lines", function (this: DepauditWorld) {
    const lines = this.result!.stdout.trim().split("\n").filter(Boolean);
    const findingLines = lines.filter((l) => FINDING_LINE_RE.test(l));
    assert.equal(findingLines.length, 0, `expected no finding lines, got:\n${findingLines.join("\n")}`);
  });
  ```
- Semantics preserved for scenarios that currently pass with empty stdout (0 total lines → 0 finding lines). Newly-allowed: non-finding lines (e.g., the gitignore warning) on stdout.
- No other existing step needs changing. `stdout contains at least one finding line` and `stdout contains exactly one finding line` and `the finding line matches the pattern` already reference `FINDING_LINE_RE` implicitly via the regex check on line shape.

### Task 6 — Create BDD fixtures

- `fixtures/findings-json-clean-gitignored/`:
  - `package.json`: one clean dependency (copy from `fixtures/clean-npm`).
  - `package-lock.json`: matching lock file.
  - `.gitignore`: single line `.depaudit/`.
  - No CVE, no Socket alert expected.
  - Used by: "writes findings.json on a clean scan without warning" scenario and "re-run overwrites the file" scenario.
- `fixtures/findings-json-clean-not-gitignored/`:
  - `package.json`: one clean dependency.
  - `package-lock.json`: matching lock file.
  - No `.gitignore` at all.
  - Used by: "writes findings.json on a clean scan with a gitignore warning" scenario.
- `fixtures/findings-json-mixed/`:
  - `package.json`: pins one dependency with a known OSV CVE (copy from `fixtures/vulnerable-npm`).
  - `package-lock.json`: matching lock file.
  - `.gitignore`: `.depaudit/`.
  - `osv-scanner.toml`: one `[[IgnoredVulns]]` block covering the CVE with a valid `ignoreUntil` ≥ today (produces `accepted`).
  - `.depaudit.yml`:
    - `version: 1`, default policy.
    - `commonAndFine`: one entry for a Socket-alert type expected to match (produces `whitelisted`).
    - `supplyChainAccepts`: one entry for a Socket alert `(package, version, findingId)` that *no longer matches the mock Socket server's current emission* (produces `expired-accept` if the accept is expired, or forces the scenario to emit an orphan-y setup).
  - Scenario setup: mock Socket server configured to emit a supply-chain alert matching a `supplyChainAccepts` entry with `expires` in the past — generates the `expired-accept` category. A second Socket alert is emitted that's not accepted — generates the `new` supply-chain category. The OSV CVE produces the `accepted` category (covered by `osv-scanner.toml`). A third Socket alert matches `commonAndFine` — produces `whitelisted`.
  - Used by: the "four-category" scenario asserting every classification bucket is serialised.

### Task 7 — Author `features/scan_findings_json.feature`

- File header: `@adw-8`.
- Feature statement: "As a maintainer running `depaudit scan` I want `.depaudit/findings.json` written with a stable schema so that the `/depaudit-triage` skill can consume it without re-running the scan."
- Background reuses `the osv-scanner binary is installed and on PATH` and `the depaudit CLI is installed and on PATH`.
- Scenarios (all tagged `@adw-8 @regression` except where noted):
  1. **Writes findings.json on a clean scan (gitignored)**: `fixtures/findings-json-clean-gitignored`. Assert exit 0, `.depaudit/findings.json` exists, is valid JSON, has `schemaVersion: 1`, `sourceAvailability.osv: true`, `sourceAvailability.socket: true`, `findings: []`, no gitignore warning on stdout.
  2. **Writes findings.json on a clean scan (not gitignored)**: `fixtures/findings-json-clean-not-gitignored`. Assert file exists, and stdout contains `warning: .depaudit/findings.json is not gitignored`.
  3. **Every classification category round-trips**: `fixtures/findings-json-mixed` with mock Socket server configured per Task 6. Assert `findings[]` contains exactly one entry with `classification: "new"`, one `"accepted"`, one `"whitelisted"`, and one `"expired-accept"`.
  4. **Deterministic output**: Run `depaudit scan` twice back-to-back on the same fixture; assert the two `.depaudit/findings.json` files are byte-identical (re-run overwrites with identical content).
  5. **Socket unavailable surfaces in sourceAvailability**: `fixtures/findings-json-clean-gitignored` plus a mock Socket server that 503s. Assert `sourceAvailability.socket: false`, `sourceAvailability.osv: true`, file still written, no Socket findings in `findings[]`.
  6. **OSV catastrophic failure does NOT write the file**: use the existing `fakeOsvBinDir` fail-harness from `@adw-13`. Assert scan exits non-zero and `.depaudit/findings.json` **does not exist** (or, if it exists from a prior run fixture-shipped sample, is byte-identical to a pre-scan snapshot — i.e., not overwritten).
  7. **Lint failure does NOT write the file**: fixture with a malformed `.depaudit.yml`. Assert scan exits 2 and `.depaudit/findings.json` is not created.
  8. **Schema shape is stable**: `fixtures/findings-json-mixed` scan. Assert every entry has exactly the nine required string/string-or-null fields (`package`, `version`, `ecosystem`, `manifestPath`, `findingId`, `severity`, `summary`, `classification`, `source`, `upgradeSuggestion`) with no extras and no missing fields. Assert `upgradeSuggestion` is `null` on every entry this slice.
  9. **Top-level keys in fixed order**: assert the serialised JSON's top-level keys are `schemaVersion`, `sourceAvailability`, `findings` in that order (string `.indexOf` checks on the raw text before `JSON.parse`).
  10. **No mtime side-effect on unrelated files**: assert `.depaudit.yml` and `osv-scanner.toml` mtimes are unchanged by the reporter — only `.depaudit/findings.json` should be written.
- Each scenario uses either the mock Socket server or no Socket at all; spin up the server from step hooks as in `scan_socket_supply_chain_steps.ts`.

### Task 8 — Author `features/step_definitions/scan_findings_json_steps.ts`

- File imports: `Given/When/Then` from `@cucumber/cucumber`, `readFile`, `stat`, `access` from `node:fs/promises`, `resolve`, `join` from `node:path`, `assert` from `node:assert/strict`, `DepauditWorld`, `PROJECT_ROOT` from `../support/world.js`, step helpers from `./scan_steps.js`.
- Before/After hooks:
  - `Before({ tags: "@adw-8" })`: initialise `world.originalFileContents ??= new Map()`. Snapshot `.depaudit/findings.json` under the fixture if it exists pre-scan — used by scenarios #6 and #7 to assert non-overwrite.
  - `After({ tags: "@adw-8" })`: delete `.depaudit/findings.json` under the fixture (tests are hermetic; the next run re-creates it). If the snapshot recorded a pre-existing file, restore its content; otherwise remove.
- New `Given` steps:
  - `Given<DepauditWorld>("a fixture Node repository at {string} with .depaudit/ gitignored", …)` — sets `this.fixturePath` and confirms `.gitignore` contains `.depaudit/`.
  - `Given<DepauditWorld>("a fixture Node repository at {string} without .depaudit/ gitignored", …)` — sets `this.fixturePath` and confirms no `.gitignore` or `.gitignore` that doesn't match `.depaudit/`.
  - `Given<DepauditWorld>("a malformed .depaudit.yml at {string}", …)` — reused from `depaudit_yml_steps.ts` if available, else small inline version.
- New `When` steps:
  - `When<DepauditWorld>("I capture the .depaudit/findings.json in {string}", …)` — reads bytes into `world.capturedFileContent`.
- New `Then` steps:
  - `Then<DepauditWorld>(".depaudit/findings.json exists in {string}", …)` — `access(resolve(PROJECT_ROOT, path, ".depaudit/findings.json"))`.
  - `Then<DepauditWorld>(".depaudit/findings.json does not exist in {string}", …)` — `access` throws ENOENT.
  - `Then<DepauditWorld>("the findings.json at {string} has schemaVersion {int}", …)` — parse and compare.
  - `Then<DepauditWorld>("the findings.json at {string} has sourceAvailability osv={word} socket={word}", …)` — parse and compare booleans.
  - `Then<DepauditWorld>("the findings.json at {string} has {int} findings", …)` — parse and assert `.length`.
  - `Then<DepauditWorld>("the findings.json at {string} has exactly one finding with classification {string}", …)` — filter and assert.
  - `Then<DepauditWorld>("every finding in the findings.json at {string} has exactly the keys {string}", …)` — parse each entry, assert `Object.keys(entry).sort()` equals the expected set.
  - `Then<DepauditWorld>("every finding in the findings.json at {string} has upgradeSuggestion null", …)` — parse and assert.
  - `Then<DepauditWorld>("the findings.json at {string} top-level keys are {string} in order", …)` — raw text `indexOf` checks.
  - `Then<DepauditWorld>("the .depaudit/findings.json in {string} is byte-identical to the captured content", …)` — re-read and compare.
  - `Then<DepauditWorld>("stdout contains {string}", …)` — if not already defined elsewhere, `assert.ok(this.result!.stdout.includes(expected))`. If already defined, skip.
  - `Then<DepauditWorld>("stdout does not contain {string}", …)` — complement.
  - `Then<DepauditWorld>("the mtime of {string} in {string} is unchanged", …)` — requires a `When I record the mtime of {string} in {string}` counterpart; store pre-scan `stat().mtimeMs` in a world field and compare post-scan.
- Reuse existing assertions for exit code, stdout content, stderr mentions.

### Task 9 — Update documentation

- Create `app_docs/feature-2rdowb-json-reporter.md` in the house style (same headings as `app_docs/feature-82j9dc-orphan-auto-prune.md`): Overview, What Was Built, Technical Implementation (Files Modified / Key Changes), How to Use, Testing, Notes.
- Append to `.adw/conditional_docs.md`:
  ```
  - [app_docs/feature-2rdowb-json-reporter.md](../app_docs/feature-2rdowb-json-reporter.md) — When working with `JsonReporter`, `.depaudit/findings.json`, the `FindingsJsonSchema` shape, the `/depaudit-triage` skill handoff, or gitignore warnings on un-ignored artifacts; when troubleshooting snapshot-test failures on the rendered JSON output.
  ```
- Do NOT add a README.md section; the README is intentionally minimal (pre-release pointer to the PRD).

### Task 10 — Run the validation suite

- Execute every command in **Validation Commands** below. All must pass with zero regressions.

## Testing Strategy

### Unit Tests

`.adw/project.md` does not carry a `## Unit Tests: enabled` marker. This plan includes unit-test tasks as a documented override, matching the precedent set by issues #3, #4, #5, #6, #7, and #13. Justifications for this slice, in priority order:

1. **The issue explicitly mandates snapshot tests** for `JsonReporter` output. Acceptance criterion "Snapshot tests for `JsonReporter` output" cannot be satisfied by BDD alone at a reasonable cost.
2. **Renderer contract.** Per PRD `specs/prd/depaudit.md:229` and `:241`, `JsonReporter` is a "Tier 1 module" (Renderer category) that is expressly called out as a snapshot-test target: "Snapshot tests are used for renderer output (`MarkdownReporter`, `JsonReporter`) because the exact formatting is part of the external contract."
3. **BDD cannot economically cover the sort-key matrix.** Deterministic ordering requires tests for reverse-input, mixed-manifest-path, duplicate-but-different-source findings, etc. The unit-level snapshot tests collapse that matrix into fast, diffable fixture comparisons.
4. **Gitignore edge cases are cheaper as unit tests.** Patterns like `.depaudit/`, `.depaudit/findings.json`, negation (`!.depaudit/findings.json`), nested rules, and ENOENT handling are a small enum tested directly against `isFindingsJsonGitignored`.

Unit tests to build:

- **`src/modules/__tests__/jsonReporter.test.ts`**:
  - `buildFindingsJsonSchema` purity and sort-key correctness (Task 3, group 1).
  - `writeFindingsJson` file write, overwrite, directory creation, byte-for-byte match against fixture files (Task 3, group 2).
  - `isFindingsJsonGitignored` rule matching across the enumerated cases (Task 3, group 3).

### Edge Cases

- **Empty classified findings.** Reporter still writes the file with `findings: []` and current `sourceAvailability`. Covered by `empty.expected.json` fixture.
- **`.depaudit/` already exists as a directory.** `mkdir({ recursive: true })` is a no-op; no crash.
- **`.depaudit/findings.json` already exists from a prior run.** `writeFile` overwrites; snapshot test confirms byte-identity on re-run with identical input.
- **Scan root is read-only.** `writeFile` throws; error propagates to `ScanCommand`'s top-level handler (same as any unhandled I/O error). No special handling added here — the scenario is rare and failing loudly is correct.
- **Scan root is relative.** `resolve(scanPath, ".depaudit", "findings.json")` promotes to absolute. Tests cover both relative and absolute inputs.
- **`.gitignore` with CRLF line endings.** The `ignore` package parses `\r\n`-terminated lines correctly; unit-tested.
- **`.gitignore` with a negation that un-ignores `.depaudit/findings.json`.** Reporter treats the path as NOT covered and emits the warning. User's rule wins.
- **`.gitignore` at an ancestor of `scanPath`.** Reporter only inspects `<scanPath>/.gitignore`. If the scan path is a subdirectory and `.depaudit/` is ignored at the repo root but no `.gitignore` exists at the scan path, the reporter warns. This is acceptable for MVP — documented in Notes.
- **Finding with empty `package` or `version`.** Mapped through verbatim; sorts using the default empty-string comparison. No validation at the reporter boundary — upstream producers (`OsvScannerAdapter`, `SocketApiClient`) already guarantee non-empty identities; reporter stays dumb.
- **Two findings identical on all five sort keys.** `Array.prototype.sort` in V8 is stable as of Node 12+; the relative input order is preserved. Unit-tested against a known-duplicate input to pin the behaviour.
- **`summary` contains double quotes, newlines, or Unicode.** `JSON.stringify` escapes correctly; covered by a fixture whose summary contains `"` and newlines.
- **`source: "socket"` finding with `manifestPath: ""`.** Socket findings with no manifest match emit `manifestPath: ""` (see `src/modules/socketApiClient.ts:257-268`). Reporter sorts the empty string first by default. Acceptable.
- **Write failure mid-operation (e.g., disk full).** `writeFile` throws; `ScanCommand` propagates. No partial file state is tolerable — if the user sees the throw, they re-run. No cleanup needed.
- **Warning stream is a buffered writable that rejects writes.** Out of scope; reporter's injection point is for tests only. Production always uses `process.stdout`.

## Acceptance Criteria

- [ ] `src/types/findingsJson.ts` defines `FindingsJsonSchema`, `FindingsJsonEntry`, `SourceAvailability`, and `CURRENT_SCHEMA_VERSION`.
- [ ] `src/modules/jsonReporter.ts` exports `writeFindingsJson(scanPath, result, options?)` and `buildFindingsJsonSchema(result)`.
- [ ] `src/commands/scanCommand.ts` calls `writeFindingsJson` after classification and after the prune block on every non-aborted run.
- [ ] Running `depaudit scan` on `fixtures/findings-json-clean-gitignored` produces `.depaudit/findings.json` with `{ schemaVersion: 1, sourceAvailability: {osv: true, socket: true}, findings: [] }`, trailing newline, and no stdout warning.
- [ ] Running `depaudit scan` on `fixtures/findings-json-clean-not-gitignored` produces `.depaudit/findings.json` AND emits `warning: .depaudit/findings.json is not gitignored …` to stdout.
- [ ] Running `depaudit scan` on `fixtures/findings-json-mixed` produces a `findings[]` containing exactly one entry per classification category (`new`, `accepted`, `whitelisted`, `expired-accept`).
- [ ] Every entry in `findings[]` has exactly the nine fields (`package`, `version`, `ecosystem`, `manifestPath`, `findingId`, `severity`, `summary`, `classification`, `source`, `upgradeSuggestion`) with `upgradeSuggestion: null`.
- [ ] Running the same scan twice back-to-back produces byte-identical `.depaudit/findings.json`.
- [ ] `sourceAvailability.socket` is `false` in the JSON when the Socket mock returns 503.
- [ ] On OSV catastrophic failure, `.depaudit/findings.json` is not overwritten.
- [ ] On lint failure, `.depaudit/findings.json` is not created.
- [ ] Snapshot tests in `src/modules/__tests__/jsonReporter.test.ts` cover every classification × source permutation plus the gitignore edge cases.
- [ ] `bun run lint`, `bun run typecheck`, `bun run build`, `bun test` all pass with zero new warnings or errors.
- [ ] `bun run test:e2e -- --tags "@adw-8"` passes all `@adw-8` scenarios.
- [ ] `bun run test:e2e -- --tags "@regression"` continues to pass unchanged — no regressions introduced by the tightened `stdout contains no finding lines` step.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `bun install` — ensure dependencies resolved (no new runtime dependencies expected; `ignore` already present).
- `bun run lint` — lint the entire codebase; must pass with zero warnings.
- `bun run typecheck` — TypeScript strict mode must pass with zero errors across the new types, the reporter, and the extended `ScanCommand`.
- `bun test` — full Vitest suite including new `jsonReporter.test.ts`. Zero failures.
- `bun run build` — emits `dist/types/findingsJson.js`, `dist/modules/jsonReporter.js`, updated `dist/commands/scanCommand.js`.
- `bun run test:e2e -- --tags "@adw-8"` — the new BDD scenarios pass end-to-end.
- `bun run test:e2e -- --tags "@regression"` — every prior scenario (`@adw-3` through `@adw-13`) continues to pass unchanged.
- `bun run test:e2e` — run the entire Cucumber suite as a final smoke test.

## Notes

- **No new runtime dependencies.** `ignore` (used by the gitignore check) is already a direct dep via `ManifestDiscoverer`. No need for `bun add`.
- **Unit tests override.** `.adw/project.md` lacks `## Unit Tests: enabled`. This plan includes snapshot unit tests because the issue mandates them as an acceptance criterion and the PRD's testing decisions (`specs/prd/depaudit.md:229, :241`) explicitly position `JsonReporter` as a snapshot-test target. Same precedent as issues #3–#7 and #13.
- **Schema versioning policy.** `schemaVersion: 1` is hard-coded. Future bumps require both a code change and a migration note in the PRD. The field lets `/depaudit-triage` refuse to consume unsupported versions gracefully rather than silently mis-parsing.
- **`upgradeSuggestion` is forward-looking.** Always `null` in this slice. A future slice (tentatively issue-22 or similar) will add a resolver that computes concrete upgrade paths per finding. Reserving the field now avoids a breaking schema change later.
- **`summary` defaults to empty string, not omitted.** Optional JSON fields complicate consumer code. Fixed-shape output (always all fields present) is easier to type and parse. The trade-off is a slightly larger file for `socket` findings without a `props.title`, which is negligible.
- **Key ordering in output JSON.** `JSON.stringify` preserves insertion order for object keys. The reporter constructs objects with keys in the deliberate order `package, version, ecosystem, manifestPath, findingId, severity, summary, classification, source, upgradeSuggestion` for per-entry, and `schemaVersion, sourceAvailability, findings` at the top level. Snapshot tests pin both.
- **Write timing relative to auto-prune.** The reporter runs AFTER auto-prune. Downstream consumers see the classification for *this* run, not the next run's predicted state. Matches the orphan-prune slice's "pre-prune findings remain in `ScanResult.findings`" invariant.
- **Stdout vs stderr for the warning.** The issue explicitly specifies stdout. Other metadata emissions in this CLI (`expired accept:`, `socket: supply-chain unavailable`, `auto-prune: …`) go to stderr. This slice follows the issue literally; an opportunistic future patch could align all warning destinations, but that is out of scope here. The relaxation of `stdout contains no finding lines` accommodates the choice.
- **`stdout contains no finding lines` step tightening is a semantic preservation, not an expansion.** Every currently-passing scenario continues to pass: `0 total lines` ⊆ `0 finding-pattern lines`. New scenarios can emit the gitignore warning to stdout without tripping the assertion.
- **Gitignore check is scoped to `<scanPath>/.gitignore`.** Ancestor `.gitignore` files are not consulted. A user scanning a subdirectory of a repo whose root `.gitignore` covers `.depaudit/` but whose subdirectory has no `.gitignore` will see a spurious warning. This is acceptable for MVP and can be fixed in a future slice by walking parents; the PRD's design intent is that `depaudit scan` is invoked from the repo root.
- **Early-abort file-preservation semantics.** On lint/parse/auth/OSV-catastrophe failure, the reporter is not invoked, so any prior `.depaudit/findings.json` survives untouched. This is explicit design: a user fixing a lint error in `.depaudit.yml` should not have their stale-but-pending triage artifact silently nuked. Documented in the BDD scenarios #6 and #7.
- **Future extension: SARIF or SBOM export.** Explicitly out of scope (PRD `specs/prd/depaudit.md:269`). `.depaudit/findings.json` is the only structured artifact depaudit emits.
- **Coverage mapping.** User story 23 (triage skill context) is addressed by making the artifact available; the skill itself lands in a later ADW issue. PRD references `:121, :160, :204, :212, :229, :241, :250` are satisfied by Tasks 1–4 (shape + write + integration) and Task 3 (snapshot tests).
