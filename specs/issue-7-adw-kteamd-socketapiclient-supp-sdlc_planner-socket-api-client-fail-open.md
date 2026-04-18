# Feature: SocketApiClient + supply-chain findings + fail-open

## Metadata
issueNumber: `7`
adwId: `kteamd-socketapiclient-supp`
issueJson: `{"number":7,"title":"SocketApiClient + supply-chain findings + fail-open","body":"## Parent PRD\n\n`specs/prd/depaudit.md`\n\n## What to build\n\nAdds `SocketApiClient` — HTTP client for Socket.dev's REST API with bearer auth via `SOCKET_API_TOKEN`, retries with exponential backoff, and fail-open on timeout / 5xx / rate-limit. Supply-chain `Finding` objects are normalized to the same internal `Finding` shape as CVEs and merged into the scan result. `FindingMatcher` now matches against `supplyChainAccepts` entries in `.depaudit.yml`.\n\nFail-open: when Socket is unavailable, scan still completes with CVE findings only; result annotated so PR comment (future slice) can note \"supply-chain unavailable\".\n\n## Acceptance criteria\n\n- [ ] `SocketApiClient` reads token from `SOCKET_API_TOKEN` env var; errors if missing.\n- [ ] Packages batched; retries with backoff on transient errors.\n- [ ] Timeout / 5xx / rate-limit → fail-open; scan continues with OSV-only; result carries a `socketAvailable: false` flag.\n- [ ] Supply-chain findings normalized into `Finding` with stable `(package, version, alertType)` identity.\n- [ ] `FindingMatcher` honors `supplyChainAccepts` entries; accepted supply-chain findings drop from \"new\" bucket.\n- [ ] Unit tests: mocked HTTP (MSW-style) covering happy path, retry-then-success, permanent-failure-fail-open, auth error.\n\n## Blocked by\n\n- Blocked by #6\n\n## User stories addressed\n\n- User story 3\n- User story 17\n- User story 18\n","state":"OPEN","author":"paysdoc","labels":[],"createdAt":"2026-04-17T13:24:39Z","comments":[],"actionableComment":null}`

## Feature Description

Wires the second finding source — Socket.dev — into the `depaudit scan` pipeline. Adds a new deep module `SocketApiClient` that batches every package discovered during the scan into a Socket.dev REST API request, normalizes each returned alert into the existing internal `Finding` shape (with `source: "socket"` and `findingId: <socket alert type>`), and merges those findings into the same list that `FindingMatcher` already classifies. The pre-existing `supplyChainAccepts` and `commonAndFine` branches of `FindingMatcher` (landed in issue #5) begin classifying real supply-chain findings instead of only synthetic unit-test ones.

The client honors the PRD's fail-open semantics in full: any transient failure (timeout, connection reset, HTTP 5xx, HTTP 429 rate-limit) triggers exponential-backoff retries; on retry exhaustion — or any terminal failure such as a missing `SOCKET_API_TOKEN`, HTTP 401/403 auth rejection, or hostname lookup failure — the scan continues with CVE findings from OSV-Scanner only. The merged result carries a `socketAvailable: boolean` flag so the (future) PR-comment reporter can emit a "supply-chain unavailable" annotation, and `ScanCommand` writes a single stderr line to the same effect so the CLI user sees the degraded state today.

The client uses the native `fetch` built into Bun and Node 22+ (no new dependency). A `FetchFn` injection point mirrors the `ExecFileFn` pattern already established in `OsvScannerAdapter`, giving unit tests an MSW-style boundary mock without a real server. Batching uses Socket's batch endpoint `POST /v0/purl` (Socket's documented component-list endpoint): every `(ecosystem, name, version)` tuple OSV-Scanner enumerated is rendered as a [purl](https://github.com/package-url/purl-spec) and sent in configurable-size batches (default 100 per request) so large monorepos stay under Socket's per-request payload cap without a round-trip per package.

A deliberately-narrow BDD slice (tagged `@adw-7`) exercises the fail-open path end-to-end: a fixture repo with `SOCKET_API_TOKEN` unset produces OSV findings, exits the same way as before, and surfaces the "supply-chain unavailable" annotation on stderr. All other Socket code paths (happy path, retry-then-success, permanent-failure, auth error, batching boundary) are covered by unit tests so CI does not depend on a live Socket.dev account or account-rate-limit state.

## User Story

As a maintainer (PRD user stories 3, 17, 18)
I want `depaudit scan` to surface Socket.dev supply-chain signals (maintainer churn, install scripts, typosquatting, deprecation) alongside OSV-Scanner CVE findings, honor any `supplyChainAccepts` entries I've written in `.depaudit.yml`, and degrade gracefully to CVE-only gating when Socket is unreachable
So that I catch supply-chain threats that don't yet carry a CVSS score, I can accept known-and-fine install scripts once with a bounded expiry, and a Socket.dev outage never blocks a contributor's PR.

## Problem Statement

The pipeline currently ends at OSV. Four concrete gaps:

1. **No Socket.dev client exists.** `src/modules/` contains `configLoader`, `findingMatcher`, `linter`, `lintReporter`, `manifestDiscoverer`, `osvScannerAdapter`, `stdoutReporter` — no `socketApiClient`. The PRD names `SocketApiClient` as a deep module (`specs/prd/depaudit.md` lines 200 and `UBIQUITOUS_LANGUAGE.md` line 45), but nothing creates or consumes the type. `Finding.source: "socket"` is defined in `src/types/finding.ts:3` but never emitted.

2. **`supplyChainAccepts` entries in `.depaudit.yml` are un-exercised.** `FindingMatcher.classifyFindings` (`src/modules/findingMatcher.ts:58-72`) already reads the `supplyChainAccepts` list and matches on `(package, version, findingId)` — but no `source: "socket"` findings ever reach it in production, so those branches only run under synthetic unit-test conditions (`findingMatcher.test.ts` lines 61-88). Issue #5's acceptance criterion "FindingMatcher now matches against supplyChainAccepts entries" shipped the code; this slice's corresponding criterion shipping means the code now has real input.

3. **No fail-open plumbing exists.** `ScanCommand` (`src/commands/scanCommand.ts:9`) returns `Promise<number>` — a raw exit code — with no place to carry a "supply-chain unavailable" flag for the (future) `MarkdownReporter` to consume. PRD section "Socket failure mode" mandates fail-open; PRD section "Auto-prune fail-open guard" depends on knowing whether Socket was available for a given run.

4. **The PR's contract for supply-chain alert severity is unspecified in-code.** Socket's alert types (`didYouMean`, `installScripts`, `deprecated`, `criticalCVE`, `unpopularPackage`, `suspiciousStarActivity`, …) each carry a Socket-assigned severity level (`low`, `middle`, `high`, `critical`). That scale needs to be mapped onto depaudit's internal `Severity` union (`UNKNOWN | LOW | MEDIUM | HIGH | CRITICAL`) so the existing severity-threshold gate applies uniformly across OSV and Socket findings.

Collectively, these mean a maintainer today running `depaudit scan` on a repo with `eslint-config-airbnb` (a typical npm package Socket would flag for unmaintained-peer-deps) or `node-gyp` (install scripts) gets zero supply-chain visibility regardless of how many `supplyChainAccepts` or `commonAndFine` entries they've curated.

## Solution Statement

Add one new deep module (`SocketApiClient`), one new shared type (`ScanResult`), extend one module (`OsvScannerAdapter` — a single new export that reuses the existing shell invocation), and extend the `ScanCommand` composition root to wire Socket between OSV and classification. No new runtime dependency (native `fetch` + retry/backoff written inline — ~100 LOC). No changes to `FindingMatcher`, `Linter`, or `ConfigLoader` — they already handle supply-chain data.

Concretely:

- **`src/types/scanResult.ts`** (new) — `export interface ScanResult { findings: Finding[]; socketAvailable: boolean; }`. `ScanCommand` internally builds one before emitting output; this slice exposes the flag on stderr only, with the full propagation into `.depaudit/findings.json` and the PR comment landing in the future `JsonReporter`/`MarkdownReporter` slice.

- **`src/modules/socketApiClient.ts`** (new, deep, function-based following the established `runOsvScanner`/`classifyFindings` pattern) — One primary export `fetchSupplyChainFindings(packages, options): Promise<Finding[]>`:

  ```ts
  export interface SocketPackageRef {
    ecosystem: Ecosystem;
    name: string;
    version: string;
    manifestPath: string;
  }

  export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

  export interface SocketApiClientOptions {
    token?: string;              // default: process.env.SOCKET_API_TOKEN
    baseUrl?: string;            // default: "https://api.socket.dev"
    batchSize?: number;          // default: 100
    maxRetries?: number;         // default: 3
    initialBackoffMs?: number;   // default: 500
    timeoutMs?: number;          // default: 15_000 per request
    fetch?: FetchFn;             // default: globalThis.fetch
    sleep?: (ms: number) => Promise<void>;  // test-injectable
  }

  export async function fetchSupplyChainFindings(
    packages: SocketPackageRef[],
    options?: SocketApiClientOptions
  ): Promise<Finding[]>;

  export class MissingSocketTokenError extends Error { }
  ```

  Behavior:
  - Reads `token = options.token ?? process.env.SOCKET_API_TOKEN`; if empty/undefined, throws `MissingSocketTokenError` (per AC #1).
  - Converts `packages` to `purl` strings; filters out any for which we have no reliable purl mapping (maven `groupId:artifactId` and composer `vendor/name` edge cases — see Notes) and emits a stderr warning for each dropped entry.
  - Splits the purl list into `batchSize`-sized batches.
  - Per batch: `POST {baseUrl}/v0/purl` with body `{"components": [{"purl": "pkg:npm/lodash@4.17.20"}, ...]}`, `Authorization: Bearer <token>`, `Content-Type: application/json`, request timeout per `timeoutMs` via `AbortController`.
  - On HTTP 200: parse response into `Finding[]` (one per alert per component).
  - On HTTP 401/403: throw a terminal `SocketAuthError` — do **not** retry.
  - On HTTP 4xx other than 401/403/429: treat as terminal failure (throw) — do not retry.
  - On HTTP 429 or 5xx or `fetch` rejection (timeout, DNS failure, connection reset): retry up to `maxRetries` with exponential backoff (`initialBackoffMs * 2^attempt`).
  - On retry exhaustion: throw a `SocketUnavailableError`.
  - `MissingSocketTokenError`, `SocketAuthError`, and `SocketUnavailableError` are all caught by `ScanCommand` and folded into `socketAvailable: false`. The client itself does not decide fail-open — it surfaces the failure type; the composition root owns the policy.

  **Severity mapping** (Socket → internal):
  | Socket alert severity | Internal `Severity` |
  |------|-----------|
  | `critical` | `CRITICAL` |
  | `high` | `HIGH` |
  | `middle` or `medium` | `MEDIUM` |
  | `low` | `LOW` |
  | other/missing | `UNKNOWN` |

  **Purl construction** (internal helper `toPurl(ref): string | null`):
  | Ecosystem | Purl form | Notes |
  |------|-----------|------|
  | `npm` | `pkg:npm/<name>@<version>` | scoped packages encode `/` as-is per purl spec |
  | `pip` | `pkg:pypi/<name>@<version>` | normalized-lowercase name per purl spec |
  | `gomod` | `pkg:golang/<name>@<version>` | `name` is the full module path |
  | `cargo` | `pkg:cargo/<name>@<version>` | |
  | `gem` | `pkg:gem/<name>@<version>` | |
  | `maven` | `pkg:maven/<group>/<artifact>@<version>` | requires `name == "group:artifact"`; fall back to null if not colon-separated |
  | `composer` | `pkg:composer/<vendor>/<name>@<version>` | requires `name == "vendor/name"`; fall back to null if not slash-separated |

- **`src/modules/osvScannerAdapter.ts`** (extended — one new export, zero behavior change to `runOsvScanner`) — Factor out the shell invocation + JSON parse into an internal helper `async function runOsvJson(manifests, execFile): Promise<OsvOutput>`, then add a new sibling export:

  ```ts
  export async function enumerateOsvPackages(
    manifests: Manifest[],
    execFile: ExecFileFn = defaultExecFile
  ): Promise<SocketPackageRef[]>;
  ```

  which returns every `(ecosystem, name, version, manifestPath)` tuple OSV-Scanner emitted — including packages with empty `vulnerabilities` arrays (OSV-Scanner's `scan source --format=json` lists the full dep tree in `results[].packages[]`, not just vulnerable ones). `runOsvScanner` is unchanged at the signature level and internally now delegates to `runOsvJson` for the shell call. `ScanCommand` calls `runOsvJson` directly once (via a shared helper) and derives both the `Finding[]` and the `SocketPackageRef[]` from the single `OsvOutput` to avoid shelling out twice.

  **Design note:** an alternative is to introduce `runOsvScannerFull(manifests, execFile): Promise<{ findings; packages }>` and make `runOsvScanner` wrap it. The implementer picks whichever reads cleaner after the factor-out. The external contract — one shell invocation per scan, both outputs available — is what matters.

- **`src/commands/scanCommand.ts`** (extended) — Insert Socket between OSV and classification:

  1. (existing) Load + lint `.depaudit.yml` and `osv-scanner.toml`.
  2. (existing) `discoverManifests(scanPath)`.
  3. **(changed)** Run OSV once, capturing both `osvFindings: Finding[]` and `packages: SocketPackageRef[]`.
  4. **(new)** Try to fetch supply-chain findings:
     ```ts
     let socketFindings: Finding[] = [];
     let socketAvailable = true;
     try {
       socketFindings = await fetchSupplyChainFindings(packages);
     } catch (err) {
       socketAvailable = false;
       process.stderr.write(`supply-chain unavailable: ${(err as Error).message}\n`);
     }
     ```
  5. **(changed)** `const allFindings = [...osvFindings, ...socketFindings];`
  6. (existing) `classifyFindings(allFindings, depauditConfig, osvConfig)` — the matcher already handles both `source` values.
  7. (existing) Emit `new` bucket to stdout, `expired-accept` to stderr.
  8. **(new)** Return the same exit code as before — no new exit-code semantics for supply-chain findings in this slice. `socketAvailable` is written to stderr only; the `ScanResult` type exists so a later slice can plumb it into `.depaudit/findings.json` and the PR comment.

- **`src/modules/stdoutReporter.ts`** — Unchanged. `printFindings` already emits one line per finding; supply-chain findings print with `source`-independent formatting because `stdoutReporter` reads only `package`, `version`, `findingId`, `severity` off each `Finding`.

- **`src/modules/findingMatcher.ts`** — Unchanged. The four-way classifier already matches `source === "socket"` findings against `supplyChainAccepts[]` on `(package, version, findingId)`, and `commonAndFine[]` applies source-agnostically on `(package, alertType == findingId)` — both land from issue #5.

- **`src/cli.ts`** — Unchanged. The `scan` subcommand dispatch is already correct; all new wiring lives inside `ScanCommand`.

**`UBIQUITOUS_LANGUAGE.md` canonical terms preserved:** **Finding**, **Finding source**, **Supply-chain finding**, **Acceptance**, **Acceptance Register**, **Common-and-fine entry**, **Fail open**, **`SocketApiClient`**. No new "retry policy" or "graceful degradation" synonym introduced; "fail open" is the canonical phrase.

## Relevant Files
Use these files to implement the feature:

- `README.md` — Always include; project overview and status.
- `specs/prd/depaudit.md` — Authoritative source for the Socket-related design: section "Findings sources" (OSV + Socket, Socket-failure-mode), "Graceful degradation" (ecosystem non-coverage), "Modules" → `SocketApiClient` (auth, retry, fail-open, normalization), "Modules" → `FindingMatcher` (four-way classification, source-agnostic), user stories 3/17/18 (the specific AC bindings for this slice), "Gate semantics" (severity threshold applies post-merge), "Auto-prune of orphaned accept entries" → fail-open guard (not implemented in this slice but motivates the `socketAvailable` flag).
- `UBIQUITOUS_LANGUAGE.md` — Canonical terms `Finding`, `Finding source`, `Supply-chain finding`, `Acceptance`, `Acceptance Register`, `Common-and-fine entry`, `Fail open`, `SocketApiClient`. Implementation prose uses these verbatim; "Socket client" alias is acceptable in short-form comments but not in public type/function names.
- `.env.sample` — Declares `SOCKET_API_TOKEN`. No change expected; verify the entry exists and stays documented.
- `.adw/project.md` — Deep-module layout (`src/modules/`, `src/modules/__tests__/`), stack (Bun, TypeScript strict, Vitest, ESM `.js` imports), `Library Install Command: bun add {library}`. `## Unit Tests` marker absent — see Notes for the override precedent (same as issues #3/#4/#5/#6).
- `.adw/commands.md` — Validation commands: `bun install`, `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`, `bun run test:e2e -- --tags "@adw-7"`, `bun run test:e2e -- --tags "@regression"`.
- `.adw/conditional_docs.md` — Confirms `specs/prd/depaudit.md` (new feature) and `app_docs/feature-m8fl2v-depaudit-yml-schema-finding-matcher.md` (FindingMatcher / supplyChainAccepts contract) should be read for this task.
- `.adw/review_proof.md` — Rule 3 (`bun test` must pass with coverage), Rule 5 ("For changes to `OsvScannerAdapter` or `SocketApiClient`: confirm mock boundary tests cover the new behavior" — directly names this slice's module), Rule 6 (fixture-driven unit tests for `Linter`, `FindingMatcher`, `ConfigLoader` — `FindingMatcher` is unchanged but its supply-chain branches gain fixture coverage via this slice's new unit tests).
- `app_docs/feature-m8fl2v-depaudit-yml-schema-finding-matcher.md` — Documents the existing `FindingMatcher` contract: first-match-wins, `source === "socket"` branch, `supplyChainAccepts` key `(package, version, findingId)`, `commonAndFine` key `(package, alertType)`. This slice produces the real supply-chain findings that exercise that branch.
- `app_docs/feature-u2drew-polyglot-manifest-discoverer.md` — Documents the seven-ecosystem `Ecosystem` union and the `manifestPath` finding field that `SocketPackageRef` mirrors. Socket coverage in this slice passes through the same seven values.
- `app_docs/feature-oowire-configloader-linter-cve-ignores.md` — Documents `ConfigLoader` / `Linter` shapes. No change to either module in this slice; referenced for the `supplyChainAccepts` schema those modules already parse + lint.
- `specs/issue-5-adw-m8fl2v-depaudit-yml-schema-sdlc_planner-depaudit-yml-schema-finding-matcher.md` — Reference plan for the matcher the current slice activates; documents the supplyChainAccepts lookup structure and date-placeholder fixture pattern the unit tests reuse.
- `specs/issue-6-adw-u2drew-polyglot-ecosystem-s-sdlc_planner-polyglot-manifest-discoverer.md` — Reference plan for the polyglot adapter; establishes the `MSW-style mocked boundary + JSON fixture` test pattern `SocketApiClient` follows verbatim (substituting `FetchFn` for `ExecFileFn`, Socket response JSON for OSV-Scanner output JSON).
- `src/cli.ts` — Unchanged; the `scan` dispatch already routes to `runScanCommand`.
- `src/commands/scanCommand.ts` — Extended: wire Socket between OSV and classification, catch Socket errors and annotate stderr, return the existing exit-code contract unchanged.
- `src/commands/lintCommand.ts` — Unchanged. `supplyChainAccepts` lint rules already land in issue #5.
- `src/modules/osvScannerAdapter.ts` — Extended: factor out `runOsvJson` helper, add `enumerateOsvPackages` sibling export. `runOsvScanner` signature unchanged.
- `src/modules/socketApiClient.ts` — NEW. `fetchSupplyChainFindings(packages, options)`, `toPurl(ref)`, `MissingSocketTokenError`, `SocketAuthError`, `SocketUnavailableError` exports.
- `src/modules/findingMatcher.ts` — Unchanged. `classifyFindings` already matches `source === "socket"` on `supplyChainAccepts` and `commonAndFine`.
- `src/modules/linter.ts` — Unchanged. `supplyChainAccepts` and `commonAndFine` lint rules already land in issue #5.
- `src/modules/configLoader.ts` — Unchanged. `loadDepauditConfig` already parses `supplyChainAccepts` with source-line tracking.
- `src/modules/stdoutReporter.ts` — Unchanged. `printFindings` reads only `package`/`version`/`findingId`/`severity` — source-agnostic.
- `src/types/finding.ts` — Unchanged. `FindingSource = "osv" | "socket"` already defined.
- `src/types/depauditConfig.ts` — Unchanged. `SupplyChainAccept` and `CommonAndFineEntry` already defined.
- `src/types/manifest.ts` — Unchanged.
- `src/types/osvScannerConfig.ts` — Unchanged.

### New Files

- `src/types/scanResult.ts` — NEW. `export interface ScanResult { findings: Finding[]; socketAvailable: boolean; }`. Kept separate from `finding.ts` because it's a pipeline-level aggregate, not a domain primitive.
- `src/modules/socketApiClient.ts` — NEW. The core module described above.
- `src/modules/__tests__/socketApiClient.test.ts` — NEW. Vitest unit suite covering happy path, retry-then-success, permanent-failure-fail-open (retry exhaustion on 5xx and on timeout), auth error (401/403), missing token, batch splitting at `batchSize` boundary, and purl construction for each ecosystem (including the maven/composer null fall-back).
- `src/modules/__tests__/fixtures/socket-api/happy-path-response.json` — NEW. Representative `/v0/purl` response body: three components (npm `lodash@4.17.20` with `installScripts` + `unpopularPackage`, npm `event-stream@3.3.6` with `criticalCVE`, pypi `requests@2.25.0` clean). Structured as the actual Socket API response shape.
- `src/modules/__tests__/fixtures/socket-api/rate-limit-then-success-response.json` — NEW. Same shape as happy path, used to assert the client retries past a 429 and ultimately succeeds.
- `src/modules/__tests__/fixtures/socket-api/auth-error-response.json` — NEW. Socket's documented auth error envelope; used to assert the client throws `SocketAuthError` immediately without retry.
- `src/modules/__tests__/fixtures/socket-api/multi-batch-response.json` — NEW. Deterministic response for the batch-boundary test: 250 components in the input split into three batches (100 + 100 + 50).
- `features/scan_supply_chain.feature` — NEW. `@adw-7` scenarios focused on the fail-open path (no live Socket required in CI).
- `features/step_definitions/scan_supply_chain_steps.ts` — NEW. Cucumber steps for `@adw-7`. Most steps reuse the global registry from `scan_steps.ts` and `scan_accepts_steps.ts`; this file adds only the Socket-specific env-var and stderr-annotation steps.
- `fixtures/vulnerable-npm-no-socket-token/` — NEW. Copy of `fixtures/vulnerable-npm` with its own `.depaudit.yml` and `osv-scanner.toml`; exercises the no-token fail-open BDD scenario.
- `fixtures/vulnerable-npm-socket-unreachable/` — NEW. Same shape, with a `.depaudit.yml` carrying a `supplyChainAccepts` entry for a synthetic `(package, version, alertType)`; exercises the "Socket returns error → fail-open" BDD scenario (Socket forced unreachable via env-var override of base URL to `http://127.0.0.1:1/`, a port-1 refusal).

## Implementation Plan

### Phase 1: Foundation
Type and helper scaffolding that subsequent phases depend on:
- Add `ScanResult` type in `src/types/scanResult.ts`.
- Factor out the OSV shell invocation + JSON parse in `osvScannerAdapter.ts` so both `runOsvScanner` and the new `enumerateOsvPackages` reuse it (one shell call per scan).

### Phase 2: Core Implementation
Build `SocketApiClient` end-to-end:
- `toPurl(ref)` helper with the seven-ecosystem mapping table.
- Severity mapping helper (`mapSocketSeverity`).
- Finding normalization (`alertToFinding`): each alert → one `Finding` with `source: "socket"`, `findingId: alert.type`, `severity: mapSocketSeverity(alert.severity)`.
- `fetchSupplyChainFindings(packages, options)` orchestrator: token resolution, batching, per-batch request with timeout, retry-with-backoff loop, terminal-error surface.
- Typed error classes (`MissingSocketTokenError`, `SocketAuthError`, `SocketUnavailableError`).
- Full Vitest unit suite under `src/modules/__tests__/socketApiClient.test.ts` with MSW-style `FetchFn` mocks covering every success and failure branch.

### Phase 3: Integration
Wire the new module into the `ScanCommand` pipeline and validate end-to-end:
- Extend `scanCommand.ts` to derive both `findings` and `packages` from one OSV invocation, call `fetchSupplyChainFindings`, fold errors into `socketAvailable: false`, merge findings, and pass the merged list through `classifyFindings`.
- Add BDD feature file `features/scan_supply_chain.feature` tagged `@adw-7` exercising the no-token fail-open path and the `supplyChainAccepts`-accepted-finding composition (the latter forces Socket unreachable via env-var-overridden base URL).
- Run the full validation suite including prior `@regression` tags to confirm zero regressions.

## Step by Step Tasks
Execute every step in order, top to bottom.

### 1. Add `ScanResult` type

- Create `src/types/scanResult.ts`:
  ```ts
  import type { Finding } from "./finding.js";

  export interface ScanResult {
    findings: Finding[];
    socketAvailable: boolean;
  }
  ```
- No re-export needed from any other types file; callers import directly from `src/types/scanResult.js`.
- Confirm `tsconfig.json`'s `include` pattern (`src/**/*`) picks it up — no config change.

### 2. Factor OSV shell invocation for reuse

- In `src/modules/osvScannerAdapter.ts`:
  - Add an internal helper `async function runOsvJson(manifests, execFile): Promise<OsvOutput>` containing the existing `execFile` call, code-1-stdout handling, and `JSON.parse`. Return the parsed `OsvOutput`.
  - Rewrite `runOsvScanner(manifests, execFile)` to call `runOsvJson` and then extract findings — the existing `for (const result of parsed.results)` loop moves into the wrapper unchanged.
  - Add a new exported function:
    ```ts
    export async function enumerateOsvPackages(
      manifests: Manifest[],
      execFile: ExecFileFn = defaultExecFile
    ): Promise<SocketPackageRef[]>;
    ```
    which calls `runOsvJson` and maps every `results[].packages[]` entry to a `SocketPackageRef` (dedupe by `ecosystem|name|version` — same package reported in multiple result blocks should yield one ref; preserve order by first occurrence).
  - Export a matching new type `SocketPackageRef` from `socketApiClient.ts` (see Step 3). For now, declare a minimal interface locally and re-export from the client module so `osvScannerAdapter.ts` imports it cleanly.

- In `src/modules/__tests__/osvScannerAdapter.test.ts`, add tests for the new `enumerateOsvPackages` export:
  - Reuses `polyglot.json` — assert the returned array has one ref per ecosystem with the correct `(ecosystem, name, version)` mapping.
  - Reuses `with-findings.json` — assert `lodash 4.17.20` and `minimist ...` are both present (the existing file already demonstrates clean + vulnerable packages in the same JSON).
  - Fixture `clean.json` — assert zero packages returned.
  - Assert dedupe: synthetic fixture with the same `(ecosystem, name, version)` in two `results[]` blocks returns one ref.

### 3. Scaffold `SocketApiClient` public surface

- Create `src/modules/socketApiClient.ts`. Add exports and types only — no logic yet:
  ```ts
  import type { Finding, Ecosystem, Severity } from "../types/finding.js";

  export interface SocketPackageRef {
    ecosystem: Ecosystem;
    name: string;
    version: string;
    manifestPath: string;
  }

  export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

  export interface SocketApiClientOptions {
    token?: string;
    baseUrl?: string;
    batchSize?: number;
    maxRetries?: number;
    initialBackoffMs?: number;
    timeoutMs?: number;
    fetch?: FetchFn;
    sleep?: (ms: number) => Promise<void>;
  }

  export class MissingSocketTokenError extends Error {
    constructor() { super("SOCKET_API_TOKEN is not set"); this.name = "MissingSocketTokenError"; }
  }
  export class SocketAuthError extends Error {
    constructor(public readonly status: number, message: string) { super(message); this.name = "SocketAuthError"; }
  }
  export class SocketUnavailableError extends Error {
    constructor(message: string, public readonly cause?: unknown) { super(message); this.name = "SocketUnavailableError"; }
  }

  export async function fetchSupplyChainFindings(
    _packages: SocketPackageRef[],
    _options: SocketApiClientOptions = {}
  ): Promise<Finding[]> {
    throw new Error("not implemented");
  }
  ```
- Confirm `bun run typecheck` passes on the skeleton.

### 4. Implement `toPurl` helper

- Add internal helper `function toPurl(ref: SocketPackageRef): string | null` inside `socketApiClient.ts`. Table:
  | Ecosystem | Purl emitted | Null fall-back |
  |------|-----------|------|
  | `npm` | `pkg:npm/<name>@<version>` | never null (scoped packages retain the `@scope/pkg` shape — purl spec encodes the first `@` separator as `@` and scope-leading `@` stays literal) |
  | `pip` | `pkg:pypi/<lower-name>@<version>` | never null |
  | `gomod` | `pkg:golang/<name>@<version>` | never null |
  | `cargo` | `pkg:cargo/<name>@<version>` | never null |
  | `gem` | `pkg:gem/<name>@<version>` | never null |
  | `maven` | `pkg:maven/<group>/<artifact>@<version>` — split `name` on the first `:` | **null** if `name` doesn't contain `:` |
  | `composer` | `pkg:composer/<vendor>/<pkg>@<version>` — split `name` on the first `/` | **null** if `name` doesn't contain `/` |
- `encodeURIComponent` each path segment per purl spec but **don't** double-encode the `@scope/pkg` npm scope prefix.
- Unit-test every row in Step 8 below.

### 5. Implement severity mapping + response normalization

- Add `function mapSocketSeverity(raw: string | undefined): Severity` using the table from the Solution section. Unknown strings → `"UNKNOWN"`.
- Add `function alertToFinding(ref: SocketPackageRef, alert: { type: string; severity?: string; title?: string }): Finding`:
  ```ts
  {
    source: "socket",
    ecosystem: ref.ecosystem,
    package: ref.name,
    version: ref.version,
    findingId: alert.type,
    severity: mapSocketSeverity(alert.severity),
    summary: alert.title,
    manifestPath: ref.manifestPath,
  }
  ```
- `findingId === alert.type` is the canonical supply-chain identity (e.g. `installScripts`, `criticalCVE`, `didYouMean`) — this is what `supplyChainAccepts[].findingId` in `.depaudit.yml` matches on, per the PRD's "Finding identity" section.

### 6. Implement the request loop

- Add internal `async function fetchBatchWithRetry(purls, options, attempt = 0)`:
  - Build `body = JSON.stringify({ components: purls.map(p => ({ purl: p })) })`.
  - Create `AbortController`; `setTimeout(() => ac.abort(), timeoutMs)`.
  - `response = await fetchFn(url, { method: "POST", headers: {...}, body, signal: ac.signal })`.
  - Clear the timeout on both paths.
  - On `response.ok`: return `await response.json()`.
  - On `401` or `403`: throw `SocketAuthError(response.status, await response.text())` (no retry).
  - On `429` or `status >= 500`: if `attempt < maxRetries`, await `sleep(initialBackoffMs * 2 ** attempt)` then recurse; else throw `SocketUnavailableError`.
  - On other `4xx` (400, 404, 422, …): throw `SocketUnavailableError` (terminal, no retry — a permanent 4xx is a contract mismatch, not a transient failure).
  - On `fetchFn` rejection (AbortError, TypeError, DNS, ECONNREFUSED): classify as transient → retry with backoff the same as 5xx; on exhaustion throw `SocketUnavailableError`.
- Default `fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)`.
- Default `sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))`.
- `const url = \`\${baseUrl}/v0/purl\`` — `baseUrl` defaults to `"https://api.socket.dev"`.

### 7. Implement `fetchSupplyChainFindings` orchestrator

- Replace the `not implemented` stub:
  ```ts
  export async function fetchSupplyChainFindings(
    packages: SocketPackageRef[],
    options: SocketApiClientOptions = {}
  ): Promise<Finding[]> {
    const token = options.token ?? process.env["SOCKET_API_TOKEN"];
    if (!token || token.trim() === "") throw new MissingSocketTokenError();

    const batchSize = options.batchSize ?? 100;
    // …

    // Map refs → purl while tracking the ref for each purl so we can attach
    // the right manifestPath/name/version on the response side.
    const refByPurl = new Map<string, SocketPackageRef>();
    for (const ref of packages) {
      const purl = toPurl(ref);
      if (!purl) {
        process.stderr.write(`supply-chain: cannot build purl for ${ref.ecosystem}/${ref.name}@${ref.version}\n`);
        continue;
      }
      refByPurl.set(purl, ref);
    }

    const purls = [...refByPurl.keys()];
    const findings: Finding[] = [];

    for (let i = 0; i < purls.length; i += batchSize) {
      const batch = purls.slice(i, i + batchSize);
      const response = await fetchBatchWithRetry(batch, { ...options, token });
      for (const component of response.components ?? []) {
        const ref = refByPurl.get(component.purl);
        if (!ref) continue;
        for (const alert of component.alerts ?? []) {
          findings.push(alertToFinding(ref, alert));
        }
      }
    }

    return findings;
  }
  ```
- `purls` is deduped by the Map semantics — two refs that stringify to the same purl dedupe automatically. This is a defensive property; OSV-Scanner's output is already deduped upstream.

### 8. Write `SocketApiClient` unit tests

- Create `src/modules/__tests__/socketApiClient.test.ts` in the vitest style used across the repo (`describe` + `it` + `expect` + `vi.fn`). Follow the `osvScannerAdapter.test.ts` shape for fixture loading (`readFile` from `fixtures/socket-api/*.json`).
- Shared test helpers:
  ```ts
  const NPM_LODASH: SocketPackageRef = {
    ecosystem: "npm", name: "lodash", version: "4.17.20", manifestPath: "/p/package.json",
  };

  function mockFetch(response: { status: number; body?: unknown }): FetchFn {
    return vi.fn<FetchFn>().mockResolvedValue(
      new Response(JSON.stringify(response.body ?? {}), { status: response.status })
    );
  }
  ```

- **Cases** (each `it` gets its own block):
  1. `throws MissingSocketTokenError when token unset` — `process.env.SOCKET_API_TOKEN` cleared and no `options.token` → asserts `MissingSocketTokenError`.
  2. `happy path: single batch returns mapped Finding[]` — `fetch` resolves with `happy-path-response.json`, `packages = [lodash, event-stream, requests-clean]`; asserts `Finding[]` has 3 entries (2 for lodash, 1 for event-stream), each with `source === "socket"`, correct `findingId` and mapped severity.
  3. `retry then success on 429` — `fetch` rejects/resolves scripted: `[{status:429},{status:200, body:happy}]`; asserts one findings array returned, `fetch` called twice, `sleep` called once with `initialBackoffMs * 2^0`.
  4. `retry then success on 503` — same pattern with `503` first.
  5. `retry exhausted on 5xx throws SocketUnavailableError` — `fetch` resolves with `500` for all `maxRetries + 1` calls; asserts `SocketUnavailableError` thrown and `sleep` called exactly `maxRetries` times.
  6. `retry exhausted on timeout throws SocketUnavailableError` — `fetch` rejects with an `AbortError` for all attempts; assertion as above.
  7. `401 throws SocketAuthError without retry` — `fetch` resolves `401` once; asserts `SocketAuthError` thrown, `fetch` called exactly once, `sleep` never called.
  8. `403 throws SocketAuthError without retry` — same pattern with `403`.
  9. `400 (permanent 4xx) throws SocketUnavailableError without retry` — asserts `SocketUnavailableError`, `fetch` called once, `sleep` not called.
  10. `batches at batchSize boundary` — input 250 packages, `batchSize: 100`, `fetch` mocked to return empty components per batch; asserts `fetch` called 3 times with request bodies containing 100/100/50 components respectively. Uses `multi-batch-response.json` once to reduce boilerplate.
  11. `empty packages returns [] without calling fetch` — `packages = []` → returns `[]`, `fetch` never called.
  12. `purl construction: npm, pypi (normalized lowercase), gomod, cargo, gem` — five refs in one call, `fetch` mock asserts the request body contains the expected purls.
  13. `purl construction: maven colon-split and composer slash-split` — `{ecosystem: "maven", name: "com.example:foo", version: "1.0"}` → `pkg:maven/com.example/foo@1.0`; `{ecosystem: "composer", name: "vendor/pkg", version: "1.0"}` → `pkg:composer/vendor/pkg@1.0`.
  14. `purl fall-back to null when maven/composer name malformed` — refs without `:` (maven) or `/` (composer) get warned on stderr and excluded from the request. Uses `vi.spyOn(process.stderr, "write")`.
  15. `fetch rejection with ECONNREFUSED classified as transient` — `fetch.mockRejectedValueOnce({code: "ECONNREFUSED"}).mockResolvedValueOnce({status: 200, body: ...happy})` — asserts one retry + success.
  16. `manifestPath propagates from SocketPackageRef to Finding` — asserts each returned `Finding.manifestPath` equals the input `ref.manifestPath`.

### 9. Wire Socket into `ScanCommand`

- Extend `src/commands/scanCommand.ts`:
  - Import `enumerateOsvPackages` from `osvScannerAdapter.js` and `fetchSupplyChainFindings` from `socketApiClient.js`.
  - Replace the existing `const findings = await runOsvScanner(manifests)` with one call that reuses the OSV JSON. Two acceptable shapes — implementer picks:
    - Shape A: keep `runOsvScanner` and add a second call to `enumerateOsvPackages` — two shell invocations. **Rejected** — unnecessary OSV binary churn.
    - Shape B: introduce a third export in `osvScannerAdapter.ts` that returns `{ findings; packages }` from a single `runOsvJson` call. **Preferred.** `scanCommand` calls it once.
  - After OSV:
    ```ts
    let socketFindings: Finding[] = [];
    let socketAvailable = true;
    try {
      socketFindings = await fetchSupplyChainFindings(osvPackages);
    } catch (err) {
      socketAvailable = false;
      process.stderr.write(`supply-chain unavailable: ${(err as Error).message}\n`);
    }
    const findings = [...osvFindings, ...socketFindings];
    ```
  - Pass the merged `findings` to `classifyFindings` exactly as before.
  - (Do NOT introduce `ScanResult` into the public exit-code contract this slice — the flag lives in-memory only; a later slice plumbs it into `.depaudit/findings.json` and the PR comment. The `ScanResult` type is still introduced in this slice so the contract shape exists for downstream consumers to import.)
- Confirm all existing `@adw-3`/`@adw-4`/`@adw-5`/`@adw-6` scenarios still pass — the only change they see is an extra stderr line "supply-chain unavailable: SOCKET_API_TOKEN is not set" (because BDD does not set the env var). Verify this does not break any existing `stderr` assertion: grep the existing feature files for `stderr mentions` steps and confirm none of them would spuriously match "supply-chain unavailable" (they match `"ignoreUntil"`, `"expires"`, `"osv-scanner.toml"`, `".depaudit.yml"`, `"duplicate"`, `"does not exist"`, `"365-day cap"`, `"date is in the past"` — none overlap).

### 10. Build supply-chain BDD fixtures

- Create `fixtures/vulnerable-npm-no-socket-token/`:
  - `package.json` — same minimal CVE-bearing payload as `fixtures/vulnerable-npm` (so OSV still flags it).
  - `.depaudit.yml` — valid minimal config, `version: 1`, default policy, empty `commonAndFine` and `supplyChainAccepts`.
  - `osv-scanner.toml` — empty valid TOML (no `IgnoredVulns`).

- Create `fixtures/vulnerable-npm-socket-unreachable/`:
  - `package.json` — same minimal CVE-bearing payload.
  - `.depaudit.yml` — valid minimal config.
  - `osv-scanner.toml` — empty valid TOML.
  - (No test-only environment mangling in the fixture itself — the env vars are set at `When` time by the step definition.)

### 11. Write supply-chain BDD feature file

Create `features/scan_supply_chain.feature`:

```gherkin
@adw-7
Feature: depaudit scan — supply-chain fail-open and supplyChainAccepts composition
  As a maintainer
  I want `depaudit scan` to gracefully skip Socket supply-chain signals when SOCKET_API_TOKEN is unset or Socket is unreachable
  So that a Socket outage or missing credential never blocks a contributor's PR,
  and so that existing OSV-only gating remains unchanged

  Background:
    Given the `osv-scanner` binary is installed and on PATH
    And the `depaudit` CLI is installed and on PATH

  @adw-7 @regression
  Scenario: SOCKET_API_TOKEN unset — scan falls through to OSV-only with stderr annotation
    Given a fixture Node repository at "fixtures/vulnerable-npm-no-socket-token" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is unset in the environment
    When I run "depaudit scan fixtures/vulnerable-npm-no-socket-token"
    Then the exit code is non-zero
    And stdout contains at least one finding line
    And stderr contains "supply-chain unavailable"

  @adw-7 @regression
  Scenario: SOCKET_API_TOKEN set but Socket base URL points to an unreachable host — fail-open
    Given a fixture Node repository at "fixtures/vulnerable-npm-socket-unreachable" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a dummy value in the environment
    And DEPAUDIT_SOCKET_BASE_URL is set to "http://127.0.0.1:1" in the environment
    When I run "depaudit scan fixtures/vulnerable-npm-socket-unreachable"
    Then the exit code is non-zero
    And stdout contains at least one finding line
    And stderr contains "supply-chain unavailable"

  @adw-7
  Scenario: No SOCKET_API_TOKEN on a clean repo — exit 0 with stderr annotation
    Given a fixture Node repository at "fixtures/clean-npm" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is unset in the environment
    When I run "depaudit scan fixtures/clean-npm"
    Then the exit code is 0
    And stdout contains no finding lines
    And stderr contains "supply-chain unavailable"
```

**Note on the second scenario:** requires `ScanCommand` (or `socketApiClient`) to read a `DEPAUDIT_SOCKET_BASE_URL` env override. Add this override in Step 9 so the BDD layer can force the unreachable-host code path without crafting a local mock HTTP server. This is a testability affordance, not a user-facing config knob — document it accordingly in Notes.

### 12. Write supply-chain step definitions

Create `features/step_definitions/scan_supply_chain_steps.ts`:

```ts
import { Given, Then } from "@cucumber/cucumber";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { DepauditWorld, PROJECT_ROOT, CLI_PATH } from "../support/world.js";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

Given<DepauditWorld>("SOCKET_API_TOKEN is unset in the environment", function (this: DepauditWorld) {
  (this as unknown as { envOverrides?: Record<string, string | undefined> }).envOverrides ??= {};
  ((this as any).envOverrides)["SOCKET_API_TOKEN"] = undefined;
});

Given<DepauditWorld>("SOCKET_API_TOKEN is set to a dummy value in the environment", function (this: DepauditWorld) {
  (this as any).envOverrides ??= {};
  ((this as any).envOverrides)["SOCKET_API_TOKEN"] = "dummy-token-for-testing";
});

Given<DepauditWorld>("DEPAUDIT_SOCKET_BASE_URL is set to {string} in the environment", function (this: DepauditWorld, value: string) {
  (this as any).envOverrides ??= {};
  ((this as any).envOverrides)["DEPAUDIT_SOCKET_BASE_URL"] = value;
});

Then<DepauditWorld>("stderr contains {string}", function (this: DepauditWorld, substring: string) {
  assert.ok(
    this.result!.stderr.includes(substring),
    `expected stderr to contain "${substring}", got: "${this.result!.stderr}"`
  );
});
```

- Extend `DepauditWorld` (`features/support/world.ts`) with an `envOverrides?: Record<string, string | undefined>` field.
- Extend the shared `runDepaudit` helper in `scan_steps.ts`: when `world.envOverrides` is present, merge it into the `execFileAsync`'s `env` option (undefined values delete keys from `{ ...process.env, ...envOverrides }`).
- The new `stderr contains {string}` step is shared-namespace — add it here once; if an identical step already exists in another file (checked during the step-definition audit: none found currently), unify.

### 13. Verify existing BDD suites still pass

- Run `bun run build` to refresh `dist/`.
- Run `bun run test:e2e -- --tags "@regression"` — every pre-existing `@adw-3`, `@adw-4`, `@adw-5`, `@adw-6` scenario continues to pass unchanged.
- Spot-check: the no-token stderr annotation fires on every scan BDD scenario now. Confirm no existing `stderr` assertion spuriously matches or is spuriously violated. (See Step 9 for the audit.)

### 14. Run the full validation suite

- `bun install` — no new dependencies expected (native `fetch` only).
- `bun run typecheck` — zero type errors.
- `bun run lint` — zero lint errors.
- `bun test` — all unit tests pass, including the new `socketApiClient.test.ts` and the extended `osvScannerAdapter.test.ts` enumerate-packages cases.
- `bun run build` — build succeeds and `dist/cli.js` is rebuilt.
- `bun run test:e2e -- --tags "@adw-7"` — new supply-chain scenarios pass.
- `bun run test:e2e -- --tags "@regression"` — every previously-passing scenario continues to pass.

## Testing Strategy

### Unit Tests

`.adw/project.md` lacks the `## Unit Tests: enabled` marker. Unit-test tasks are included in this plan as a documented override, matching the precedent established by issue #3, #4, #5, and #6 plans. Justification: (a) `.adw/review_proof.md` Rule 5 **explicitly names `SocketApiClient`** as a module requiring mock-boundary tests; skipping them would fail the review bar. (b) Socket.dev is a paid-tier remote API with rate limits; BDD-layer coverage of the full set of response codes (200, 401, 403, 429, 5xx, network timeout) would require either a live account + live rate-limit triggering, or a local mock HTTP server. Per-request `FetchFn` mocks in the unit layer are dramatically faster, more deterministic, and strictly more exhaustive.

Specifically:

- **`SocketApiClient` mocked-fetch tests** (`src/modules/__tests__/socketApiClient.test.ts`) — enumerated in Step 8 above. Cover: missing token, happy-path happy normalization, retry-then-success on 429, retry-then-success on 5xx, retry exhaustion on 5xx, retry exhaustion on timeout, 401 auth error no-retry, 403 auth error no-retry, 400 permanent failure no-retry, batch-size boundary (250 packages → 3 batches), empty input short-circuit, purl construction across ecosystems (happy path + maven/composer null fall-back), ECONNREFUSED classified transient, manifestPath propagation from ref to finding.

- **`OsvScannerAdapter.enumerateOsvPackages` fixture tests** (extend existing `src/modules/__tests__/osvScannerAdapter.test.ts`) — cover: empty manifests short-circuits without shell call; polyglot JSON emits one ref per ecosystem; existing `with-findings.json` also exercises the enumerate path; dedupe of duplicate `(ecosystem, name, version)` across multiple result blocks. The existing `runOsvScanner` tests continue to pass unchanged — the internal `runOsvJson` factor-out is contract-preserving.

### Edge Cases

- **Socket returns a 200 with an empty `components` array.** Every input package absent from the response → `findings = []`. Scan still emits OSV findings normally. Covered in happy-path test (any package in the request but not the response is silently skipped — we only add findings when we can look up the purl in `refByPurl` and the response contains alerts for it).
- **Socket returns an alert with unknown `severity` field.** Mapped to `"UNKNOWN"`; downstream `classifyFindings` severity-threshold drops it from the `new` bucket unless an accept or whitelist matches. Covered implicitly by the severity-mapping table test.
- **Socket returns an alert for a package we didn't request** (defensive input sanitization on the response). Dropped silently — `refByPurl.get(component.purl)` is undefined, continue. Covered by happy-path test (the fixture includes one extra component whose purl isn't in the request; assertion: it does not produce a finding).
- **Packages list contains duplicates across manifests** (e.g. `lodash@4.17.20` in both `services/a/package.json` and `services/b/package.json`). `refByPurl` Map dedupes on purl. Tested implicitly by the happy-path case with two manifestPath entries — only one purl goes to Socket; the finding's `manifestPath` reflects the first occurrence (documented behavior, tested).
- **Socket transitions mid-scan — one batch succeeds, next batch 503s.** The second batch retries to exhaustion, throws `SocketUnavailableError`, the error surfaces to `ScanCommand` → `socketAvailable: false`, the partial findings from batch 1 are discarded (we return `[]` on error so there's no half-state). Tested via a two-batch scenario with `[ok, 503_forever]` and asserting `findings.length === 0` on throw.
- **`AbortController` timeout.** `AbortError` caught by the fetch promise rejection handler and classified as transient; retries apply. Tested via a scripted `AbortError` rejection.
- **Unusual ecosystem in OSV-Scanner output** (`Pub`, `NuGet`, `Hex`). `enumerateOsvPackages` throws (inherits the same `mapOsvEcosystem` path `runOsvScanner` uses) — downstream `fetchSupplyChainFindings` never sees it. Fail-loud behavior per issue #6's established precedent.
- **`.depaudit.yml` carries a `supplyChainAccepts` entry for a `(package, version, alertType)` that Socket produces.** `classifyFindings` returns `accepted`; stdout does not include it. Tested indirectly via the `findingMatcher` existing unit tests (which already cover this; this slice doesn't regress them).
- **`.depaudit.yml` carries a `commonAndFine` entry for `(package, alertType)` that Socket produces.** `classifyFindings` returns `whitelisted`; stdout does not include it. Tested via `findingMatcher` existing unit tests.
- **`SOCKET_API_TOKEN=""` (empty string)** — treated the same as unset. Unit test asserts `MissingSocketTokenError`.
- **Node 22 / Bun native `fetch` without `undici` polyfill** — `globalThis.fetch` is available in both; no polyfill needed. Confirmed by `.adw/project.md` runtime (Bun) and `tsconfig.json` target `ES2022`.
- **Purl for npm scoped packages** — `pkg:npm/@scope/pkg@1.0.0` with the scope's leading `@` intact. Tested explicitly because it's the most common npm special case.
- **A package name containing a space or unusual URL-reserved character.** `encodeURIComponent` per segment; tested with a synthetic name in the purl-construction suite.

## Acceptance Criteria

The feature is complete when every box below is verifiable by running the Validation Commands:

- [ ] `src/modules/socketApiClient.ts` exists and exports `fetchSupplyChainFindings`, `MissingSocketTokenError`, `SocketAuthError`, `SocketUnavailableError`, `SocketApiClientOptions`, `SocketPackageRef`, `FetchFn`.
- [ ] `SocketApiClient` reads `SOCKET_API_TOKEN` from `process.env` when no explicit `token` option is provided; throws `MissingSocketTokenError` when the env var is unset or empty.
- [ ] `SocketApiClient` batches input packages into `batchSize`-sized (default 100) requests to Socket's `/v0/purl` endpoint.
- [ ] `SocketApiClient` retries with exponential backoff on HTTP 429, 5xx, `AbortError` (timeout), and network rejection; caps retries at `maxRetries` (default 3).
- [ ] `SocketApiClient` throws `SocketAuthError` on 401/403 **without** retry.
- [ ] `SocketApiClient` throws `SocketUnavailableError` on retry exhaustion and on permanent 4xx (400/404/422).
- [ ] `SocketApiClient` normalizes each alert to a `Finding` with `source: "socket"`, `findingId === alert.type`, mapped severity, and the originating `ref.manifestPath`.
- [ ] `OsvScannerAdapter` exports `enumerateOsvPackages` returning `SocketPackageRef[]` from the same OSV-Scanner shell invocation (single subprocess per scan).
- [ ] `ScanCommand` invokes OSV-Scanner once, builds both `osvFindings` and `packages`, passes `packages` to Socket, catches any Socket error and writes `supply-chain unavailable: <message>` to stderr, merges `osvFindings ++ socketFindings`, and passes the merged list through `classifyFindings`.
- [ ] `ScanResult` type exists at `src/types/scanResult.ts` with `findings: Finding[]` and `socketAvailable: boolean` fields (used internally; exit-code contract unchanged in this slice).
- [ ] `FindingMatcher` — no code change — now classifies real supply-chain findings against `supplyChainAccepts` and `commonAndFine`; existing unit tests continue to pass.
- [ ] `features/scan_supply_chain.feature` is tagged `@adw-7` (with two scenarios also tagged `@regression`), and every scenario passes under `bun run test:e2e -- --tags "@adw-7"`.
- [ ] `src/modules/__tests__/socketApiClient.test.ts` covers happy path, retry-then-success (on 429 and on 5xx), permanent-failure-fail-open (retry exhaustion on 5xx and on timeout), auth error (401, 403), permanent 4xx (400), missing token, batching boundary (250 → 100/100/50), empty input, purl construction for every supported ecosystem, purl null fall-back for malformed maven/composer names, manifestPath propagation.
- [ ] Every pre-existing BDD scenario (tags `@adw-3`, `@adw-4`, `@adw-5`, `@adw-6`, `@regression`) continues to pass unchanged.
- [ ] `bun run typecheck`, `bun run lint`, `bun test`, `bun run build` all succeed with zero errors.

## Validation Commands
Execute every command to validate the feature works correctly with zero regressions.

Per `.adw/commands.md`:

- `bun install` — confirm no new dependencies are required (none are; native `fetch` only).
- `bun run typecheck` — confirm zero TypeScript errors across the new module, new types, and the `ScanCommand` / `OsvScannerAdapter` extensions.
- `bun run lint` — confirm zero lint errors.
- `bun test` — run the Vitest unit suite. Every existing test must continue to pass; new `socketApiClient.test.ts` cases and the extended `osvScannerAdapter.test.ts` enumerate-package cases must all pass.
- `bun run build` — compile to `dist/` and confirm `dist/cli.js` is executable (`postbuild` runs `chmod +x`).
- `bun run test:e2e -- --tags "@adw-7"` — run only the new supply-chain scenarios. Expect all three to pass: no-token fail-open, unreachable-host fail-open, clean-repo no-token fail-open.
- `bun run test:e2e -- --tags "@regression"` — run the full regression suite across all prior slices plus the regression-tagged `@adw-7` scenarios. Expect zero regressions.
- Manual smoke test:
  - `SOCKET_API_TOKEN= node dist/cli.js scan fixtures/vulnerable-npm-no-socket-token/` — expect non-zero exit, stdout finding lines for the OSV CVE, stderr line `supply-chain unavailable: SOCKET_API_TOKEN is not set`.
  - `SOCKET_API_TOKEN=dummy DEPAUDIT_SOCKET_BASE_URL=http://127.0.0.1:1 node dist/cli.js scan fixtures/vulnerable-npm-socket-unreachable/` — expect non-zero exit, OSV findings on stdout, stderr line `supply-chain unavailable: ...`.
  - If a real token is available: `SOCKET_API_TOKEN=<real-token> node dist/cli.js scan fixtures/vulnerable-npm-no-socket-token/` — expect non-zero exit, OSV findings plus any Socket alerts on stdout, no "supply-chain unavailable" stderr line.

## Notes

- **Unit tests override**: `.adw/project.md` lacks `## Unit Tests: enabled`. This plan includes unit-test tasks because (a) `.adw/review_proof.md` Rule 5 explicitly names `SocketApiClient` as a module requiring mock-boundary tests, and (b) the GitHub issue's acceptance criteria explicitly require "Unit tests: mocked HTTP (MSW-style) covering happy path, retry-then-success, permanent-failure-fail-open, auth error." Same precedent applied by issue #3, #4, #5, and #6 plans.
- **No new libraries required.** Bun and Node 22+ ship native `fetch`, `AbortController`, and `Response` — no `undici` import, no MSW, no `node-fetch`. Unit-test boundary mocking uses `vi.fn<FetchFn>()` plus `new Response(...)`. Per `.adw/commands.md`, a future library add would be `bun add <name>`; not needed for this slice.
- **`DEPAUDIT_SOCKET_BASE_URL` is a testability override, not a user-facing knob.** Documented here so a future maintainer doesn't mistake it for a supported config surface. A user-controlled Socket base URL would live in `.depaudit.yml`'s `policy` section; no user story asks for it.
- **Socket API evolution.** Socket's REST API version pinning is `/v0/purl` today. If Socket introduces `/v1/...`, the constant `const url = \`\${baseUrl}/v0/purl\`` updates in one place. The request/response shape is expected to stay stable per Socket's semver discipline; future breakage is a maintenance concern, not a design flaw.
- **Finding identity for supply-chain signals.** The PRD ("Finding identity" section) mandates `(package, version, findingId)` where `findingId === alert.type` for Socket. This means repeated alerts of the same type for the same package-version produce **one** finding per acceptance-matching — Socket emits each alert type at most once per component in its current response shape, so this is a non-issue in practice. If Socket ever emits multiple alerts of the same type with distinct sub-reasons, the dedup happens naturally because `FindingMatcher` classifies by key.
- **Socket ecosystem coverage.** Socket covers npm and PyPI strongly, with varying coverage for Go, Cargo, Maven, Gem, Composer. Packages in weakly-covered ecosystems simply receive no alerts in the response — this is the "graceful degradation" PRD behavior, and it requires no code on our side. We send all seven ecosystems' purls; Socket filters server-side.
- **Maven and Composer purl edge case.** Maven's purl requires `group:artifact` split and Composer's requires `vendor/name` split. Packages with unconventional naming fall through the null fall-back in `toPurl` and are excluded from the Socket request with a stderr warning per-package. In the current polyglot fixtures none trigger this path, but the behavior is unit-tested. A future slice may extract `group:artifact` from `pom.xml` parsing.
- **`ScanResult.socketAvailable` exit-code contract unchanged in this slice.** The flag exists in-memory but is only surfaced on stderr today. When the PR-comment reporter lands (a later slice), the same flag flows into `.depaudit/findings.json` and the `<!-- depaudit-gate-comment -->` markdown — at which point the `.depaudit.yml` auto-prune "fail-open guard" wiring uses it to refuse to prune supply-chain accepts when Socket was unavailable. Keeping the flag in the type surface today avoids a breaking type change later.
- **Pre-existing limitation retained**: auto-prune of orphaned `supplyChainAccepts` entries is **not** wired up in this slice. The PRD's "Fail-open guard" depends on `socketAvailable` — we introduce the flag here so the guard can key off it later; the actual prune mutation lands in a future slice alongside the reporter. This is an intentional scope boundary.
- **Stderr annotation format is terse by design.** `supply-chain unavailable: <message>` on a single line is consumed by humans today and, in the future, by the reporter's PR-comment "supply-chain unavailable" block. If future coordination needs a structured format (e.g. NDJSON), the line stays additive — it does not break the existing format.
- **`guidelines/` directory does not exist** in this repo at time of writing; no guideline-specific refactoring obligations apply to this slice.
