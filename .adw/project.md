## Project Overview

**depaudit** is a polyglot dependency audit gate CLI tool published to npm. It scans every dependency manifest in a repository for CVEs (via OSV.dev) and supply-chain risk (via Socket.dev), classifies findings against a committed, time-limited acceptance list, and fails CI when new or expired findings are present.

Key features:
- Polyglot manifest discovery (package.json, go.mod, Cargo.toml, requirements.txt, pom.xml, Gemfile, composer.json)
- OSV-Scanner integration for CVE detection across all supported ecosystems
- Socket.dev API integration for supply-chain signals (fail-open on API errors)
- Time-limited acceptance entries (max 90 days) with required reasons
- GitHub Actions CI gate with PR comment updates and Slack notifications
- Interactive `/depaudit-triage` Claude Code skill for guided remediation
- `depaudit setup` bootstrap command for new repositories

## Relevant Files

| Path | Description |
|------|-------------|
| `specs/prd/depaudit.md` | Full product requirements document with architecture and design decisions |
| `README.md` | Project overview and status |
| `src/` | Source code (to be created) |
| `src/commands/` | CLI command implementations (ScanCommand, DepauditSetupCommand) |
| `src/modules/` | Deep modules: ManifestDiscoverer, ConfigLoader, Linter, FindingMatcher, StateTracker, OsvScannerAdapter, SocketApiClient, Reporter, CommitOrPrExecutor |
| `src/__tests__/` | Integration tests (ScanCommand, DepauditSetupCommand end-to-end) |
| `src/modules/__tests__/` | Unit tests for all deep modules |
| `.depaudit.yml` | Per-repo depaudit master config (scaffolded by setup) |
| `osv-scanner.toml` | OSV-Scanner native config with CVE acceptance entries |
| `.github/workflows/depaudit-gate.yml` | CI workflow scaffolded by depaudit setup |

## Framework Notes

- **Runtime**: Node.js / Bun CLI; distributed via npm (`npm install -g depaudit`)
- **Language**: TypeScript
- **Test runner**: Vitest (unit + integration); use `bun test` to execute
- **Module pattern**: Deep modules with pure or state-machine interfaces; composition roots (`ScanCommand`, `DepauditSetupCommand`) are thin wires
- **Subprocess boundary**: `OsvScannerAdapter` shells out to `osv-scanner` Go binary; mock with `execFile` in tests
- **HTTP boundary**: `SocketApiClient` calls Socket.dev REST API; mock with MSW-style interceptors in tests
- **No web server**: Pure CLI tool; no dev server, no browser testing
- **Config files**: `.depaudit.yml` (YAML) for supply-chain accepts and policy; `osv-scanner.toml` (TOML) for CVE accepts — both committed to target repos, not to this repo
- **ADW integration**: `adwInit.tsx` calls `depaudit setup` as a post-clone step; `/depaudit-triage` skill lives in ADW's `.claude/skills/`

## Library Install Command
bun add {library}

## Script Execution
bun run {script}
