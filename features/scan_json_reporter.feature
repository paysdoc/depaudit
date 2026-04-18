@adw-8
Feature: depaudit scan — JsonReporter writes classified findings to .depaudit/findings.json
  As a maintainer
  I want `depaudit scan` to write every classified finding to `.depaudit/findings.json`
  with a stable, documented schema that carries classification, source, ecosystem, manifest path,
  and source availability
  So that the `/depaudit-triage` skill (and future UI clients) can reason about every finding —
  including whether Socket's supply-chain input was available — without re-running the scan

  Background:
    Given the `osv-scanner` binary is installed and on PATH
    And the `depaudit` CLI is installed and on PATH

  # ─── File is written every scan ────────────────────────────────────────────

  @adw-8 @regression
  Scenario: Clean repo still writes .depaudit/findings.json with an empty findings array
    Given a fixture Node repository at "fixtures/json-clean-npm" whose manifests have no known CVEs
    And the repository's .gitignore excludes ".depaudit/"
    When I run "depaudit scan fixtures/json-clean-npm"
    Then the exit code is 0
    And the file ".depaudit/findings.json" is written under the scanned repository
    And ".depaudit/findings.json" is valid JSON
    And ".depaudit/findings.json" has a top-level "version" field set to 1
    And ".depaudit/findings.json" has a top-level "findings" array with length 0

  @adw-8 @regression
  Scenario: Repo with a known CVE writes that finding to .depaudit/findings.json classified as "new"
    Given a fixture Node repository at "fixtures/json-new-osv" whose manifest pins a package with a known OSV CVE
    And the repository's .gitignore excludes ".depaudit/"
    When I run "depaudit scan fixtures/json-new-osv"
    Then the exit code is non-zero
    And ".depaudit/findings.json" has a top-level "findings" array with length 1
    And the first finding in ".depaudit/findings.json" has "classification" set to "new"
    And the first finding in ".depaudit/findings.json" has "source" set to "osv"
    And the first finding in ".depaudit/findings.json" has non-empty "package", "version", "findingId", "severity", "ecosystem", and "manifestPath" fields

  # ─── Schema supports every classification category ─────────────────────────

  @adw-8 @regression
  Scenario: Accepted OSV finding is emitted with classification "accepted" and source "osv"
    Given a fixture Node repository at "fixtures/json-accepted-osv" whose manifest pins a package with a known OSV CVE
    And the repository's .gitignore excludes ".depaudit/"
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for that CVE's id with a valid `ignoreUntil` and a `reason` of at least 20 characters
    When I run "depaudit scan fixtures/json-accepted-osv"
    Then the exit code is 0
    And ".depaudit/findings.json" has a top-level "findings" array with length 1
    And the first finding in ".depaudit/findings.json" has "classification" set to "accepted"
    And the first finding in ".depaudit/findings.json" has "source" set to "osv"

  @adw-8 @regression
  Scenario: Whitelisted Socket finding is emitted with classification "whitelisted" and source "socket"
    Given a fixture Node repository at "fixtures/json-whitelisted-socket" whose manifests have no known CVEs
    And the repository's .gitignore excludes ".depaudit/"
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package declared in that manifest
    And the repository's .depaudit.yml has a `commonAndFine` entry matching that (package, alertType) pair with a valid `expires`
    When I run "depaudit scan fixtures/json-whitelisted-socket"
    Then the exit code is 0
    And ".depaudit/findings.json" contains a finding with "classification" set to "whitelisted"
    And that finding has "source" set to "socket"
    And that finding has "findingId" set to "install-scripts"

  @adw-8 @regression
  Scenario: Schema documents the "expired-accept" classification as a valid category
    Given a fixture Node repository at "fixtures/json-schema-categories" whose manifests have no known CVEs
    And the repository's .gitignore excludes ".depaudit/"
    When I run "depaudit scan fixtures/json-schema-categories"
    Then the exit code is 0
    And ".depaudit/findings.json" documents "classification" as one of: new, accepted, whitelisted, expired-accept

  # ─── sourceAvailability reflects fail-open state ───────────────────────────

  @adw-8 @regression
  Scenario: Both OSV and Socket available — sourceAvailability marks both as "available"
    Given a fixture Node repository at "fixtures/json-sources-happy" whose manifests have no known CVEs
    And the repository's .gitignore excludes ".depaudit/"
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/json-sources-happy"
    Then the exit code is 0
    And ".depaudit/findings.json" has "sourceAvailability.osv" set to "available"
    And ".depaudit/findings.json" has "sourceAvailability.socket" set to "available"

  @adw-8 @regression
  Scenario: Socket timeout — .depaudit/findings.json marks supply-chain as "unavailable" and still emits CVE findings
    Given a fixture Node repository at "fixtures/json-socket-timeout" whose manifest pins a package with a known OSV CVE
    And the repository's .gitignore excludes ".depaudit/"
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that never responds within the client timeout
    When I run "depaudit scan fixtures/json-socket-timeout"
    Then the exit code is non-zero
    And ".depaudit/findings.json" has "sourceAvailability.osv" set to "available"
    And ".depaudit/findings.json" has "sourceAvailability.socket" set to "unavailable"
    And ".depaudit/findings.json" contains at least one finding with "source" set to "osv"

  @adw-8 @regression
  Scenario: Socket 5xx — clean repo still writes findings.json with socket marked "unavailable"
    Given a fixture Node repository at "fixtures/json-socket-5xx" whose manifests have no known CVEs
    And the repository's .gitignore excludes ".depaudit/"
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 503 for every request
    When I run "depaudit scan fixtures/json-socket-5xx"
    Then the exit code is 0
    And ".depaudit/findings.json" has "sourceAvailability.socket" set to "unavailable"
    And ".depaudit/findings.json" has a top-level "findings" array with length 0

  # ─── Ecosystem and manifestPath attribution ────────────────────────────────

  @adw-8 @regression
  Scenario: Polyglot repo — each finding in .depaudit/findings.json carries its originating ecosystem and manifestPath
    Given a fixture repository at "fixtures/json-polyglot" with the following manifests:
      | path             | ecosystem |
      | package.json     | npm       |
      | requirements.txt | pip       |
    And the repository's .gitignore excludes ".depaudit/"
    And each listed manifest pins a package with a known OSV CVE
    When I run "depaudit scan fixtures/json-polyglot"
    Then the exit code is non-zero
    And ".depaudit/findings.json" contains a finding with "ecosystem" set to "npm" and "manifestPath" ending in "package.json"
    And ".depaudit/findings.json" contains a finding with "ecosystem" set to "pip" and "manifestPath" ending in "requirements.txt"

  # ─── Upgrade suggestion carried when available ─────────────────────────────

  @adw-8 @regression
  Scenario: OSV finding with an available upgrade records a suggestion on the JSON entry
    Given a fixture Node repository at "fixtures/json-upgrade-available" whose manifest pins a package with a known OSV CVE that has a resolving upgrade version
    And the repository's .gitignore excludes ".depaudit/"
    When I run "depaudit scan fixtures/json-upgrade-available"
    Then the exit code is non-zero
    And the first finding in ".depaudit/findings.json" has an "upgrade" field whose "suggestedVersion" is non-empty

  @adw-8
  Scenario: Finding with no upstream fix omits the upgrade field rather than carrying an empty one
    Given a fixture Node repository at "fixtures/json-upgrade-unavailable" whose manifest pins a package with a known OSV CVE that has no resolving upgrade
    And the repository's .gitignore excludes ".depaudit/"
    When I run "depaudit scan fixtures/json-upgrade-unavailable"
    Then the exit code is non-zero
    And the first finding in ".depaudit/findings.json" has no "upgrade" field

  # ─── .gitignore warning (no fatal) ─────────────────────────────────────────

  @adw-8 @regression
  Scenario: Repository without .gitignore entry for .depaudit/ emits a warning but still writes the file
    Given a fixture Node repository at "fixtures/json-not-gitignored" whose manifests have no known CVEs
    And the repository's .gitignore does not exclude ".depaudit/findings.json"
    When I run "depaudit scan fixtures/json-not-gitignored"
    Then the exit code is 0
    And stdout mentions "findings.json" and "gitignore"
    And the file ".depaudit/findings.json" is written under the scanned repository

  @adw-8 @regression
  Scenario: Repository whose .gitignore excludes the parent ".depaudit/" directory does not trigger the warning
    Given a fixture Node repository at "fixtures/json-gitignored-dir" whose manifests have no known CVEs
    And the repository's .gitignore excludes ".depaudit/"
    When I run "depaudit scan fixtures/json-gitignored-dir"
    Then the exit code is 0
    And stdout does not mention "gitignore"

  @adw-8
  Scenario: Repository with no .gitignore at all emits the warning but still writes the file
    Given a fixture Node repository at "fixtures/json-no-gitignore" whose manifests have no known CVEs
    And the repository has no .gitignore
    When I run "depaudit scan fixtures/json-no-gitignore"
    Then the exit code is 0
    And stdout mentions "findings.json" and "gitignore"
    And the file ".depaudit/findings.json" is written under the scanned repository

  # ─── Idempotency / overwrite ───────────────────────────────────────────────

  @adw-8
  Scenario: Re-running scan overwrites the previous .depaudit/findings.json atomically
    Given a fixture Node repository at "fixtures/json-rerun" whose manifests have no known CVEs
    And the repository's .gitignore excludes ".depaudit/"
    And a stale ".depaudit/findings.json" from a previous run exists under that repository with a single stale finding entry
    When I run "depaudit scan fixtures/json-rerun"
    Then the exit code is 0
    And ".depaudit/findings.json" has a top-level "findings" array with length 0
    And ".depaudit/findings.json" does not contain the stale finding entry

  @adw-8
  Scenario: scannedAt is a valid ISO-8601 timestamp
    Given a fixture Node repository at "fixtures/json-scanned-at" whose manifests have no known CVEs
    And the repository's .gitignore excludes ".depaudit/"
    When I run "depaudit scan fixtures/json-scanned-at"
    Then the exit code is 0
    And ".depaudit/findings.json" has a top-level "scannedAt" field that is a valid ISO-8601 timestamp
