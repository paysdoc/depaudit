@adw-13
Feature: depaudit scan — auto-prune of orphaned accept entries with fail-open guard
  As a maintainer whose upgrade PRs resolve previously-accepted findings
  I want `depaudit scan` to automatically remove accept entries whose finding no longer exists in the tree
  So that I don't have to open a cleanup PR just to delete stale YAML/TOML,
  while still preserving accepts whose finding source was unavailable this run (fail-open safety)

  Background:
    Given the `osv-scanner` binary is installed and on PATH
    And the `depaudit` CLI is installed and on PATH

  # ─── Happy path: orphans are pruned from both files ─────────────────────────

  @adw-13 @regression
  Scenario: Orphaned supplyChainAccepts entry is removed from .depaudit.yml after a clean scan
    Given a fixture Node repository at "fixtures/prune-sca-orphan" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the repository's .depaudit.yml has a `supplyChainAccepts` entry for package "ghost-pkg" at version "9.9.9" that matches no current finding
    When I run "depaudit scan fixtures/prune-sca-orphan"
    Then the exit code is 0
    And stdout contains no finding lines
    And the .depaudit.yml in "fixtures/prune-sca-orphan" no longer contains a `supplyChainAccepts` entry for package "ghost-pkg"

  @adw-13 @regression
  Scenario: Orphaned [[IgnoredVulns]] entry is removed from osv-scanner.toml after a clean scan
    Given a fixture Node repository at "fixtures/prune-cve-orphan" whose manifests have no known CVEs
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for id "CVE-ORPHAN-0001" that matches no current finding
    When I run "depaudit scan fixtures/prune-cve-orphan"
    Then the exit code is 0
    And stdout contains no finding lines
    And the osv-scanner.toml in "fixtures/prune-cve-orphan" no longer contains an `[[IgnoredVulns]]` entry for id "CVE-ORPHAN-0001"

  @adw-13 @regression
  Scenario: Both files are pruned in a single scan when each carries its own orphan
    Given a fixture Node repository at "fixtures/prune-both-files" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the repository's .depaudit.yml has a `supplyChainAccepts` entry for package "ghost-pkg" at version "9.9.9" that matches no current finding
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for id "CVE-ORPHAN-0010" that matches no current finding
    When I run "depaudit scan fixtures/prune-both-files"
    Then the exit code is 0
    And the .depaudit.yml in "fixtures/prune-both-files" no longer contains a `supplyChainAccepts` entry for package "ghost-pkg"
    And the osv-scanner.toml in "fixtures/prune-both-files" no longer contains an `[[IgnoredVulns]]` entry for id "CVE-ORPHAN-0010"

  # ─── Matching accepts are preserved (negative controls) ─────────────────────

  @adw-13 @regression
  Scenario: Matching supplyChainAccepts entry is NOT pruned when Socket reports the same alert
    Given a fixture Node repository at "fixtures/prune-sca-matching" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package in that manifest
    And the repository's .depaudit.yml has a valid `supplyChainAccepts` entry matching that (package, version, alertType) tuple
    When I run "depaudit scan fixtures/prune-sca-matching"
    Then the exit code is 0
    And the .depaudit.yml in "fixtures/prune-sca-matching" still contains the matching `supplyChainAccepts` entry

  @adw-13 @regression
  Scenario: Matching [[IgnoredVulns]] entry is NOT pruned when OSV reports the same CVE
    Given a fixture Node repository at "fixtures/prune-cve-matching" whose manifest pins a package with a known OSV CVE
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for that CVE's id with a valid `ignoreUntil` and a `reason` of at least 20 characters
    When I run "depaudit scan fixtures/prune-cve-matching"
    Then the exit code is 0
    And the osv-scanner.toml in "fixtures/prune-cve-matching" still contains an `[[IgnoredVulns]]` entry for that CVE

  # ─── Selective pruning when multiple entries are present ────────────────────

  @adw-13 @regression
  Scenario: Only the orphan entry is removed when .depaudit.yml has both a matching and an orphan supplyChainAccepts entry
    Given a fixture Node repository at "fixtures/prune-sca-mixed" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package in that manifest
    And the repository's .depaudit.yml has two `supplyChainAccepts` entries: one matching the Socket alert and one for package "ghost-pkg" at version "9.9.9" that matches no current finding
    When I run "depaudit scan fixtures/prune-sca-mixed"
    Then the exit code is 0
    And the .depaudit.yml in "fixtures/prune-sca-mixed" no longer contains a `supplyChainAccepts` entry for package "ghost-pkg"
    And the .depaudit.yml in "fixtures/prune-sca-mixed" still contains a `supplyChainAccepts` entry matching the Socket alert

  # ─── Fail-open guard: Socket unavailable protects supply-chain accepts ──────

  @adw-13 @regression
  Scenario: Orphaned supplyChainAccepts entry is PRESERVED when Socket returns HTTP 503
    Given a fixture Node repository at "fixtures/prune-sca-socket-503" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 503 for every request
    And the repository's .depaudit.yml has a `supplyChainAccepts` entry for package "ghost-pkg" at version "9.9.9" that matches no current finding
    When I run "depaudit scan fixtures/prune-sca-socket-503"
    Then the exit code is 0
    And stderr mentions "supply-chain unavailable"
    And the .depaudit.yml in "fixtures/prune-sca-socket-503" still contains a `supplyChainAccepts` entry for package "ghost-pkg"

  @adw-13 @regression
  Scenario: Orphaned supplyChainAccepts entry is PRESERVED when Socket times out
    Given a fixture Node repository at "fixtures/prune-sca-socket-timeout" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that never responds within the client timeout
    And the repository's .depaudit.yml has a `supplyChainAccepts` entry for package "ghost-pkg" at version "9.9.9" that matches no current finding
    When I run "depaudit scan fixtures/prune-sca-socket-timeout"
    Then the exit code is 0
    And stderr mentions "supply-chain unavailable"
    And the .depaudit.yml in "fixtures/prune-sca-socket-timeout" still contains a `supplyChainAccepts` entry for package "ghost-pkg"

  @adw-13 @regression
  Scenario: Orphaned supplyChainAccepts entry is PRESERVED when Socket returns HTTP 429
    Given a fixture Node repository at "fixtures/prune-sca-socket-429" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 429 for every request
    And the repository's .depaudit.yml has a `supplyChainAccepts` entry for package "ghost-pkg" at version "9.9.9" that matches no current finding
    When I run "depaudit scan fixtures/prune-sca-socket-429"
    Then the exit code is 0
    And stderr mentions "supply-chain unavailable"
    And the .depaudit.yml in "fixtures/prune-sca-socket-429" still contains a `supplyChainAccepts` entry for package "ghost-pkg"

  # ─── Cross-source isolation: Socket outage does not protect CVE accepts ─────

  @adw-13 @regression
  Scenario: When Socket is down, orphan CVE accepts are still pruned (OSV ran successfully)
    Given a fixture Node repository at "fixtures/prune-cve-socket-down" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 503 for every request
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for id "CVE-ORPHAN-0020" that matches no current finding
    And the repository's .depaudit.yml has a `supplyChainAccepts` entry for package "ghost-pkg" at version "9.9.9" that matches no current finding
    When I run "depaudit scan fixtures/prune-cve-socket-down"
    Then the exit code is 0
    And stderr mentions "supply-chain unavailable"
    And the osv-scanner.toml in "fixtures/prune-cve-socket-down" no longer contains an `[[IgnoredVulns]]` entry for id "CVE-ORPHAN-0020"
    And the .depaudit.yml in "fixtures/prune-cve-socket-down" still contains a `supplyChainAccepts` entry for package "ghost-pkg"

  # ─── Fail-open guard: OSV catastrophic failure protects CVE accepts ─────────

  @adw-13 @regression
  Scenario: Orphaned [[IgnoredVulns]] entry is PRESERVED when OSV scan fails catastrophically
    Given a fixture Node repository at "fixtures/prune-osv-fails" whose OSV scan fails catastrophically
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for id "CVE-ORPHAN-0030" that matches no current finding
    When I run "depaudit scan fixtures/prune-osv-fails"
    Then the exit code is non-zero
    And the osv-scanner.toml in "fixtures/prune-osv-fails" still contains an `[[IgnoredVulns]]` entry for id "CVE-ORPHAN-0030"

  # ─── Idempotency ────────────────────────────────────────────────────────────

  @adw-13 @regression
  Scenario: Re-running scan on an already-clean state produces no further mutations
    Given a fixture Node repository at "fixtures/prune-idempotent" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the repository's .depaudit.yml has version 1, default policy, and empty `commonAndFine` and `supplyChainAccepts`
    When I run "depaudit scan fixtures/prune-idempotent"
    And I capture the content of .depaudit.yml in "fixtures/prune-idempotent"
    And I run "depaudit scan fixtures/prune-idempotent"
    Then the exit code is 0
    And the .depaudit.yml content in "fixtures/prune-idempotent" is byte-identical to the captured content

  @adw-13
  Scenario: Re-running scan after an orphan was pruned produces no further mutations
    Given a fixture Node repository at "fixtures/prune-idempotent-post" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for id "CVE-ORPHAN-0040" that matches no current finding
    When I run "depaudit scan fixtures/prune-idempotent-post"
    And I capture the content of osv-scanner.toml in "fixtures/prune-idempotent-post"
    And I run "depaudit scan fixtures/prune-idempotent-post"
    Then the exit code is 0
    And the osv-scanner.toml content in "fixtures/prune-idempotent-post" is byte-identical to the captured content
