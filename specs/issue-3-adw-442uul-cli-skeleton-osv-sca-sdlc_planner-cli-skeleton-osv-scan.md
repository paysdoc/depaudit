# Feature: CLI skeleton + OSV-Scanner CVE scan (npm, stdout)

## Metadata
issueNumber: `3`
adwId: `442uul-cli-skeleton-osv-sca`
issueJson: `{"number":3,"title":"CLI skeleton + OSV-Scanner CVE scan (npm, stdout)","body":"## Parent PRD\n\n`specs/prd/depaudit.md`\n\n## What to build\n\nThe thinnest end-to-end tracer bullet for the `depaudit` CLI. A single command `depaudit scan [path]` discovers `package.json` manifests, invokes `osv-scanner` as a subprocess, parses its JSON output into an internal `Finding` type, and prints findings to stdout as plain text. No configuration, no lint, no Socket, no JSON output, no gate, no PR comment — those follow in later slices.\n\nProves CLI plumbing, `OsvScannerAdapter`, `ManifestDiscoverer` (npm only), and the `Finding` shape. See PRD \"Stack & Architecture\" and \"Modules\".\n\n## Acceptance criteria\n\n- [ ] Package scaffold (`package.json`, `tsconfig.json`, CLI entry bin) so `npm install -g .` / `bun link` puts `depaudit` on `PATH`.\n- [ ] `depaudit scan <path>` succeeds on a Node repo.\n- [ ] `ManifestDiscoverer` finds every `package.json` (respects `.gitignore`, skips `node_modules/`).\n- [ ] `OsvScannerAdapter` invokes the binary, parses JSON, returns `Finding[]`.\n- [ ] Stdout output: one line per finding (package, version, finding-id, severity).\n- [ ] Exit 0 with zero findings; non-zero otherwise (severity filtering comes in #3).\n- [ ] Vitest unit tests for `ManifestDiscoverer` (fixture repos) and `OsvScannerAdapter` (mocked `execFile`).\n\n## Blocked by\n\nNone — can start immediately.\n\n## User stories addressed\n\n- User story 1 (partial — CVE layer only, no gate yet)\n- User story 15 (partial — npm only; other ecosystems land in #4)\n","state":"OPEN","author":"paysdoc","labels":[],"createdAt":"2026-04-17T13:24:35Z","comments":[{"author":"paysdoc","createdAt":"2026-04-18T08:44:32Z","body":"## Take action"}],"actionableComment":null}`

## Feature Description

Establishes the thinnest end-to-end tracer bullet for the `depaudit` CLI. The slice introduces a single subcommand, `depaudit scan [path]`, that walks a target repository for npm manifests, delegates CVE detection to the external `osv-scanner` binary, normalizes the binary's JSON output into an internal `Finding` shape, and reports those findings to stdout as one plain-text line per finding. The process exits 0 when nothing is found and non-zero otherwise.

This slice deliberately excludes config loading (`ConfigLoader`), the lint step (`Linter`), the Socket supply-chain layer (`SocketApiClient`), acceptance classification (`FindingMatcher`), the gate's PR comment/Slack output (`Reporter` composites), the JSON findings artifact (`JsonReporter`), and the `depaudit setup` command. Those arrive in later tracer slices. The value delivered here is the working CLI pipeline — packaging, argument parsing, the `ManifestDiscoverer` walker, and the `OsvScannerAdapter` subprocess boundary — with the `Finding` shape proven against real OSV-Scanner output.

## User Story

As a maintainer who has cloned the depaudit repo
I want to run `depaudit scan <path>` against a Node project
So that I can see the list of CVEs OSV-Scanner detects in that project's dependency tree, proving the CLI pipeline works end-to-end before we layer on config, supply-chain, and gating.

## Problem Statement

The repository currently contains only a PRD, an ADW config, and an empty package scaffold — no `src/` directory exists. Nothing executes. Before any of the richer slices (config lint, Socket integration, acceptance classification, PR comment, Slack, setup) can be built, we need:

1. A callable CLI entry point on `PATH` (so contributors can iterate with `bun link`).
2. A proven `ManifestDiscoverer` that walks a target repo the way the gate will for every future slice.
3. A proven `OsvScannerAdapter` that shells out, survives OSV-Scanner's exit-code-1-on-findings convention, and emits a normalized `Finding`.
4. A concrete `Finding` type — the canonical shape that every later module (`Linter`, `FindingMatcher`, `Reporter`, `StateTracker`) will consume or produce.

Without this skeleton, every subsequent slice would have to invent plumbing and placeholder types before it could deliver its own value, multiplying rework.

## Solution Statement

Create `src/` following the deep-module structure documented in `.adw/project.md`: thin composition root (`ScanCommand`) wires two deep modules (`ManifestDiscoverer`, `OsvScannerAdapter`), which emit values of a single internal type (`Finding`). A tiny `stdoutReporter` prints findings one per line. `src/cli.ts` parses `process.argv` with Node's built-in `util.parseArgs` (no new parser dependency) and dispatches to `ScanCommand`.

`ManifestDiscoverer` walks the target directory, honors `.gitignore` via the `ignore` npm package, hard-skips `node_modules/` and `.git/` as a safety rail, and returns only `package.json` manifests (the issue scopes this slice to npm — other ecosystems arrive in #4). `OsvScannerAdapter` derives the unique parent directories of the discovered manifests and passes them to `osv-scanner scan source --format=json <dirs>`, which handles lockfile discovery internally (non-recursive by default, so `node_modules/` is not re-entered). The adapter treats OSV-Scanner's exit code 1 (vulnerabilities found) as a success path, parses the JSON, and maps each reported vulnerability to a `Finding`. Any other non-zero exit is propagated as an error.

`Finding` carries the strict `(package, version, findingId)` identity the PRD demands, plus ecosystem, severity, source (`osv`), summary, and the originating manifest path. `stdoutReporter` formats each as `<ecosystem> <package>@<version> <findingId> <severity>`. `ScanCommand` returns an exit code of 0 for an empty findings list and 1 otherwise. Severity filtering is deferred to a later slice.

Unit tests cover the two deep modules, per the issue's acceptance criteria: `ManifestDiscoverer` against committed fixture directories covering gitignore, nested manifests, and `node_modules/` skipping; `OsvScannerAdapter` against mocked `execFile` invocations covering happy path, findings-present (exit 1 with stdout), and real-error (exit >1).

## Relevant Files
Use these files to implement the feature:

- `README.md` — Always include; project overview and status. Already mentions this slice is the first to populate `src/`.
- `specs/prd/depaudit.md` — Full architecture and module contracts. The "Stack & Architecture", "Finding identity", and "Modules" sections define the shape of `ManifestDiscoverer`, `OsvScannerAdapter`, and `Finding`.
- `UBIQUITOUS_LANGUAGE.md` — Canonical domain terms. Names and comments must use **Finding**, **ManifestDiscoverer**, **OsvScannerAdapter**, **ScanCommand** exactly as defined; avoid aliases ("vulnerability", "walker", etc.).
- `.adw/project.md` — Declares the module layout (`src/commands/`, `src/modules/`, `src/modules/__tests__/`) and runtime assumptions (Bun, TypeScript, Vitest, `execFile` mocking for subprocess boundaries).
- `.adw/commands.md` — Authoritative validation commands (`bun install`, `bun run build`, `bun test`, `bun run typecheck`). Install syntax for new libraries is `bun add {library}`.
- `.adw/review_proof.md` — Defines the PR review bar: typecheck, lint, test with coverage all green; `OsvScannerAdapter` must have mock-boundary tests covering new behavior.
- `package.json` — Existing scaffold with `bin.depaudit = ./dist/cli.js` and `build`/`test` scripts; needs a `typecheck` script and the `ignore` runtime dependency added.
- `tsconfig.json` — Existing; compiles `src/**/*` to `dist/`. No changes needed.
- `.gitignore` — Currently only ignores ADW-copied command files. Needs entries for `dist/`, `node_modules/`, `.env`, and `.depaudit/` so future slices don't surface stale artifacts.
- `.env.sample` — Documents env vars for later slices (Socket, Slack); no change needed for this slice but confirms the secret layout we reference in the PRD.
- `bun.lock` — Already tracks existing devDependencies (`@types/node`, `typescript`, `vitest`, `@cucumber/cucumber`); will gain `ignore` after `bun add ignore` runs.

### New Files

- `src/cli.ts` — Executable CLI entry (shebang `#!/usr/bin/env node`). Parses `argv` with `util.parseArgs`, dispatches `scan` to `ScanCommand`, exits with the command's returned code.
- `src/commands/scanCommand.ts` — Composition root (not deep) that wires the pipeline: `ManifestDiscoverer` → `OsvScannerAdapter` → `stdoutReporter`. Returns `0` on empty findings, `1` otherwise.
- `src/modules/manifestDiscoverer.ts` — Deep module. Walks a root directory, honors `.gitignore` via the `ignore` package, hard-skips `node_modules/` and `.git/`, returns `Manifest[]` (npm only in this slice).
- `src/modules/osvScannerAdapter.ts` — Deep module. Takes `Manifest[]`, builds the positional-directory args for `osv-scanner scan source --format=json`, invokes via injected `execFile`, tolerates exit code 1, parses JSON, normalizes to `Finding[]`.
- `src/modules/stdoutReporter.ts` — Tiny formatter/printer. Exports `printFindings(findings, stream)` that writes one line per finding to the given writable stream (stdout by default); keeps `ScanCommand` thin and lets us unit-test formatting independently of the pipeline.
- `src/types/finding.ts` — Exports the `Finding`, `Severity`, `Ecosystem`, and `FindingSource` types used across the codebase. Central canonical type.
- `src/types/manifest.ts` — Exports the `Manifest` type (`ecosystem`, `path`). Shared between discoverer and adapter.
- `src/modules/__tests__/manifestDiscoverer.test.ts` — Vitest unit tests covering simple/nested manifests, `.gitignore` exclusion, and `node_modules/` skipping against committed fixture directories.
- `src/modules/__tests__/osvScannerAdapter.test.ts` — Vitest unit tests against a mocked `execFile`: no-findings happy path, findings-present (exit 1 with valid JSON on stdout), and hard error (exit >1) propagation.
- `src/modules/__tests__/fixtures/simple-npm/package.json` — Root-only npm manifest fixture.
- `src/modules/__tests__/fixtures/nested-npm/packages/a/package.json` — Monorepo fixture, first package.
- `src/modules/__tests__/fixtures/nested-npm/packages/b/package.json` — Monorepo fixture, second package.
- `src/modules/__tests__/fixtures/with-gitignore/.gitignore` — Declares `excluded/` as ignored.
- `src/modules/__tests__/fixtures/with-gitignore/excluded/package.json` — Should be excluded by gitignore.
- `src/modules/__tests__/fixtures/with-gitignore/included/package.json` — Should be included.
- `src/modules/__tests__/fixtures/with-node-modules/package.json` — Root manifest (should be discovered).
- `src/modules/__tests__/fixtures/with-node-modules/node_modules/lodash/package.json` — Nested-dep manifest (must be skipped).
- `src/modules/__tests__/fixtures/osv-output/clean.json` — Canned OSV-Scanner JSON with no vulnerabilities.
- `src/modules/__tests__/fixtures/osv-output/with-findings.json` — Canned OSV-Scanner JSON featuring at least two `npm` packages with CVE/GHSA findings (covers severity and alias-list parsing).

## Implementation Plan
### Phase 1: Foundation

Bring the package scaffold to a state where a contributor can build, typecheck, run Vitest, and `bun link` the CLI onto their `PATH`. This covers: updating `.gitignore`, adding a `typecheck` script, adding the `ignore` runtime dependency, wiring the `bin` shebang, and confirming `tsc` produces an executable `dist/cli.js`. No domain code yet — this phase gives the rest of the slice a ground to stand on.

### Phase 2: Core Implementation

Introduce the internal types (`Finding`, `Severity`, `Ecosystem`, `FindingSource`, `Manifest`), then the two deep modules. Build `ManifestDiscoverer` first (pure-ish, easy to test) with its unit tests and fixture directories. Build `OsvScannerAdapter` next (subprocess boundary, dependency-injected `execFile` so tests can mock it) with its unit tests driven by canned OSV-Scanner JSON fixtures. Both modules land behind their canonical PRD names.

### Phase 3: Integration

Wire everything behind the CLI: `ScanCommand` composes `ManifestDiscoverer` → `OsvScannerAdapter` → `stdoutReporter`; `src/cli.ts` parses `argv` and dispatches. Run `bun run build`, chmod the resulting `dist/cli.js`, and manually exercise the CLI against a fixture Node repo to confirm the end-to-end path prints findings and returns the expected exit codes. Finally, run the full validation suite (`typecheck` + `test` + `build`).

## Step by Step Tasks
Execute every step in order, top to bottom.

### Update `.gitignore`

- Add `dist/`, `node_modules/`, `.env`, and `.depaudit/` to `.gitignore`. Preserve the existing "ADW: copied slash commands" block at the top.
- Verify `git status` no longer lists `node_modules/` as untracked.

### Add `typecheck` script and `ignore` dependency

- Edit `package.json`:
  - Add `"typecheck": "tsc --noEmit"` to `scripts` (sits alongside `build` and `test`).
  - Leave `bin.depaudit = ./dist/cli.js` unchanged.
- Run `bun add ignore` — adds `ignore` to `dependencies` (runtime, not dev) and updates `bun.lock`.
- Run `bun install` to confirm the lockfile resolves cleanly.

### Create canonical types

- Create `src/types/finding.ts` exporting:
  - `type Severity = "UNKNOWN" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"`.
  - `type Ecosystem = "npm"` (sole entry for now; later slices widen the union).
  - `type FindingSource = "osv" | "socket"`.
  - `interface Finding { source: FindingSource; ecosystem: Ecosystem; package: string; version: string; findingId: string; severity: Severity; summary?: string; manifestPath: string }`.
- Create `src/types/manifest.ts` exporting `interface Manifest { ecosystem: Ecosystem; path: string }` (absolute path to the manifest file).

### Implement `ManifestDiscoverer`

- Create `src/modules/manifestDiscoverer.ts` exporting `async function discoverManifests(rootPath: string): Promise<Manifest[]>`.
- Implementation:
  - Resolve `rootPath` to an absolute path.
  - Load the root `.gitignore` if present into an `ignore` instance; always hard-append `node_modules/` and `.git/` to the rule set so even missing-gitignore trees skip them.
  - Walk the directory with `fs/promises.readdir(..., { withFileTypes: true })` recursively; for each directory entry, compute the path relative to `rootPath` and test it against the `ignore` instance; skip if ignored.
  - When a directory contains `package.json`, emit `{ ecosystem: "npm", path: <absolute package.json path> }`; continue descending into subdirectories unless they are ignored.
- Keep the module pure-functional — no class needed.

### Create `ManifestDiscoverer` fixtures

- Create the following under `src/modules/__tests__/fixtures/`:
  - `simple-npm/package.json` — `{ "name": "simple", "version": "0.0.0" }`.
  - `nested-npm/packages/a/package.json` — `{ "name": "a", "version": "0.0.0" }`.
  - `nested-npm/packages/b/package.json` — `{ "name": "b", "version": "0.0.0" }`.
  - `with-gitignore/.gitignore` — `excluded/`.
  - `with-gitignore/excluded/package.json` — `{ "name": "excluded" }`.
  - `with-gitignore/included/package.json` — `{ "name": "included" }`.
  - `with-node-modules/package.json` — `{ "name": "root" }`.
  - `with-node-modules/node_modules/lodash/package.json` — `{ "name": "lodash" }`.

### Write `ManifestDiscoverer` unit tests

- Create `src/modules/__tests__/manifestDiscoverer.test.ts` asserting:
  1. `simple-npm/` → exactly one manifest at the root `package.json`.
  2. `nested-npm/` → two manifests, one each under `packages/a` and `packages/b`, both with `ecosystem: "npm"`.
  3. `with-gitignore/` → only `included/package.json`; `excluded/package.json` is filtered out by the `.gitignore` rule.
  4. `with-node-modules/` → only the root `package.json`; the `node_modules/lodash/package.json` is filtered by the hard-coded `node_modules/` rule even without a `.gitignore`.
- Tests resolve fixture paths relative to the test file using `import.meta.url` / `fileURLToPath`.

### Implement `OsvScannerAdapter`

- Create `src/modules/osvScannerAdapter.ts` exporting:
  - `type ExecFileFn = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>`.
  - `async function runOsvScanner(manifests: Manifest[], execFile?: ExecFileFn): Promise<Finding[]>` with a default `execFile` built from `promisify(childProcess.execFile)`.
- Implementation:
  - Derive unique parent directories from the manifest paths (`path.dirname` then dedupe). If the list is empty, return `[]` immediately without invoking the subprocess.
  - Invoke `osv-scanner` with args `["scan", "source", "--format=json", ...directories]`.
  - If `execFile` rejects, inspect the error: when `err.code === 1` and `err.stdout` is present, OSV-Scanner ran successfully and found vulnerabilities — parse `err.stdout`. Any other error propagates.
  - Parse the OSV JSON output (`results[].packages[].vulnerabilities[]`) into `Finding[]`:
    - `source: "osv"`.
    - `ecosystem`: map OSV's `"npm"` to our `"npm"` (other ecosystems land in #4; for unknown values throw a clear error referencing `#4`).
    - `package` / `version`: from `package.name` / `package.version`.
    - `findingId`: prefer the vulnerability's primary `id`; if it's a `GHSA-*` id, also accept it as-is (the PRD allows either CVE or GHSA).
    - `severity`: read `database_specific.severity` if it's one of the canonical levels; otherwise bucket from the highest-score CVSS vector in `severity[]` (≥9.0 → CRITICAL, ≥7.0 → HIGH, ≥4.0 → MEDIUM, >0 → LOW, else UNKNOWN). Never fail the scan on an unparseable severity — fall back to `"UNKNOWN"`.
    - `summary`: the vulnerability's `summary` field if present.
    - `manifestPath`: the `source.path` reported by OSV-Scanner for the package.
- Do not add any `osv-scanner`-binary-exists precheck in this slice; callers get a `spawn ENOENT`-style error if the binary is missing, and that's an acceptable failure mode for the tracer bullet.

### Create `OsvScannerAdapter` JSON fixtures

- Create `src/modules/__tests__/fixtures/osv-output/clean.json` — an OSV-Scanner JSON document with `results: []` (no vulnerabilities).
- Create `src/modules/__tests__/fixtures/osv-output/with-findings.json` — an OSV-Scanner JSON document with at least two packages across one or two lockfile sources, each with one CVE/GHSA vulnerability, exercising both `database_specific.severity` and CVSS-score-derived severity paths.

### Write `OsvScannerAdapter` unit tests

- Create `src/modules/__tests__/osvScannerAdapter.test.ts` with a mocked `execFile`:
  1. Empty `manifests` input → no subprocess call, returns `[]`.
  2. `execFile` resolves with the `clean.json` payload on stdout → returns `[]`.
  3. `execFile` rejects with `{ code: 1, stdout: <with-findings.json> }` (OSV-Scanner's exit-on-findings convention) → returns normalized `Finding[]` matching the fixture, including severity extraction from both paths.
  4. `execFile` rejects with `{ code: 127, stderr: "not found" }` (simulating binary missing or crash) → the adapter re-throws and does not swallow.
  5. Argument assertion: confirm the mocked `execFile` was called with `osv-scanner` as the binary and the expected positional directory list derived from the input manifests (deduped parents, sorted for deterministic assertion).

### Implement `stdoutReporter`

- Create `src/modules/stdoutReporter.ts` exporting `function printFindings(findings: Finding[], stream: NodeJS.WritableStream = process.stdout): void`.
- Each line format: `${finding.ecosystem} ${finding.package}@${finding.version} ${finding.findingId} ${finding.severity}` followed by `\n`.
- If `findings.length === 0`, write nothing (the exit code carries the signal; extra text would pollute downstream consumers).

### Implement `ScanCommand`

- Create `src/commands/scanCommand.ts` exporting `async function runScanCommand(scanPath: string): Promise<number>`.
- Pipeline:
  1. `const manifests = await discoverManifests(scanPath)`.
  2. `const findings = await runOsvScanner(manifests)`.
  3. `printFindings(findings)`.
  4. `return findings.length === 0 ? 0 : 1`.
- Any uncaught error bubbles up to `cli.ts` for top-level handling.

### Implement `src/cli.ts`

- First line: `#!/usr/bin/env node`.
- Use `util.parseArgs` to parse `process.argv.slice(2)` with a positional `scan` subcommand and a single positional path argument (default `process.cwd()`).
- Supported invocations for this slice:
  - `depaudit scan` — scan the current working directory.
  - `depaudit scan <path>` — scan the provided path.
  - `depaudit --help` / `depaudit -h` — print a one-screen usage summary listing the `scan [path]` form; exit 0.
  - `depaudit --version` / `-v` — print the version from `package.json` (read via `createRequire(import.meta.url)("../package.json").version`); exit 0.
- Dispatch: if argv[0] is `scan`, call `runScanCommand(path)` and `process.exit(await runScanCommand(...))`. Any other subcommand or missing subcommand prints the usage summary to stderr and exits 2.
- Wrap the dispatch in a `try/catch`: on error, write `error.message` to stderr and exit 2.

### Wire the `bin` executable

- After `bun run build`, the compiled `dist/cli.js` needs the executable bit set for `bun link` / `npm install -g .` to install a working `depaudit` on `PATH`. Options:
  - Add a `postbuild` script `"postbuild": "chmod +x dist/cli.js"` to `package.json`. This runs automatically after `bun run build`.
- Confirm the compiled output keeps the `#!/usr/bin/env node` shebang (TypeScript preserves leading comments but strips actual shebangs at parse time — use a leading `// #!/usr/bin/env node` block is NOT correct; the real fix is a banner file copied by `postbuild` **or** — the simpler path — leave the shebang as the first statement in `src/cli.ts` (TypeScript preserves it in `ES2022` output when `tsc` sees it as the first token). Verify by reading `dist/cli.js` after `bun run build`. If the shebang is stripped, extend `postbuild` to prepend it.

### Smoke-test the end-to-end CLI

- Run `bun install && bun run build` in the worktree.
- From the worktree root, run `bun link` so `depaudit` is globally resolvable.
- Prepare a throwaway Node fixture outside the repo: `/tmp/depaudit-smoke/` with a known-vulnerable `package-lock.json` (reuse the `lodash@4.17.20` fixture pattern used during plan research).
- Run `depaudit scan /tmp/depaudit-smoke/` and confirm:
  - Stdout contains one line per finding in the `<ecosystem> <package>@<version> <findingId> <severity>` format.
  - Exit code is `1` (non-zero due to findings).
- Run `depaudit scan /tmp/empty-node-repo/` against a fixture with a lockfile that has no vulnerabilities; confirm exit code `0` and no stdout output.
- Run `bun unlink` to clean up.

### Run full validation

- Execute the validation commands below and confirm every command exits 0.

## Testing Strategy

### Unit Tests

`.adw/project.md` does not contain a `## Unit Tests` section, so the default plan rule is to omit unit-test tasks. This plan deliberately overrides that default because the issue's acceptance criteria explicitly require `Vitest unit tests for ManifestDiscoverer (fixture repos) and OsvScannerAdapter (mocked execFile)`, and `.adw/review_proof.md` mandates passing tests with coverage as review evidence. Override is documented in the Notes section below.

- **`ManifestDiscoverer` tests (`src/modules/__tests__/manifestDiscoverer.test.ts`)** — drive the walker against committed fixture directories for: simple root manifest, monorepo nested manifests, `.gitignore`-excluded subtree, and `node_modules/`-skipping. Assert exact manifest lists sorted deterministically.
- **`OsvScannerAdapter` tests (`src/modules/__tests__/osvScannerAdapter.test.ts`)** — inject a mocked `execFile`; assert no-subprocess-on-empty-input, clean-output normalization, findings-on-exit-1 parsing, and error propagation on exit codes other than 1. Verify the exact argv passed to `execFile`.

### Edge Cases

- `ManifestDiscoverer` invoked on a path that does not exist — the walker surfaces the underlying `ENOENT` from `readdir`. Assert this in the manifest discoverer test suite and verify `cli.ts` converts it into a human-readable stderr message plus exit code 2.
- `ManifestDiscoverer` invoked on a directory that has no `package.json` anywhere — returns `[]`; `ScanCommand` short-circuits via `runOsvScanner([])` returning `[]`; exit 0, no stdout.
- `OsvScannerAdapter` called with manifests whose parent directories all coincide — deduped to a single directory arg.
- OSV-Scanner reports a vulnerability whose primary `id` is `GHSA-*` with a `CVE-*` alias — `findingId` takes the primary `id`, not the alias. Documented in the module contract.
- OSV-Scanner reports severity neither in `database_specific.severity` nor in `severity[]` — falls back to `"UNKNOWN"`, not an error.
- OSV-Scanner emits an ecosystem other than `npm` (e.g., `"PyPI"` from a stray lockfile discovered by OSV-Scanner itself) — the adapter throws a clear error pointing at issue `#4`. This slice is npm-only by contract.
- Top-level uncaught error in `ScanCommand` — `cli.ts` catches, prints `error.message` to stderr, exits 2.
- `.gitignore` contains a negation pattern (`!foo.txt`) — delegated to the `ignore` package's semantics, which implement the full Git rule set; trust it.
- Trailing arguments on the CLI beyond the path (e.g., `depaudit scan /tmp extra`) — print usage to stderr, exit 2.

## Acceptance Criteria

- Running `bun install && bun run build` produces an executable `dist/cli.js` with a correct Node shebang.
- After `bun link` (or `npm install -g .`), typing `depaudit --help` prints usage and exits 0.
- `depaudit --version` prints `0.1.0` (the version in `package.json`) and exits 0.
- `depaudit scan /path/to/node-repo` exits 0 and writes nothing to stdout when the repo has no OSV findings.
- `depaudit scan /path/to/node-repo` exits 1 and writes one line per finding (format `<ecosystem> <package>@<version> <findingId> <severity>`) when the repo has findings.
- `ManifestDiscoverer` returns a `Manifest[]` that includes every `package.json` not ignored by `.gitignore` and not under `node_modules/` or `.git/`.
- `OsvScannerAdapter` returns a `Finding[]` normalized from OSV-Scanner's JSON output, correctly handling the exit-code-1-on-findings convention.
- Vitest runs via `bun test` with zero failing tests; `ManifestDiscoverer` and `OsvScannerAdapter` suites both present.
- `bun run typecheck` exits 0 with no TypeScript errors.
- `bun run build` exits 0 with no errors.
- `UBIQUITOUS_LANGUAGE.md` term usage is preserved across new files (`Finding`, `ManifestDiscoverer`, `OsvScannerAdapter`, `ScanCommand`).
- `.gitignore` now excludes `dist/`, `node_modules/`, `.env`, `.depaudit/`; `git status` does not report `node_modules/` as untracked.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions. These match the project-specific entries in `.adw/commands.md` where applicable; `bun run lint` is intentionally excluded because no JS/TS linter is configured in this slice (see Notes).

- `bun install` — resolve and install all dependencies (should complete cleanly after `ignore` is added).
- `bun run typecheck` — runs `tsc --noEmit`; must report zero type errors across `src/`.
- `bun run build` — runs `tsc` producing `dist/cli.js` and related outputs; exit 0 with no errors.
- `test -x dist/cli.js` — confirms the compiled CLI entry is executable after `postbuild`.
- `bun test` — runs Vitest (the `test` script is `vitest run`); all unit tests pass and coverage summary is printed.
- `node dist/cli.js --help` — prints usage; exit 0.
- `node dist/cli.js --version` — prints `0.1.0`; exit 0.
- `node dist/cli.js scan <clean-fixture-path>` — exits 0 with no stdout.
- `node dist/cli.js scan <vulnerable-fixture-path>` — exits 1, stdout contains at least one finding line in the documented format.

## Notes

- No `guidelines/` directory exists in this repository, so coding-style adherence falls back to the conventions in the existing scaffold and the deep-module architecture described in `.adw/project.md` and the PRD.
- **Unit tests override.** `.adw/project.md` lacks the `## Unit Tests: enabled` marker, so the plan template's default would be to omit unit-test tasks. This plan deliberately includes them because (a) the GitHub issue's acceptance criteria explicitly require Vitest unit tests for `ManifestDiscoverer` and `OsvScannerAdapter`, and (b) `.adw/review_proof.md` lists passing tests with coverage as a review proof requirement for every PR. Skipping tests would fail the explicit acceptance bar.
- **Library install.** Per `.adw/commands.md` (Library Install Command: `bun add {library}`), the new runtime dependency (`ignore`) is added via `bun add ignore`. No other dependencies are required for this slice — argument parsing uses Node's built-in `util.parseArgs`, subprocess invocation uses `node:child_process`, and directory walking uses `node:fs/promises`.
- **Lint deferral.** `.adw/commands.md` lists `bun run lint` as the lint command and `.adw/review_proof.md` requires it, but no JS/TS linter (ESLint, Biome, oxlint) is configured in `package.json`. The issue body explicitly excludes "lint" from this slice (referring to the `depaudit lint` command, not JS tooling). Configuring a JS/TS linter is out of scope here; a follow-up chore slice should add one and backfill the review-proof bar. Validation for this slice relies on `typecheck` + `test` + `build`.
- **Tests runner nuance.** `.adw/commands.md` says `bun test`, but `package.json` defines `"test": "vitest run"`. `bun test` is Bun's built-in test runner, which does not understand Vitest's mocking APIs. The invocation that actually runs our Vitest suite is `bun run test` (or `npx vitest run`). In this plan, `bun test` appears only in the commands list as it is documented in `.adw/commands.md`; follow-up can align the two by renaming the script or amending `.adw/commands.md`.
- **Deferred concerns (deliberately excluded, per the issue body and the PRD slice breakdown):** config loading (`ConfigLoader`), register lint (`Linter`), severity threshold filtering, acceptance classification (`FindingMatcher`), Socket supply-chain findings (`SocketApiClient`, fail-open semantics), `Reporter` composite output (markdown/JSON/Slack), PR comment dedupe (`StateTracker`), commit-or-PR policy (`CommitOrPrExecutor`), the `depaudit setup` command, polyglot manifest discovery (issue #4), and `.depaudit/findings.json` persistence. The `Finding` shape defined here is the canonical type those slices will consume; adding fields later (e.g., `accepted`, `whitelisted`) is an additive change.
- **Shebang preservation risk.** TypeScript's behavior with a leading shebang in `.ts` sources varies by toolchain. If `tsc` strips the shebang, extend the `postbuild` hook to re-prepend it (e.g., via a short Node one-liner that reads `dist/cli.js`, ensures the first line is `#!/usr/bin/env node`, rewrites). Verify by inspecting `dist/cli.js` after the first build; adjust only if needed.
- **`UBIQUITOUS_LANGUAGE.md` discipline.** Code identifiers and any comments introduced must use the canonical terms (`Finding`, `ManifestDiscoverer`, `OsvScannerAdapter`, `ScanCommand`). Avoid synonyms like `vulnerability`, `walker`, `runner`, etc.
