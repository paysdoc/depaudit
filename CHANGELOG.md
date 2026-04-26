# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-26

Initial public release.

### Added

- CLI skeleton with OSV-Scanner integration for CVE scanning of npm projects (#15).
- `ConfigLoader` and `Linter` with `osv-scanner.toml` CVE accept-list support (#16).
- `.depaudit.yml` schema, `FindingMatcher`, and severity threshold gating (#17).
- Polyglot ecosystem support: pip, gomod, cargo, maven, gem, composer (#18).
- `SocketApiClient` for supply-chain findings with fail-open behaviour on API outage (#19).
- `JsonReporter` that writes findings to `.depaudit/findings.json` (#22).
- `MarkdownReporter` for stdout output and PR-comment-ready markdown (#23).
- GitHub Actions `depaudit-gate.yml` template with PR comment integration and `StateTracker` (#24).
- `SlackReporter` with first-failure-per-PR notifications via `StateTracker` (#25).
- `depaudit setup` command: baseline generation and commit-or-PR executor (#26).
- Orphan auto-prune in `ScanCommand` with fail-open guard (#20).

[1.0.0]: https://github.com/paysdoc/depaudit/releases/tag/v1.0.0
