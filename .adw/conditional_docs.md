## Conditional Documentation

- [README.md](../README.md)
  - Owns:
    - README.md
  - Conditions:
    - Always include; project overview and status

- [specs/prd/depaudit.md](../specs/prd/depaudit.md)
  - Owns:
    - specs/prd/depaudit.md
  - Conditions:
    - When working on architecture decisions, new features, or understanding module boundaries across the depaudit CLI; contains the full design, user stories, implementation decisions, and module contracts

- [app_docs/feature-442uul-cli-skeleton-osv-scan.md](../app_docs/feature-442uul-cli-skeleton-osv-scan.md)
  - Owns:
    - src/cli.ts
    - src/commands/scanCommand.ts
    - src/modules/stdoutReporter.ts
    - src/types/finding.ts
    - src/types/manifest.ts
  - Conditions:
    - When working on the CLI entry point, argument parsing, the `depaudit scan` command composition root, plain-text stdout reporting, or the core `Finding`/`Manifest` types; when troubleshooting CLI exit codes or severity derivation

- [app_docs/feature-oowire-configloader-linter-cve-ignores.md](../app_docs/feature-oowire-configloader-linter-cve-ignores.md)
  - Owns:
    - src/types/osvScannerConfig.ts
    - src/modules/configLoader.ts
    - src/modules/linter.ts
    - src/modules/lintReporter.ts
    - src/commands/lintCommand.ts
  - Conditions:
    - When working on the `ConfigLoader`, `Linter`, `LintReporter`, `LintCommand`, or `osv-scanner.toml` parsing/acceptance entries; when implementing lint rules or scan-time CVE suppression; when troubleshooting lint pre-flight failures, `ConfigParseError` line/col reporting, or `ignoreUntil` expiry logic; when working on the `depaudit lint` subcommand

- [app_docs/feature-5sllud-depaudit-yml-schema-finding-matcher.md](../app_docs/feature-5sllud-depaudit-yml-schema-finding-matcher.md)
  - Owns:
    - src/types/depauditConfig.ts
    - src/modules/findingMatcher.ts
  - Conditions:
    - When working on the `.depaudit.yml` schema or parsing, `FindingMatcher`, `classifyFindings`, severity threshold configuration, `commonAndFine` whitelisting, `supplyChainAccepts`, `lintDepauditConfig`, or the four-way finding classification (`new`, `accepted`, `whitelisted`, `expired-accept`); when troubleshooting expired-accept stderr output or understanding why findings are dropped below threshold

- [app_docs/feature-m8fl2v-depaudit-yml-schema-finding-matcher.md](../app_docs/feature-m8fl2v-depaudit-yml-schema-finding-matcher.md)
  - Owns: (none — duplicate of feature-5sllud-depaudit-yml-schema-finding-matcher.md; see that entry for the canonical `Owns` glob list)
  - Conditions:
    - When working on the `.depaudit.yml` schema or parsing, `FindingMatcher`, `classifyFindings`, severity threshold configuration, `commonAndFine` whitelisting, `supplyChainAccepts`, `lintDepauditConfig`, or the four-way finding classification (`new`, `accepted`, `whitelisted`, `expired-accept`); when troubleshooting expired-accept stderr output or understanding why findings are dropped below threshold

- [app_docs/feature-u2drew-polyglot-manifest-discoverer.md](../app_docs/feature-u2drew-polyglot-manifest-discoverer.md)
  - Owns:
    - src/modules/manifestDiscoverer.ts
    - src/modules/osvScannerAdapter.ts
  - Conditions:
    - When working on `ManifestDiscoverer`, `OsvScannerAdapter`, or the `Ecosystem` type; when adding a new manifest type or ecosystem; when troubleshooting missing manifests in polyglot repos, build-directory bleed-through, or unknown OSV ecosystem errors; when scanning non-npm repos (pip, gomod, cargo, maven, gem, composer)

- [app_docs/feature-kteamd-socketapiclient-supply-chain.md](../app_docs/feature-kteamd-socketapiclient-supply-chain.md)
  - Owns:
    - src/modules/socketApiClient.ts
    - src/types/scanResult.ts
  - Conditions:
    - When working on `SocketApiClient`, `fetchSocketFindings`, `ScanResult`, or supply-chain findings; when implementing or debugging fail-open / fail-loud Socket.dev behaviour; when troubleshooting `SOCKET_API_TOKEN` auth errors, retry/backoff logic, PURL conversion, severity mapping, or `supplyChainAccepts` matching; when adding new ecosystems to the Socket scan pipeline

- [app_docs/feature-ekjs2i-socketapiclient-supply-chain.md](../app_docs/feature-ekjs2i-socketapiclient-supply-chain.md)
  - Owns: (none — duplicate of feature-kteamd-socketapiclient-supply-chain.md; see that entry for the canonical `Owns` glob list)
  - Conditions:
    - When working on `SocketApiClient`, `fetchSocketFindings`, `ScanResult`, or supply-chain findings; when implementing or debugging fail-open / fail-loud Socket.dev behaviour; when troubleshooting `SOCKET_API_TOKEN` auth errors, retry/backoff logic, PURL conversion, severity mapping, or `supplyChainAccepts` matching; when adding new ecosystems to the Socket scan pipeline

- [app_docs/feature-82j9dc-orphan-auto-prune.md](../app_docs/feature-82j9dc-orphan-auto-prune.md)
  - Owns:
    - src/modules/orphanDetector.ts
    - src/modules/configWriter.ts
  - Conditions:
    - When working on orphan auto-prune, `orphanDetector`, `configWriter`, `pruneDepauditYml`, `pruneOsvScannerToml`, `osvAvailable`, or in-place mutation of `.depaudit.yml` / `osv-scanner.toml`; when troubleshooting why stale accepts are or aren't being removed; when extending the prune step with OSV fail-soft behaviour

- [app_docs/feature-2rdowb-json-reporter.md](../app_docs/feature-2rdowb-json-reporter.md)
  - Owns:
    - src/modules/jsonReporter.ts
    - src/types/findingsJson.ts
  - Conditions:
    - When working on `JsonReporter`, `.depaudit/findings.json`, the `FindingsJsonSchema` shape, the `/depaudit-triage` skill handoff, or gitignore warnings on un-ignored artifacts; when troubleshooting snapshot-test failures on the rendered JSON output; when extending the findings schema or adding new classification categories

- [app_docs/feature-xgupjx-markdown-reporter.md](../app_docs/feature-xgupjx-markdown-reporter.md)
  - Owns:
    - src/modules/markdownReporter.ts
    - src/types/markdownReport.ts
  - Conditions:
    - When working on `MarkdownReporter`, the `--format` CLI flag, the PR-comment marker, the new-findings or expired-accepts tables, the supply-chain-unavailable annotation, the markdown report's stdout placement, or the legacy `--format text` opt-out for line-based stdout; when troubleshooting snapshot-test failures on the rendered markdown output; when migrating BDD scenarios that depended on `FINDING_LINE_RE` stdout to opt into `--format text`

- [app_docs/feature-e1layl-github-actions-gate-state-tracker.md](../app_docs/feature-e1layl-github-actions-gate-state-tracker.md)
  - Owns:
    - src/types/prComment.ts
    - src/modules/stateTracker.ts
    - src/modules/ghPrCommentClient.ts
    - src/commands/postPrCommentCommand.ts
  - Conditions:
    - When working on the `.github/workflows/depaudit-gate.yml` template, `StateTracker`, `GhPrCommentClient`, the `depaudit post-pr-comment` subcommand, single-comment-in-place PR behaviour, or `GH_TOKEN` / `GITHUB_EVENT_PATH` resolution; when troubleshooting missing-or-duplicated gate comments; when extending the workflow to add Slack first-failure dedupe in a future slice

- [app_docs/feature-2sm4zt-slack-reporter-state-tracker-transitions.md](../app_docs/feature-2sm4zt-slack-reporter-state-tracker-transitions.md)
  - Owns:
    - src/modules/slackReporter.ts
  - Conditions:
    - When working on `SlackReporter`, `postSlackNotification`, the `SLACK_WEBHOOK_URL` env var, `StateTracker.computeTransition`, `StateTracker.outcomeFromBody`, the `SlackTransition` type, the fail-soft Slack contract, or first-failure-per-PR dedupe; when troubleshooting Slack notifications firing too often, not firing at all, or affecting the gate's exit code; when extending the workflow to add a separate `slack-notify` subcommand or to retry the Slack POST

- [app_docs/feature-1j2fia-depauditsetupcommand.md](../app_docs/feature-1j2fia-depauditsetupcommand.md)
  - Owns:
    - src/commands/depauditSetupCommand.ts
    - src/modules/commitOrPrExecutor.ts
    - src/modules/gitRemoteResolver.ts
    - src/modules/templateInstaller.ts
  - Conditions:
    - When working on `depaudit setup`, `DepauditSetupCommand`, `CommitOrPrExecutor`, `gitRemoteResolver`, `templateInstaller`, or the baseline-write helpers (`appendDepauditYmlBaseline`, `appendOsvScannerTomlBaseline`); when troubleshooting trigger-branch resolution, scaffold idempotency, baseline filtering by severity, commit-vs-PR branch decisions, or branch-collision suffix logic; when extending or testing the setup command end to end
