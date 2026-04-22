@adw-12
Feature: depaudit setup — baseline of existing findings at install time
  As a maintainer onboarding a repo that already has pre-existing findings
  I want `depaudit setup` to auto-accept every current finding at or above my severity threshold
  So that my first PR after installation doesn't fail on decades of pre-existing debt —
  with each baselined entry carrying a canonical `reason: "baselined at install"` and a 90-day
  `expires`/`ignoreUntil` that forces quarterly re-review, so the register naturally
  converts from "baselined" reasons into real decisions within one release cycle

  Background:
    Given the `osv-scanner` binary is installed and on PATH
    And the `depaudit` CLI is installed and on PATH
    And a mock `gh` CLI is on PATH that records its invocations and serves a fake remote branch list
    And a mock `git` CLI is on PATH that records its invocations and serves a fake repo state
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"

  # ─── Canonical reason + 90-day expiry on every entry ──────────────────────

  @adw-12 @regression
  Scenario: Every baselined CVE entry has reason "baselined at install"
    Given a fixture Node repository at "fixtures/baseline-cve-reason" whose manifest pins a package with a known MEDIUM-severity OSV finding
    When I run "depaudit setup" in "fixtures/baseline-cve-reason"
    Then the exit code is 0
    And every `[[IgnoredVulns]]` entry in "fixtures/baseline-cve-reason/osv-scanner.toml" has `reason` equal to "baselined at install"

  @adw-12 @regression
  Scenario: Every baselined CVE entry has ignoreUntil = today + 90 days
    Given a fixture Node repository at "fixtures/baseline-cve-expiry" whose manifest pins a package with a known MEDIUM-severity OSV finding
    When I run "depaudit setup" in "fixtures/baseline-cve-expiry"
    Then every `[[IgnoredVulns]]` entry in "fixtures/baseline-cve-expiry/osv-scanner.toml" has `ignoreUntil` equal to today plus 90 days

  @adw-12 @regression
  Scenario: Every baselined supply-chain entry has reason "baselined at install"
    Given a fixture Node repository at "fixtures/baseline-sca-reason" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package declared in that manifest
    When I run "depaudit setup" in "fixtures/baseline-sca-reason"
    Then the exit code is 0
    And every `supplyChainAccepts` entry in "fixtures/baseline-sca-reason/.depaudit.yml" has `reason` equal to "baselined at install"

  @adw-12 @regression
  Scenario: Every baselined supply-chain entry has expires = today + 90 days
    Given a fixture Node repository at "fixtures/baseline-sca-expiry" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package declared in that manifest
    When I run "depaudit setup" in "fixtures/baseline-sca-expiry"
    Then every `supplyChainAccepts` entry in "fixtures/baseline-sca-expiry/.depaudit.yml" has `expires` equal to today plus 90 days

  # ─── Routing: CVE → osv-scanner.toml, supply-chain → .depaudit.yml ────────

  @adw-12 @regression
  Scenario: A CVE finding is baselined into osv-scanner.toml (not .depaudit.yml)
    Given a fixture Node repository at "fixtures/baseline-route-cve" whose manifest pins a package with a known MEDIUM-severity OSV finding
    When I run "depaudit setup" in "fixtures/baseline-route-cve"
    Then "fixtures/baseline-route-cve/osv-scanner.toml" contains at least one `[[IgnoredVulns]]` entry whose id matches that CVE
    And "fixtures/baseline-route-cve/.depaudit.yml"'s `supplyChainAccepts` list is empty

  @adw-12 @regression
  Scenario: A supply-chain finding is baselined into .depaudit.yml (not osv-scanner.toml)
    Given a fixture Node repository at "fixtures/baseline-route-sca" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package declared in that manifest
    When I run "depaudit setup" in "fixtures/baseline-route-sca"
    Then "fixtures/baseline-route-sca/.depaudit.yml" contains at least one `supplyChainAccepts` entry for that (package, version, alertType)
    And "fixtures/baseline-route-sca/osv-scanner.toml" contains no `[[IgnoredVulns]]` entries

  @adw-12 @regression
  Scenario: A repo with both a CVE and a supply-chain finding baselines each into its correct file
    Given a fixture Node repository at "fixtures/baseline-route-both" whose manifest pins a package with a known MEDIUM-severity OSV finding
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a different package declared in that manifest
    When I run "depaudit setup" in "fixtures/baseline-route-both"
    Then "fixtures/baseline-route-both/osv-scanner.toml" contains exactly one `[[IgnoredVulns]]` entry for the CVE
    And "fixtures/baseline-route-both/.depaudit.yml" contains exactly one `supplyChainAccepts` entry for the Socket alert

  # ─── Severity-threshold filter ────────────────────────────────────────────

  @adw-12 @regression
  Scenario: A finding BELOW the default threshold of "medium" is NOT baselined
    Given a fixture Node repository at "fixtures/baseline-low-excluded" whose manifest pins a package with a known LOW-severity OSV finding
    When I run "depaudit setup" in "fixtures/baseline-low-excluded"
    Then the exit code is 0
    And "fixtures/baseline-low-excluded/osv-scanner.toml" contains no `[[IgnoredVulns]]` entries
    And "fixtures/baseline-low-excluded/.depaudit.yml"'s `supplyChainAccepts` list is empty

  @adw-12 @regression
  Scenario: A finding AT the default threshold of "medium" IS baselined (inclusive boundary)
    Given a fixture Node repository at "fixtures/baseline-medium-included" whose manifest pins a package with a known MEDIUM-severity OSV finding
    When I run "depaudit setup" in "fixtures/baseline-medium-included"
    Then "fixtures/baseline-medium-included/osv-scanner.toml" contains exactly one `[[IgnoredVulns]]` entry

  @adw-12 @regression
  Scenario: A finding ABOVE the default threshold (HIGH) is baselined
    Given a fixture Node repository at "fixtures/baseline-high-included" whose manifest pins a package with a known HIGH-severity OSV finding
    When I run "depaudit setup" in "fixtures/baseline-high-included"
    Then "fixtures/baseline-high-included/osv-scanner.toml" contains exactly one `[[IgnoredVulns]]` entry

  @adw-12
  Scenario: When a threshold is configured to "high", a MEDIUM finding is NOT baselined
    Given a fixture Node repository at "fixtures/baseline-threshold-high" whose manifest pins a package with a known MEDIUM-severity OSV finding
    And the fixture repo is pre-configured with a depaudit setup override setting `policy.severityThreshold` to "high"
    When I run "depaudit setup" in "fixtures/baseline-threshold-high"
    Then "fixtures/baseline-threshold-high/osv-scanner.toml" contains no `[[IgnoredVulns]]` entries

  # ─── Empty-repo and mixed-severity sanity ─────────────────────────────────

  @adw-12 @regression
  Scenario: A clean repo produces no baseline entries
    Given a fixture Node repository at "fixtures/baseline-clean" whose manifests have no known CVEs
    When I run "depaudit setup" in "fixtures/baseline-clean"
    Then the exit code is 0
    And "fixtures/baseline-clean/osv-scanner.toml" contains no `[[IgnoredVulns]]` entries
    And "fixtures/baseline-clean/.depaudit.yml"'s `supplyChainAccepts` list is empty

  @adw-12 @regression
  Scenario: Mixed severities — LOW is excluded, MEDIUM and HIGH are baselined
    Given a fixture Node repository at "fixtures/baseline-mixed" that produces one LOW-severity, one MEDIUM-severity, and one HIGH-severity OSV finding
    When I run "depaudit setup" in "fixtures/baseline-mixed"
    Then "fixtures/baseline-mixed/osv-scanner.toml" contains exactly two `[[IgnoredVulns]]` entries
    And no `[[IgnoredVulns]]` entry in "fixtures/baseline-mixed/osv-scanner.toml" matches the LOW-severity finding

  # ─── Polyglot: findings in multiple ecosystems all baseline ───────────────

  @adw-12 @regression
  Scenario: Polyglot findings across npm, gomod, and pip are all baselined into osv-scanner.toml
    Given a fixture repository at "fixtures/baseline-polyglot" with the following manifests:
      | path             | ecosystem |
      | package.json     | npm       |
      | go.mod           | gomod     |
      | requirements.txt | pip       |
    And each listed manifest pins a package with a known MEDIUM-severity OSV finding
    When I run "depaudit setup" in "fixtures/baseline-polyglot"
    Then "fixtures/baseline-polyglot/osv-scanner.toml" contains at least three `[[IgnoredVulns]]` entries

  # ─── Post-baseline green scan (the whole point of baseline) ───────────────

  @adw-12 @regression
  Scenario: After baseline, re-running `depaudit scan` exits 0 because every current finding is accepted
    Given a fixture Node repository at "fixtures/baseline-then-green" that produces two MEDIUM-severity OSV findings
    When I run "depaudit setup" in "fixtures/baseline-then-green"
    And I run "depaudit scan fixtures/baseline-then-green"
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-12 @regression
  Scenario: After baseline, a subsequent `depaudit lint` exits 0 — every entry passes the 90-day cap
    Given a fixture Node repository at "fixtures/baseline-lints-green" whose manifest pins a package with a known MEDIUM-severity OSV finding
    When I run "depaudit setup" in "fixtures/baseline-lints-green"
    And I run "depaudit lint fixtures/baseline-lints-green"
    Then the exit code is 0

  # ─── Baseline identity (strict package, version, finding-ID) ──────────────

  @adw-12 @regression
  Scenario: Baseline CVE entry records the finding's exact CVE identifier
    Given a fixture Node repository at "fixtures/baseline-cve-id" whose manifest pins a package with a known OSV finding of identifier "GHSA-c2qf-rxjj-qqgw"
    When I run "depaudit setup" in "fixtures/baseline-cve-id"
    Then "fixtures/baseline-cve-id/osv-scanner.toml" contains an `[[IgnoredVulns]]` entry with `id` equal to "GHSA-c2qf-rxjj-qqgw"

  @adw-12 @regression
  Scenario: Baseline supply-chain entry records strict (package, version, findingId) identity
    Given a fixture Node repository at "fixtures/baseline-sca-identity" whose manifest pins package "install-script-pkg" at version "1.2.3"
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for package "install-script-pkg" at version "1.2.3"
    When I run "depaudit setup" in "fixtures/baseline-sca-identity"
    Then "fixtures/baseline-sca-identity/.depaudit.yml" contains a `supplyChainAccepts` entry with `package` "install-script-pkg", `version` "1.2.3", and `findingId` "install-scripts"

  # ─── Baseline fail-open interactions with Socket ──────────────────────────

  @adw-12 @regression
  Scenario: When Socket is unavailable during first scan, supply-chain findings are not baselined (fail-open)
    Given a fixture Node repository at "fixtures/baseline-socket-down" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 503 for every request
    When I run "depaudit setup" in "fixtures/baseline-socket-down"
    Then the exit code is 0
    And stderr mentions "supply-chain unavailable"
    And "fixtures/baseline-socket-down/.depaudit.yml"'s `supplyChainAccepts` list is empty

  @adw-12
  Scenario: When Socket is unavailable but OSV succeeds, CVE findings are still baselined
    Given a fixture Node repository at "fixtures/baseline-socket-down-cve-ok" whose manifest pins a package with a known MEDIUM-severity OSV finding
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 503 for every request
    When I run "depaudit setup" in "fixtures/baseline-socket-down-cve-ok"
    Then the exit code is 0
    And "fixtures/baseline-socket-down-cve-ok/osv-scanner.toml" contains at least one `[[IgnoredVulns]]` entry
