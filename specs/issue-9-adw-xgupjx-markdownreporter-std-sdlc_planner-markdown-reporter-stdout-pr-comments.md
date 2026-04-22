# Feature: MarkdownReporter (stdout + PR-comment-ready markdown)

## Metadata
issueNumber: `9`
adwId: `xgupjx-markdownreporter-std`
issueJson: `{"number":9,"title":"MarkdownReporter (stdout + PR-comment-ready markdown)","body":"## Parent PRD\n\n`specs/prd/depaudit.md`\n\n## What to build\n\n`MarkdownReporter` renders classified findings into markdown usable for both stdout and PR comments. Structure matches PRD \"PR comment and Slack notification\" section: pass header (count of new / accepted / whitelisted / expired), fail header, new-findings table (severity, package, version, finding-id, suggested action), expired-accepts table if any, `socketAvailable: false` annotation when applicable.\n\nRemediation suggestions come from OSV (fixed version) or are plain text when not available (e.g., \"investigate; accept or upgrade\").\n\n## Acceptance criteria\n\n- [ ] `MarkdownReporter` emits pass / fail / mixed outcomes per PRD template.\n- [ ] New-findings table contains severity, package, version, finding-id, suggested action.\n- [ ] Expired-accepts surfaced as a distinct section when present.\n- [ ] Supply-chain-unavailable annotation when `socketAvailable: false`.\n- [ ] Snapshot tests for each output shape (pass, fail, expired-only, supply-chain-unavailable).\n- [ ] `depaudit scan --format markdown` (or default) routes through `MarkdownReporter` to stdout.\n\n## Blocked by\n\n- Blocked by #8\n\n## User stories addressed\n\n- User story 31\n","state":"OPEN","author":"paysdoc","labels":[],"createdAt":"2026-04-17T13:24:41Z","comments":[],"actionableComment":null}`

## Feature Description

`depaudit scan` today writes two stdout artefacts: line-based finding strings via `stdoutReporter.printFindings` (`src/modules/stdoutReporter.ts:3-10`), one per `new` finding in the form `<package> <version> <finding-id> <severity>`, and the `JsonReporter` gitignore warning when applicable. Neither is consumable as a PR comment, neither summarises the run for a human glance, and neither carries the per-category counts (`new`/`accepted`/`whitelisted`/`expired`) that the PRD's "PR comment and Slack notification" section requires. The classified outcome of every run today vanishes from the user's terminal as a flat list with no context about why the gate flipped or what to do next.

This slice introduces `MarkdownReporter`: a deep module that renders the post-classification `ScanResult` into PR-comment-ready markdown — the same markdown that a future CI step will copy into a GitHub PR comment, a developer reads off the terminal, and `SlackReporter` will eventually summarise (a later slice). It composes the structure prescribed in the PRD: a pass-or-fail header, per-category counts, a new-findings table with `(severity, package, version, finding-id, suggested action)` columns, an expired-accepts section when applicable, and a `socketAvailable: false` annotation when the supply-chain layer fell open. The output begins with the HTML marker `<!-- depaudit-gate-comment -->` so future PR-comment-update logic can locate the prior comment for in-place rewrite (PRD `:190`).

`depaudit scan` gains a `--format <markdown|text>` CLI flag. `markdown` becomes the default; `text` preserves the legacy line-based output (current `printFindings` behaviour) for users who pipe stdout into ad-hoc shell tooling and for the existing BDD test surface. JSON output goes to `.depaudit/findings.json` regardless of `--format` (that's the JsonReporter's contract; `--format` only governs stdout shape).

Suggested actions in the new-findings table are deliberately a placeholder string in this slice — `"investigate; accept or upgrade"` — mirroring the precedent set by JsonReporter's `upgradeSuggestion: null` (issue #8). A future slice (the upgrade-resolver, tentatively coupled to triage skill work) will derive concrete fixed-version suggestions from OSV's `affected.ranges` data and surface them through the same column. The placeholder keeps the column shape stable so the future change is a content-only delta.

## User Story

As a contributor who pushes a PR that fails the depaudit gate
I want the gate's stdout output to be a markdown report I (or CI) can paste verbatim into a PR comment
So that I can see at a glance which findings introduced the failure, what severity and finding-id each carries, and a suggested next step — without digging through CI logs or reasoning about a flat list of finding strings.

As a maintainer running `depaudit scan` locally
I want the same markdown report on my terminal so my local run looks the same as the CI gate
So that there's exactly one mental model for "what does a depaudit failure look like."

As a maintainer who scripts the CLI's text output today
I want a `--format text` opt-out that preserves the legacy line-based stdout
So that ad-hoc shell pipelines I've already built keep working.

## Problem Statement

Today, `ScanCommand` (`src/commands/scanCommand.ts`) ends with:

1. `printFindings(newFindings)` (line `:183`) — flat lines of `<package> <version> <finding-id> <severity>` for `new` findings only. `accepted`, `whitelisted`, and `expired-accept` counts are never surfaced on stdout.
2. `process.stderr.write(\`expired accept: …\`)` (lines `:186-188`) — one stderr line per expired-accept. Mixed in with auto-prune notices and Socket fail-open lines, with no header to bracket them as a section.
3. `await writeFindingsJson(...)` (line `:216`) — writes `.depaudit/findings.json` for the future triage skill.

Concretely the gaps this slice closes:

1. **No PR-comment-ready output.** PRD `:190` names a PR comment as the canonical contributor-facing artifact: "PR comment is identified by an HTML marker (`<!-- depaudit-gate-comment -->`) and updated in place on every scan." No code today renders that marker, the pass/fail header, or the per-category counts. The CI step that posts to GitHub has nothing to post.
2. **No category counts.** PRD `:190` and the issue body both call for "pass header (count of new / accepted / whitelisted / expired)". The classified result carries every category in `ClassifiedFinding[]` (`src/types/depauditConfig.ts:38-43`), but only `new` reaches stdout via `printFindings`. A maintainer reading the local terminal cannot see — without re-running with a debugger — how many findings were silently accepted, whitelisted, or expired.
3. **No table with the columns the issue mandates.** Issue acceptance criterion: "New-findings table contains severity, package, version, finding-id, suggested action." `printFindings` emits four space-separated tokens with no `severity` first, no header row, and no `suggested action` column. There is no markdown-format renderer at all; the column ordering required by the issue isn't representable in the current stdout format.
4. **No "expired-accepts" section.** PRD `:190` calls out that "expired-accept-driven failures are called out in a dedicated section." Today expired accepts emit one stderr line per finding via `process.stderr.write` (`scanCommand.ts:186-188`), with no section header, no table, and no separation from auto-prune or Socket-fail-open notices.
5. **No supply-chain-unavailable annotation.** When Socket falls open (`socketResult.available === false`), `scanCommand.ts:172-174` emits one stderr line `"socket: supply-chain unavailable …"`. PRD `:191` and the issue body require that annotation to be part of the PR comment / markdown output, not buried in stderr where it gets lost on a terminal that paints stderr the same colour as stdout.
6. **No `--format` selection.** The CLI has `parseArgs` setup at `src/cli.ts:26-35` for `--help` and `--version`; there is no `--format` option. Without it, there is no way for a CI step to ask for "markdown please" without parsing line-based output and reformatting itself.
7. **No snapshot-test surface for the renderer contract.** PRD `:229` and `:241` make `MarkdownReporter` a Tier 1 module with snapshot tests as the contract guard, mirroring the JsonReporter slice (`src/modules/__tests__/jsonReporter.test.ts`). No code or tests exist for it today; the issue's "Snapshot tests for each output shape" criterion has nothing to bind to.
8. **No HTML marker.** PRD `:190` names `<!-- depaudit-gate-comment -->` as the marker the comment-update logic will use to find the prior comment. Even though the comment-update logic itself is a later slice (`StateTracker` integration), the marker has to live in the rendered output now so that future logic can read it without a downstream coupling-to-CI rewrite.

The shape of the data needed is fully present in `ScanResult` (`src/types/scanResult.ts`); the gap is purely in the rendering boundary.

## Solution Statement

Add a deep `MarkdownReporter` module that renders a post-classification `ScanResult` into a deterministic markdown document. Wire it into `ScanCommand` behind a new `--format <markdown|text>` CLI flag whose default is `markdown`. Cover the renderer with fixture-driven snapshot tests (per PRD `:229, :241`) and the wiring with BDD scenarios. Migrate existing BDD scenarios that depend on the legacy line-based stdout to opt into `--format text`.

Specifically:

- **New `src/types/markdownReport.ts`** — exports the renderer's input options and the canonical column ordering as constants:
  - `MARKDOWN_COMMENT_MARKER = "<!-- depaudit-gate-comment -->"` — the HTML marker per PRD `:190`.
  - `MarkdownReportOptions { suggestedActionFor?(cf: ClassifiedFinding): string }` — single hook for the future upgrade-resolver slice; defaults to the placeholder text.
  - No new domain types; the renderer consumes `ScanResult` directly.

- **New `src/modules/markdownReporter.ts`** — exports a single pure function `renderMarkdownReport(result: ScanResult, options?: MarkdownReportOptions): string`. Internally:
  1. Splits the classified array into the four `FindingCategory` buckets (`new`, `accepted`, `whitelisted`, `expired-accept`) with `Array.prototype.filter`.
  2. Sorts the `new` and `expired-accept` buckets with the same comparator JsonReporter uses (`(manifestPath, source, findingId, package, version)` via `localeCompare`) so snapshot output is byte-deterministic.
  3. Emits, in order:
     - One blank line, then `MARKDOWN_COMMENT_MARKER`, then a blank line.
     - Pass-or-fail header line: `## depaudit gate: PASS` if `result.exitCode === 0`, else `## depaudit gate: FAIL`. (No emoji per project convention; the word `PASS` / `FAIL` is the unambiguous status signal.)
     - Per-category count list (always emitted, regardless of pass/fail):
       ```
       - new: <count>
       - accepted: <count>
       - whitelisted: <count>
       - expired: <count>
       ```
     - The new-findings table (only when `new` count > 0). Header row exactly:
       ```
       | severity | package | version | finding-id | suggested action |
       | --- | --- | --- | --- | --- |
       ```
       Followed by one row per `new` finding in sorted order. Cell values escape pipe characters (`|` → `\|`) and replace newlines in `summary` (used as a fallback for suggested action — see hook contract) with a literal space.
     - The expired-accepts section (only when `expired-accept` count > 0):
       ```
       ### Expired accepts (<count>)
       
       | severity | package | version | finding-id | suggested action |
       | --- | --- | --- | --- | --- |
       ```
       Same column structure. Suggested action defaults to `"re-evaluate or extend acceptance"` for expired entries (different placeholder than `new` to reflect the user's likely next move).
     - Supply-chain-unavailable annotation, only when `result.socketAvailable === false`:
       ```
       > supply-chain unavailable — Socket scan failed; CVE-only gating ran for this run.
       ```
     - OSV-unavailable annotation, only when `result.osvAvailable === false`:
       ```
       > CVE scan unavailable — OSV scanner failed; supply-chain gating ran for this run.
       ```
     - Trailing newline.
  4. Returns the full string. No I/O. No mutation of inputs. Determinism over identical inputs is the test contract.

- **New `MarkdownReportOptions.suggestedActionFor` hook** — accepts a `ClassifiedFinding` and returns the cell string. When unset, the renderer uses:
  - `"investigate; accept or upgrade"` for `new` rows.
  - `"re-evaluate or extend acceptance"` for `expired-accept` rows.
  
  Reserving the hook now avoids a breaking signature change when the future upgrade-resolver slice begins computing `"upgrade ajv to ≥8.17.1"`-style strings (issue body's verbatim example, lifted from PRD user-story 31). This slice does NOT call `OsvScannerAdapter` or any new boundary; the placeholder strings are hard-coded fallback in the renderer, and the hook is exported for future extension.

- **Extend `src/cli.ts`** with a `--format` option:
  - `format: { type: "string", short: "f" }` added to `parseArgs` options.
  - Validation: `values.format` must be in `{"markdown", "text"}`; default is `"markdown"`. Unknown values emit `error: unknown --format value …` to stderr and exit 2 (matching the existing unknown-command exit policy at `cli.ts:77-78`).
  - The selected format is threaded into `runScanCommand` as a second argument: `runScanCommand(scanPath, { format })`.

- **Extend `src/commands/scanCommand.ts`**:
  - Signature becomes `runScanCommand(scanPath: string, options: { format: "markdown" | "text" } = { format: "markdown" })`. Default at the function level keeps existing direct callers (none today besides the CLI) working without an audit.
  - Replace the unconditional `printFindings(newFindings)` call (`scanCommand.ts:183`) with a format switch:
    - `format === "text"`: keep the existing `printFindings(newFindings)` call exactly as-is. Stderr `expired accept: …` lines (`scanCommand.ts:186-188`) and `socket: supply-chain unavailable …` (line `:173`) remain on stderr — text mode preserves current behaviour byte-for-byte except for the new `--format` flag's presence in argv.
    - `format === "markdown"`: call `process.stdout.write(renderMarkdownReport({ findings: classified, socketAvailable, osvAvailable, exitCode }))` once, AFTER `exitCode` is computed (line `:214`). Suppress the `printFindings(newFindings)` call AND the per-finding stderr expired-accept lines (the markdown report's expired-accepts section subsumes them). Keep the `socket: supply-chain unavailable …` and `osv: CVE scan failed catastrophically …` stderr lines as-is — they double as a CI-log audit trail and the markdown annotation is for the human reader.
  - The `writeFindingsJson` call remains unchanged — it's format-orthogonal, governed by the JsonReporter contract.
  - Wiring order constraint: `renderMarkdownReport` must run AFTER `exitCode` is computed (otherwise the pass/fail header is wrong). Move the `exitCode` calculation above the markdown emit; the existing `return { … exitCode }` continues to use the same value.

- **Migrate existing BDD scenarios that depend on `FINDING_LINE_RE`** to opt into `--format text`:
  - The scenarios live in `features/scan.feature`, `features/scan_accepts.feature`, `features/scan_polyglot.feature`, `features/scan_severity_threshold.feature`, `features/scan_socket_supply_chain.feature`, `features/scan_yml_accepts.feature`, `features/scan_orphan_prune.feature`. Each `When I run "depaudit scan …"` step that is followed (now or in any later step in the same scenario) by a `FINDING_LINE_RE`-dependent assertion gets `--format text` appended to the depaudit invocation in the When step.
  - Scenarios that assert only on stderr / exit code / file state (not stdout finding lines) do NOT need `--format text` — markdown's stdout doesn't break them and may incidentally cover them.
  - `features/scan_json_reporter.feature` (issue #8) is unchanged — JsonReporter's behaviour is format-orthogonal; a markdown stdout run still writes the JSON file. The "stdout mentions `gitignore`" assertions in that file continue to hold (the warning string is identical regardless of `--format`).
  - `features/lint*.feature` files are unaffected — `depaudit lint` doesn't go through `runScanCommand`.

- **Snapshot tests for `MarkdownReporter` output** (`src/modules/__tests__/markdownReporter.test.ts`): drive the renderer with synthetic `ScanResult` objects and assert against checked-in expected-markdown files under `src/modules/__tests__/fixtures/markdown-output/`. Cover every output shape the issue mandates plus determinism / column-escape / category-count edge cases. Use file-based snapshot assertions (read expected file, `assert.strictEqual`) for diffability — same pattern as JsonReporter's fixture comparisons.

- **BDD scenarios (`features/scan_markdown_reporter.feature`, tag `@adw-9`)** cover the end-to-end behaviour of the wiring: default format is markdown, `--format text` opts out, `--format markdown` is explicit, marker is present, pass header on clean repo, fail header on CVE repo, expired-accepts section when applicable, supply-chain-unavailable annotation when Socket falls open, OSV-unavailable annotation on OSV catastrophic failure, unknown `--format` value exits 2.

- **Documentation** — new `app_docs/feature-xgupjx-markdown-reporter.md` in the house style of `app_docs/feature-2rdowb-json-reporter.md`; conditional_docs entry appended.

## Relevant Files

Use these files to implement the feature:

- `specs/prd/depaudit.md` — parent PRD. Lines `:190-193` (PR-comment template, marker, Slack notification semantics), `:204` (`Reporter` composes `MarkdownReporter`), `:229, :241` (snapshot tests for renderer output), user stories 8 and 31 (contributor-facing PR comment with suggested action). Lines `:109-110` (Socket fail-open) — the supply-chain-unavailable annotation is the user-visible side of that decision.
- `README.md` — project overview and pre-release status; confirms target deliverables.
- `src/cli.ts` — composition root for CLI argument parsing. Lines `:26-35` (`parseArgs` options) get a new `--format` flag. Line `:62` (`runScanCommand(cmdPath ?? process.cwd())`) gets a second `{ format }` argument.
- `src/commands/scanCommand.ts` — composition root to extend. Lines `:183-188` (current stdout/stderr emit) become a format-switched block. Line `:214` (`exitCode` computation) must execute before the markdown emit. Line `:216` (`writeFindingsJson`) stays put — format-orthogonal.
- `src/modules/stdoutReporter.ts` — existing line-based reporter; reused unchanged for `--format text`.
- `src/modules/jsonReporter.ts` — house-style reference for a deep reporter module. The `buildFindingsJsonSchema` pure helper at `:9-41` is the structural twin of `renderMarkdownReport`'s body — sort comparator can be lifted verbatim.
- `src/types/scanResult.ts` — `ScanResult { findings, socketAvailable, osvAvailable, exitCode }` is the renderer's input. No extension.
- `src/types/depauditConfig.ts` — `ClassifiedFinding` (`:40-43`) and `FindingCategory` (`:38`) are the per-entry types the renderer buckets and renders.
- `src/types/finding.ts` — `Finding`, `Severity`, `FindingSource`, `Ecosystem`. Cell values come from these fields.
- `src/modules/__tests__/jsonReporter.test.ts` — fixture-driven snapshot harness pattern; markdown reporter test layout copies it (temp dir / fixture file comparison).
- `src/modules/__tests__/findingMatcher.test.ts` — pure-function test idiom for the renderer's bucketing logic.
- `features/step_definitions/scan_steps.ts` — `runDepaudit` helper (`:97`+), `FINDING_LINE_RE` (`:12`). Existing scenarios that assert finding lines need updating to pass `--format text`. Step definitions for new markdown assertions can live alongside.
- `features/step_definitions/scan_json_reporter_steps.ts` — house-style reference for an `@adw-N`-tagged feature: Before/After hooks, world-state usage, JSON-file assertion patterns translate to markdown-string assertion patterns.
- `features/support/world.ts` — `DepauditWorld` already carries `result`, `fixturePath`, `socket*` fields. No new world fields required for markdown assertions (we read from `result.stdout` directly).
- `features/support/mockSocketServer.ts` — reused for the supply-chain-unavailable scenario so `socketAvailable: false` is observable.
- `features/scan.feature`, `features/scan_accepts.feature`, `features/scan_polyglot.feature`, `features/scan_severity_threshold.feature`, `features/scan_socket_supply_chain.feature`, `features/scan_yml_accepts.feature`, `features/scan_orphan_prune.feature` — files containing scenarios whose `When I run "depaudit scan …"` step needs `--format text` appended (identified by the presence of `FINDING_LINE_RE`-bound assertions in the same scenario).
- `features/scan_json_reporter.feature` — unchanged. JsonReporter behaviour is format-orthogonal.
- `app_docs/feature-2rdowb-json-reporter.md` — house-style reference for the new `app_docs/feature-xgupjx-markdown-reporter.md`.
- `.adw/project.md` — confirms deep-module layout, `bun` tooling, test runner choice.
- `.adw/commands.md` — validation commands (`bun run lint`, `bun run typecheck`, `bun run build`, `bun test`, `bun run test:e2e`).
- `.adw/conditional_docs.md` — append the new `app_docs/feature-xgupjx-markdown-reporter.md` entry.
- `.adw/review_proof.md` — line `:17` already calls out "snapshot assertions are updated and match the intended output" for `MarkdownReporter` and `JsonReporter`. This slice satisfies that proof requirement.
- `specs/issue-8-adw-2rdowb-jsonreporter-depaudi-sdlc_planner-json-reporter-findings-output.md` — sister-slice plan; format and depth precedent.

### New Files

- `src/types/markdownReport.ts` — new types and constants: `MARKDOWN_COMMENT_MARKER`, `MarkdownReportOptions`.
- `src/modules/markdownReporter.ts` — new deep module: `renderMarkdownReport(result, options?): string`.
- `src/modules/__tests__/markdownReporter.test.ts` — snapshot tests for the renderer output and pure-helper invariants.
- `src/modules/__tests__/fixtures/markdown-output/` — checked-in expected markdown files:
  - `pass-empty.expected.md` — clean scan, all categories at 0, both sources available.
  - `pass-with-accepts.expected.md` — passing scan with non-zero `accepted` and `whitelisted` counts but no `new` or `expired-accept`.
  - `fail-new-only.expected.md` — failing scan with one `new` finding from `osv`.
  - `fail-new-multiple.expected.md` — failing scan with several `new` findings from both sources, asserts sort order and table rows.
  - `fail-expired-only.expected.md` — failing scan with only `expired-accept` (no `new`); demonstrates the expired-accepts section appears and the new-findings table is omitted.
  - `fail-mixed.expected.md` — failing scan with `new` + `expired-accept` + `accepted` + `whitelisted` together; both tables present, all four counts non-zero.
  - `fail-supply-chain-unavailable.expected.md` — failing scan with `socketAvailable: false` annotation present.
  - `pass-supply-chain-unavailable.expected.md` — passing scan with `socketAvailable: false` annotation present.
  - `fail-osv-unavailable.expected.md` — failing scan with `osvAvailable: false` annotation present.
  - `cell-escapes.expected.md` — a `new` finding whose `package` contains a literal `|` and whose `summary` contains a newline; demonstrates pipe-escape and newline-replacement.
- `features/scan_markdown_reporter.feature` — new BDD feature file tagged `@adw-9`.
- `features/step_definitions/scan_markdown_reporter_steps.ts` — step definitions for marker-presence, header, count-list, table-presence, annotation-presence assertions.
- `fixtures/md-*/` — per-scenario BDD fixtures (enumerated in Task 7). Each scenario ships a dedicated fixture under the `md-` prefix so its preconditions (CVE pinning, Socket mock setup, OSV fail-harness, `.gitignore` for findings.json) are isolated from other slices.
- `app_docs/feature-xgupjx-markdown-reporter.md` — implementation summary in the house style.

## Implementation Plan

### Phase 1: Foundation

Define the renderer's input shape (already covered by `ScanResult`), introduce the new `--format` types and constants, and stand up the deep reporter module with a pure function and zero I/O.

- Create `src/types/markdownReport.ts` with `MARKDOWN_COMMENT_MARKER` and `MarkdownReportOptions`.
- Create `src/modules/markdownReporter.ts` exporting `renderMarkdownReport(result, options?): string` with the structural logic but using placeholder action strings.
- Land this slice without touching `cli.ts` or `scanCommand.ts` yet — the renderer is independently usable and unit-testable.

### Phase 2: Snapshot test surface

Lock down the rendering contract before wiring it into `ScanCommand`, so any subsequent integration regression surfaces as a snapshot delta rather than as a flaky e2e.

- Build the fixture markdown files under `src/modules/__tests__/fixtures/markdown-output/` for the cases enumerated above.
- Unit-test the renderer (purity, deterministic sort order, category count list, table emit conditions, annotation emit conditions, pipe escape, newline replacement, marker presence, pass-vs-fail header, suggested-action hook fallbacks).

### Phase 3: CLI flag and ScanCommand wiring

Wire the renderer behind `--format`, default to markdown, preserve text mode, and migrate existing BDD scenarios.

- Extend `src/cli.ts` with the `--format` option, validation, and threading into `runScanCommand`.
- Extend `src/commands/scanCommand.ts` with the format switch, moving `exitCode` computation above the emit.
- Migrate every legacy `When I run "depaudit scan …"` step in non-`@adw-8` `@regression` scenarios to append `--format text` when the same scenario asserts on `FINDING_LINE_RE`.
- Author `features/scan_markdown_reporter.feature` and step definitions.
- Create the BDD fixtures under `fixtures/md-*/`.
- Author `app_docs/feature-xgupjx-markdown-reporter.md` and append to `.adw/conditional_docs.md`.
- Run the full validation suite.

## Step by Step Tasks

Execute every step in order, top to bottom.

### Task 1 — Define the markdown-reporter types and constants

- Create `src/types/markdownReport.ts`.
- Export `export const MARKDOWN_COMMENT_MARKER = "<!-- depaudit-gate-comment -->" as const;`.
- Export interface:
  ```ts
  export interface MarkdownReportOptions {
    suggestedActionFor?(cf: ClassifiedFinding): string;
  }
  ```
  (Import `ClassifiedFinding` from `./depauditConfig.js`.)
- No behaviour; pure type / constant exports.

### Task 2 — Implement `src/modules/markdownReporter.ts`

- New file. No external runtime deps; pure rendering only.
- Imports: types from `../types/scanResult.js`, `../types/depauditConfig.js`, `../types/markdownReport.js`, `../types/finding.js`. Plus the constant `MARKDOWN_COMMENT_MARKER`.
- Internal helpers:
  - `function bucketByCategory(findings: ClassifiedFinding[]): Record<FindingCategory, ClassifiedFinding[]>` — splits into the four buckets.
  - `function compareForRender(a: ClassifiedFinding, b: ClassifiedFinding): number` — same comparator as `jsonReporter.buildFindingsJsonSchema` (manifestPath, source, findingId, package, version via localeCompare). Lift the body to keep the comparators in lockstep.
  - `function escapeCell(s: string): string` — replaces `\\` → `\\\\`, `|` → `\\|`, then `\r?\n` → ` `. Order matters (escape backslashes first).
  - `function defaultSuggestedAction(cf: ClassifiedFinding): string` — returns `"re-evaluate or extend acceptance"` when `cf.category === "expired-accept"`, else `"investigate; accept or upgrade"`.
  - `function renderTable(rows: ClassifiedFinding[], suggestedAction: (cf: ClassifiedFinding) => string): string` — emits the `severity | package | version | finding-id | suggested action` header + separator + body rows. Returns `""` when `rows.length === 0`.
- Main entry:
  ```ts
  export function renderMarkdownReport(
    result: ScanResult,
    options: MarkdownReportOptions = {}
  ): string
  ```
  Behaviour:
  - `const buckets = bucketByCategory(result.findings);`
  - Sort `buckets.new` and `buckets["expired-accept"]` with `compareForRender`.
  - `const action = options.suggestedActionFor ?? defaultSuggestedAction;`
  - Compose lines:
    - `""` (leading blank)
    - `MARKDOWN_COMMENT_MARKER`
    - `""` (blank after marker)
    - `result.exitCode === 0 ? "## depaudit gate: PASS" : "## depaudit gate: FAIL"`
    - `""` (blank before counts)
    - `- new: ${buckets.new.length}`
    - `- accepted: ${buckets.accepted.length}`
    - `- whitelisted: ${buckets.whitelisted.length}`
    - `- expired: ${buckets["expired-accept"].length}`
    - If `buckets.new.length > 0`:
      - `""`
      - `### New findings (${buckets.new.length})`
      - `""`
      - `renderTable(buckets.new, action)`
    - If `buckets["expired-accept"].length > 0`:
      - `""`
      - `### Expired accepts (${buckets["expired-accept"].length})`
      - `""`
      - `renderTable(buckets["expired-accept"], action)`
    - If `result.socketAvailable === false`:
      - `""`
      - `> supply-chain unavailable — Socket scan failed; CVE-only gating ran for this run.`
    - If `result.osvAvailable === false`:
      - `""`
      - `> CVE scan unavailable — OSV scanner failed; supply-chain gating ran for this run.`
  - Join with `"\n"`, append a trailing `"\n"`, return.
- Pure: no I/O, no Date, no random. Same input → same output.

### Task 3 — Snapshot-test `markdownReporter`

- New file: `src/modules/__tests__/markdownReporter.test.ts`.
- Use Vitest (matches existing test pattern; runs under `bun test`).
- Helpers (lift / adapt from `jsonReporter.test.ts`):
  - `makeOsvFinding(overrides?): Finding`
  - `makeSocketFinding(overrides?): Finding`
  - `makeScanResult(findings, overrides?): ScanResult` — defaults `socketAvailable: true`, `osvAvailable: true`, `exitCode: 0`.
  - `loadFixture(name): Promise<string>` — reads `src/modules/__tests__/fixtures/markdown-output/<name>.expected.md`.
- Test groups:
  1. **Marker and header** —
     - Output begins with a blank line, then `<!-- depaudit-gate-comment -->`.
     - `result.exitCode === 0` → header reads `## depaudit gate: PASS`.
     - `result.exitCode !== 0` → header reads `## depaudit gate: FAIL`.
  2. **Per-category count list** —
     - All four counts always present, in the order `new, accepted, whitelisted, expired`, even when zero.
     - `expired` count comes from the `expired-accept` bucket (verifying the renderer's bucket → label mapping).
  3. **New-findings table** —
     - Omitted when `new` count is zero (no header, no separator).
     - Header row exactly `| severity | package | version | finding-id | suggested action |`.
     - Rows in deterministic sort order across `(manifestPath, source, findingId, package, version)`.
     - Each row's `suggested action` cell is `"investigate; accept or upgrade"` by default.
     - Custom `options.suggestedActionFor` is called per row and the returned string lands in the `suggested action` cell.
  4. **Expired-accepts section** —
     - Omitted when `expired-accept` count is zero.
     - Section header reads `### Expired accepts (<n>)`.
     - Suggested action defaults to `"re-evaluate or extend acceptance"` for these rows even though the same custom hook would override.
  5. **Supply-chain / OSV annotations** —
     - `socketAvailable: false` adds the supply-chain-unavailable line; `true` omits it.
     - `osvAvailable: false` adds the CVE-unavailable line; `true` omits it.
     - Both `false` together emit both lines, in order (supply-chain first, then OSV — matches the order stderr lines fire today in `scanCommand.ts:158, :173`).
  6. **Cell escapes** —
     - `package: "foo|bar"` renders as `foo\|bar` in the table cell.
     - `summary: "line1\nline2"` (when used as suggested action via the hook) renders as `line1 line2`.
     - `package: "back\\slash"` renders as `back\\\\slash` (backslash double-escaped before pipe escape, preserving order independence).
  7. **Determinism and purity** —
     - Same `ScanResult` passed twice yields byte-identical strings.
     - Shuffled `findings` input produces the same output as sorted input.
     - Frozen input object: renderer doesn't mutate `result.findings` (assert `Object.isFrozen` round-trip).
  8. **Fixture comparison** — for each fixture file in `src/modules/__tests__/fixtures/markdown-output/`, build the corresponding `ScanResult` and assert `assert.strictEqual(renderMarkdownReport(result), await loadFixture(name))`.
- Build the fixture files. Each file is the FULL expected markdown including the leading blank line, marker, trailing newline. Use `bun run test` first to capture actual output, then check that against the spec, then commit. (Snapshot test bootstrapping pattern.)

### Task 4 — Add `--format` flag to `src/cli.ts`

- Modify `src/cli.ts`:
  - Extend the `parseArgs` `options` map (`:30-33`):
    ```ts
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      format: { type: "string", short: "f" },
    },
    ```
  - Update the `values` typing on line `:36` to include `format?: string`.
  - Update the USAGE string (`:10-20`) to document the new flag:
    ```
      -f, --format   Output format for stdout (markdown|text; default: markdown)
    ```
  - In the `if (subcommand === "scan")` branch (line `:60`), validate format:
    ```ts
    const format = values.format ?? "markdown";
    if (format !== "markdown" && format !== "text") {
      process.stderr.write(`error: unknown --format value '${format}' (expected 'markdown' or 'text')\n\n${USAGE}`);
      process.exit(2);
    }
    ```
  - Pass it: `await runScanCommand(cmdPath ?? process.cwd(), { format });`.
  - Lint command is unaffected.
- The `--format` flag MUST work positionally with the path argument. Verify by hand: `depaudit scan --format text fixtures/clean-npm` and `depaudit scan fixtures/clean-npm --format text` both succeed. `parseArgs` with `allowPositionals: true` (line `:33`) handles both.

### Task 5 — Wire `MarkdownReporter` into `ScanCommand`

- Modify `src/commands/scanCommand.ts`:
  - Add imports:
    ```ts
    import { renderMarkdownReport } from "../modules/markdownReporter.js";
    ```
  - Change the function signature:
    ```ts
    export async function runScanCommand(
      scanPath: string,
      options: { format: "markdown" | "text" } = { format: "markdown" }
    ): Promise<ScanResult>
    ```
  - Move the `const exitCode = …` line (currently `:214`) to AFTER `expiredAccepts` is computed (it depends on `newFindings.length` and `expiredAccepts.length`) but BEFORE the format-dependent emit. Concretely: keep its current position; move the markdown emit AFTER it.
  - Replace the unconditional `printFindings(newFindings)` (line `:183`) and the `for (const cf of expiredAccepts) { process.stderr.write(...) }` loop (lines `:186-188`) with a format switch:
    ```ts
    if (options.format === "text") {
      printFindings(newFindings);
      for (const cf of expiredAccepts) {
        process.stderr.write(`expired accept: ${cf.finding.package} ${cf.finding.version} ${cf.finding.findingId}\n`);
      }
    }
    ```
  - The auto-prune block (lines `:190-212`) and `writeFindingsJson` call (line `:216`) stay put.
  - AFTER `exitCode` is computed (line `:214`) and BEFORE `writeFindingsJson` (line `:216`), insert the markdown emit:
    ```ts
    if (options.format === "markdown") {
      const result: ScanResult = { findings: classified, socketAvailable: socketResult.available, osvAvailable, exitCode };
      process.stdout.write(renderMarkdownReport(result));
    }
    ```
    Order: markdown is emitted BEFORE the `JsonReporter`'s gitignore-warning line so the warning lands at the bottom of stdout (or vice versa — the order doesn't matter for the assertion suite, but one stable choice is required for snapshot scenarios). Pick: markdown emit FIRST, JsonReporter call SECOND. This puts any gitignore warning AFTER the markdown report on stdout, so a CI step that pipes stdout into a PR comment captures the markdown plus any warning as a trailing line; the warning line is still parseable by the existing `stdout mentions "gitignore"` assertion.
  - Pre-classification abort paths (`ConfigParseError`, lint failure, `SocketAuthError`) DO NOT emit markdown — they return before classification. This matches the JsonReporter's preservation semantics. The user's terminal sees the lint / parse / auth error and a non-zero exit code, no half-rendered markdown.
  - The `osvAvailable === false` catastrophic path continues to classification (matches current behaviour after JsonReporter slice). Markdown emit fires with the OSV-unavailable annotation.
  - `ScanResult` shape is unchanged. The format option does not leak into the return value.

### Task 6 — Migrate existing BDD scenarios to opt into `--format text`

For every existing feature file OTHER than `features/scan_json_reporter.feature` and `features/lint*.feature`, audit each `When I run "depaudit scan …"` step. If the same scenario contains any of these stdout-line assertions:

- `Then stdout matches the finding-line pattern …`
- `Then stdout contains exactly one finding line`
- `Then stdout contains at least N finding lines`
- `Then the finding line matches "<package> <version> <id> <severity>"`
- (any other assertion that uses `FINDING_LINE_RE`)

…then the When step needs `--format text` appended before the path argument:

- Before: `When I run "depaudit scan fixtures/medium-finding-npm"`
- After:  `When I run "depaudit scan --format text fixtures/medium-finding-npm"`

Files to audit and update:

- `features/scan.feature` — bulk of finding-line assertions live here.
- `features/scan_accepts.feature` — scenarios that assert "no finding lines" (already tightened by the issue #8 work) AND scenarios that assert finding lines for un-accepted CVEs.
- `features/scan_polyglot.feature` — multi-manifest finding-line assertions.
- `features/scan_severity_threshold.feature` — threshold-driven finding-line filtering.
- `features/scan_socket_supply_chain.feature` — supply-chain finding-line assertions.
- `features/scan_yml_accepts.feature` — `.depaudit.yml` accept assertions on finding lines.
- `features/scan_orphan_prune.feature` — prune-related finding-line assertions.

Audit method: open each file, search for `FINDING_LINE_RE`-bound assertions in `features/step_definitions/scan_steps.ts`, walk the call sites in features, and update only the affected scenarios.

For scenarios whose assertions only check exit code, stderr, file presence, or `stdout contains no finding lines` (the relaxed assertion from issue #8 already tolerates non-finding stdout), DO NOT add `--format text`. Markdown stdout containing zero rows in the new-findings table satisfies "no finding lines" (the assertion checks `FINDING_LINE_RE`, which doesn't match any markdown construct).

Validation after migration: `bun run test:e2e -- --tags "@regression"` must pass with zero failures. Any failure indicates a missed scenario or a stronger-than-expected coupling between stdout shape and the assertion.

### Task 7 — Create BDD fixtures

Each scenario in `features/scan_markdown_reporter.feature` gets its own `fixtures/md-*/` directory so preconditions are isolated and scenarios can run in parallel. Every fixture is an npm project with `package.json` + `package-lock.json` and a `.gitignore` that includes `.depaudit/` (to silence the JsonReporter warning so stdout assertions are clean).

**Pass / fail outcome fixtures:**
- `fixtures/md-pass-clean/`: clean npm project (no CVEs, no Socket alerts).
- `fixtures/md-fail-cve/`: npm project pinning a package with a known OSV CVE (copy from `fixtures/json-cve-schema`).
- `fixtures/md-fail-mixed/`: npm project pinning a CVE-bearing package + `osv-scanner.toml` `[[IgnoredVulns]]` for a DIFFERENT CVE-bearing package + `commonAndFine` whitelist for a Socket alert. Produces non-zero `new`, `accepted`, and `whitelisted` counts simultaneously.

**Expired-accept fixtures:**
- `fixtures/md-fail-expired-only/`: npm project + `osv-scanner.toml` `[[IgnoredVulns]]` whose `ignoreUntil` lint-passes but is treated as expired at scan time (reuse the timing-trick pattern from `fixtures/json-class-expired`).

**Supply-chain / OSV availability fixtures:**
- `fixtures/md-supply-chain-down/`: clean npm project; scenario spins up a mock Socket server that returns 503. Expects supply-chain-unavailable annotation and PASS header (no CVEs).
- `fixtures/md-osv-down/`: npm project; scenario uses the `fakeOsvBinDir` harness from `@adw-13`. Expects OSV-unavailable annotation and FAIL header (osvAvailable=false → exit non-zero).

**Format-flag fixtures:**
- `fixtures/md-format-text/`: clean npm project. Scenario invokes with `--format text` and asserts legacy line-based stdout (no markdown marker on stdout).
- `fixtures/md-format-explicit/`: clean npm project. Scenario invokes with `--format markdown` and asserts marker is present.
- `fixtures/md-format-default/`: clean npm project. Scenario invokes with no `--format` flag and asserts marker is present (default = markdown).
- `fixtures/md-format-unknown/`: clean npm project. Scenario invokes with `--format yaml` and asserts exit 2 + stderr mentions `unknown --format value`.

**Marker / header / annotation fixtures:** these reuse the above as appropriate; no new fixtures needed for marker / header assertions.

All fixtures must include `.gitignore` with `.depaudit/` to suppress the JsonReporter gitignore warning during stdout assertions.

### Task 8 — Author `features/scan_markdown_reporter.feature`

- File header: `@adw-9`.
- Feature statement: "As a contributor I want `depaudit scan` to print a PR-comment-ready markdown report on stdout so that I can paste the output into a PR comment, and so that the CI step that posts the comment has nothing to format itself."
- Background reuses `the osv-scanner binary is installed and on PATH` and `the depaudit CLI is installed and on PATH`.
- Scenarios (every one tagged `@adw-9`; most also `@regression`):

  **Default format and explicit format:**
  1. `Default format is markdown — stdout begins with the comment marker on a clean repo` (`fixtures/md-format-default`). Asserts: exit 0, stdout includes `<!-- depaudit-gate-comment -->`, stdout includes `## depaudit gate: PASS`.
  2. `Explicit --format markdown matches the default` (`fixtures/md-format-explicit`). Asserts: same assertions as scenario 1.
  3. `--format text emits legacy line-based stdout (no marker)` (`fixtures/md-format-text`). Asserts: exit 0, stdout does NOT include `<!-- depaudit-gate-comment -->`, stdout has zero finding lines (since clean repo).
  4. `Unknown --format value exits 2` (`fixtures/md-format-unknown`). Asserts: exit 2, stderr mentions `unknown --format value`.

  **Pass header and category counts:**
  5. `Pass header and zero counts on a clean scan` (`fixtures/md-pass-clean`). Asserts: stdout contains `## depaudit gate: PASS`, contains `- new: 0`, `- accepted: 0`, `- whitelisted: 0`, `- expired: 0`.

  **Fail header and new-findings table:**
  6. `Fail header on a CVE-bearing scan` (`fixtures/md-fail-cve`). Asserts: exit non-zero, stdout contains `## depaudit gate: FAIL`, stdout contains `- new: 1` (or whatever the fixture produces), stdout contains `### New findings`, stdout contains `| severity | package | version | finding-id | suggested action |`.
  7. `New-findings table includes severity, package, version, finding-id, suggested action columns in that order` (`fixtures/md-fail-cve`). Asserts: the table header row matches the column ordering required by the issue acceptance criteria.
  8. `Suggested action defaults to "investigate; accept or upgrade" for new findings` (`fixtures/md-fail-cve`). Asserts: stdout contains `investigate; accept or upgrade`.

  **Expired-accepts section:**
  9. `Expired-accepts section appears when expired-accept count > 0` (`fixtures/md-fail-expired-only`). Asserts: exit non-zero, stdout contains `### Expired accepts (`, stdout contains `re-evaluate or extend acceptance`, stdout does NOT contain `### New findings`.
  10. `Expired-accepts section omitted when expired-accept count is zero` (`fixtures/md-fail-cve`). Asserts: stdout does NOT contain `### Expired accepts`.

  **Supply-chain / OSV annotations:**
  11. `Supply-chain-unavailable annotation appears when Socket falls open` (`fixtures/md-supply-chain-down`). Asserts: exit 0 (clean repo), stdout contains `> supply-chain unavailable`, stdout contains `Socket scan failed`.
  12. `Supply-chain annotation omitted when Socket is healthy` (`fixtures/md-pass-clean`). Asserts: stdout does NOT contain `supply-chain unavailable`.
  13. `OSV-unavailable annotation appears on OSV catastrophic failure` (`fixtures/md-osv-down`). Asserts: exit non-zero, stdout contains `> CVE scan unavailable`, stdout contains `OSV scanner failed`.

  **Mixed outcome:**
  14. `Mixed outcome — new + expired + accepted + whitelisted counts all non-zero` (`fixtures/md-fail-mixed`). Asserts: stdout contains `### New findings`, stdout contains `### Expired accepts`, stdout contains all four count list items with non-zero values.

  **Marker placement:**
  15. `HTML comment marker is present on every markdown emission` (covered by scenarios 1, 2, 5, 6, 11, 13, 14). Add as an explicit scenario to make the requirement greppable: clean repo (`fixtures/md-pass-clean`), assert marker exists exactly once on stdout.

  **Stdout / stderr separation:**
  16. `Markdown report goes to stdout; existing stderr lines (auto-prune, fail-open) remain on stderr` (`fixtures/md-supply-chain-down`). Asserts: stderr contains `socket: supply-chain unavailable` (existing stderr line), stdout contains `> supply-chain unavailable` (new markdown annotation). Both are present; the markdown annotation does not displace the stderr line.

### Task 9 — Author `features/step_definitions/scan_markdown_reporter_steps.ts`

- File imports: `Given/When/Then` from `@cucumber/cucumber`, `assert` from `node:assert/strict`, `DepauditWorld` from `../support/world.js`. Reuse `runDepaudit` from `./scan_steps.js` for any `When` steps not already defined.
- New `Then` steps (only those not already defined elsewhere):
  - `Then<DepauditWorld>("stdout includes the depaudit comment marker", function …)` — assert `result.stdout.includes("<!-- depaudit-gate-comment -->")`.
  - `Then<DepauditWorld>("stdout does not include the depaudit comment marker", function …)` — complement.
  - `Then<DepauditWorld>("stdout includes the markdown header {string}", function …, function (this, header) { assert.ok(this.result!.stdout.includes(header)); })` — generic header presence (`## depaudit gate: PASS` etc).
  - `Then<DepauditWorld>("stdout includes a count line for {string} with value {int}", function …)` — asserts `- <name>: <n>` substring.
  - `Then<DepauditWorld>("stdout includes the new-findings table header", function …)` — asserts `| severity | package | version | finding-id | suggested action |`.
  - `Then<DepauditWorld>("stdout includes the expired-accepts section header", function …)` — asserts `### Expired accepts (`.
  - `Then<DepauditWorld>("stdout includes the supply-chain-unavailable annotation", function …)` — asserts `> supply-chain unavailable`.
  - `Then<DepauditWorld>("stdout includes the OSV-unavailable annotation", function …)` — asserts `> CVE scan unavailable`.
  - `Then<DepauditWorld>("stderr mentions {string}", function …)` — asserts `result.stderr.includes(text)`. (If already defined elsewhere, skip; otherwise add.)
- Reuse the existing `Then stdout mentions {string}` and `Then stdout does not mention {string}` from `scan_json_reporter_steps.ts` for substring assertions on annotation text.
- Reuse existing exit-code, stdout-content, runDepaudit `When` steps.

### Task 10 — Update documentation

- Create `app_docs/feature-xgupjx-markdown-reporter.md` in the house style of `app_docs/feature-2rdowb-json-reporter.md`. Headings: Overview, What Was Built, Technical Implementation (Files Modified / Key Changes), How to Use, Configuration, Testing, Notes.
- Append to `.adw/conditional_docs.md`:
  ```
  - [app_docs/feature-xgupjx-markdown-reporter.md](../app_docs/feature-xgupjx-markdown-reporter.md) — When working with `MarkdownReporter`, the `--format` CLI flag, the PR-comment marker, the new-findings or expired-accepts tables, the supply-chain-unavailable annotation, the markdown report's stdout placement, or the legacy `--format text` opt-out for line-based stdout; when troubleshooting snapshot-test failures on the rendered markdown output; when migrating BDD scenarios that depended on `FINDING_LINE_RE` stdout to opt into `--format text`.
  ```
- Do NOT add a README.md section; the README is intentionally minimal (pre-release pointer to the PRD).

### Task 11 — Run the validation suite

Execute every command in **Validation Commands** below. All must pass with zero regressions.

## Testing Strategy

### Unit Tests

`.adw/project.md` does not carry a `## Unit Tests: enabled` marker. This plan includes unit-test tasks as a documented override, matching the precedent set by issues #3, #4, #5, #6, #7, #8, and #13. Justifications for this slice, in priority order:

1. **The issue explicitly mandates snapshot tests** for `MarkdownReporter` output across each shape (pass, fail, expired-only, supply-chain-unavailable). Acceptance criterion "Snapshot tests for each output shape" cannot be satisfied by BDD alone at a reasonable cost.
2. **Renderer contract.** Per PRD `:229` and `:241`, `MarkdownReporter` is a Tier 1 module called out explicitly as a snapshot-test target: "Snapshot tests are used for renderer output (`MarkdownReporter`, `JsonReporter`) because the exact formatting is part of the external contract."
3. **`.adw/review_proof.md:17`** explicitly requires "snapshot assertions are updated and match the intended output" for `MarkdownReporter` and `JsonReporter` PRs to pass review. Without unit-level snapshot coverage, the review proof requirement cannot be met.
4. **BDD cannot economically cover the cell-escape, sort-key, and table-emit-condition matrix.** A pipe character in a package name, a newline in a summary, four classification categories × two sources × two availability flags × pass-vs-fail header → a combinatorial space far better tested at the unit level with deterministic inputs.

Unit tests to build:

- **`src/modules/__tests__/markdownReporter.test.ts`** covering:
  - Marker and pass/fail header (Task 3, group 1)
  - Per-category count list (group 2)
  - New-findings table emit conditions, header, sort order, default suggested action, custom hook (group 3)
  - Expired-accepts section emit conditions, default expired action (group 4)
  - Supply-chain / OSV annotations conditional emit (group 5)
  - Cell escapes for `|`, `\`, newlines (group 6)
  - Determinism and purity (group 7)
  - Fixture-file byte-comparison for every shape in `src/modules/__tests__/fixtures/markdown-output/` (group 8)

### Edge Cases

- **Empty classified findings.** Renderer emits header + counts (all zeros) + no tables + no annotations. Covered by `pass-empty.expected.md`.
- **All four categories non-zero.** All counts non-zero, both tables present, no annotations. Covered by `fail-mixed.expected.md`.
- **Only `expired-accept` non-zero (the contributor's worst-case "I didn't change anything but the gate failed").** Header is FAIL, only the expired-accepts table renders, no new-findings table. Covered by `fail-expired-only.expected.md`.
- **Both `socketAvailable` and `osvAvailable` are false simultaneously.** Both annotations emitted, supply-chain first. Unit-tested explicitly.
- **`new` finding with `package` containing a literal `|`.** Cell escape applies; final markdown renders as `foo\|bar`. Covered by `cell-escapes.expected.md`.
- **`new` finding with multiline `summary` used as a custom suggested action.** Newlines replaced by spaces so the cell stays on one row. Covered by `cell-escapes.expected.md`.
- **`new` finding with `package` containing backslashes.** Backslash escape applies before pipe escape; rendering is order-independent. Unit-tested.
- **Two findings identical on all five sort keys.** `Array.prototype.sort` in V8 is stable; relative input order preserved. Unit-tested with a known-duplicate input.
- **Suggested-action hook returns an empty string.** Cell renders as ` ` (intentional — a markdown table cell can be empty). Unit-tested.
- **Suggested-action hook throws.** Renderer does NOT catch — the throw propagates to `ScanCommand` which surfaces it via the top-level error handler (same as any unhandled error in depaudit). The hook is internal-API; misuse should fail loudly.
- **Pre-classification abort paths.** No markdown emit (matches JsonReporter's preservation semantics). User sees the lint / parse / auth error and a non-zero exit; no half-rendered markdown.
- **`--format text` with a CVE-bearing repo.** Existing line-based stdout AND existing stderr expired-accept lines preserved byte-for-byte. Markdown is NOT emitted. Verified by the format-text BDD scenario plus the migrated `@regression` suite.
- **`--format markdown` with `osvAvailable: false`.** Markdown is emitted with the OSV-unavailable annotation; stderr's `osv: CVE scan failed catastrophically …` line remains as the audit trail.
- **`--format markdown` with the JsonReporter gitignore warning firing.** Markdown is emitted first, JsonReporter warning second on stdout. The warning is a single distinct line and remains parseable by existing `stdout mentions "gitignore"` assertions.
- **Unknown `--format` value.** CLI exits 2 with stderr message; `runScanCommand` is never invoked. Covered by BDD scenario 4.
- **Trailing newline.** Renderer always ends with a single `"\n"`. Snapshot fixtures include the trailing newline.
- **Large finding count.** No pagination, no truncation; the table grows linearly. Acceptable for the MVP — a 1000-finding PR comment is unrealistic and would block the gate before it is ever rendered. Documented in Notes.

## Acceptance Criteria

- [ ] `src/types/markdownReport.ts` defines `MARKDOWN_COMMENT_MARKER` and `MarkdownReportOptions`.
- [ ] `src/modules/markdownReporter.ts` exports `renderMarkdownReport(result, options?): string` as a pure function.
- [ ] `src/cli.ts` accepts `--format <markdown|text>` (also `-f`); default is `markdown`; unknown values exit 2 with a stderr message.
- [ ] `src/commands/scanCommand.ts` accepts an `options.format` argument; defaults to `markdown`; routes through `MarkdownReporter` when `markdown` and `printFindings` when `text`.
- [ ] Running `depaudit scan` (no `--format`) on a clean fixture writes the comment marker, the `## depaudit gate: PASS` header, and all four zero counts to stdout.
- [ ] Running `depaudit scan --format markdown` on a CVE-bearing fixture emits the `## depaudit gate: FAIL` header, a `### New findings (n)` section, the table header `| severity | package | version | finding-id | suggested action |`, and one row per `new` finding with the default `investigate; accept or upgrade` suggested action.
- [ ] Running `depaudit scan --format markdown` on a fixture that produces only expired accepts emits the `### Expired accepts (n)` section with `re-evaluate or extend acceptance` and NO `### New findings` section.
- [ ] Running `depaudit scan --format markdown` against a Socket fail-open emits `> supply-chain unavailable …` on stdout AND keeps the existing `socket: supply-chain unavailable …` line on stderr.
- [ ] Running `depaudit scan --format markdown` after an OSV catastrophic failure emits `> CVE scan unavailable …` on stdout AND keeps the existing `osv: CVE scan failed catastrophically …` line on stderr.
- [ ] Running `depaudit scan --format text` on a CVE-bearing fixture preserves byte-for-byte the legacy line-based stdout (`<package> <version> <id> <severity>`) and stderr `expired accept: …` lines.
- [ ] Running the same scan twice back-to-back produces byte-identical markdown stdout (modulo any non-deterministic stderr lines from auto-prune timing).
- [ ] On lint failure / config parse error / `SocketAuthError`, no markdown is emitted (pre-classification abort preserved).
- [ ] Snapshot tests in `src/modules/__tests__/markdownReporter.test.ts` cover every fixture file in `src/modules/__tests__/fixtures/markdown-output/` and pass.
- [ ] `bun run lint`, `bun run typecheck`, `bun run build`, `bun test` all pass with zero new warnings or errors.
- [ ] `bun run test:e2e -- --tags "@adw-9"` passes all `@adw-9` scenarios.
- [ ] `bun run test:e2e -- --tags "@regression"` continues to pass — every previously-passing scenario still passes after the `--format text` migration.
- [ ] `bun run test:e2e -- --tags "@adw-8"` continues to pass — JsonReporter behaviour is format-orthogonal.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `bun install` — ensure dependencies resolved (no new runtime dependencies expected; renderer is pure-string composition).
- `bun run lint` — lint the entire codebase; must pass with zero warnings.
- `bun run typecheck` — TypeScript strict mode must pass with zero errors across the new types, the renderer, the extended `cli.ts` option parsing, and the extended `scanCommand.ts` signature.
- `bun test` — full Vitest suite including new `markdownReporter.test.ts`. Zero failures.
- `bun run build` — emits `dist/types/markdownReport.js`, `dist/modules/markdownReporter.js`, and updated `dist/cli.js` + `dist/commands/scanCommand.js`.
- `bun run test:e2e -- --tags "@adw-9"` — the new BDD scenarios pass end-to-end.
- `bun run test:e2e -- --tags "@adw-8"` — JsonReporter scenarios continue to pass (format-orthogonal).
- `bun run test:e2e -- --tags "@regression"` — every prior `@regression` scenario passes (with the migrated `--format text` opt-ins where needed).
- `bun run test:e2e` — run the entire Cucumber suite as a final smoke test.

## Notes

- **No new runtime dependencies.** Renderer is pure-string composition. No npm install needed.
- **Unit tests override.** `.adw/project.md` lacks `## Unit Tests: enabled`. This plan includes snapshot unit tests because the issue mandates them as an acceptance criterion AND `.adw/review_proof.md:17` requires snapshot assertions for `MarkdownReporter` PRs to pass review. Same precedent as issues #3–#8 and #13.
- **Default format is markdown.** The issue's "(or default)" wording is interpreted as `--format` defaults to `markdown`. The legacy line-based `printFindings` output is preserved via `--format text` so users with shell pipelines depending on the line shape can opt in.
- **Existing BDD scenarios get a mechanical migration.** Every scenario whose assertions depend on `FINDING_LINE_RE` gets `--format text` appended to its `When I run "depaudit scan …"` step. Scenarios that assert only stderr / exit code / file state require no change. The migration is grep-able and reviewable in the PR diff.
- **Stderr lines preserved in markdown mode.** `socket: supply-chain unavailable …`, `osv: CVE scan failed catastrophically …`, and `auto-prune: …` continue to fire on stderr in `--format markdown`. They are CI-log audit trails; the markdown annotations on stdout are the human-facing summary. Per-finding `expired accept: …` stderr lines are SUPPRESSED in markdown mode (the markdown's expired-accepts section subsumes them); they are kept in text mode.
- **HTML marker is in the rendered output today even though no comment-update logic consumes it yet.** This avoids a future cross-slice rewrite and keeps the comment-update slice (likely tied to `StateTracker`) a pure addition rather than a marker-injection edit.
- **Suggested-action placeholder strings.** `"investigate; accept or upgrade"` for new findings, `"re-evaluate or extend acceptance"` for expired accepts. Both are deliberate placeholders awaiting the upgrade-resolver slice. The `MarkdownReportOptions.suggestedActionFor` hook is exported now so the future slice is a content-only delta with no signature change.
- **Pass / fail wording uses ALL-CAPS `PASS` / `FAIL` rather than emoji.** Project convention: no emojis in source files unless explicitly requested. The capitalised word is the unambiguous status signal and renders correctly in any markdown viewer (GitHub, terminal renderers, plain text).
- **Markdown emit ordering on stdout: report first, then JsonReporter gitignore warning if applicable.** Picking one stable order keeps snapshot tests deterministic. The warning is a single line and is still recognised by the existing `stdout mentions "gitignore"` assertion.
- **No pagination / truncation for large finding counts.** A 1000-finding PR comment would be unwieldy but is also a far worse problem at the user / process level than a renderer concern. If needed, a future slice can add `--max-table-rows` or similar.
- **JSON output to stdout is NOT introduced in this slice.** `--format json` is reserved (rejected by validation) but not implemented; the issue does not ask for it. JsonReporter's contract is the file at `.depaudit/findings.json`; stdout-JSON would be a separate, later concern.
- **`--format` short flag is `-f`.** Matches POSIX convention. `parseArgs` exposes both forms.
- **Coverage mapping.** User story 31 (PR comment with concrete next step) is addressed by the `### New findings` table with the suggested action column; the actual "concrete next step" content awaits the upgrade-resolver slice. PRD references `:190-193, :204, :229, :241` are satisfied by Tasks 1–5 (types + renderer + tests + wiring) and Task 8 (BDD coverage).
