# SocketApiClient + Supply-Chain Findings + Fail-Open

**ADW ID:** kteamd-socketapiclient-supp
**Date:** 2026-04-18
**Specification:** specs/issue-7-adw-ekjs2i-socketapiclient-supp-sdlc_planner-socket-api-supply-chain-fail-open.md

## Overview

Adds `SocketApiClient` — a deep HTTP module that calls Socket.dev's REST API to surface supply-chain findings (typosquatting, malware, install-script risk, etc.) alongside CVE findings from OSV-Scanner. The client is fail-open: Socket outages never block the scan; auth failures (misconfigured token) fail loud so CI misconfiguration is caught immediately.

## What Was Built

- `src/modules/socketApiClient.ts` — new deep module: PURL conversion, 1,000-PURL batching, per-request 30s `AbortController` timeout, exponential-backoff retry (3 attempts, 500ms→1s→2s, honouring `Retry-After` on 429), severity mapping, info-alert filter, and `Finding` normalisation
- `src/types/scanResult.ts` — new `ScanResult` interface carrying `{ findings, socketAvailable, exitCode }` returned by `ScanCommand`
- `src/commands/scanCommand.ts` — extended to extract `PackageRef[]` from manifests + OSV findings, call Socket, merge results, surface `socketAvailable`, and re-throw `SocketAuthError` as exit 2
- `src/cli.ts` — updated to read `result.exitCode` from the widened `ScanResult` shape
- `src/modules/__tests__/socketApiClient.test.ts` — full Vitest unit suite (mocked `fetch`) covering every retry/fail-open/auth/happy-path branch
- `src/modules/__tests__/fixtures/socket-output/*.json` — canned Socket API response fixtures
- `features/scan_socket_supply_chain.feature` — BDD scenarios tagged `@adw-7`
- `features/step_definitions/scan_socket_supply_chain_steps.ts` — step definitions with in-process mock server
- `features/support/mockSocketServer.ts` — reusable mock HTTP server helper
- 17 fixture directories under `fixtures/socket-*/` for BDD scenarios

## Technical Implementation

### Files Modified

- `src/commands/scanCommand.ts`: added `extractPackagesFromManifests` helper; calls `fetchSocketFindings`; merges OSV + Socket findings; widens return type to `ScanResult`; catches `SocketAuthError` → exit 2; emits `socket: supply-chain unavailable` stderr on fail-open
- `src/cli.ts`: reads `result.exitCode` from `ScanResult` instead of a bare number
- `features/step_definitions/scan_steps.ts`: minor update to forward `SOCKET_API_BASE_URL` / `SOCKET_API_TOKEN` env vars to child process
- `features/support/world.ts`: adds optional `socketMockUrl` and `socketMock` fields to `DepauditWorld`
- `.env.sample`: adds commented `SOCKET_API_BASE_URL` override hint

### Key Changes

- **Fail-open vs. fail-loud split**: transient failures (timeout, 5xx, 429) return `{ findings: [], available: false }` without throwing; auth failures (missing token, 401/403) throw `SocketAuthError` which surfaces as exit 2
- **`FetchFn` DI seam**: production uses `globalThis.fetch`; tests inject `vi.fn<FetchFn>()` — mirrors the `ExecFileFn` pattern in `OsvScannerAdapter`
- **PURL conversion** maps internal `Ecosystem` → PURL type strings (`npm`→`npm`, `pip`→`pypi`, `gomod`→`golang`, …) and back for response parsing
- **Severity mapping**: Socket's `low/middle/high/critical` → internal `LOW/MEDIUM/HIGH/CRITICAL`; `info` alerts are filtered before emission; unknown strings → `UNKNOWN`
- **`findingId` = Socket alert type** (e.g. `malware`, `typosquat`, `install-scripts`) — the stable identity key that `FindingMatcher.supplyChainAccepts` already matches against; no matcher changes needed
- **`FindingMatcher` untouched**: the `source === "socket"` branch at `findingMatcher.ts:59-71` was already live; this slice wires up the first real `source: "socket"` findings

## How to Use

1. Set `SOCKET_API_TOKEN` in your environment (or `.env`):
   ```sh
   export SOCKET_API_TOKEN=sktsec_...
   ```
2. Run the scan as usual:
   ```sh
   depaudit scan /path/to/repo
   ```
3. Socket supply-chain findings appear in stdout alongside CVE findings. Finding IDs for Socket alerts are alert-type strings (e.g. `install-scripts`, `typosquat`) — distinct from OSV IDs (`CVE-*`, `GHSA-*`).
4. To suppress a known supply-chain alert, add a `supplyChainAccepts` entry to `.depaudit.yml`:
   ```yaml
   supplyChainAccepts:
     - package: esbuild
       version: "0.21.5"
       findingId: install-scripts
       reason: "Known build tool — install script is benign"
       expires: "2027-01-01"
   ```
5. On Socket outage, the scan continues on CVE findings only and writes to stderr:
   ```
   socket: supply-chain unavailable — scan continuing on CVE findings only
   ```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SOCKET_API_TOKEN` | (required) | Bearer token for Socket.dev API |
| `SOCKET_API_BASE_URL` | `https://api.socket.dev` | Override API base URL (used by tests / enterprise mirrors) |
| `SOCKET_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout in milliseconds |

## Testing

**Unit tests** (mocked `fetch`, no network):
```sh
bun test src/modules/__tests__/socketApiClient.test.ts
```
Covers: happy path, multi-alert, info-filter, severity mapping, PURL ecosystem mapping, retry-then-success (500 and 429 with `Retry-After`), permanent-failure fail-open, network-error fail-open, timeout fail-open (fake timers), batching ≥1000, batch-failure fail-open, `manifestPath` fan-out, unknown severity, malformed-JSON fail-open, missing token, 401, 403.

**BDD scenarios** (local mock server, no live network):
```sh
bun run test:e2e -- --tags "@adw-7"
```

**Regression suite** (all prior slices unaffected):
```sh
bun run test:e2e -- --tags "@regression"
```

## Notes

- `stdoutReporter` format is unchanged (4 fields: `<package> <version> <findingId> <severity>`). Socket finding IDs are lexically non-overlapping with OSV IDs, so no source-tag column is needed.
- `FindingMatcher` required zero code changes — `supplyChainAccepts` and `commonAndFine` both light up automatically the moment Socket findings arrive.
- Batching is sequential at 1,000 PURLs per POST (rate-limit-friendlier on the free tier). Any single batch transient failure fails the whole run open — no partial supply-chain data enters the gate decision.
- Auth errors are fail-loud by design: a silently-misconfigured CI token would mask supply-chain gaps indefinitely.
- `SOCKET_API_BASE_URL` is also useful for air-gapped enterprise Socket mirrors.
