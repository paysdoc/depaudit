# depaudit

Polyglot dependency audit gate. Scans every manifest in a repo for CVEs (via OSV.dev) and supply-chain risk (via Socket.dev), classifies findings against a committed, time-limited acceptance list, and fails CI when new or expired findings exist.

## Status

Pre-release. See [specs/prd/depaudit.md](specs/prd/depaudit.md) for the full design.

Work is tracked in this repo's [Issues](https://github.com/paysdoc/depaudit/issues). Slice numbering comes from the PRD's tracer-bullet breakdown.

## Setup

Copy `.env.sample` to `.env` and fill in your credentials:

```sh
cp .env.sample .env
```

| Variable | Description |
|---|---|
| `SOCKET_API_TOKEN` | Socket.dev API token for supply-chain risk scanning |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL for gate failure notifications |

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
