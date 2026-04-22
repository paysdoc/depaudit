@adw-9
Feature: depaudit scan — MarkdownReporter renders pass/fail markdown for stdout and PR comments
  As a maintainer reviewing a PR
  I want every `depaudit scan` to emit its classified result as PR-comment-ready markdown to stdout
  So that the same byte stream powers the CI PR-comment update path AND the local terminal view,
  with clear pass/fail headers, counts in each classification bucket, a new-findings table that
  tells contributors exactly how to remediate, a distinct expired-accepts section when present,
  and a supply-chain-unavailable annotation when Socket failed open

  Background:
    Given the `osv-scanner` binary is installed and on PATH
    And the `depaudit` CLI is installed and on PATH

  # ─── Format selection: --format markdown and the default route ──────────────

  @adw-9 @regression
  Scenario: depaudit scan with no --format flag routes through MarkdownReporter (markdown is the default)
    Given a fixture Node repository at "fixtures/md-default-format" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-default-format"
    Then the exit code is 0
    And stdout contains the HTML marker "<!-- depaudit-gate-comment -->"
    And stdout contains a markdown header indicating a passing gate

  @adw-9 @regression
  Scenario: depaudit scan --format markdown routes through MarkdownReporter
    Given a fixture Node repository at "fixtures/md-explicit-format" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-explicit-format --format markdown"
    Then the exit code is 0
    And stdout contains the HTML marker "<!-- depaudit-gate-comment -->"
    And stdout contains a markdown header indicating a passing gate

  # ─── HTML marker is always present so the PR-comment updater can identify it ─

  @adw-9 @regression
  Scenario: stdout markdown always includes the depaudit-gate-comment HTML marker
    Given a fixture Node repository at "fixtures/md-marker-present" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-marker-present"
    Then the exit code is non-zero
    And stdout contains the HTML marker "<!-- depaudit-gate-comment -->"

  # ─── Pass shape: header with all four counts, no new-findings table ─────────

  @adw-9 @regression
  Scenario: Clean repo emits a pass markdown header with counts new=0, accepted=0, whitelisted=0, expired=0
    Given a fixture Node repository at "fixtures/md-pass-clean" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-pass-clean"
    Then the exit code is 0
    And stdout contains a markdown header indicating a passing gate
    And the markdown header reports counts of `new=0`, `accepted=0`, `whitelisted=0`, `expired=0`
    And stdout does not contain a markdown table titled "New findings"
    And stdout does not contain a markdown section titled "Expired accepts"

  @adw-9 @regression
  Scenario: Pass output omits the new-findings table when zero new findings exist
    Given a fixture Node repository at "fixtures/md-pass-no-new-table" whose manifest pins a package with a known OSV CVE
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for that CVE's id with a valid `ignoreUntil` and a `reason` of at least 20 characters
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-pass-no-new-table"
    Then the exit code is 0
    And stdout contains a markdown header indicating a passing gate
    And the markdown header reports a count of `accepted=1`
    And stdout does not contain a markdown table titled "New findings"

  # ─── Fail shape: fail header + new-findings table with required columns ─────

  @adw-9 @regression
  Scenario: New CVE produces a fail markdown header
    Given a fixture Node repository at "fixtures/md-fail-new-cve" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-fail-new-cve"
    Then the exit code is non-zero
    And stdout contains a markdown header indicating a failing gate
    And the markdown header reports a count of `new=1`
    And stdout contains a markdown table titled "New findings"

  @adw-9 @regression
  Scenario: New-findings table contains columns severity, package, version, finding-id, suggested action
    Given a fixture Node repository at "fixtures/md-new-table-columns" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-new-table-columns"
    Then the exit code is non-zero
    And the "New findings" markdown table has the column headers "severity", "package", "version", "finding-id", "suggested action"

  @adw-9 @regression
  Scenario: New-findings row carries the finding's package, version, finding-id, and severity
    Given a fixture Node repository at "fixtures/md-new-row-content" that produces exactly one OSV finding
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-new-row-content"
    Then the exit code is non-zero
    And the "New findings" markdown table has exactly one data row
    And that row contains the finding's package name, version, finding-id, and severity

  @adw-9 @regression
  Scenario: New-findings table includes a Socket supply-chain finding alongside its OSV CVE siblings
    Given a fixture Node repository at "fixtures/md-new-row-socket" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package in that manifest
    When I run "depaudit scan fixtures/md-new-row-socket"
    Then the exit code is non-zero
    And stdout contains a markdown table titled "New findings"
    And the "New findings" markdown table contains a row whose finding-id is the supply-chain alert type "install-scripts"

  # ─── Suggested-action column: OSV fixed-version vs. plain-text fallback ────

  @adw-9 @regression
  Scenario: Suggested action shows the OSV fixed-version recommendation when a fixed version is available
    Given a fixture Node repository at "fixtures/md-suggest-osv-fix" whose manifest pins a package with a known OSV CVE that has a published fixed version "1.2.4"
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-suggest-osv-fix"
    Then the exit code is non-zero
    And the "New findings" markdown table row's "suggested action" cell mentions the fixed version "1.2.4"

  @adw-9 @regression
  Scenario: Suggested action falls back to plain "investigate; accept or upgrade" when no OSV fixed version is available
    Given a fixture Node repository at "fixtures/md-suggest-fallback" whose manifest pins a package with a known OSV CVE that has no published fixed version
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-suggest-fallback"
    Then the exit code is non-zero
    And the "New findings" markdown table row's "suggested action" cell contains the text "investigate; accept or upgrade"

  @adw-9
  Scenario: Suggested action for a Socket supply-chain finding is the plain-text fallback (no OSV fixed-version path)
    Given a fixture Node repository at "fixtures/md-suggest-socket-fallback" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package in that manifest
    When I run "depaudit scan fixtures/md-suggest-socket-fallback"
    Then the exit code is non-zero
    And the "New findings" markdown table row whose finding-id is "install-scripts" has a "suggested action" cell containing the text "investigate; accept or upgrade"

  # ─── Mixed: classification counts in the header reflect every bucket ────────

  @adw-9 @regression
  Scenario: Mixed scan with new + accepted + whitelisted findings reports every count in the header
    Given a fixture Node repository at "fixtures/md-mixed-counts" whose manifest pins a package with a known OSV CVE and declares two additional packages
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for the second declared package and a "typosquat" alert for the third declared package
    And the repository's .depaudit.yml has a valid `supplyChainAccepts` entry matching the second package's (package, version, alertType="install-scripts") tuple
    And the repository's .depaudit.yml has a `commonAndFine` entry matching the third package's (package, alertType="typosquat") tuple with a valid expiry
    When I run "depaudit scan fixtures/md-mixed-counts"
    Then the exit code is non-zero
    And stdout contains a markdown header indicating a failing gate
    And the markdown header reports counts of `new=1`, `accepted=1`, `whitelisted=1`, `expired=0`

  @adw-9 @regression
  Scenario: Accepted findings increment the `accepted` count but do NOT appear in the new-findings table
    Given a fixture Node repository at "fixtures/md-accepted-not-in-table" whose manifest pins a package with a known OSV CVE
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for that CVE's id with a valid `ignoreUntil` and a `reason` of at least 20 characters
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-accepted-not-in-table"
    Then the exit code is 0
    And the markdown header reports a count of `accepted=1`
    And stdout does not contain a markdown table titled "New findings"

  @adw-9 @regression
  Scenario: Whitelisted findings increment the `whitelisted` count but do NOT appear in the new-findings table
    Given a fixture Node repository at "fixtures/md-whitelisted-not-in-table" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package in that manifest
    And the repository's .depaudit.yml has a `commonAndFine` entry matching that (package, alertType) tuple with a valid expiry
    When I run "depaudit scan fixtures/md-whitelisted-not-in-table"
    Then the exit code is 0
    And the markdown header reports a count of `whitelisted=1`
    And stdout does not contain a markdown table titled "New findings"

  # ─── Expired-accepts dedicated section ──────────────────────────────────────

  @adw-9 @regression
  Scenario: Expired-accept produces a fail header AND a distinct "Expired accepts" section
    Given a fixture Node repository at "fixtures/md-expired-section" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for that CVE's id whose `ignoreUntil` lint-passes but is treated as expired by FindingMatcher at scan time
    When I run "depaudit scan fixtures/md-expired-section"
    Then the exit code is non-zero
    And stdout contains a markdown header indicating a failing gate
    And the markdown header reports a count of `expired=1`
    And stdout contains a markdown section titled "Expired accepts"
    And the "Expired accepts" markdown table contains a row whose finding-id is the expired CVE's id

  @adw-9 @regression
  Scenario: "Expired accepts" section is omitted entirely when no expired-accept findings exist
    Given a fixture Node repository at "fixtures/md-no-expired-section" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-no-expired-section"
    Then the exit code is non-zero
    And the markdown header reports a count of `expired=0`
    And stdout does not contain a markdown section titled "Expired accepts"

  @adw-9
  Scenario: Expired-accept-only scan (no new findings) still fails the gate and renders only the Expired-accepts section
    Given a fixture Node repository at "fixtures/md-expired-only" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for that CVE's id whose `ignoreUntil` lint-passes but is treated as expired by FindingMatcher at scan time
    When I run "depaudit scan fixtures/md-expired-only"
    Then the exit code is non-zero
    And stdout contains a markdown header indicating a failing gate
    And the markdown header reports counts of `new=0`, `expired=1`
    And stdout does not contain a markdown table titled "New findings"
    And stdout contains a markdown section titled "Expired accepts"

  # ─── Supply-chain-unavailable annotation when socketAvailable: false ────────

  @adw-9 @regression
  Scenario: Socket HTTP 503 adds the supply-chain-unavailable annotation to the markdown
    Given a fixture Node repository at "fixtures/md-socket-503-annotation" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 503 for every request
    When I run "depaudit scan fixtures/md-socket-503-annotation"
    Then the exit code is 0
    And stdout contains a markdown annotation indicating supply-chain coverage is unavailable

  @adw-9 @regression
  Scenario: Socket timeout adds the supply-chain-unavailable annotation
    Given a fixture Node repository at "fixtures/md-socket-timeout-annotation" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that never responds within the client timeout
    When I run "depaudit scan fixtures/md-socket-timeout-annotation"
    Then the exit code is 0
    And stdout contains a markdown annotation indicating supply-chain coverage is unavailable

  @adw-9 @regression
  Scenario: Socket HTTP 429 adds the supply-chain-unavailable annotation
    Given a fixture Node repository at "fixtures/md-socket-429-annotation" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 429 for every request
    When I run "depaudit scan fixtures/md-socket-429-annotation"
    Then the exit code is 0
    And stdout contains a markdown annotation indicating supply-chain coverage is unavailable

  @adw-9 @regression
  Scenario: No supply-chain-unavailable annotation when Socket succeeds
    Given a fixture Node repository at "fixtures/md-socket-up-no-annotation" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-socket-up-no-annotation"
    Then the exit code is 0
    And stdout does not contain a markdown annotation indicating supply-chain coverage is unavailable

  # ─── Snapshot reproducibility (the formatting is part of the external contract) ─

  @adw-9 @regression
  Scenario: Identical scan input produces byte-identical markdown output across two runs (snapshot pass shape)
    Given a fixture Node repository at "fixtures/md-snapshot-pass" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-snapshot-pass" and capture the markdown stdout as "first"
    And I run "depaudit scan fixtures/md-snapshot-pass" and capture the markdown stdout as "second"
    Then the markdown stdout captured as "first" is byte-identical to the markdown stdout captured as "second"

  @adw-9 @regression
  Scenario: Identical scan input produces byte-identical markdown output across two runs (snapshot fail shape)
    Given a fixture Node repository at "fixtures/md-snapshot-fail" that produces exactly one OSV finding
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-snapshot-fail" and capture the markdown stdout as "first"
    And I run "depaudit scan fixtures/md-snapshot-fail" and capture the markdown stdout as "second"
    Then the markdown stdout captured as "first" is byte-identical to the markdown stdout captured as "second"

  @adw-9
  Scenario: Identical scan input produces byte-identical markdown output across two runs (snapshot expired-only shape)
    Given a fixture Node repository at "fixtures/md-snapshot-expired" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for that CVE's id whose `ignoreUntil` lint-passes but is treated as expired by FindingMatcher at scan time
    When I run "depaudit scan fixtures/md-snapshot-expired" and capture the markdown stdout as "first"
    And I run "depaudit scan fixtures/md-snapshot-expired" and capture the markdown stdout as "second"
    Then the markdown stdout captured as "first" is byte-identical to the markdown stdout captured as "second"

  @adw-9
  Scenario: Identical scan input produces byte-identical markdown output across two runs (snapshot supply-chain-unavailable shape)
    Given a fixture Node repository at "fixtures/md-snapshot-sca-unavail" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 503 for every request
    When I run "depaudit scan fixtures/md-snapshot-sca-unavail" and capture the markdown stdout as "first"
    And I run "depaudit scan fixtures/md-snapshot-sca-unavail" and capture the markdown stdout as "second"
    Then the markdown stdout captured as "first" is byte-identical to the markdown stdout captured as "second"

  # ─── Polyglot ──────────────────────────────────────────────────────────────

  @adw-9
  Scenario: Polyglot scan surfaces findings from every ecosystem in one markdown new-findings table
    Given a fixture repository at "fixtures/md-polyglot-table" with the following manifests:
      | path             | ecosystem |
      | package.json     | npm       |
      | requirements.txt | pip       |
    And each listed manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/md-polyglot-table"
    Then the exit code is non-zero
    And stdout contains a markdown table titled "New findings"
    And the "New findings" markdown table contains at least one row whose package is declared in "package.json"
    And the "New findings" markdown table contains at least one row whose package is declared in "requirements.txt"

  # ─── Format flag rejection ──────────────────────────────────────────────────

  @adw-9
  Scenario: Unknown --format value is rejected with a clear error before the scan runs
    Given a fixture Node repository at "fixtures/md-unknown-format" whose manifests have no known CVEs
    When I run "depaudit scan fixtures/md-unknown-format --format yaml"
    Then the exit code is non-zero
    And stderr mentions "format"
    And stderr mentions "markdown"
