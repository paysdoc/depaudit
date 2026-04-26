# depaudit

Polyglot dependency audit gate. Scans every manifest in a repo for CVEs (via OSV.dev) and supply-chain risk (via Socket.dev), classifies findings against a committed, time-limited acceptance list, and fails CI when new or expired findings exist.

## Install

```sh
npm install -g @paysdoc/depaudit
```

depaudit shells out to [`osv-scanner`](https://google.github.io/osv-scanner/installation/) for CVE scanning, so that binary must also be on `PATH`.

## Getting Started

In the root of the repo you want to gate:

```sh
depaudit setup
```

This will:

- Scaffold `.depaudit.yml`, `osv-scanner.toml`, and `.github/workflows/depaudit-gate.yml`
- Run a baseline scan and record current findings as accepted (so existing issues don't fail the first CI run)
- Commit the scaffold to your trigger branch, or open a PR if it's protected

Subsequent CI runs will fail the gate whenever new or expired findings appear.

## Configuration

depaudit reads the following from the environment of the process running the scan (typically your CI job):

| Variable | Required | Description |
|---|---|---|
| `SOCKET_API_TOKEN` | Yes | Socket.dev API token. Without it the gate fails with exit code 2. Get one at https://socket.dev. |
| `SLACK_WEBHOOK_URL` | No | Slack Incoming Webhook for first-failure-per-PR notifications. If unset, Slack reporting is silently skipped. |

If the Socket API is unreachable or rate-limits during a scan, depaudit fails open: it logs `socket: supply-chain unavailable` to stderr and gates on CVE findings only. The token must still be present.

## Domain Language

See [UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md) for the canonical definitions of terms used throughout this codebase — Findings, Acceptances, the Gate, trigger branches, and more.

## Project Structure

```
.adw/                    # ADW project config (commands, providers, scenarios)
.claude/                 # Claude Code commands and skills
app_docs/                # Feature documentation (per implemented slice)
features/                # Cucumber e2e feature files and step definitions
fixtures/                # Fixture repos for e2e tests
specs/
  prd/
    depaudit.md          # Full product requirements document
  issue-*.md             # Per-issue ADW plan specs
  patch/                 # Patch specs for incremental fixes
src/
  cli.ts                 # CLI entry point
  commands/
    scanCommand.ts       # ScanCommand composition root
    lintCommand.ts       # LintCommand composition root
    postPrCommentCommand.ts  # PostPrCommentCommand composition root
    __tests__/           # Unit tests for commands
  modules/               # Deep modules (ManifestDiscoverer, OsvScannerAdapter, ConfigLoader, Linter,
                         #   FindingMatcher, StateTracker, GhPrCommentClient, JsonReporter,
                         #   MarkdownReporter, SocketApiClient, OrphanDetector, ConfigWriter, etc.)
    __tests__/           # Unit tests with fixture data
  types/                 # Shared domain types (Finding, Manifest, ScanResult, DepauditConfig,
                         #   OsvScannerConfig, PrComment, MarkdownReport, etc.)
templates/
  depaudit-gate.yml      # GitHub Actions gate workflow template (copied by depaudit setup)
.env.sample              # Environment variable template
UBIQUITOUS_LANGUAGE.md   # Domain glossary
cucumber.js              # Cucumber e2e runner config
package.json
tsconfig.json
```
