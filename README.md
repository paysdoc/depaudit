# depaudit

A CI gate that scans your repo's dependencies for CVEs and supply-chain risk, and only fails the build on findings you haven't already reviewed.

## What it does

- **Polyglot manifest discovery** — walks the repo for `package.json`, `requirements.txt`/`pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, and `composer.json`, honoring `.gitignore` plus built-in excludes (`node_modules/`, `.git/`, `vendor/`, `target/`, `.venv/`, `__pycache__/`).
- **CVE scanning via OSV-Scanner** — shells out to the `osv-scanner` binary per ecosystem and normalizes results (CVE/GHSA IDs, severity, fixed version) into a common `Finding` type.
- **Supply-chain risk via Socket.dev** — calls the Socket.dev REST API for alert-type signals on direct and transitive packages, with retry and **fail-open** behavior if the API is unreachable or rate-limited (CVE gating still applies).
- **Finding classification** — matches each finding against the acceptance register by exact `(package, version, finding-ID)` identity, bucketing into `new`, `accepted`, `whitelisted`, or `expired-accept`.
- **Time-limited acceptances** — per-finding accepts capped at 90 days and category-wide "common-and-fine" entries capped at 365 days, each requiring a written reason; the gate re-fails once an entry expires.
- **Config linting** — validates `.depaudit.yml` and `osv-scanner.toml` for schema errors, expired or unparsable dates, and unsupported ecosystems, with file:line:column error output.
- **Severity threshold policy** — configurable per repo (`medium`, `high`, or `critical`) to control which findings actually fail the gate.
- **Orphan auto-pruning** — detects acceptance entries whose finding no longer appears in scan results and removes them from the owning config file, while preserving comments/formatting; entries are left untouched if their finding source was unavailable during the run.
- **`depaudit setup` bootstrap command** — scaffolds `.depaudit.yml`, `osv-scanner.toml`, and a GitHub Actions gate workflow in a target repo, runs a baseline scan so pre-existing findings don't fail day one, then commits directly or opens a PR depending on branch protection.
- **Trigger-branch resolution** — resolves the repo's production branch (`main` if present, else the default branch) to decide whether setup commits directly or opens a PR.
- **GitHub Actions gate workflow template** — installs `osv-scanner` and `depaudit`, runs the scan, and posts/updates a single deduplicated PR comment with the results.
- **PR comment lifecycle management** — creates or updates one marked comment per PR (via `depaudit post-pr-comment`) instead of spamming a new comment on every push.
- **Markdown and JSON reporters** — human-readable PR comment output plus a machine-readable `.depaudit/findings.json` snapshot (schema-versioned) for downstream tooling.
- **Slack notifications on fail-edges** — pings a configured webhook only when a PR transitions from passing (or no prior run) to failing, avoiding repeat noise on consecutive failures.
- **CLI with scan/lint/setup/post-pr-comment subcommands** — `depaudit scan`, `depaudit lint`, `depaudit setup`, and `depaudit post-pr-comment`, each independently runnable outside CI.
- **`/depaudit-triage` Claude Code skill** — interactive, sequential walkthrough of findings in `.depaudit/findings.json` to accept-with-reason or skip, without hand-editing YAML/TOML.
- **Ubiquitous-language glossary** — canonical domain terminology (Finding, Acceptance, Gate, Trigger branch, etc.) kept in sync with the codebase in [UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md).

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

For local development, copy `.env.sample` to `.env` in the repo root and fill in the values below.

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
.claude/
  commands/              # ADW slash commands (plan, implement, review, etc.)
  skills/                # Claude Code skills, incl. depaudit-triage (interactive finding review)
app_docs/                # Feature documentation (per implemented slice)
features/                # Cucumber e2e feature files, step definitions, and regression vocabulary
fixtures/                # Fixture repos for e2e tests
specs/
  prd/
    depaudit.md          # Full product requirements document
  issue-*.md             # Per-issue ADW plan specs
  patch/                 # Patch specs for incremental fixes
src/
  cli.ts                 # CLI entry point (scan/lint/setup/post-pr-comment)
  commands/
    scanCommand.ts             # ScanCommand composition root
    lintCommand.ts             # LintCommand composition root
    depauditSetupCommand.ts    # DepauditSetupCommand composition root
    postPrCommentCommand.ts    # PostPrCommentCommand composition root
    __tests__/           # Unit tests for commands
  modules/               # Deep modules (ManifestDiscoverer, OsvScannerAdapter, ConfigLoader, Linter,
                         #   FindingMatcher, StateTracker, GhPrCommentClient, GitRemoteResolver,
                         #   CommitOrPrExecutor, TemplateInstaller, JsonReporter, MarkdownReporter,
                         #   StdoutReporter, SlackReporter, SocketApiClient, OrphanDetector, ConfigWriter, etc.)
    __tests__/           # Unit tests with fixture data
  types/                 # Shared domain types (Finding, Manifest, ScanResult, DepauditConfig,
                         #   OsvScannerConfig, PrComment, MarkdownReport, FindingsJson, etc.)
templates/
  depaudit-gate.yml      # GitHub Actions gate workflow template (copied by depaudit setup)
.env.sample              # Environment variable template
UBIQUITOUS_LANGUAGE.md   # Domain glossary
CHANGELOG.md
cucumber.js              # Cucumber e2e runner config
package.json
tsconfig.json
```
