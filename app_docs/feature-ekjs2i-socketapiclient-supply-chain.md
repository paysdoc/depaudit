# SocketApiClient + Supply-Chain Findings + Fail-Open

**ADW ID:** ekjs2i-socketapiclient-supp
**Date:** 2026-04-18
**Specification:** specs/issue-7-adw-ekjs2i-socketapiclient-supp-sdlc_planner-socket-api-supply-chain-fail-open.md

## Overview

Adds `SocketApiClient` — a deep module that calls the Socket.dev REST API to surface supply-chain findings (typosquatting, install-script risk, maintainer churn, etc.) alongside the existing OSV CVE findings. The client is fail-open: Socket outages, timeouts, 5xx, and rate-limits cause the scan to continue on CVE findings alone rather than blocking CI. Auth failures (401/403 or missing `SOCKET_API_TOKEN`) are fail-loud configuration errors that abort with exit 2.

## What Was Built

- `src/modules/socketApiClient.ts` — new deep module: `fetchSocketFindings`, `PackageRef`, `SocketApiResult`, `SocketAuthError`, `FetchFn` DI seam
- `src/types/scanResult.ts` — new `ScanResult { findings, socketAvailable, exitCode }` type
- `src/commands/scanCommand.ts` — extended to call Socket after OSV, merge findings, surface `socketAvailable`
- `src/cli.ts` — reads `exitCode` from the new `ScanResult` shape
- `src/modules/__tests__/socketApiClient.test.ts` — full Vitest unit suite (mocked fetch, 20+ cases)
- `src/modules/__tests__/fixtures/socket-output/*.json` — canonical Socket response fixtures
- `features/scan_socket_supply_chain.feature` — BDD scenarios tagged `@adw-7`
- `features/step_definitions/scan_socket_supply_chain_steps.ts` — step definitions with in-process mock server
- `features/support/mockSocketServer.ts` — shared mock HTTP server helper (port 0, configurable faults)
- 18 fixture directories under `fixtures/socket-*/` — one per BDD scenario

## Technical Implementation

### Files Modified

- `src/commands/scanCommand.ts`: added `extractPackagesFromManifests` helper, Socket call + merge, `SocketAuthError` catch, widened return type to `ScanResult`
- `src/cli.ts`: reads `result.exitCode` from the new `ScanResult` shape instead of bare number
- `features/step_definitions/scan_steps.ts`: forwards `SOCKET_API_BASE_URL` / `SOCKET_API_TOKEN` env vars to the spawned depaudit process
- `features/support/world.ts`: added optional `socketMockUrl` and `socketMock` fields to `DepauditWorld`
- `.env.sample`: added commented `SOCKET_API_BASE_URL` override for test/local use

### Key Changes

- **Fail-open vs. fail-loud split**: transient errors (`timeout / 5xx / 429`) return `{ findings: [], available: false }` and annotate stderr with `socket: supply-chain unavailable — scan continuing on CVE findings only`; auth errors throw `SocketAuthError` → exit 2 with a clear message
- **Retry with backoff**: up to 3 attempts, 500ms → 1s → 2s exponential backoff with jitter; 429 respects `Retry-After` header; 30-second per-request timeout via `AbortController`
- **Batch size**: packages chunked at 1,000 PURLs per POST; one failed batch short-circuits the whole run to fail-open (no partial results)
- **Normalisation**: Socket alert → `Finding` with `source: "socket"`, `findingId: alert.type`, severity mapped from `low/middle/high/critical` → `LOW/MEDIUM/HIGH/CRITICAL`; `info`-severity alerts filtered before emission
- **`FindingMatcher` unchanged**: the existing `source === "socket"` branch and `supplyChainAccepts` lookup already handle Socket findings once they arrive with the correct `(package, version, findingId)` identity

## How to Use

1. Set `SOCKET_API_TOKEN` in your environment (or `.env`):
   ```
   export SOCKET_API_TOKEN=sktsec_<your-token>
   ```
2. Run `depaudit scan <path>` as usual — Socket findings are automatically merged with CVE findings.
3. Supply-chain findings appear in stdout using the same 4-field format: `<package> <version> <findingId> <severity>`. Socket alert types (`install-scripts`, `typosquat`, `malware`, …) are lexically distinct from OSV IDs (`CVE-*` / `GHSA-*`).
4. To suppress a known supply-chain alert, add a `supplyChainAccepts` entry to `.depaudit.yml`:
   ```yaml
   supplyChainAccepts:
     - package: esbuild
       version: "0.21.5"
       findingId: install-scripts
       reason: "Known; part of dev toolchain"
       expires: "2027-01-01"
   ```

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SOCKET_API_TOKEN` | Yes (for supply-chain) | — | Bearer token for Socket.dev API |
| `SOCKET_API_BASE_URL` | No | `https://api.socket.dev` | Override Socket base URL (used for tests against a mock server) |
| `SOCKET_REQUEST_TIMEOUT_MS` | No | `30000` | Per-request timeout in ms (useful in BDD to speed up timeout scenarios) |

## Testing

**Unit tests** (`bun test`):
- `src/modules/__tests__/socketApiClient.test.ts` — covers happy path, multi-alert, info-filter, severity/ecosystem mapping, retry-then-success, retry-then-success-on-429 with `Retry-After`, permanent-failure fail-open, network-error fail-open, timeout fail-open, batching ≥1000, batch-failure-fail-open-whole-run, manifestPath fan-out, unknown severity, malformed JSON fail-open, missing token, 401, 403

**BDD scenarios** (`bun run test:e2e -- --tags "@adw-7"`):
- Missing `SOCKET_API_TOKEN` → exit 2, stderr names the env var
- Happy path: Socket alert surfaced in stdout with correct `findingId`
- Clean scan (no alerts) → exit 0
- CVE + Socket alert merged → both in stdout
- Timeout / 5xx / 429 → exit 0 (fail-open), stderr mentions "supply-chain unavailable"
- 401 auth error → exit 2 (fail-loud)
- Retry-then-success → finding emitted, fetch called twice
- `supplyChainAccepts` match / mismatch variants
- Severity threshold filtering (below/at threshold)
- Finding-line format assertion
- Polyglot (npm + pip) batching

**Regression** (`bun run test:e2e -- --tags "@regression"`): all prior `@adw-3`–`@adw-6` scenarios pass unchanged; stdout format (4 fields) is preserved.

## Notes

- **`FindingMatcher` was not changed**: the `source === "socket"` classification branch (`findingMatcher.ts:59-71`) and `supplyChainAccepts` lookup were already live; this slice wires up the emission side.
- **`commonAndFine` also activates**: users who pre-listed alert types in `commonAndFine` see them suppressed automatically — no code change needed.
- **Stdout format unchanged**: 4 fields (`<package> <version> <findingId> <severity>`). A future JSON/SARIF output format is the right home for programmatic source-attribution.
- **No new runtime dependencies**: `fetch` and `AbortController` are built-in in Node 20+/Bun.
- **Partial batch failure → whole run fails open**: avoids leaking partial supply-chain data into the gate decision when one of several batches errors.
- **`SOCKET_API_BASE_URL` env override** is the seam for BDD tests and also useful for enterprise Socket mirrors.
