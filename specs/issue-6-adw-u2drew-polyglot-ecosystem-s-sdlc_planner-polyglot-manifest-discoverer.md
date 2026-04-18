# Feature: Polyglot Manifest Discoverer + OSV-Scanner Ecosystem Mapping

## Metadata
issueNumber: `6`
adwId: `u2drew-polyglot-ecosystem-s`
issueJson: `{"number":6,"title":"Polyglot ecosystem support (pip, gomod, cargo, maven, gem, composer)","body":"## Parent PRD\n\n`specs/prd/depaudit.md`\n\n## What to build\n\nExtends `ManifestDiscoverer` beyond npm to the full polyglot set documented in the PRD: `requirements.txt` / `pyproject.toml` (pip), `go.mod` (gomod), `Cargo.toml` (cargo), `pom.xml` (maven), `Gemfile` (gem), `composer.json` (composer). `OsvScannerAdapter` must emit the right ecosystem per manifest (OSV-Scanner supports all of these natively). Monorepos with multiple manifests at multiple depths are discovered; findings attributed to their originating manifest and merged into a single scan result.\n\n## Acceptance criteria\n\n- [ ] `ManifestDiscoverer` walks the repo and returns `(ecosystem, manifest_path)` tuples for all supported manifest types.\n- [ ] `.gitignore` and obvious build directories (`node_modules/`, `vendor/`, `target/`, `.venv/`, `__pycache__/`) excluded.\n- [ ] `OsvScannerAdapter` invocation handles multi-manifest input correctly.\n- [ ] Merged scan: all findings from all manifests surface in one result, each tagged with its originating manifest.\n- [ ] Integration test: fixture repo with `package.json` + `go.mod` + `requirements.txt`, assert findings from each.\n\n## Blocked by\n\n- Blocked by #5\n\n## User stories addressed\n\n- User story 15\n- User story 16\n","state":"OPEN","author":"paysdoc","labels":[],"createdAt":"2026-04-17T13:24:38Z","comments":[],"actionableComment":null}`

## Feature Description

Extends `depaudit scan` from an npm-only tool into the full polyglot scanner the PRD calls for. The existing `ManifestDiscoverer` currently only looks for `package.json`; this slice teaches it to recognise every manifest type listed in PRD user story 15: `requirements.txt` and `pyproject.toml` (pip), `go.mod` (gomod), `Cargo.toml` (cargo), `pom.xml` (maven), `Gemfile` (gem), `composer.json` (composer), alongside the existing `package.json` (npm). The existing `OsvScannerAdapter` currently **throws** for any non-`npm` ecosystem (`throw new Error("OsvScannerAdapter: unsupported ecosystem ... — polyglot support lands in issue #4")`); this slice removes that guard and maps OSV-Scanner's native ecosystem identifier strings (`npm`, `PyPI`, `Go`, `crates.io`, `Maven`, `RubyGems`, `Packagist`) onto the internal `Ecosystem` type.

Because `osv-scanner scan source <dir>` already natively walks a directory and emits one result block per manifest file it finds across all supported ecosystems, the adapter itself needs only two changes: (a) widen the internal `Ecosystem` union and the `Ecosystem` type's switch-style mapping, and (b) drop the old npm-only guard. The heavy lifting is in `ManifestDiscoverer`: it must learn the new manifest-file-name set, continue honouring `.gitignore`, and additionally hard-skip the build directories each ecosystem leaves behind — `vendor/` (Ruby/Go/PHP), `target/` (Rust/Maven), `.venv/` (Python virtualenv), `__pycache__/` (Python bytecode), alongside the existing `node_modules/` and `.git/`.

A directory may carry **multiple manifests at once** (e.g. a Python repo with both `requirements.txt` and `pyproject.toml`, or a mixed Node+Go toolbox with both `package.json` and `go.mod`). The discoverer must emit one `Manifest` tuple per manifest file, not one per directory; downstream the `OsvScannerAdapter` continues to dedupe by parent directory when invoking `osv-scanner` (which scans the directory once and produces a result block per manifest found there — so passing the dir once still surfaces all manifests), then attributes each parsed finding back to the originating `source.path` string that OSV-Scanner already emits per result block.

Findings from a polyglot monorepo flow through the existing `ScanCommand` pipeline unchanged — `discoverManifests → runOsvScanner → classifyFindings → printFindings`. Each `Finding` carries its `ecosystem` and `manifestPath` fields end-to-end, so the stdout report already attributes each finding to the correct manifest. No schema change to `.depaudit.yml`, no new config knobs, no new subcommand; this is a pure capability expansion of existing modules.

## User Story

As a maintainer of a polyglot repository (PRD user stories 15 and 16)
I want `depaudit scan` to automatically discover every `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, and `composer.json` in my repo — including monorepos with multiple manifests at multiple depths — and emit all findings from all ecosystems in one merged scan result
So that I don't have to declare manifests explicitly, I don't need one gate per language, and a single `depaudit scan` run is sufficient regardless of whether my repo is Node-only, Python+Go+Node, or a mixed-language monorepo.

## Problem Statement

The current `depaudit scan` pipeline is npm-only in two distinct places that both need to change for polyglot support to work end-to-end:

1. **`ManifestDiscoverer` recognises only `package.json`.** `src/modules/manifestDiscoverer.ts:26-32` walks every non-ignored directory and, per directory, sets a `hasPackageJson` boolean; if true, it emits exactly one `{ ecosystem: "npm", path: "<dir>/package.json" }` tuple. Every other manifest type the PRD names (`requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, `composer.json`) is **silently ignored** — a Go-only repo returns zero manifests and `depaudit scan` exits 0 even if `osv-scanner` would flag CVEs in its `go.mod`.

2. **`OsvScannerAdapter` throws for any non-npm ecosystem.** `src/modules/osvScannerAdapter.ts:111-115` contains an explicit guard: `if (ecosystem !== "npm") { throw new Error("OsvScannerAdapter: unsupported ecosystem ... — polyglot support lands in issue #4") }`. Even if the discoverer were extended, the adapter would crash the first time OSV-Scanner emitted a result block with `ecosystem: "PyPI"` or `ecosystem: "Go"`.

3. **The `Ecosystem` type is a single-value union.** `src/types/finding.ts:2` literally reads `export type Ecosystem = "npm";`. Every downstream consumer (`Finding`, `Manifest`, `classifyFindings`, `SUPPORTED_ECOSYSTEMS` in `depauditConfig.ts:58`) is narrowed to that one value and will fail type-checking the moment anything else flows through.

4. **Build directories for non-Node ecosystems are not excluded from the walk.** The discoverer currently hard-skips only `node_modules/` and `.git/` (`manifestDiscoverer.ts:10`). A Rust project's `target/` directory (which OSV-Scanner will happily re-scan as a build output containing thousands of transitive `Cargo.toml` lockfile copies), a Python project's `.venv/` (a full vendored Python interpreter + installed packages), Ruby/Go/PHP projects' `vendor/` (checked-in third-party sources), and Python's `__pycache__/` are all walked — producing either false-positive manifests, long scan times, or both. This is called out explicitly in the issue's acceptance criteria #2.

5. **No feature scenarios cover polyglot behaviour.** `features/scan.feature` is entirely tagged `@adw-3` and covers only npm fixtures. There is no BDD contract asserting that a mixed-language monorepo produces one merged scan result with findings from each manifest, nor that build directories are skipped.

Collectively these mean depaudit today is advertised as polyglot (per README and PRD) but in practice is useful only for Node repos, and adding a `go.mod` or `requirements.txt` to an existing consumer would either do nothing (silent dropout) or crash (the npm-guard in the adapter). PRD user stories 15 and 16 — the contract for this slice — are the explicit commitment to fix this.

## Solution Statement

Expand the two npm-specific modules into genuine polyglot ones, and widen the shared type. All downstream machinery (`classifyFindings`, `supplyChainAccepts`, stdout reporter, BDD steps) already treats `ecosystem` and `manifestPath` as opaque tagging values — no schema change, no new config knob, no breaking change to `.depaudit.yml`.

Concretely:

- **Widen `Ecosystem` union** (`src/types/finding.ts`). Change `type Ecosystem = "npm"` to `type Ecosystem = "npm" | "pip" | "gomod" | "cargo" | "maven" | "gem" | "composer"`. Update `SUPPORTED_ECOSYSTEMS` in `src/types/depauditConfig.ts:58` to the matching full tuple so the `.depaudit.yml` `policy.ecosystems` linter rule (introduced in issue #5's `lintDepauditConfig`) accepts any of the seven values. No other schema field shifts.

- **`ManifestDiscoverer` — polyglot recognition** (`src/modules/manifestDiscoverer.ts`). Replace the inline `hasPackageJson` boolean with a lookup table mapping manifest file name → ecosystem:
  ```ts
  const MANIFEST_FILES: Record<string, Ecosystem> = {
    "package.json": "npm",
    "requirements.txt": "pip",
    "pyproject.toml": "pip",
    "go.mod": "gomod",
    "Cargo.toml": "cargo",
    "pom.xml": "maven",
    "Gemfile": "gem",
    "composer.json": "composer",
  };
  ```
  For every non-ignored directory the walker visits, for every direct-child file whose name is a key in this table, emit one `{ ecosystem, path }` tuple. A directory with both `requirements.txt` and `pyproject.toml` emits two tuples (both `pip`); a directory with `package.json` + `go.mod` emits two tuples (`npm` and `gomod`). This naturally handles user story 16's monorepo case — e.g. `services/web/package.json` + `services/api/go.mod` + `ml/requirements.txt` produces three tuples, each at its own manifest's path.

- **`ManifestDiscoverer` — build-directory exclusion** (`src/modules/manifestDiscoverer.ts`). Extend the hard-coded `ig.add([...])` seed list to include every directory the issue's acceptance criteria names as "obvious build directories," even when the target repo does not list them in `.gitignore`:
  ```ts
  ig.add([
    "node_modules/",
    ".git/",
    "vendor/",      // Ruby (bundler --path vendor), Go (pre-modules), PHP (Composer)
    "target/",      // Rust (Cargo), Maven default output
    ".venv/",       // Python virtualenv
    "__pycache__/", // Python bytecode
  ]);
  ```
  User-committed `.gitignore` entries continue to be read on top of this seed, so repos that legitimately want to scan inside `vendor/` can override by omitting it from `.gitignore` — except they can't, because our seed is unconditional. That's intentional: these directories are build outputs and checking them in is itself an anti-pattern; the issue's acceptance criteria explicitly demands they be excluded. If a future slice needs to allow opt-in scanning of these dirs, a `.depaudit.yml` override can be added then; YAGNI for now.

- **`OsvScannerAdapter` — ecosystem mapping** (`src/modules/osvScannerAdapter.ts`). Replace the npm-only guard at `osvScannerAdapter.ts:111-115` with a translation function that maps OSV-Scanner's native ecosystem identifier strings to the internal `Ecosystem` union. The OSV schema documents these identifiers and OSV-Scanner emits them verbatim in each `results[].packages[].package.ecosystem` field:
  | OSV ecosystem string | Internal `Ecosystem` |
  |------|-----------|
  | `npm` | `npm` |
  | `PyPI` | `pip` |
  | `Go` | `gomod` |
  | `crates.io` | `cargo` |
  | `Maven` | `maven` |
  | `RubyGems` | `gem` |
  | `Packagist` | `composer` |

  Unknown ecosystem strings (anything outside this table) throw a clear error that names the encountered string and points at the known-supported set — defensive to catch future OSV-Scanner additions we haven't wired up. The existing finding-emission loop is unchanged except for substituting the mapped ecosystem for the hard-coded `"npm"` literal in the `Finding` object.

- **`runOsvScanner` — multi-manifest input handling** (`src/modules/osvScannerAdapter.ts:83-133`). No structural change. The current implementation already dedupes by `dirname(m.path)` (`osvScannerAdapter.ts:89`) before passing dirs to `osv-scanner scan source --format=json <dirs>`. Because `osv-scanner` native-walks each passed directory for manifest files across every supported ecosystem, a dir containing both `package.json` and `go.mod` produces two result blocks (different `source.path`, different `package.ecosystem`) from a single invocation. The iteration at `osvScannerAdapter.ts:107-130` already emits one `Finding` per `(result, package, vulnerability)` triple — so polyglot naturally falls out once the ecosystem guard is lifted. The `Finding.manifestPath` attribution comes directly from `result.source.path` per PRD user story 16 ("findings attributed to their originating manifest and merged into a single scan result").

- **`ScanCommand` stays unchanged**. The pipeline `loadDepauditConfig → lintDepauditConfig → loadOsvScannerConfig → lintOsvScannerConfig → discoverManifests → runOsvScanner → classifyFindings → printFindings` already treats `Finding.ecosystem` and `Finding.manifestPath` as opaque tags. `classifyFindings`'s matching keys (`(package, version, findingId)` and `(package, alertType)`) are ecosystem-agnostic, so a supply-chain or CVE accept written for a `pip` finding classifies exactly the same way as one for an `npm` finding. No composition-root change is needed.

- **BDD coverage — new `features/scan_polyglot.feature`** (tagged `@adw-6`). Adds the acceptance-criteria-mandated integration scenarios: a polyglot monorepo fixture with `package.json` + `go.mod` + `requirements.txt` each pinning a known CVE, assert findings from each ecosystem; individual single-ecosystem fixtures (pip, gomod, cargo, maven, gem, composer) for each manifest type to verify discovery and adapter mapping; build-directory exclusion scenarios for each of the new seeded ignore entries (`vendor/`, `target/`, `.venv/`, `__pycache__/`). Existing `@adw-3` scan scenarios stay untouched — no regression risk because the discoverer's npm behaviour is a subset of its new polyglot behaviour.

- **Unit test coverage — extends existing fixture-driven pattern.** `src/modules/__tests__/manifestDiscoverer.test.ts` gets new cases: each new manifest file name is discovered; a single dir with multiple manifests emits multiple tuples; each new build-directory exclusion is honoured even without a `.gitignore`. `src/modules/__tests__/osvScannerAdapter.test.ts` gets new OSV-output fixtures for each ecosystem (mocked `execFile` stdout containing PyPI, Go, etc. ecosystem strings) asserting correct `Ecosystem` mapping and error on unknown strings.

No library additions are required. The existing `ignore` package already supports the directory-name patterns we're adding. The `yaml` and `smol-toml` deps remain used only by `ConfigLoader`, not the manifest discoverer (OSV-Scanner itself parses each manifest).

## Relevant Files
Use these files to implement the feature:

- `README.md` — Always include per `.adw/conditional_docs.md`. Project overview and status. The "Project Structure" block references `ManifestDiscoverer` and needs no change.
- `specs/prd/depaudit.md` — Authoritative source for PRD user stories 15 and 16 (polyglot discovery, monorepo merged-scan contract), the full supported-ecosystem set in "Stack & Architecture → Findings sources," and the `ManifestDiscoverer` module contract (Modules section). Referenced from `.adw/conditional_docs.md`.
- `app_docs/feature-442uul-cli-skeleton-osv-scan.md` — Documents the current npm-only `ManifestDiscoverer` and `OsvScannerAdapter` this slice extends. Referenced by `.adw/conditional_docs.md` for tasks touching `ManifestDiscoverer`, `OsvScannerAdapter`, or `Finding` types. Explicit "Notes" section at line 98 reads "This slice is npm-only. `OsvScannerAdapter` throws an explicit error for any non-`npm` ecosystem, pointing at issue #4 where polyglot support lands" — the exact extension this slice removes.
- `app_docs/feature-oowire-configloader-linter-cve-ignores.md` — Documents the `ConfigLoader` / `Linter` pair that already consumes `SUPPORTED_ECOSYSTEMS` via the YAML linter's `policy.ecosystems` enum check. Widening the union here means the linter implicitly accepts all seven values — no change needed in `linter.ts` as long as the constant is updated.
- `app_docs/feature-5sllud-depaudit-yml-schema-finding-matcher.md` and `app_docs/feature-m8fl2v-depaudit-yml-schema-finding-matcher.md` — Document `FindingMatcher` and the `.depaudit.yml` schema. Confirms `classifyFindings` is ecosystem-agnostic (keys are `(package, version, findingId)` / `(package, alertType)` — no ecosystem component), so no change to matching logic is required.
- `UBIQUITOUS_LANGUAGE.md` — Canonical terms: **Finding** (must carry ecosystem + manifestPath), **Finding identity** (`(package, version, finding-ID)`), **`ManifestDiscoverer`** (returns `(ecosystem, manifest path)` tuples), **CVE finding**. Use these terms in comments and commit message.
- `.adw/project.md` — Deep-module layout (`src/modules/`, `src/modules/__tests__/`), stack (Bun, TypeScript strict, Vitest, ESM `.js` imports). No `## Unit Tests` marker — see Notes for the override precedent.
- `.adw/commands.md` — Validation commands: `bun install`, `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`, `bun run test:e2e`, `bun run test:e2e -- --tags "@{tag}"`.
- `.adw/review_proof.md` — Rule 5: "For changes to `OsvScannerAdapter` or `SocketApiClient`: confirm mock boundary tests cover the new behavior." Directly mandates mocked-execFile tests for the new ecosystem mappings. Rule 1-3 mandate typecheck/lint/test must all pass.
- `.adw/conditional_docs.md` — Confirms `README.md`, `specs/prd/depaudit.md`, and the two `app_docs/*` entries for issues #3 and #4 should be consulted for this slice.
- `src/types/finding.ts` — Declares the `Ecosystem` union (currently `"npm"` only) and the canonical `Finding` shape. Widening happens here.
- `src/types/manifest.ts` — `Manifest` carries `ecosystem: Ecosystem` and `path: string`. No shape change; the widened union propagates automatically.
- `src/types/depauditConfig.ts` — Holds `SUPPORTED_ECOSYSTEMS = ["npm"] as const` at line 58, consumed by `lintDepauditConfig`'s `policy.ecosystems` enum check. Update to the full seven-ecosystem tuple.
- `src/types/osvScannerConfig.ts` — Holds `LintResult`, `LintMessage`, `ConfigParseError`. No change required.
- `src/modules/manifestDiscoverer.ts` — Primary change site. Replaces the `hasPackageJson` boolean with a manifest-file lookup table, extends the `ig.add([...])` seed list with the four additional build-directory names.
- `src/modules/osvScannerAdapter.ts` — Second change site. Replaces the npm-only guard with an ecosystem-string mapping function; maps OSV's `PyPI`/`Go`/`crates.io`/`Maven`/`RubyGems`/`Packagist` onto the internal union; throws a clear error on unknown strings.
- `src/modules/configLoader.ts` — No change. Already parses `.depaudit.yml` with the `SUPPORTED_ECOSYSTEMS` constant from `depauditConfig.ts`; widening the constant is the only lever needed.
- `src/modules/linter.ts` — No change. `lintDepauditConfig` references `SUPPORTED_ECOSYSTEMS`; widening the constant implicitly widens the accepted enum set.
- `src/modules/findingMatcher.ts` — No change. `classifyFindings`'s matching keys are ecosystem-agnostic.
- `src/modules/stdoutReporter.ts` — No change. Already prints `<package> <version> <findingId> <severity>` per finding — no ecosystem-specific formatting.
- `src/commands/scanCommand.ts` — No change. Pipeline is already polyglot-shaped; only the modules it wires need to be widened.
- `src/commands/lintCommand.ts` — No change. `lintDepauditConfig` accepts the widened `SUPPORTED_ECOSYSTEMS` automatically.
- `src/cli.ts` — No change. CLI dispatch is unchanged.
- `src/modules/__tests__/manifestDiscoverer.test.ts` — Extends with polyglot cases and the new build-directory exclusions. Existing npm cases continue to pass because npm is still in the table.
- `src/modules/__tests__/osvScannerAdapter.test.ts` — Extends with OSV-output fixtures for each non-npm ecosystem and assertions on the ecosystem-mapping function. The existing "unsupported ecosystem" assertion needs to be replaced with an "unknown ecosystem string" case using a fabricated ecosystem identifier (e.g. `"NuGet"`, which OSV supports but this slice does not).
- `src/modules/__tests__/fixtures/` — Existing fixture root. New subdirectories are added here (see New Files).
- `features/scan_polyglot.feature` — NEW. Tagged `@adw-6`. BDD scenarios for polyglot monorepo, single-ecosystem variants, and build-directory exclusions.
- `features/step_definitions/scan_polyglot_steps.ts` — NEW. Step definitions specific to polyglot scenarios (ecosystem-parametrised manifest assertions, build-directory-excluded assertions). Reuses `scan_steps.ts`'s `I run "…"` and exit-code steps via Cucumber's global step registry.
- `features/support/world.ts` — No change. `DepauditWorld`, `PROJECT_ROOT`, `CLI_PATH` are reused.
- `features/scan.feature` — Existing `@adw-3` scenarios. Must continue to pass unchanged — npm behaviour is a subset of the new polyglot behaviour.
- `features/scan_accepts.feature`, `features/scan_yml_accepts.feature`, `features/scan_severity_threshold.feature`, `features/lint.feature`, `features/lint_depaudit_yml.feature` — All existing BDD files. Must continue to pass unchanged.
- `fixtures/` — Existing npm fixture root. New polyglot fixtures are added here (see New Files).

### New Files

- `fixtures/polyglot-monorepo/package.json` — Monorepo-root npm manifest pinning a known-vulnerable package (e.g. `lodash@4.17.20` for `CVE-2021-23337`, already proven in `fixtures/vulnerable-npm`).
- `fixtures/polyglot-monorepo/services/api/go.mod` — Go manifest pinning a package with a known OSV CVE (e.g. an older `github.com/dgrijalva/jwt-go` version which has a well-known published CVE).
- `fixtures/polyglot-monorepo/services/ml/requirements.txt` — Python pip manifest pinning a package with a known OSV CVE (e.g. an older `pyyaml` version pre-CVE-2020-1747 or `urllib3` pre-fix).
- `fixtures/pip-requirements/requirements.txt` — Single-ecosystem pip fixture pinning a known CVE. Used by the "pip manifest is discovered and scanned" scenario.
- `fixtures/pip-pyproject/pyproject.toml` — Single-ecosystem pip fixture using the modern manifest format.
- `fixtures/gomod/go.mod` — Single-ecosystem Go fixture pinning a known CVE.
- `fixtures/cargo/Cargo.toml` — Single-ecosystem Rust fixture.
- `fixtures/maven/pom.xml` — Single-ecosystem Maven fixture.
- `fixtures/gem/Gemfile` — Single-ecosystem Ruby fixture.
- `fixtures/composer/composer.json` — Single-ecosystem PHP fixture.
- `fixtures/with-build-dirs/package.json` — Clean root manifest.
- `fixtures/with-build-dirs/vendor/legacy/Gemfile` — Nested manifest inside `vendor/` that must NOT be discovered.
- `fixtures/with-build-dirs/target/debug/Cargo.toml` — Nested manifest inside `target/` that must NOT be discovered.
- `fixtures/with-build-dirs/.venv/lib/requirements.txt` — Nested manifest inside `.venv/` that must NOT be discovered.
- `fixtures/with-build-dirs/__pycache__/requirements.txt` — Nested manifest inside `__pycache__/` that must NOT be discovered.
- `src/modules/__tests__/fixtures/polyglot-repo/package.json` — Root npm manifest for unit-test discovery.
- `src/modules/__tests__/fixtures/polyglot-repo/requirements.txt` — pip manifest (same dir as `package.json` to test multi-manifest-per-dir).
- `src/modules/__tests__/fixtures/polyglot-repo/services/api/go.mod` — Nested gomod manifest.
- `src/modules/__tests__/fixtures/polyglot-repo/services/ml/pyproject.toml` — Nested pip pyproject manifest.
- `src/modules/__tests__/fixtures/polyglot-repo/tools/Cargo.toml` — Nested cargo manifest.
- `src/modules/__tests__/fixtures/polyglot-repo/vendor-libs/pom.xml` — Nested maven manifest (in a user-named dir that is **not** `vendor/`; the test asserts the seeded ignore matches the exact name `vendor` only).
- `src/modules/__tests__/fixtures/polyglot-repo/cli/Gemfile` — Nested gem manifest.
- `src/modules/__tests__/fixtures/polyglot-repo/web/composer.json` — Nested composer manifest.
- `src/modules/__tests__/fixtures/with-build-dirs/package.json` — Clean root manifest for unit-test.
- `src/modules/__tests__/fixtures/with-build-dirs/vendor/Gemfile` — Must NOT be discovered.
- `src/modules/__tests__/fixtures/with-build-dirs/target/Cargo.toml` — Must NOT be discovered.
- `src/modules/__tests__/fixtures/with-build-dirs/.venv/requirements.txt` — Must NOT be discovered.
- `src/modules/__tests__/fixtures/with-build-dirs/__pycache__/pyproject.toml` — Must NOT be discovered.
- `src/modules/__tests__/fixtures/osv-output/polyglot.json` — Synthetic OSV-Scanner output covering one result per ecosystem (`npm`, `PyPI`, `Go`, `crates.io`, `Maven`, `RubyGems`, `Packagist`) with one vulnerability each. Used by the adapter unit tests to assert the ecosystem-string mapping.
- `src/modules/__tests__/fixtures/osv-output/unknown-ecosystem.json` — Synthetic OSV-Scanner output with an unrecognised ecosystem string (e.g. `NuGet`) to exercise the error path.

## Implementation Plan

### Phase 1: Foundation — widen the shared type

Broaden the `Ecosystem` union from `"npm"` to the full seven-value tuple and update `SUPPORTED_ECOSYSTEMS` so the type-check pass cascades through every consumer. This is the lowest-risk change and exposes every call-site that needs attention via the compiler.

### Phase 2: Core Implementation — teach the two modules polyglot

Replace `ManifestDiscoverer`'s single-file check with the file-name → ecosystem lookup table, and add the four new build-directory seeds to the `ignore` initialization. Replace `OsvScannerAdapter`'s npm-only guard with the OSV-string → `Ecosystem` mapping. Add fixture-driven unit tests for every new recognition/mapping path and every new exclusion.

### Phase 3: Integration — BDD coverage and polyglot fixtures

Build the polyglot monorepo fixture and the single-ecosystem fixtures, write `features/scan_polyglot.feature` with scenarios matching the issue's acceptance criteria (monorepo merged scan, per-ecosystem discovery, build-directory exclusions), wire up `scan_polyglot_steps.ts`, and run the full validation suite end-to-end including `osv-scanner` against the fixtures.

## Step by Step Tasks
Execute every step in order, top to bottom.

### 1. Widen the `Ecosystem` type and the supported set

- Edit `src/types/finding.ts`: replace `export type Ecosystem = "npm";` with `export type Ecosystem = "npm" | "pip" | "gomod" | "cargo" | "maven" | "gem" | "composer";`. Keep the rest of the file identical.
- Edit `src/types/depauditConfig.ts`: replace `export const SUPPORTED_ECOSYSTEMS = ["npm"] as const;` at line 58 with `export const SUPPORTED_ECOSYSTEMS = ["npm", "pip", "gomod", "cargo", "maven", "gem", "composer"] as const;`.
- Run `bun run typecheck` — expect compile errors to surface in `manifestDiscoverer.ts` (no change yet, but its inline `"npm"` literal is still a valid member of the new union, so this passes) and in `osvScannerAdapter.ts` at the hard-coded `"npm"` finding emission (still valid, passes). The typecheck should succeed at this step, confirming the widening is purely additive.

### 2. Extend `ManifestDiscoverer` to recognise all manifest types

- Edit `src/modules/manifestDiscoverer.ts`: at the top of the module, define the manifest-file lookup table:
  ```ts
  const MANIFEST_FILES: Record<string, Ecosystem> = {
    "package.json": "npm",
    "requirements.txt": "pip",
    "pyproject.toml": "pip",
    "go.mod": "gomod",
    "Cargo.toml": "cargo",
    "pom.xml": "maven",
    "Gemfile": "gem",
    "composer.json": "composer",
  };
  ```
- Rewrite the per-directory logic in the `walk` function: remove the `hasPackageJson` boolean and the post-loop `if (hasPackageJson)` push. Instead, inside the for-loop over `entries`, for each `entry.isFile()` whose `entry.name` is a key in `MANIFEST_FILES`, push `{ ecosystem: MANIFEST_FILES[entry.name], path: join(dir, entry.name) }`.
- Order-stability: the existing code emits one tuple per dir in walk-order; the new code emits multiple tuples per dir. To keep test assertions stable, after `await walk(absRoot)` returns, sort `results` by `path` so output ordering is deterministic.

### 3. Extend `ManifestDiscoverer`'s seeded ignore list

- In `src/modules/manifestDiscoverer.ts`, replace the existing `ig.add(["node_modules/", ".git/"]);` call with:
  ```ts
  ig.add([
    "node_modules/",
    ".git/",
    "vendor/",
    "target/",
    ".venv/",
    "__pycache__/",
  ]);
  ```
- These seeds apply on top of any user-committed `.gitignore`; the existing try/catch around reading `.gitignore` (`manifestDiscoverer.ts:13-17`) stays unchanged.

### 4. Extend `ManifestDiscoverer` unit tests

- Open `src/modules/__tests__/manifestDiscoverer.test.ts`. Create fixture files under `src/modules/__tests__/fixtures/polyglot-repo/` and `src/modules/__tests__/fixtures/with-build-dirs/` per the "New Files" list.
- Add test cases:
  - `"finds every supported manifest type in polyglot-repo"` — asserts 8 tuples are returned (one per `MANIFEST_FILES` key, with both `requirements.txt` and `pyproject.toml` where present) with the correct ecosystem per path.
  - `"emits multiple tuples for a directory with multiple manifests"` — asserts the root dir's `package.json` and `requirements.txt` both appear as two distinct tuples.
  - `"hard-skips vendor/, target/, .venv/, __pycache__/ even without a .gitignore"` — asserts the `with-build-dirs` fixture returns only the single root `package.json`.
  - Keep all existing tests green; `simple-npm`, `nested-npm`, `with-gitignore`, `with-node-modules` continue to assert npm-only results (they don't have polyglot manifests to trigger).

### 5. Replace `OsvScannerAdapter`'s npm-only guard with ecosystem mapping

- Edit `src/modules/osvScannerAdapter.ts`: at the top of the module, define the OSV→internal mapping function:
  ```ts
  const OSV_ECOSYSTEM_MAP: Record<string, Ecosystem> = {
    "npm": "npm",
    "PyPI": "pip",
    "Go": "gomod",
    "crates.io": "cargo",
    "Maven": "maven",
    "RubyGems": "gem",
    "Packagist": "composer",
  };
  function mapOsvEcosystem(osvEcosystem: string): Ecosystem {
    const mapped = OSV_ECOSYSTEM_MAP[osvEcosystem];
    if (!mapped) {
      throw new Error(
        `OsvScannerAdapter: unknown ecosystem "${osvEcosystem}" — supported: ${Object.keys(OSV_ECOSYSTEM_MAP).join(", ")}`
      );
    }
    return mapped;
  }
  ```
- In the finding-emission loop at `osvScannerAdapter.ts:107-130`, replace the block:
  ```ts
  if (ecosystem !== "npm") {
    throw new Error(...);
  }
  for (const vuln of pkg.vulnerabilities) {
    findings.push({
      source: "osv",
      ecosystem: "npm",
      ...
    });
  }
  ```
  with:
  ```ts
  const mappedEcosystem = mapOsvEcosystem(ecosystem);
  for (const vuln of pkg.vulnerabilities) {
    findings.push({
      source: "osv",
      ecosystem: mappedEcosystem,
      ...
    });
  }
  ```
- Import `Ecosystem` at the top of the file if it isn't already.

### 6. Extend `OsvScannerAdapter` unit tests

- Create `src/modules/__tests__/fixtures/osv-output/polyglot.json` — a single synthetic OSV output document with one result per ecosystem string (`npm`, `PyPI`, `Go`, `crates.io`, `Maven`, `RubyGems`, `Packagist`), each carrying one package with one vulnerability. Use representative but clearly-test-only package names and CVE IDs.
- Create `src/modules/__tests__/fixtures/osv-output/unknown-ecosystem.json` — one result block with an ecosystem string of `NuGet` (a real OSV ecosystem not in the supported set this slice wires up).
- In `src/modules/__tests__/osvScannerAdapter.test.ts`:
  - Add a test `"maps OSV ecosystem strings to internal Ecosystem values across the full polyglot set"` — mock `execFile` to resolve with `polyglot.json` stdout, assert the returned `Finding[]` has one finding per ecosystem and each `ecosystem` field matches the expected internal value.
  - Add a test `"throws a clear error on an unknown OSV ecosystem string"` — mock `execFile` to resolve with `unknown-ecosystem.json`, assert `runOsvScanner(...)` rejects with an error whose message contains the string `"unknown ecosystem"` and the unrecognised identifier (`NuGet`).
  - Remove the no-longer-relevant "unsupported ecosystem" test (if present from issue #3; the existing test file does not appear to have one — the guard is exercised only via the missing ecosystem check).

### 7. Build polyglot BDD fixtures

- Create `fixtures/polyglot-monorepo/` with:
  - Root `package.json` pinning a known-vulnerable npm package (reuse the `lodash@4.17.20` pattern from `fixtures/vulnerable-npm`).
  - `services/api/go.mod` pinning a known-vulnerable Go module. Use a well-documented, long-standing CVE-bearing version (e.g. `github.com/dgrijalva/jwt-go v3.2.0+incompatible` for `CVE-2020-26160`) so OSV-Scanner reliably flags it across runs.
  - `services/ml/requirements.txt` pinning a known-vulnerable Python package (e.g. `urllib3==1.26.4` or similar; pick any line with a published OSV entry).
- Create `fixtures/pip-requirements/requirements.txt`, `fixtures/pip-pyproject/pyproject.toml`, `fixtures/gomod/go.mod`, `fixtures/cargo/Cargo.toml`, `fixtures/maven/pom.xml`, `fixtures/gem/Gemfile`, `fixtures/composer/composer.json` — each pinning a known-vulnerable package for its ecosystem. Use minimal, valid manifest content for each (each ecosystem's OSV-Scanner support requires only a parseable manifest).
- Create `fixtures/with-build-dirs/` with clean root `package.json` and polluted `vendor/`, `target/`, `.venv/`, `__pycache__/` subtrees each containing a CVE-bearing manifest.

### 8. Add polyglot BDD feature file

- Create `features/scan_polyglot.feature` tagged `@adw-6`. Model after `features/scan.feature`'s `@adw-3` style. Scenarios:
  - **Polyglot monorepo — merged scan produces findings from each ecosystem.** Given `fixtures/polyglot-monorepo` with `package.json` + `go.mod` + `requirements.txt` each pinning a known CVE, when `depaudit scan fixtures/polyglot-monorepo` runs, assert exit non-zero and stdout contains finding lines whose ecosystems (derived from matching package names) span npm, gomod, and pip.
  - **Single pip requirements.txt manifest — discovered and scanned.** Given `fixtures/pip-requirements`, assert non-zero exit and at least one finding line whose package matches a pip dep.
  - **Single pip pyproject.toml manifest — discovered and scanned.** Analogous.
  - **Single go.mod manifest.**
  - **Single Cargo.toml manifest.**
  - **Single pom.xml manifest.**
  - **Single Gemfile manifest.**
  - **Single composer.json manifest.**
  - **Build-directory exclusion — vendor/, target/, .venv/, __pycache__/ each hard-skipped.** Four scenarios (or one with a table) against `fixtures/with-build-dirs`, each asserting exit 0 and zero finding lines even though each polluted subtree contains a CVE-bearing manifest.

### 9. Add polyglot step definitions

- Create `features/step_definitions/scan_polyglot_steps.ts`. Import the same `DepauditWorld`, `PROJECT_ROOT`, `CLI_PATH` from `features/support/world.ts`.
- Reuse shared steps from `scan_steps.ts` (exit code assertions, `I run "…"`, `stdout contains no finding lines`, `stdout contains at least one finding line`) via Cucumber's global step registry — no re-declaration needed.
- Add new steps as needed:
  - `Given a fixture polyglot repository at {string} with manifests: <table>` — accepts a table of `| ecosystem | manifestPath |` rows, used to set `this.fixturePath` and document the fixture shape in the feature file.
  - `Then stdout contains finding lines for each of the ecosystems:` — accepts a list of ecosystem names; asserts at least one finding line in stdout whose package name matches a dependency declared in the manifest of each named ecosystem.
  - Language-specific dep-extraction helpers (a local `readPipDeps(requirementsPath)`, `readGoMod(goModPath)`, etc.) so assertions can map package names back to their manifests.

### 10. Verify existing BDD suites still pass

- Run `bun run build` to refresh `dist/`.
- Run `bun run test:e2e -- --tags "@regression"` to exercise every scenario tagged `@regression` across `@adw-3` (scan), `@adw-4` (lint, scan_accepts), `@adw-5` (scan_yml_accepts, scan_severity_threshold, lint_depaudit_yml). All must pass unchanged.

### 11. Run the full validation suite

- Run `bun run typecheck` — zero type errors.
- Run `bun run lint` — zero lint issues.
- Run `bun test` — all unit tests pass, including the new polyglot cases in `manifestDiscoverer.test.ts` and `osvScannerAdapter.test.ts`.
- Run `bun run build` — build succeeds and `dist/cli.js` is rebuilt.
- Run `bun run test:e2e -- --tags "@adw-6"` — the new polyglot scenarios pass end-to-end against the `osv-scanner` binary.
- Run `bun run test:e2e -- --tags "@regression"` — every previously-passing scenario continues to pass.

## Testing Strategy

### Unit Tests

`.adw/project.md` lacks the `## Unit Tests: enabled` marker, but this plan includes unit-test tasks as a documented override — matching the precedent set by the issue #3, #4, and #5 plans. Justification: (a) `.adw/review_proof.md` Rule 5 mandates mock-boundary tests for any change to `OsvScannerAdapter` — which this slice changes materially (ecosystem mapping). (b) The existing `src/modules/__tests__/manifestDiscoverer.test.ts` and `osvScannerAdapter.test.ts` are established fixture-driven suites that would be silently left behind if polyglot behaviour were only covered at the BDD layer. (c) Unit tests are far faster and far more deterministic than BDD scenarios that invoke the real `osv-scanner` binary against fixture repos (which have shifted public CVE states and can flake on rate-limits or transient database unavailability). Skipping unit tests would fail the PR review bar on Rule 5 and significantly hurt the reliability of the polyglot signal.

Specifically:

- **`ManifestDiscoverer` fixture tests** (`src/modules/__tests__/manifestDiscoverer.test.ts`):
  - Every new manifest file name (`requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, `composer.json`) is discovered at the root and in nested subdirectories with the correct `ecosystem` mapping.
  - A single directory containing multiple manifests emits one `Manifest` tuple per file (e.g. `package.json` + `requirements.txt` in the same dir → two tuples).
  - Each of the four new seeded ignore entries (`vendor/`, `target/`, `.venv/`, `__pycache__/`) is hard-skipped even in the absence of a `.gitignore` — fixture contains a CVE-bearing manifest deep inside each and the test asserts it is NOT returned.
  - Results are returned in sorted-by-path order (deterministic under repeated runs).

- **`OsvScannerAdapter` mocked-execFile tests** (`src/modules/__tests__/osvScannerAdapter.test.ts`):
  - The ecosystem-mapping function maps each supported OSV string (`npm`, `PyPI`, `Go`, `crates.io`, `Maven`, `RubyGems`, `Packagist`) to the correct internal `Ecosystem` value. Asserted via a single synthetic `polyglot.json` stdout covering all seven in one response — each yielded `Finding` has the expected `ecosystem` field.
  - Unknown OSV ecosystem strings throw an error whose message contains both the literal `"unknown ecosystem"` and the offending identifier. Asserted via a synthetic `unknown-ecosystem.json` containing `ecosystem: "NuGet"`.
  - The dedupe-by-parent-dir behaviour (`osvScannerAdapter.test.ts` existing scenario) continues to pass — the change to the finding-emission block does not alter the dir-dedup logic.

### Edge Cases

- **Directory with both `requirements.txt` and `pyproject.toml`.** Both are pip manifests. Expected: two `Manifest` tuples, both with `ecosystem: "pip"` but different paths. Downstream `OsvScannerAdapter` dedupes by parent dir, so OSV-Scanner is invoked once for that dir and emits one result block per manifest file — both surface in the final `Finding[]` with their respective `source.path` in `manifestPath`.
- **Directory with `package.json` + `go.mod` side-by-side** (a toolbox repo with a Node build helper and a Go binary in the same folder). Expected: two `Manifest` tuples, different ecosystems, same parent dir. OSV-Scanner invoked once for that dir, emits two result blocks with distinct `source.path` and `package.ecosystem`.
- **A user-named directory called `my-vendor/` or `my-target/`.** Expected: walked normally. The `ignore` library matches by exact path segments, not substring, so `my-vendor/` does not match the `vendor/` seed. Covered by naming one test-fixture subdirectory `vendor-libs` to exercise this boundary.
- **A `.gitignore` that un-ignores `vendor/` via `!vendor/`.** The `ignore` library respects negation patterns. The seeded rules load first, then user `.gitignore` rules apply on top. The `ignore` library processes patterns in order, so a user's `!vendor/` **does** override the seeded `vendor/` skip. This is acceptable — opt-in scanning of `vendor/` via explicit `.gitignore` negation is a reasonable escape hatch; we document this behaviour in the feature's final app_docs note but don't write a specific test for it (YAGNI — no current user story needs it).
- **A repository with no recognised manifests at all** (e.g. a static-site HTML/CSS repo). Expected: `discoverManifests` returns `[]`; `runOsvScanner([])` short-circuits and returns `[]` without invoking `osv-scanner` (already covered by the existing first test in `osvScannerAdapter.test.ts`); `scanCommand` exits 0. No change in behaviour from pre-slice.
- **An OSV-Scanner result block with an ecosystem string that IS in the supported set but is newly-added in a future OSV-Scanner release** (e.g. `"Pub"` for Dart). Expected: the unknown-ecosystem error path fires and `runOsvScanner` rejects. This is intentional fail-loud behaviour — a silent miss would produce a confusing "scan passed but there are findings in your Dart code" failure. Extending the supported set in a future slice is a one-line change to `OSV_ECOSYSTEM_MAP`.
- **A polyglot monorepo where OSV-Scanner finds zero CVEs in one ecosystem but many in another.** Expected: the merged `Finding[]` contains only the non-clean ecosystem's findings; exit code is non-zero if any remain after `classifyFindings`.
- **`.gitignore` entry inside a monorepo subdirectory, not at the root.** The current implementation only reads the root `.gitignore` (`manifestDiscoverer.ts:13`). Nested `.gitignore` files are not respected. This is a pre-existing limitation, not introduced by this slice. Documenting it in the app_docs but not fixing it here (out of scope).
- **A `pyproject.toml` that is not a Python dependency manifest** (e.g. a Rust workspace using `pyproject.toml` for tooling config). OSV-Scanner itself decides whether a given `pyproject.toml` carries a resolvable dependency list; if it doesn't, OSV emits zero vulnerabilities for it and no `Finding` is produced. The discoverer still emits a `{ ecosystem: "pip", path: ... }` tuple, but the downstream pipeline drops it silently. Acceptable behaviour.

## Acceptance Criteria

The feature is complete when every box below is verifiable by running the Validation Commands:

- [ ] `ManifestDiscoverer` walks the repo and returns `{ ecosystem, path }` tuples for every one of `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, and `composer.json` found at any depth — with ecosystem tags `npm`, `pip`, `pip`, `gomod`, `cargo`, `maven`, `gem`, `composer` respectively.
- [ ] `ManifestDiscoverer` hard-skips `node_modules/`, `.git/`, `vendor/`, `target/`, `.venv/`, and `__pycache__/` directories even when no `.gitignore` exists in the repo root.
- [ ] `ManifestDiscoverer` continues to honour `.gitignore` entries committed to the repo root (existing `@adw-3` scenario still passes).
- [ ] A directory containing multiple manifest files (e.g. `package.json` + `requirements.txt` + `go.mod`) produces one `Manifest` tuple per file, not one per directory.
- [ ] `OsvScannerAdapter` maps OSV-Scanner's native ecosystem strings (`npm`, `PyPI`, `Go`, `crates.io`, `Maven`, `RubyGems`, `Packagist`) to the internal `Ecosystem` union values (`npm`, `pip`, `gomod`, `cargo`, `maven`, `gem`, `composer`).
- [ ] `OsvScannerAdapter` throws a clear error naming the offending string when OSV-Scanner returns a result block with an unmapped ecosystem identifier.
- [ ] `OsvScannerAdapter` accepts multi-manifest input: a single invocation of `runOsvScanner` across a fixture with manifests from multiple ecosystems returns one merged `Finding[]` with each finding tagged by its originating `ecosystem` and `manifestPath`.
- [ ] `ScanCommand` pipeline processes a polyglot repo end-to-end: `depaudit scan fixtures/polyglot-monorepo` emits finding lines from the `package.json`, `go.mod`, and `requirements.txt` in the fixture, and exits non-zero.
- [ ] `features/scan_polyglot.feature` exists, is tagged `@adw-6` (with individual scenarios also tagged `@regression` where appropriate), and every scenario passes under `bun run test:e2e -- --tags "@adw-6"`.
- [ ] Every pre-existing BDD scenario (tags `@adw-3`, `@adw-4`, `@adw-5`, `@regression`) continues to pass unchanged.
- [ ] `src/modules/__tests__/manifestDiscoverer.test.ts` and `osvScannerAdapter.test.ts` cover every new recognition, mapping, and exclusion branch.
- [ ] `bun run typecheck`, `bun run lint`, `bun test`, `bun run build` all succeed with zero errors.

## Validation Commands
Execute every command to validate the feature works correctly with zero regressions.

Per `.adw/commands.md`:

- `bun install` — confirm no new dependencies are required (none should be added by this slice).
- `bun run typecheck` — confirm zero TypeScript errors, especially that the widened `Ecosystem` union and `SUPPORTED_ECOSYSTEMS` tuple type-check cleanly across all consumers (`configLoader`, `linter`, `findingMatcher`, `scanCommand`).
- `bun run lint` — confirm zero lint errors (style-only; same rules as existing modules).
- `bun test` — run the Vitest unit suite. Every existing test must continue to pass; new `manifestDiscoverer.test.ts` and `osvScannerAdapter.test.ts` cases must all pass.
- `bun run build` — compile to `dist/` and confirm `dist/cli.js` is executable (`postbuild` runs `chmod +x`).
- `bun run test:e2e -- --tags "@adw-6"` — run only the new polyglot scenarios. Expect all scenarios to pass, including the polyglot monorepo merged-scan scenario and the build-directory exclusion scenarios.
- `bun run test:e2e -- --tags "@regression"` — run the full regression suite across all prior slices. Expect zero regressions.
- Manual smoke test:
  - `node dist/cli.js scan fixtures/polyglot-monorepo/` — expect non-zero exit and stdout lines for packages from the npm, go.mod, and requirements.txt manifests.
  - `node dist/cli.js scan fixtures/with-build-dirs/` — expect exit 0 and empty stdout despite the CVE-bearing manifests nested inside `vendor/`, `target/`, `.venv/`, `__pycache__/`.
  - `node dist/cli.js scan fixtures/gomod/` — expect non-zero exit and at least one finding line whose package name matches the Go module declared in the fixture.

## Notes

- **Unit tests override**: `.adw/project.md` lacks `## Unit Tests: enabled`. This plan includes unit-test tasks because `.adw/review_proof.md` Rule 5 mandates mock-boundary tests for `OsvScannerAdapter` changes, and Rule 6's fixture-driven pattern is the established precedent for `ManifestDiscoverer` in the existing test suite. Same precedent applied by issue #3, #4, and #5 plans.
- **No new libraries required.** The `ignore` package already handles directory-name gitignore patterns. TOML (`smol-toml`) and YAML (`yaml`) parsers remain confined to `ConfigLoader`. Per `.adw/commands.md`, any future library would use `bun add <name>` — but none is needed for this slice.
- **Pre-existing limitation retained**: `ManifestDiscoverer` only reads the root `.gitignore`. Nested `.gitignore` files are not respected. This is unchanged by this slice; documenting for awareness. If a future slice needs nested `.gitignore` honouring, it will require walking `.gitignore` per-directory and merging rules — a non-trivial change out of scope here.
- **OSV ecosystem strings are canonical** per the OSV schema (`https://ossf.github.io/osv-schema/#affectedpackage-field`). OSV-Scanner emits them verbatim; no quoting or case munging needed.
- **Socket.dev coverage** is orthogonal to this slice. Socket has per-ecosystem support (npm, PyPI, a subset of others). This slice expands only CVE coverage via OSV-Scanner; Socket wiring lands in a later issue and its own ecosystem-coverage table applies there.
- **`commonAndFine` and `supplyChainAccepts` do not carry an ecosystem field** — they match by `(package, alertType)` and `(package, version, findingId)` respectively. A pip package accidentally sharing a name with an npm package (rare but possible) would match both ecosystems' accepts. This is intentional in the PRD (see PRD "Finding identity" section): `(package, version, findingId)` is the canonical identity; the ecosystem is metadata for reporting, not part of the acceptance key. Documenting here so a future reviewer doesn't mistake it for a bug.
- **Fail-loud on unknown OSV ecosystems** (e.g. Dart `Pub`, Nuget, Hex, Pub.dev). This slice wires up the seven ecosystems the PRD names; any OSV-Scanner output for an unwired ecosystem throws. Extending the set is a one-line change to `OSV_ECOSYSTEM_MAP` plus matching unit-test fixture; kept outside this slice per YAGNI.
- **CI runtime impact**: scanning a repo with `target/` or `.venv/` checked in used to recurse through thousands of vendored manifests; after this slice those are hard-skipped, so scan time on polluted repos improves. No CI time budget change needed; the speedup is strictly in the repo's favour.
- **`guidelines/` directory does not exist** in this repo at time of writing; no guideline-specific refactoring obligations apply to this slice.
