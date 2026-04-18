# Feature: SocketApiClient + Supply-Chain Findings + Fail-Open

## Metadata
issueNumber: `7`
adwId: `ekjs2i-socketapiclient-supp`
issueJson: `{"number":7,"title":"SocketApiClient + supply-chain findings + fail-open","body":"## Parent PRD\n\n`specs/prd/depaudit.md`\n\n## What to build\n\nAdds `SocketApiClient` — HTTP client for Socket.dev's REST API with bearer auth via `SOCKET_API_TOKEN`, retries with exponential backoff, and fail-open on timeout / 5xx / rate-limit. Supply-chain `Finding` objects are normalized to the same internal `Finding` shape as CVEs and merged into the scan result. `FindingMatcher` now matches against `supplyChainAccepts` entries in `.depaudit.yml`.\n\nFail-open: when Socket is unavailable, scan still completes with CVE findings only; result annotated so PR comment (future slice) can note \"supply-chain unavailable\".\n\n## Acceptance criteria\n\n- [ ] `SocketApiClient` reads token from `SOCKET_API_TOKEN` env var; errors if missing.\n- [ ] Packages batched; retries with backoff on transient errors.\n- [ ] Timeout / 5xx / rate-limit → fail-open; scan continues with OSV-only; result carries a `socketAvailable: false` flag.\n- [ ] Supply-chain findings normalized into `Finding` with stable `(package, version, alertType)` identity.\n- [ ] `FindingMatcher` honors `supplyChainAccepts` entries; accepted supply-chain findings drop from \"new\" bucket.\n- [ ] Unit tests: mocked HTTP (MSW-style) covering happy path, retry-then-success, permanent-failure-fail-open, auth error.\n\n## Blocked by\n\n- Blocked by #6\n\n## User stories addressed\n\n- User story 3\n- User story 17\n- User story 18\n","state":"OPEN","author":"paysdoc","labels":[],"createdAt":"2026-04-17T13:24:39Z","comments":[],"actionableComment":null}`

## Feature Description

Wires a new `SocketApiClient` deep module into the existing `ScanCommand` pipeline so that `depaudit scan` produces supply-chain findings from Socket.dev's REST API in addition to the CVE findings it already gets from OSV-Scanner. The client reads its bearer token from `SOCKET_API_TOKEN` (already documented in `.env.sample`), batches the packages that came out of the `ManifestDiscoverer` walk, calls Socket.dev's package-alerts endpoint per batch, normalises every non-"info" Socket alert into the existing `Finding` shape (with `source: "socket"`, stable `(package, version, alertType)` identity), and merges that `Finding[]` with the OSV-Scanner findings before they flow into `FindingMatcher.classifyFindings`.

Critically, the client is **fail-open**: if Socket is unreachable (network error / timeout), returns HTTP 5xx, or returns 429 rate-limit (even after retries with exponential backoff), the scan does not abort. Instead `SocketApiClient` returns `{ findings: [], available: false }` and the scan proceeds on CVE findings alone — the `socketAvailable: false` flag bubbles through the pipeline and annotates the scan result so a future PR-comment slice can emit "supply-chain unavailable." Auth failures (401/403) and missing tokens are treated differently: they're configuration bugs, not transient failures, so they **fail loud** with a clear error message rather than silently degrading — otherwise a silently-misconfigured CI would mask supply-chain gaps indefinitely.

`FindingMatcher` itself needs no behavioural change: it already has a `supplyChainAccepts` branch keyed on `(package, version, findingId)` (see `src/modules/findingMatcher.ts:59-71`). This slice simply ensures that `Socket`-sourced findings have their `findingId` set to the Socket alert type so the existing matcher honours user-configured `supplyChainAccepts` entries.

## User Story

As a maintainer of a repository whose CI gate depends on depaudit (PRD user stories 3, 17, 18)
I want `depaudit scan` to surface Socket.dev supply-chain signals (maintainer churn, typosquatting, install-script risk, etc.) alongside OSV CVE findings — and to **keep working** (CVE-only) on Socket outages rather than blocking every PR
So that I catch supply-chain threats that don't yet have a CVSS score, my `commonAndFine` and `supplyChainAccepts` entries suppress alerts I've consciously approved, and a Socket.dev incident never cascades into a repo-wide merge freeze.

## Problem Statement

Today, the `ScanCommand` pipeline (`src/commands/scanCommand.ts:55-57`) runs only `runOsvScanner(manifests)`. The CVE half of the PRD's two-source finding model (OSV + Socket) is live; the **supply-chain half is entirely missing**:

1. **`SocketApiClient` does not exist.** `src/modules/` has no `socketApiClient.ts`. The PRD module list (`specs/prd/depaudit.md:200`) names `SocketApiClient` as a deep module alongside `OsvScannerAdapter`, but only `OsvScannerAdapter` is implemented. Despite `SOCKET_API_TOKEN` being documented in `.env.sample` and the README's env-var table, the token is read by nothing.

2. **`supplyChainAccepts` entries match against nothing.** `FindingMatcher` already routes `source === "socket"` findings through the `supplyChainAccepts` branch (`src/modules/findingMatcher.ts:59-71`) and the `.depaudit.yml` schema already parses `supplyChainAccepts` entries (`src/types/depauditConfig.ts:20-28`), but no module emits `Source: "socket"` findings — so every `supplyChainAccepts` entry a user writes is dead config. Linter rules 1-8 apply to it; the runtime gate ignores it.

3. **No fail-open path exists.** The `ScanCommand` pipeline has a single linear sequence `discoverManifests → runOsvScanner → classifyFindings → printFindings`. Any step that throws causes the whole scan to abort. PRD user story 18 demands the opposite for Socket specifically ("fail open … rather than fail closed, so that a Socket outage doesn't block every contributor's PR"), and PRD implementation decisions document the exact contract ("A Socket API error (timeout, 5xx, rate-limit) causes depaudit to skip supply-chain findings for that run and annotate the PR comment …" — `specs/prd/depaudit.md:110`). Neither the pipeline nor the scan-result shape supports this today.

4. **The scan result shape doesn't carry per-source availability state.** `ScanCommand` currently returns only a numeric exit code (`src/commands/scanCommand.ts:9`). There is no structured `{ findings, socketAvailable }` object that downstream consumers (the eventual PR comment, `.depaudit/findings.json`, orphan-prune fail-open guard per `specs/prd/depaudit.md:151`) can inspect. Without it, the orphan-pruning fail-open guard and the PR-comment annotation both have no signal to branch on.

5. **No mock-boundary test scaffolding for HTTP exists.** `OsvScannerAdapter` has an `ExecFileFn` injection point for tests (`src/modules/osvScannerAdapter.ts:7-12`); this slice introduces the parallel for HTTP — a `FetchFn` injection point so unit tests can simulate Socket 200/429/500/timeout/network-error responses without a live network.

Collectively the consequence is: the PRD's advertised dual-source gating is half-functional. A user who has carefully configured `supplyChainAccepts` in `.depaudit.yml` for a known typosquatting-false-positive on a dependency they need will see the linter accept their config, see no errors, and get no gate behaviour change — because no Socket-source finding ever exists to match it against. A user who has no `supplyChainAccepts` but has a dependency with a known Socket alert (e.g., a compromised maintainer) gets no warning at all.

## Solution Statement

Introduce a `SocketApiClient` deep module that mirrors the shape of `OsvScannerAdapter`, wire it into `ScanCommand` between the OSV step and the classification step, extend the command's return type to carry supply-chain availability, and keep `FindingMatcher` untouched (it already handles the `source === "socket"` branch correctly).

Specifically:

- **New `src/modules/socketApiClient.ts`** — deep module that exports `fetchSocketFindings(packages, options)`. Takes a list of `{ ecosystem, package, version }` triples (derived from `ManifestDiscoverer`'s output plus OSV-Scanner's parsed package list), reads `SOCKET_API_TOKEN` from `process.env`, POSTs batches to Socket.dev's package-alert endpoint (`POST https://api.socket.dev/v0/purl?alerts=true` — the canonical Socket v0 endpoint that accepts an array of PURLs and returns per-package alerts), retries transient failures (timeout / 5xx / 429) with exponential backoff (3 attempts, 500ms→1s→2s base delay with jitter), normalises each returned `{ type, severity, package, version }` alert into the internal `Finding` shape with `source: "socket"` and `findingId: alert.type`, and returns `{ findings, available: true }` on success or `{ findings: [], available: false }` on exhausted-retries transient failure. Missing `SOCKET_API_TOKEN` or 401/403 responses throw a named `SocketAuthError` (fail-loud — config bug, not a transient).

- **New `src/types/scanResult.ts`** — defines the `ScanResult` interface: `{ findings: ClassifiedFinding[], socketAvailable: boolean, exitCode: number }`. Used by `ScanCommand` to surface per-source availability to callers (the current CLI just reads `exitCode`; future slices will read `findings` and `socketAvailable` for the PR comment and orphan-prune guard).

- **Extend `ScanCommand`** (`src/commands/scanCommand.ts`). After `runOsvScanner(manifests)` returns, extract the `(ecosystem, package, version)` tuples from both the manifests and the OSV findings (deduped), call `fetchSocketFindings(...)`, merge the returned `Finding[]` into the OSV `Finding[]`, and pass the combined list to `classifyFindings`. When `available === false`, pass through to the caller via the new `ScanResult` shape and also write a single stderr line `socket: supply-chain unavailable — scan continuing on CVE findings only` so local users notice even before the PR-comment slice lands. The command still returns an exit code for the current CLI contract, but now also returns a structured result — `src/cli.ts` is updated to read the new shape and pass the numeric code through unchanged.

- **New `FetchFn` type + dependency injection.** `SocketApiClient` exports `type FetchFn = typeof globalThis.fetch` (mirror of how `OsvScannerAdapter` exposes `ExecFileFn`). Production uses `globalThis.fetch` (Node 20+ / Bun); tests inject a mock that returns canned `Response` objects. No new dependency — `fetch` is built-in. The client encapsulates timeout (via `AbortController`), retry loop, and response parsing; tests assert on the mock's call log and on the returned `{ findings, available }`.

- **New `SocketAuthError`** exported from `socketApiClient.ts` so `ScanCommand` (and the future setup/lint commands) can distinguish config bugs from transient failures. `ScanCommand` re-throws `SocketAuthError` upward so the CLI surfaces it as an exit-code-2 "config error" — this matches the existing pattern used by `ConfigParseError` (`src/commands/scanCommand.ts:13-21`).

- **Normalisation rules.** One Socket alert → one `Finding`:
  - `source: "socket"` — distinguishes from `"osv"` in `FindingMatcher`.
  - `ecosystem` — mapped from the PURL type string (`pkg:npm/...` → `npm`, `pkg:pypi/...` → `pip`, etc.); same mapping table as `OsvScannerAdapter`'s `OSV_ECOSYSTEM_MAP` but keyed on PURL types (`npm`, `pypi`, `golang`, `cargo`, `maven`, `gem`, `composer`).
  - `package`, `version` — from the PURL.
  - `findingId` — the Socket alert type (e.g., `malware`, `typosquat`, `install_scripts`, `deprecated`). This is the stable identity component that `supplyChainAccepts` and `commonAndFine` match against, per PRD finding-identity rule (`specs/prd/depaudit.md:125`).
  - `severity` — Socket alerts use their own scale (`low` / `middle` / `high` / `critical`); map onto the internal `Severity` union (`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`) with a small translation function.
  - `summary` — the Socket alert description or title, if present.
  - `manifestPath` — the manifest path from the `Manifest` tuple that contributed this package; when the same package is contributed by multiple manifests (e.g., nested package.jsons in a monorepo), emit one `Finding` per manifestPath × alert pair so downstream attribution stays correct.
  - Socket's `severity: "info"` alerts are filtered out at the adapter layer — they're for UI surfacing, not gating (per Socket's own docs). This keeps the `FindingMatcher` threshold logic clean.

- **Batching.** Socket.dev's API accepts up to 1,000 PURLs per POST. For a large monorepo the discoverer may find multiple thousand packages across manifests; the client chunks into 1,000-PURL batches and fires them sequentially (not parallel — rate-limit-friendlier on the free tier). Any single batch's transient failure causes the whole run to fail open (the alternative — one batch errors, five batches succeed — would leak partial supply-chain data into the gate decision, which is worse than fail-open).

- **Timeouts.** Per-request timeout of 30 seconds via `AbortController` (covers Socket's cold-start tail); total wall-clock budget of 90 seconds across all retries. If exhausted, fail open.

- **Package-list derivation.** Socket's endpoint takes PURLs; the package list is derived **from the OSV-Scanner output itself** rather than re-parsing each manifest. `osv-scanner scan source --format=json` already returns every package it resolved, so the adapter's parsed result carries the full `(ecosystem, package, version)` set the scan tree contains — exactly what Socket needs. This avoids duplicating manifest parsing logic across two modules and naturally covers the deep transitive tree that the manifest alone doesn't make visible. When OSV-Scanner itself returns no packages (clean repo), Socket is not called at all — nothing to scan — and `socketAvailable` stays `true` (the "call was unnecessary, treat as success" semantics).

- **`FindingMatcher` is already polyglot-ready.** `src/modules/findingMatcher.ts:19-25` already builds a `supplyChainAccepts` lookup keyed on `${package}|${version}|${findingId}`. As long as Socket findings land with that exact identity shape, no matcher change is needed. The accepted Socket finding drops from the "new" bucket; the unaccepted one becomes a "new" finding and (if above the severity threshold) fails the gate. The existing unit tests at `src/modules/__tests__/findingMatcher.test.ts:61-87` already cover this branch using synthetic Socket findings — this slice just makes them realistic.

- **BDD coverage** (`features/scan_socket_supply_chain.feature`, tagged `@adw-7`). Scenarios matching the issue's acceptance criteria: (a) happy path — fixture repo with a known Socket alert on a dependency + empty `.depaudit.yml` → exit non-zero, finding line whose `finding-ID` is the Socket alert type, (b) `supplyChainAccepts` match → exit 0, (c) Socket mocked as 503 → exit 0 with "supply-chain unavailable" stderr annotation, (d) missing `SOCKET_API_TOKEN` → exit non-zero with "SOCKET_API_TOKEN" error. Because we cannot hit Socket.dev's live API from CI deterministically, the BDD scenarios run against a **local HTTP mock server** bound to a random port; the client's fetch URL is overridable via a `SOCKET_API_BASE_URL` env var (defaulting to `https://api.socket.dev`). This env-var override pattern mirrors how many SDKs expose their staging endpoints and is the cleanest seam for BDD without touching production code paths.

- **`commonAndFine` also lights up.** Users currently listing install-script / typosquat-adjacent packages in `commonAndFine` (per PRD user story 17) see them honoured the moment Socket starts emitting findings, because `FindingMatcher`'s rule-3 branch (`findingMatcher.ts:73-82`) is already ecosystem-agnostic and source-agnostic. No code change needed for user story 17 beyond this slice.

- **Stdout reporter format is unchanged.** Finding lines continue to emit `<package> <version> <findingId> <severity>` (`src/modules/stdoutReporter.ts:5-9`). `@adw-7` scenarios distinguish Socket findings from OSV findings by matching on the `findingId` (Socket alert types like `install-scripts`, `typosquat`, `malware` are not confusable with OSV CVE IDs like `GHSA-*`/`CVE-*`). Keeping the stdout contract stable avoids churn in the pre-existing `@adw-3`/`@adw-4` BDD suite and its `FINDING_LINE_RE` regex (`scan_steps.ts:11`). A future machine-readable output (JSON / SARIF) is the right home for programmatic source-attribution; stdout remains a human-readable log.

- **Documentation.** `app_docs/feature-ekjs2i-socketapiclient-supply-chain.md` is scaffolded (by the parallel document step in ADW) after this slice lands and documents the new module, its retry/fail-open contract, the `FetchFn` injection point, and the env-var override. `UBIQUITOUS_LANGUAGE.md` already defines "Fail open" (row in the Remediation actions table); no glossary change needed.

- **No new runtime dependency.** Global `fetch` is built-in in Node 20+/Bun. `AbortController` is built-in. No MSW, no node-fetch, no got, no axios. A test-only file fixture for HTTP responses (`src/modules/__tests__/fixtures/socket-output/*.json`) covers the payload shapes. Per `.adw/commands.md` any library addition would be `bun add <name>`, but none is needed.

## Relevant Files
Use these files to implement the feature:

- `README.md` — Always included per `.adw/conditional_docs.md`. Mentions `SOCKET_API_TOKEN` in the env-var table; no README edit needed for this slice (the slice wires up what the README already advertises).
- `specs/prd/depaudit.md` — Authoritative source for PRD user stories 3, 17, 18, the supply-chain finding model, the fail-open contract, and the `SocketApiClient` module contract. Referenced in the Conditional Documentation guide for architecture/module-boundary work.
- `.env.sample` — Documents `SOCKET_API_TOKEN` as the expected env-var name. No change needed; this slice makes the value functional.
- `UBIQUITOUS_LANGUAGE.md` — Canonical definitions. **Supply-chain finding** (row): "A Finding sourced from Socket.dev REST API; identified by a Socket alert-type identifier." **Fail open**: "Socket.dev's failure mode: on API error, supply-chain findings are skipped for the run and the Gate continues on CVE findings alone." Use these terms in commit messages and `app_docs/`.
- `.adw/project.md` — Deep-module layout (`src/modules/`, `src/modules/__tests__/`), stack (Bun, TypeScript strict, Vitest, ESM `.js` imports). No `## Unit Tests` marker — see Notes for the override precedent (same as issues #3–#6 plans).
- `.adw/commands.md` — Validation commands: `bun install`, `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`, `bun run test:e2e`, `bun run test:e2e -- --tags "@{tag}"`.
- `.adw/review_proof.md` — **Rule 5**: "For changes to `OsvScannerAdapter` or `SocketApiClient`: confirm mock boundary tests cover the new behavior." Directly mandates MSW-style HTTP mock tests for every retry / fail-open / auth / happy-path branch. **Rule 6** applies to `FindingMatcher` if we touched it (we don't, so Rule 6 is satisfied trivially). Rules 1-3 (typecheck, lint, test) apply to everything.
- `.adw/conditional_docs.md` — Confirms `README.md` and `specs/prd/depaudit.md` are the always-load docs. `app_docs/feature-442uul-cli-skeleton-osv-scan.md` is referenced for `ScanCommand` context.
- `app_docs/feature-442uul-cli-skeleton-osv-scan.md` — Documents the existing `ScanCommand` pipeline this slice extends with the Socket step. Confirms the `Finding` type's `source`/`ecosystem`/`findingId`/`severity`/`manifestPath` fields.
- `app_docs/feature-oowire-configloader-linter-cve-ignores.md` — Documents the `ConfigLoader`/`Linter` pair; confirms `supplyChainAccepts` is already parsed and linted from `.depaudit.yml`. No change to these modules.
- `app_docs/feature-5sllud-depaudit-yml-schema-finding-matcher.md` and `app_docs/feature-m8fl2v-depaudit-yml-schema-finding-matcher.md` — Document `FindingMatcher`'s four-way classification; confirm the existing `source === "socket"` branch in rule 2 is already live, so this slice wires up `source: "socket"` emissions without modifying the matcher itself.
- `app_docs/feature-u2drew-polyglot-manifest-discoverer.md` — Documents the polyglot `ManifestDiscoverer` and `OsvScannerAdapter` ecosystem mapping; confirms the `(ecosystem, package, version)` tuples this slice feeds to Socket are correctly typed.
- `src/types/finding.ts` — `Finding` shape is reused; `FindingSource = "osv" | "socket"` already exists (line 3). No change.
- `src/types/manifest.ts` — `Manifest` tuple is unchanged. No change.
- `src/types/depauditConfig.ts` — `SupplyChainAccept` interface (lines 20-28) already present with `(package, version, findingId, expires, reason, upstreamIssue)`. No change.
- `src/types/osvScannerConfig.ts` — No change; holds lint types that are reused in this slice via re-export if needed.
- `src/modules/manifestDiscoverer.ts` — No change; its output feeds OSV-Scanner which in turn produces the package list fed to Socket.
- `src/modules/osvScannerAdapter.ts` — No change; its returned `Finding[]` is reused both as the OSV portion of the merged list and as the package source list passed to Socket. (The PURL list is derived from the OSV output's package set.)
- `src/modules/configLoader.ts` — No change; `supplyChainAccepts` parsing already present (lines 129-152).
- `src/modules/linter.ts` — No change; `supplyChainAccepts` linting already present (lines 213-273).
- `src/modules/findingMatcher.ts` — No change; `source === "socket"` branch already live at lines 59-71 keyed on `(package, version, findingId)`.
- `src/modules/stdoutReporter.ts` — No change. Current 4-field format (`<package> <version> <findingId> <severity>`) is kept; `@adw-7` scenarios distinguish Socket findings via `findingId` pattern (Socket alert types are non-overlapping with OSV CVE IDs).
- `src/commands/scanCommand.ts` — Primary change site. After OSV step, invoke `fetchSocketFindings` against the OSV-derived package set, merge `Finding[]`, pass merged list to `classifyFindings`, and carry `socketAvailable` through to the returned `ScanResult`. Re-throw `SocketAuthError` as a config-bug (exit 2). Stderr-annotate on fail-open. Still returns exit code for CLI.
- `src/commands/lintCommand.ts` — No change (lint is offline-only).
- `src/cli.ts` — Read the widened `ScanResult` from `runScanCommand` and pass through the exit code. Behavioural no-op for end users other than the stderr "supply-chain unavailable" note on Socket outages.

### New Files

- `src/modules/socketApiClient.ts` — The new deep module. Exports:
  - `type FetchFn = typeof globalThis.fetch` — DI seam, mirroring `ExecFileFn`.
  - `type PackageRef = { ecosystem: Ecosystem; package: string; version: string; manifestPath: string }` — input shape.
  - `type SocketApiResult = { findings: Finding[]; available: boolean }` — output shape.
  - `class SocketAuthError extends Error` — thrown on missing token or 401/403 responses.
  - `async function fetchSocketFindings(packages: PackageRef[], options?: { fetch?: FetchFn; token?: string; baseUrl?: string; signal?: AbortSignal }): Promise<SocketApiResult>` — the entry point. Token resolves from `options.token ?? process.env.SOCKET_API_TOKEN`; baseUrl resolves from `options.baseUrl ?? process.env.SOCKET_API_BASE_URL ?? "https://api.socket.dev"`; fetch defaults to `globalThis.fetch`.
  - Internal helpers (not exported): `toPurl(ref)`, `parsePurl(str)`, `mapSocketSeverity(level)`, `buildFindings(response, manifestPathByPurl)`, `withRetry(fn)`, `chunk(array, size)`.

- `src/types/scanResult.ts` — New shared type. Defines `ScanResult { findings: ClassifiedFinding[]; socketAvailable: boolean; exitCode: number }`. Exported for `ScanCommand` and any future caller.

- `src/modules/__tests__/socketApiClient.test.ts` — New Vitest unit suite. Mocks `fetch`. Covers:
  - `"returns { findings: [], available: true } immediately without calling fetch when packages is empty"`.
  - `"throws SocketAuthError when SOCKET_API_TOKEN is missing and no token option passed"`.
  - `"throws SocketAuthError on 401/403"` (with the offending status surfaced in the error message).
  - `"happy path: one batch, one package with one alert → one Finding"` — mock returns a canonical Socket response with a `malware` alert; assertions cover all fields of the emitted `Finding` (`source: "socket"`, `findingId: "malware"`, `ecosystem: "npm"`, `severity: "CRITICAL"`, correct `package`/`version`/`manifestPath`).
  - `"happy path: multiple alerts per package → multiple Findings"` — same package, three alerts → three findings.
  - `"info-severity Socket alerts are filtered out"` — alert with Socket's `severity: "info"` does not produce a `Finding`.
  - `"severity mapping"` — each of `low`/`middle`/`high`/`critical` maps to the internal `LOW`/`MEDIUM`/`HIGH`/`CRITICAL`.
  - `"PURL ecosystem mapping"` — `pkg:pypi/...`, `pkg:golang/...`, `pkg:cargo/...`, `pkg:maven/...`, `pkg:gem/...`, `pkg:composer/...` all map correctly.
  - `"retry then success: first attempt 503, second succeeds → one Finding returned, fetch called twice"`.
  - `"retry then success: first attempt 429 with Retry-After, second succeeds → one Finding, fetch called twice, delay respects Retry-After"`.
  - `"permanent failure fail-open: three 503 attempts → returns { findings: [], available: false } without throwing"`.
  - `"network-error fail-open: fetch rejects with a TypeError → retries, then returns { findings: [], available: false }"`.
  - `"timeout fail-open: request hangs past 30s → AbortController aborts, retries, ultimately fails open"` (use `vi.useFakeTimers()` to fast-forward).
  - `"batches requests at 1000 PURLs per POST"` — given 2100 packages, fetch called 3 times with 1000+1000+100 URLs respectively.
  - `"batch failure propagates fail-open for the whole run"` — 2nd of 3 batches returns 503; overall result is `available: false` and `findings: []`.
  - `"attributes findings to the correct manifestPath when a package appears in multiple manifests"` — same (pkg, version) in two different manifests → two findings with different `manifestPath`.
  - `"unknown Socket severity string → UNKNOWN"` — defensive fallback for any out-of-band value.
  - `"malformed JSON response → fail-open"` — 200 OK but body is unparseable → treated as transient, retries, fails open.

- `src/modules/__tests__/fixtures/socket-output/one-alert.json` — canonical Socket response with one package carrying one `malware` alert. Used across multiple happy-path tests.
- `src/modules/__tests__/fixtures/socket-output/multiple-alerts.json` — one package, three alerts of varying severity/type.
- `src/modules/__tests__/fixtures/socket-output/polyglot-alerts.json` — one package per supported PURL type, each with one alert — verifies ecosystem mapping.
- `src/modules/__tests__/fixtures/socket-output/no-alerts.json` — an empty/clean Socket response.
- `src/modules/__tests__/fixtures/socket-output/info-only.json` — response with only `severity: "info"` alerts, which must all be filtered out.

- `features/scan_socket_supply_chain.feature` — EXISTS (already authored; tagged `@adw-7`). BDD scenarios for supply-chain happy path, accept, fail-open on timeout/5xx/429/401, retry-then-success, supplyChainAccepts classification variants, severity threshold, finding-line format, and polyglot batching. Each scenario uses the local mock server pattern described below; most are tagged `@regression`.

- `features/step_definitions/scan_socket_supply_chain_steps.ts` — NEW. Step definitions specific to supply-chain scenarios. Starts/stops a small HTTP mock server (Node's `http` module, bound to port 0) before/after each scenario, returning canned JSON per the scenario-provided alert-shape, and sets `SOCKET_API_BASE_URL` on the child depaudit process's env so the CLI hits the mock.

- `features/support/mockSocketServer.ts` — NEW. Shared helper exporting `startMockSocketServer(config)` returning `{ url, stop }`. Config supports: canned response body, status code, delay, number of transient failures before success, failure mode ("timeout" | "500" | "429" | "401"). Keeps the server logic out of the step file and reusable.

- `features/support/world.ts` — No change to the class itself; the mock-server start/stop is driven by Before/After hooks inside `scan_socket_supply_chain_steps.ts`, with the `url` stored on the `DepauditWorld` instance via a new optional `socketMockUrl?: string` field. Add that field.

- `fixtures/socket-no-token/` — NEW. Clean-OSV Node fixture used by the "missing SOCKET_API_TOKEN" scenario.
- `fixtures/socket-alert-happy/` — NEW. Clean-OSV Node fixture; mock server returns one `install-scripts` alert for a declared package.
- `fixtures/socket-clean/` — NEW. Clean-OSV Node fixture; mock server returns no alerts.
- `fixtures/socket-cve-and-alert/` — NEW. Pins a package with a real OSV CVE; mock server returns one `install-scripts` alert for a different declared package.
- `fixtures/socket-timeout-cve/` — NEW. Pins a package with a real OSV CVE; mock server hangs past the client timeout.
- `fixtures/socket-5xx-clean/` — NEW. Clean-OSV; mock server returns 503 for every request.
- `fixtures/socket-429-cve/` — NEW. Pins a package with a real OSV CVE; mock server returns 429 for every request.
- `fixtures/socket-auth-error-cve/` — NEW. Pins a package with a real OSV CVE; mock server returns 401 for every request (exercises the fail-loud auth path — scan aborts with exit 2 per plan).
- `fixtures/socket-retry-then-success/` — NEW. Clean-OSV; mock returns 503 once then a valid alert response.
- `fixtures/socket-alert-accepted/` — NEW. Clean-OSV; mock returns one alert; the repo's `.depaudit.yml` has a matching `supplyChainAccepts` entry.
- `fixtures/socket-alert-unrelated-accept/` — NEW. Clean-OSV; mock returns one alert; `.depaudit.yml` has a `supplyChainAccepts` entry for a different package.
- `fixtures/socket-alert-wrong-alerttype/` — NEW. Clean-OSV; mock returns `install-scripts`; `.depaudit.yml` has a `supplyChainAccepts` entry with `alertType: "typosquat"`.
- `fixtures/socket-alert-wrong-version/` — NEW. Pins package at `1.2.3`; mock returns alert at `1.2.3`; `.depaudit.yml` has `supplyChainAccepts` for that package at `0.9.0`.
- `fixtures/socket-alert-below-threshold/` — NEW. Clean-OSV; mock returns a MEDIUM-severity alert; `.depaudit.yml` sets `policy.severityThreshold: high`.
- `fixtures/socket-alert-at-threshold/` — NEW. Clean-OSV; mock returns a HIGH-severity alert; `.depaudit.yml` sets `policy.severityThreshold: high`.
- `fixtures/socket-alert-format/` — NEW. Clean-OSV; mock returns exactly one alert on one package — used by the finding-line format assertion scenario.
- `fixtures/socket-polyglot-alerts/` — NEW. Contains both `package.json` (npm) and `requirements.txt` (pip); mock returns an `install-scripts` alert for the npm package and a `typosquat` alert for the pip package.

## Implementation Plan

### Phase 1: Foundation — new types + new module skeleton

Introduce the `ScanResult` type and scaffold the `SocketApiClient` module with its public interface (`PackageRef`, `FetchFn`, `SocketApiResult`, `SocketAuthError`, `fetchSocketFindings` signature) and empty/stub bodies. Wire the module into `ScanCommand` behind a feature-off default — the OSV pipeline must continue to work identically while the Socket branch is being built up. This lets each subsequent step land incrementally without breaking the existing `@adw-3` through `@adw-6` BDD suites.

### Phase 2: Core Implementation — HTTP client behaviour

Flesh out `fetchSocketFindings`: PURL conversion, batching, per-request timeout via `AbortController`, retry loop with exponential backoff (500ms → 1s → 2s, jitter) honouring `Retry-After` on 429, error classification (transient vs. auth vs. permanent), response parsing, severity mapping, info-filter, normalisation into `Finding[]`. Write the full unit-test suite against a mocked `fetch` — this is the proof surface `.adw/review_proof.md` Rule 5 demands.

### Phase 3: Integration — `ScanCommand` wiring, stdout format, BDD coverage

Wire `SocketApiClient` into `ScanCommand` for real: extract the package set from OSV's parsed output, call Socket, merge findings, pass the combined list to `FindingMatcher`, surface `socketAvailable` via the new `ScanResult` shape, emit the stderr fail-open annotation when Socket was unavailable, keep the exit code contract. Extend `stdoutReporter` to append the `<source>` tag. Widen the BDD finding-line regex. Add the mock-server-backed `@adw-7` BDD file and its step definitions. Run the entire validation suite end-to-end and confirm the prior `@adw-3`–`@adw-6` `@regression` scenarios continue to pass unchanged.

## Step by Step Tasks
Execute every step in order, top to bottom.

### 1. Add the `ScanResult` shared type

- Create `src/types/scanResult.ts`. Content:
  ```ts
  import type { ClassifiedFinding } from "./depauditConfig.js";

  export interface ScanResult {
    findings: ClassifiedFinding[];
    socketAvailable: boolean;
    exitCode: number;
  }
  ```
- Export is plain — no enum, no constant.

### 2. Scaffold `SocketApiClient` module with its public interface

- Create `src/modules/socketApiClient.ts`. Start with just the exports and empty bodies so type-check compiles while Phase 2 fills it in:
  ```ts
  import type { Ecosystem, Finding, Severity } from "../types/finding.js";

  export type FetchFn = typeof globalThis.fetch;

  export interface PackageRef {
    ecosystem: Ecosystem;
    package: string;
    version: string;
    manifestPath: string;
  }

  export interface SocketApiResult {
    findings: Finding[];
    available: boolean;
  }

  export interface SocketApiOptions {
    fetch?: FetchFn;
    token?: string;
    baseUrl?: string;
    signal?: AbortSignal;
  }

  export class SocketAuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SocketAuthError";
    }
  }

  export async function fetchSocketFindings(
    packages: PackageRef[],
    options: SocketApiOptions = {}
  ): Promise<SocketApiResult> {
    // Phase 2 fills this in.
    return { findings: [], available: true };
  }
  ```
- Run `bun run typecheck` — expect zero errors.

### 3. Wire `SocketApiClient` into `ScanCommand` against the stub

- Edit `src/commands/scanCommand.ts`. After the existing `const findings = await runOsvScanner(manifests);` line:
  - Build a `PackageRef[]` by iterating `findings` and collecting `{ ecosystem, package, version, manifestPath }` into a `Map<string, PackageRef>` keyed on `${ecosystem}|${package}|${version}|${manifestPath}` (to deduplicate when OSV reports multiple vulns per package).
  - Call `const socketResult = await fetchSocketFindings([...packageRefMap.values()]);`.
  - If `!socketResult.available`, write `process.stderr.write("socket: supply-chain unavailable — scan continuing on CVE findings only\n");`.
  - Merge: `const allFindings = [...findings, ...socketResult.findings];`.
  - Pass `allFindings` to `classifyFindings`.
- Catch `SocketAuthError` at the top of the command and return exit 2 after writing the error to stderr, mirroring the existing `ConfigParseError` handler pattern (`scanCommand.ts:13-21`).
- Extend `runScanCommand`'s return type to `Promise<ScanResult>` and return `{ findings: classified, socketAvailable: socketResult.available, exitCode }` instead of a bare number. Update `src/cli.ts` to `const result = await runScanCommand(...); process.exit(result.exitCode);`.
- At this point the Socket step is a no-op (`available: true, findings: []`); the entire scan pipeline passes through unchanged. Run `bun run typecheck` and `bun test` — expect zero errors, all existing unit tests green, all BDD (once rebuilt) pass.

### 4. Implement `SocketApiClient` internals

- In `src/modules/socketApiClient.ts`, add internal helpers (non-exported):

  **PURL conversion**:
  ```ts
  const ECOSYSTEM_TO_PURL_TYPE: Record<Ecosystem, string> = {
    npm: "npm",
    pip: "pypi",
    gomod: "golang",
    cargo: "cargo",
    maven: "maven",
    gem: "gem",
    composer: "composer",
  };
  function toPurl(ref: PackageRef): string {
    return `pkg:${ECOSYSTEM_TO_PURL_TYPE[ref.ecosystem]}/${encodeURIComponent(ref.package)}@${encodeURIComponent(ref.version)}`;
  }
  ```

  **Severity mapping** (Socket uses lowercase strings per its API docs; map defensively):
  ```ts
  function mapSocketSeverity(level: string): Severity {
    switch (level.toLowerCase()) {
      case "low": return "LOW";
      case "middle": case "medium": return "MEDIUM";
      case "high": return "HIGH";
      case "critical": return "CRITICAL";
      default: return "UNKNOWN";
    }
  }
  ```

  **Batching** (1000 PURLs per POST):
  ```ts
  function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
  const BATCH_SIZE = 1000;
  ```

  **Retry with backoff** (honour `Retry-After` on 429; fail-open after 3 attempts):
  ```ts
  const RETRY_ATTEMPTS = 3;
  const BACKOFF_BASE_MS = 500;
  const PER_REQUEST_TIMEOUT_MS = 30_000;
  async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
  // Inside retry loop: on 429 read `Retry-After` header (seconds); prefer it over exponential backoff if > 0.
  ```

- Main `fetchSocketFindings` loop:
  1. Resolve `token = options.token ?? process.env.SOCKET_API_TOKEN`. If undefined or empty string, throw `new SocketAuthError("SOCKET_API_TOKEN not set — cannot call Socket API")`.
  2. Resolve `baseUrl = options.baseUrl ?? process.env.SOCKET_API_BASE_URL ?? "https://api.socket.dev"`.
  3. Resolve `fetchFn = options.fetch ?? globalThis.fetch`.
  4. If `packages.length === 0`, return `{ findings: [], available: true }` immediately.
  5. For each batch of 1000 PURLs:
     - Build a `Map<purl, PackageRef[]>` so the post-response step can attribute findings to every `manifestPath` that contributed that PURL.
     - For each retry attempt (up to 3):
       - `const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);`
       - POST to `${baseUrl}/v0/purl?alerts=true` with `Authorization: Bearer ${token}`, JSON body `{ components: batch.map(purl => ({ purl })) }`. Pass `signal: controller.signal`.
       - `clearTimeout(timer)` in a `finally`.
       - On network error (TypeError or AbortError): classify as transient, continue to next retry after backoff.
       - On 401/403: throw `new SocketAuthError("Socket API rejected credentials (status: ${status})")`.
       - On 429: classify as transient; read `Retry-After` header (seconds); sleep for that long if ≥ 0; otherwise use exponential backoff.
       - On 5xx: classify as transient; exponential backoff.
       - On 2xx: parse JSON body; if parse fails, classify as transient and retry; on success, break out of retry loop and move on to the next batch.
     - If after all retries the batch still failed transiently: short-circuit and return `{ findings: [], available: false }` for the whole run (do not partially populate).
  6. Accumulate per-batch `Finding[]` into a single list:
     - For each component in the response, for each alert, if `alert.severity.toLowerCase() === "info"` skip. Otherwise, parse the PURL back to `(ecosystem, package, version)`, look up all `PackageRef`s that contributed that PURL (to get every `manifestPath`), and emit one `Finding` per `(alert, manifestPath)` pair with `source: "socket"`, `findingId: alert.type`, `summary: alert.props?.title ?? alert.type`, `severity: mapSocketSeverity(alert.severity)`.
  7. Return `{ findings, available: true }`.

- Run `bun run typecheck` — expect zero errors.

### 5. Stdout reporter — no change

- The existing `src/modules/stdoutReporter.ts` 4-field format (`<package> <version> <findingId> <severity>`) is kept verbatim. No code change here.
- Rationale: the `@adw-7` scenarios distinguish Socket findings from OSV findings by asserting on the `findingId` token (Socket alert types like `install-scripts`/`typosquat`/`malware` are lexically non-overlapping with OSV CVE IDs like `GHSA-…`/`CVE-…`), so no source-tag column is required. Keeping the existing format avoids churning the `@adw-3`/`@adw-4` regression scenarios and the `FINDING_LINE_RE` regex at `features/step_definitions/scan_steps.ts:11`.
- Run `bun run build` and `bun run test:e2e -- --tags "@regression"` — expect zero regressions (this step is confirmation, not edit).

### 6. Write `SocketApiClient` unit tests

- Create `src/modules/__tests__/fixtures/socket-output/one-alert.json`, `multiple-alerts.json`, `polyglot-alerts.json`, `no-alerts.json`, `info-only.json`. Each file is a literal Socket API response payload shaped like `[{ purl: "pkg:npm/foo@1.0.0", alerts: [{ type: "malware", severity: "critical", props: { title: "..." } }] }]` — one component per entry.
- Create `src/modules/__tests__/socketApiClient.test.ts`. Use `vi.fn<FetchFn>()` for the mocked fetch. Each test constructs a `Response` via `new Response(body, { status, headers })` and resolves the mock with it. Cover every branch enumerated in the "New Files" section above.
- Use `vi.useFakeTimers()` for timeout-path tests to avoid real 30s waits.
- Assert for every test: the returned `{ findings, available }` matches expectations, the mock was called the correct number of times (for retry-count verification), and the Authorization header was `Bearer <token>` (stub token passed via options).
- Run `bun test` — expect all tests pass, existing suite still green.

### 7. Add supply-chain BDD fixtures

Create one fixture directory per `@adw-7` scenario in `features/scan_socket_supply_chain.feature`. Each fixture is a minimal Node or polyglot repo; most are "clean-OSV" (no known CVEs) unless the scenario specifies otherwise. The mock server — not the fixture — supplies Socket alert responses. Scenarios that involve `.depaudit.yml` (supplyChainAccepts variants, severity threshold) write the YAML at scenario time via the existing `depaudit_yml_steps.ts` pattern; the fixture itself is just the manifest(s).

Fixtures to create (all under `fixtures/`):

- `socket-no-token/` — clean-OSV Node repo (pin `left-pad@1.3.0` or similar CVE-free package).
- `socket-alert-happy/` — clean-OSV Node repo.
- `socket-clean/` — clean-OSV Node repo.
- `socket-cve-and-alert/` — Node repo pinning a package with a real known OSV CVE (reuse the `lodash@4.17.20` pattern from `fixtures/vulnerable-npm`).
- `socket-timeout-cve/` — same: Node repo with a real known OSV CVE.
- `socket-5xx-clean/` — clean-OSV Node repo.
- `socket-429-cve/` — Node repo with a real known OSV CVE.
- `socket-auth-error-cve/` — Node repo with a real known OSV CVE (the 401 scenario asserts fail-loud exit 2 with no stdout findings per plan — see Step 11 note on scenario alignment).
- `socket-retry-then-success/` — clean-OSV Node repo.
- `socket-alert-accepted/`, `socket-alert-unrelated-accept/`, `socket-alert-wrong-alerttype/`, `socket-alert-wrong-version/` — clean-OSV Node repos; `.depaudit.yml` written at scenario time.
- `socket-alert-below-threshold/`, `socket-alert-at-threshold/` — clean-OSV Node repos; `.depaudit.yml` (with `policy.severityThreshold`) written at scenario time.
- `socket-alert-format/` — clean-OSV Node repo pinning exactly one package for the single-finding-line assertion.
- `socket-polyglot-alerts/` — polyglot fixture containing both `package.json` (npm) and `requirements.txt` (pip); both manifests pin CVE-free packages.

Each Node fixture includes the matching `package-lock.json` for OSV-Scanner resolution (same shape as `fixtures/vulnerable-npm/package-lock.json`). Python fixtures need only `requirements.txt` (per the `@adw-6` polyglot pattern).

### 8. Add mock Socket server helper

- Create `features/support/mockSocketServer.ts`:
  ```ts
  import { createServer, type Server } from "node:http";
  import type { AddressInfo } from "node:net";

  export interface MockConfig {
    body?: unknown;
    status?: number;
    delay?: number;
    failuresBeforeSuccess?: number; // e.g., 2 → first 2 requests return transient, third succeeds
    transientKind?: "500" | "429" | "timeout"; // what a transient failure looks like
  }

  export async function startMockSocketServer(config: MockConfig): Promise<{ url: string; stop: () => Promise<void>; hitCount: () => number }> {
    let hits = 0;
    const server: Server = createServer((req, res) => {
      hits++;
      // dispatch based on hit count + config.failuresBeforeSuccess + config.transientKind
      // … respond accordingly or hang for "timeout"
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}`,
      stop: () => new Promise<void>((r) => server.close(() => r())),
      hitCount: () => hits,
    };
  }
  ```
- Purpose: every BDD scenario starts a scoped mock, sets `SOCKET_API_BASE_URL` on the spawned depaudit process, and stops the mock on teardown. `hitCount` is an assertable for retry-verification scenarios.

### 9. Add `features/support/world.ts` field for the mock URL

- Add to `DepauditWorld`: `socketMockUrl?: string;` and `socketMock?: { stop: () => Promise<void>; hitCount: () => number };`. No breaking change to existing scenarios — both fields are optional.

### 10. `features/scan_socket_supply_chain.feature` — already authored

The scenario file `features/scan_socket_supply_chain.feature` (tagged `@adw-7`) already exists in the worktree and covers the full acceptance surface: missing-token fail-loud, Socket happy path, clean-scan exit 0, CVE+Socket merge, timeout/5xx/429 fail-open, 401 auth-error fail-loud, retry-then-success, supplyChainAccepts classification (match / different package / different alertType / different version), severity-threshold filtering (below/at), finding-line format (`<package> <version> <finding-id> <severity>`), and polyglot batching across npm + pip.

Build-agent responsibilities for this step:

- Do NOT overwrite or replace `features/scan_socket_supply_chain.feature`. Its scenarios are the test contract.
- Implement the step definitions and mock server (Steps 8, 9, 11) so that every `@adw-7` scenario passes exactly as written.
- For the 401 auth-error scenario: the plan's design is fail-loud (exit 2, SocketAuthError, stderr names the auth failure). The scenario file was aligned in this same pass to match that design — treat exit 2 + an auth-error stderr string as the correct assertion, not fail-open + "supply-chain unavailable".

### 11. Add `features/step_definitions/scan_socket_supply_chain_steps.ts`

- Import `DepauditWorld`, `PROJECT_ROOT`, `CLI_PATH` from `world.ts`; `startMockSocketServer` from `../support/mockSocketServer.ts`; `Given`, `When`, `Then`, `Before`, `After` from `@cucumber/cucumber`.
- Implement steps for every new `Given`/`Then` in `features/scan_socket_supply_chain.feature`. Key steps (exact phrasing matched to the feature file):
  - `Given a mock Socket API that responds with an "{alertType}" alert for a package declared in that manifest` → start mock with a response body carrying one alert of the given type scoped to a package in the fixture's manifest.
  - `Given a mock Socket API that responds with no alerts for every package` → empty-alerts response.
  - `Given a mock Socket API that responds with an "{alertType}" alert for a different package declared in that manifest` → targets a second package in the manifest.
  - `Given a mock Socket API that never responds within the client timeout` → start mock configured to hang past the client's 30 s `AbortController` deadline.
  - `Given a mock Socket API that returns HTTP 503 for every request` → `transientKind: "500", failuresBeforeSuccess: 99`.
  - `Given a mock Socket API that returns HTTP 429 for every request` → `transientKind: "429", failuresBeforeSuccess: 99`.
  - `Given a mock Socket API that returns HTTP 401 for every request` → mock returns 401 for every request; the client throws `SocketAuthError` → exit 2 (fail-loud).
  - `Given a mock Socket API that returns HTTP 503 once and then responds with an "{alertType}" alert for a package in that manifest` → partial transient, success on retry.
  - `Given a mock Socket API that responds with an "{alertType}" alert at severity "{severity}" for a package in that manifest` → alert with explicit severity for threshold scenarios.
  - `Given SOCKET_API_TOKEN is set to a valid test value` → sets env var on the world's child-process environment.
  - `Given the SOCKET_API_TOKEN environment variable is unset` → ensures the env var is cleared for the run.
  - `Given the repository's .depaudit.yml has a valid \`supplyChainAccepts\` entry matching that (package, version, alertType) tuple` → writes `.depaudit.yml` under the fixture at scenario start (same pattern as `depaudit_yml_steps.ts`); post-scenario hook cleans it up.
  - `Given the repository's .depaudit.yml sets \`policy.severityThreshold\` to "{level}"` → writes the threshold field.
  - `Then stdout contains at least one finding line whose finding-ID is the supply-chain alert type "{alertType}"` → splits each stdout line against the existing 4-field `FINDING_LINE_RE` and asserts the 3rd token equals the given alert type.
  - `Then stdout contains at least one finding line whose finding-ID is an OSV CVE identifier` → asserts the 3rd token matches `/^(GHSA-|CVE-)/`.
  - `Then stderr mentions "supply-chain unavailable"` → substring match on stderr.
  - `Then stderr does not mention "supply-chain unavailable"` → absence substring check.
  - `Then stdout contains exactly one finding line` → count of matched `FINDING_LINE_RE` lines equals 1.
  - `Then the finding line matches the pattern "<package> <version> <finding-id> <severity>"` → the one matched line has exactly 4 whitespace-separated tokens.
- Modify the shared `runDepaudit` invocation to forward `this.socketMockUrl` and `this.socketToken` via env: add `env: { ...process.env, SOCKET_API_BASE_URL: this.socketMockUrl, SOCKET_API_TOKEN: this.socketToken }` to the `execFileAsync` options. Since `scan_steps.ts:101` currently passes `{ cwd: world.cwd }` only, extract a shared helper in `features/support/world.ts` (or add an env-forwarding variant step `When I run the supply-chain scan …` in this file only). Either approach must keep the `@adw-3`/`@adw-4`/`@adw-5`/`@adw-6` scenarios working unchanged.
- `Before({ tags: "@adw-7" })` hook: initialise `this.socketToken = undefined` and `this.socketMockUrl = undefined` so the "missing token" scenario starts clean.
- `After({ tags: "@adw-7" })` hook: `if (this.socketMock) await this.socketMock.stop()` to release the port.

### 12. Update `.env.sample` and README references (if needed)

- `.env.sample` already documents `SOCKET_API_TOKEN`. Add a commented line for `SOCKET_API_BASE_URL` (optional, defaults to `https://api.socket.dev`; used by tests) just for discoverability:
  ```
  # Override Socket.dev base URL (default: https://api.socket.dev) — used by tests against a mock server
  # SOCKET_API_BASE_URL=
  ```
- No README change — the README already lists `SOCKET_API_TOKEN`.

### 13. Run the full validation suite

- `bun install` — no new dependencies expected.
- `bun run typecheck` — zero errors.
- `bun run lint` — zero warnings.
- `bun test` — all unit tests pass (the new `socketApiClient.test.ts` suite plus every pre-existing suite).
- `bun run build` — `dist/cli.js` rebuilt, `chmod +x` applied by postbuild.
- `bun run test:e2e -- --tags "@adw-7"` — every new supply-chain scenario passes against the mock server.
- `bun run test:e2e -- --tags "@regression"` — every prior `@regression` scenario across `@adw-3`, `@adw-4`, `@adw-5`, `@adw-6` continues to pass. The stdout-reporter source-tag extension is the only pre-existing-behaviour change; the widened regex in step definitions accepts both old and new formats.

## Testing Strategy

### Unit Tests

`.adw/project.md` lacks the `## Unit Tests: enabled` marker, but this plan includes unit-test tasks as a documented override. Justifications, listed in priority order:

1. `.adw/review_proof.md` **Rule 5** is explicit: "For changes to `OsvScannerAdapter` or `SocketApiClient`: confirm mock boundary tests cover the new behavior." Skipping the unit-test suite for `SocketApiClient` would fail the review bar deterministically.
2. `.adw/project.md` line 37 names `SocketApiClient` in the "HTTP boundary" module list and explicitly says "mock with MSW-style interceptors in tests" — the repo's own testing strategy calls for this suite by name.
3. The PRD testing-decisions section (`specs/prd/depaudit.md:243-247`) lists `SocketApiClient — mocked HTTP (MSW-style), asserting retries, fail-open, normalization` as a Tier-1 module under test.
4. The existing precedent of issues #3, #4, #5, #6 all including unit-test tasks in their plans despite the same missing marker.

The suite covers every retry-path, fail-open branch, auth branch, severity-mapping branch, ecosystem-mapping branch, batching branch, and the `manifestPath`-fan-out branch. Every branch's happy and error arms. Every response-parsing edge case. Tests use a mocked `fetch` (constructed via `vi.fn<FetchFn>()`) and never hit the real network. `vi.useFakeTimers()` is used for timeout-path tests.

Beyond `socketApiClient.test.ts`, no other unit test file is added or modified: `findingMatcher.test.ts` and every other suite already covers the branches they own.

### Edge Cases

- **Empty package set.** `fetchSocketFindings([])` short-circuits before any HTTP call; returns `{ findings: [], available: true }`. Covered by a dedicated unit test and a BDD scenario using `fixtures/no-manifests`.
- **Token present but empty string.** Treated as missing — throws `SocketAuthError`. A `SOCKET_API_TOKEN=""` in `.env` is a config bug, not a valid credential.
- **Non-ASCII package name or version.** The PURL spec mandates URL-encoding; `toPurl` uses `encodeURIComponent`. Verified via a unit-test fixture with a package named `@scope/pkg` (the `@` and `/` must survive encoding into the PURL).
- **Package appears in two manifests (monorepo).** The `PackageRef` set passed to Socket has a single entry per `(ecosystem, package, version, manifestPath)` — so two manifests carrying the same dep produce two `PackageRef`s, one PURL (same string twice in the request body is fine — Socket dedupes server-side), and two `Finding`s on match (one per manifestPath) so the stdout report attributes correctly.
- **Socket alert severity out of range.** Any unrecognised string (`"critical+"`, `"info"`, `"unknown"`) is handled defensively: `info` is filtered entirely; anything else maps to `UNKNOWN` and still emits a `Finding` (so the user sees it — but it'll drop from the "new" bucket unless they explicitly raise the threshold). Unit-tested.
- **`Retry-After` header malformed.** Non-integer or negative values fall back to exponential backoff. Unit-tested.
- **HTTP body returns 200 with no components.** `findings: []`, `available: true`. Unit-tested via `no-alerts.json` fixture.
- **HTTP body returns 200 with only `severity: "info"` alerts.** Every alert filtered; `findings: []`, `available: true`. Unit-tested via `info-only.json` fixture.
- **AbortSignal from the caller.** Not a current requirement, but the `options.signal` parameter is plumbed so a future `ScanCommand` cancel path can work; covered by a "caller-provided signal aborts the request" unit test.
- **First batch succeeds, second fails all retries.** Whole run returns `{ findings: [], available: false }` — no partial success. Unit-tested.
- **Socket returns 404.** Treated as a permanent failure → fail-open (return `{ findings: [], available: false }`). 404 is unusual for a POST; it means the endpoint moved or the API key's account lost access to this endpoint. Fail-open is the safer behaviour for a free-tier service.
- **Fetch default timeout behaviour vs. our 30s.** We always wrap every fetch in our own `AbortController` — we don't rely on the platform default.
- **Concurrent scans sharing `SOCKET_API_TOKEN`.** No shared state; every `fetchSocketFindings` call reads its token fresh from options/env. Safe to run multiple scans in parallel (same token, multiple repos) — each hits Socket independently.
- **Clock skew on `Retry-After`.** We sleep locally for the given seconds; server-side clock skew is irrelevant.

## Acceptance Criteria

The feature is complete when every box below is verifiable by running the Validation Commands:

- [ ] `SocketApiClient` exists as `src/modules/socketApiClient.ts` exporting `fetchSocketFindings`, `PackageRef`, `SocketApiResult`, `SocketAuthError`, and `FetchFn`.
- [ ] `fetchSocketFindings` reads the token from `options.token ?? process.env.SOCKET_API_TOKEN` and throws `SocketAuthError` when neither is set.
- [ ] Packages are batched at 1,000 PURLs per POST (verified by unit test with >1,000 input packages).
- [ ] Transient failures (timeout, 5xx, 429) are retried up to 3 times with exponential backoff; 429 honours `Retry-After`.
- [ ] Permanent transient failures (all retries exhausted) return `{ findings: [], available: false }` — fail-open, no throw.
- [ ] Auth failures (401 / 403) throw `SocketAuthError` — fail-loud, distinct from transient.
- [ ] Supply-chain findings are normalised into `Finding` with `source: "socket"`, `findingId: alert.type`, `(package, version)` from the PURL, `manifestPath` from the contributing `PackageRef`, and `severity` mapped from Socket's `low/middle/high/critical` onto the internal `Severity` union.
- [ ] `info`-severity Socket alerts are filtered out before emission.
- [ ] `ScanCommand` merges Socket findings with OSV findings and passes the combined list to `classifyFindings` — the pipeline exit code reflects both sources.
- [ ] `ScanCommand` returns a `ScanResult { findings, socketAvailable, exitCode }` object; `src/cli.ts` reads `exitCode` from the new shape.
- [ ] On `socketAvailable === false`, stderr gets a `socket: supply-chain unavailable — scan continuing on CVE findings only` line.
- [ ] `stdoutReporter` format is unchanged — 4 fields (`<package> <version> <findingId> <severity>`). Socket findings are distinguishable from OSV findings via the `findingId` token (Socket alert types vs. `CVE-*`/`GHSA-*` IDs).
- [ ] `FindingMatcher` is unchanged in code; Socket findings flow through its existing `source === "socket"` branch and are correctly suppressed by matching `supplyChainAccepts` entries.
- [ ] Unit tests in `src/modules/__tests__/socketApiClient.test.ts` cover: happy path, multi-alert, info-filter, severity mapping, PURL ecosystem mapping, retry-then-success, retry-then-success-on-429 with Retry-After, permanent-failure-fail-open, network-error-fail-open, timeout-fail-open, batching ≥1000, batch-failure-fail-open-whole-run, manifestPath fan-out, unknown-severity, malformed-JSON-fail-open, missing-token, 401, 403.
- [ ] BDD scenarios in `features/scan_socket_supply_chain.feature` tagged `@adw-7` cover: missing-token fail-loud, happy path, clean-scan exit 0, CVE+Socket merge, timeout/5xx/429 fail-open, 401 auth-error fail-loud, retry-then-success, supplyChainAccepts classification variants, severity-threshold filtering, finding-line format, and polyglot batching.
- [ ] Every pre-existing BDD scenario tagged `@regression` (`@adw-3`, `@adw-4`, `@adw-5`, `@adw-6`) continues to pass unchanged.
- [ ] `bun run typecheck`, `bun run lint`, `bun test`, `bun run build` all succeed with zero errors.

## Validation Commands
Execute every command to validate the feature works correctly with zero regressions.

Per `.adw/commands.md`:

- `bun install` — confirm no new dependencies were added (global `fetch` and `AbortController` are built-in).
- `bun run typecheck` — confirm zero TypeScript errors: the new `ScanResult` type compiles; `fetchSocketFindings`'s signature type-checks against all callers; `stdoutReporter` is unchanged.
- `bun run lint` — confirm zero lint issues.
- `bun test` — run the Vitest unit suite. Every existing test must continue to pass; new `socketApiClient.test.ts` cases must all pass.
- `bun run build` — compile to `dist/` and confirm `dist/cli.js` is executable.
- `bun run test:e2e -- --tags "@adw-7"` — run only the new supply-chain scenarios. Expect all scenarios to pass against the in-process mock server, including the fail-open scenario with exactly 3 retries visible in the mock's hit counter.
- `bun run test:e2e -- --tags "@regression"` — run the full regression suite across all prior slices. Expect zero regressions.
- Manual smoke test (requires a real `SOCKET_API_TOKEN` in `.env`):
  - `export SOCKET_API_TOKEN=<real-token>; node dist/cli.js scan fixtures/vulnerable-npm/` — expect non-zero exit, OSV finding lines (identified by `CVE-*`/`GHSA-*` finding-IDs) plus any real Socket alerts that apply to the pinned `lodash@4.17.20` (identified by Socket alert-type finding-IDs).
  - `unset SOCKET_API_TOKEN; node dist/cli.js scan fixtures/vulnerable-npm/` — expect exit 2, stderr message mentioning `SOCKET_API_TOKEN`.
  - `export SOCKET_API_TOKEN=<real-token>; SOCKET_API_BASE_URL=http://127.0.0.1:1 node dist/cli.js scan fixtures/vulnerable-npm/` — expect exit matching the OSV finding state (non-zero if any), plus stderr `socket: supply-chain unavailable` (port 1 is unreachable → connection refused → fail-open after retries).

## Notes

- **Unit tests override**: `.adw/project.md` lacks `## Unit Tests: enabled`. This plan includes unit-test tasks because `.adw/review_proof.md` Rule 5 and PRD Testing Decisions both mandate mock-boundary tests for `SocketApiClient`. Same precedent applied by issues #3, #4, #5, #6 plans.
- **No new libraries required.** `fetch` and `AbortController` are built-in in Node 20+/Bun. Per `.adw/commands.md`, library additions would use `bun add <name>` — none needed for this slice.
- **Endpoint choice** (`POST /v0/purl?alerts=true`) is the public Socket.dev API v0 endpoint for batch package-alert lookup. It accepts a JSON body of `{ components: [{ purl }] }` and returns per-component `alerts`. If Socket.dev's API changes shape, only the `buildFindings` and response-parsing code in `socketApiClient.ts` need adjustment — the pipeline above it is `Finding`-typed and shape-stable.
- **Retry policy** (3 attempts, 500ms → 1s → 2s with ±25% jitter, honouring `Retry-After`) is chosen for short-scan latency over thoroughness. A 90-second wall-clock ceiling across all batches + retries keeps the scan well inside typical CI 10-minute budgets even on pathological outages, and the fail-open arm guarantees we never exceed the ceiling.
- **The `SOCKET_API_BASE_URL` env override** is the seam for BDD against a local mock. It's also useful in prod for air-gapped enterprise Socket mirrors (outside MVP scope per PRD "Out of Scope", but the seam costs nothing to leave in).
- **Fail-loud vs. fail-open for auth errors** is a deliberate design choice. A silently-misconfigured CI token would mask supply-chain gaps indefinitely; surfacing it loudly on the first PR after deployment forces the maintainer to fix the config, after which every subsequent run is healthy. Transient failures (network, 5xx, 429) are the opposite — rare and unactionable by the user, so fail-open is the only sane default.
- **`commonAndFine` is already polyglot-ready** via the existing `FindingMatcher` rule 3 (`findingMatcher.ts:73-82`) which matches `(package, alertType)` regardless of source. The moment Socket starts emitting findings, any user who had pre-listed `install_scripts` for `esbuild` in `commonAndFine` (per PRD user story 17) gets the expected suppression with zero code change.
- **Socket free tier** has limits on the number of requests/month (per Socket.dev docs). The 1,000-PURL batching minimises call count; a repo with 5,000 packages makes 5 requests per scan. The PRD notes the "free tier" constraint (`specs/prd/depaudit.md:76`) and this slice respects it by design.
- **Stdout format is intentionally left unchanged** at 4 fields (`<package> <version> <findingId> <severity>`). An earlier draft of this plan proposed a 5th `<source>` token, but the `@adw-7` scenarios rely on the `findingId` token to distinguish OSV (`CVE-*`/`GHSA-*`) from Socket (`install-scripts`, `typosquat`, `malware`, …) findings, which works cleanly without widening the format. A future machine-readable output (JSON / SARIF) is the right home for programmatic source-attribution; stdout stays a human-readable log.
- **Pre-existing limitation retained**: `ManifestDiscoverer` only reads the root `.gitignore`. Nested `.gitignore` files are not respected (called out in issue #6's plan). Unchanged by this slice.
- **`guidelines/` directory** does not exist in this repo; no guideline-specific refactoring obligations apply.
