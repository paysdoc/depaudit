@adw-7
Feature: depaudit scan — Socket.dev supply-chain findings and fail-open behavior
  As a maintainer
  I want `depaudit scan` to enrich OSV-based CVE findings with supply-chain signals from Socket.dev
  And to fail open (never closed) when Socket is unavailable
  So that my gate catches maintainer-churn and install-script risks without blocking every PR on a Socket outage

  Background:
    Given the `osv-scanner` binary is installed and on PATH
    And the `depaudit` CLI is installed and on PATH

  # ─── Token configuration ────────────────────────────────────────────────────

  @adw-7 @regression
  Scenario: Missing SOCKET_API_TOKEN aborts the scan with a clear error
    Given a fixture Node repository at "fixtures/socket-no-token" whose manifests have no known CVEs
    And the SOCKET_API_TOKEN environment variable is unset
    When I run "depaudit scan fixtures/socket-no-token"
    Then the exit code is non-zero
    And stderr mentions "SOCKET_API_TOKEN"
    And stdout contains no finding lines

  # ─── Happy path ─────────────────────────────────────────────────────────────

  @adw-7 @regression
  Scenario: Package flagged by Socket surfaces as a supply-chain finding line
    Given a fixture Node repository at "fixtures/socket-alert-happy" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package declared in that manifest
    When I run "depaudit scan fixtures/socket-alert-happy"
    Then the exit code is non-zero
    And stdout contains at least one finding line whose finding-ID is the supply-chain alert type "install-scripts"
    And each finding line contains a package name, a version, a finding-ID, and a severity

  @adw-7 @regression
  Scenario: Scan with no CVEs and no Socket alerts exits 0 with no finding lines
    Given a fixture Node repository at "fixtures/socket-clean" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/socket-clean"
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-7 @regression
  Scenario: CVE and Socket alert from the same scan both appear as finding lines
    Given a fixture Node repository at "fixtures/socket-cve-and-alert" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a different package declared in that manifest
    When I run "depaudit scan fixtures/socket-cve-and-alert"
    Then the exit code is non-zero
    And stdout contains at least one finding line whose finding-ID is an OSV CVE identifier
    And stdout contains at least one finding line whose finding-ID is the supply-chain alert type "install-scripts"

  # ─── Fail-open on timeout / 5xx / rate-limit / auth error ──────────────────

  @adw-7 @regression
  Scenario: Socket timeout — CVE findings still reported and scan annotates supply-chain as unavailable
    Given a fixture Node repository at "fixtures/socket-timeout-cve" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that never responds within the client timeout
    When I run "depaudit scan fixtures/socket-timeout-cve"
    Then the exit code is non-zero
    And stdout contains at least one finding line whose finding-ID is an OSV CVE identifier
    And stderr mentions "supply-chain unavailable"

  @adw-7 @regression
  Scenario: Socket 5xx — clean repo still exits 0 and annotates supply-chain as unavailable
    Given a fixture Node repository at "fixtures/socket-5xx-clean" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 503 for every request
    When I run "depaudit scan fixtures/socket-5xx-clean"
    Then the exit code is 0
    And stdout contains no finding lines
    And stderr mentions "supply-chain unavailable"

  @adw-7 @regression
  Scenario: Socket rate-limit — CVE findings still reported and scan annotates supply-chain as unavailable
    Given a fixture Node repository at "fixtures/socket-429-cve" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 429 for every request
    When I run "depaudit scan fixtures/socket-429-cve"
    Then the exit code is non-zero
    And stdout contains at least one finding line whose finding-ID is an OSV CVE identifier
    And stderr mentions "supply-chain unavailable"

  @adw-7 @regression
  Scenario: Socket auth error — 401 fails loud with a clear credentials error
    Given a fixture Node repository at "fixtures/socket-auth-error-cve" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 401 for every request
    When I run "depaudit scan fixtures/socket-auth-error-cve"
    Then the exit code is non-zero
    And stderr mentions "Socket"
    And stdout contains no finding lines

  # ─── Retry-then-success ─────────────────────────────────────────────────────

  @adw-7 @regression
  Scenario: Transient Socket 5xx followed by a successful response completes cleanly without the unavailable annotation
    Given a fixture Node repository at "fixtures/socket-retry-then-success" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 503 once and then responds with an "install-scripts" alert for a package in that manifest
    When I run "depaudit scan fixtures/socket-retry-then-success"
    Then the exit code is non-zero
    And stdout contains at least one finding line whose finding-ID is the supply-chain alert type "install-scripts"
    And stderr does not mention "supply-chain unavailable"

  # ─── supplyChainAccepts classification ─────────────────────────────────────

  @adw-7 @regression
  Scenario: supplyChainAccepts entry matching (package, version, alertType) suppresses the supply-chain finding
    Given a fixture Node repository at "fixtures/socket-alert-accepted" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package in that manifest
    And the repository's .depaudit.yml has a valid `supplyChainAccepts` entry matching that (package, version, alertType) tuple
    When I run "depaudit scan fixtures/socket-alert-accepted"
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-7 @regression
  Scenario: supplyChainAccepts entry for a different package does NOT suppress the supply-chain finding
    Given a fixture Node repository at "fixtures/socket-alert-unrelated-accept" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package in that manifest
    And the repository's .depaudit.yml has a valid `supplyChainAccepts` entry for a different package
    When I run "depaudit scan fixtures/socket-alert-unrelated-accept"
    Then the exit code is non-zero
    And stdout contains at least one finding line whose finding-ID is the supply-chain alert type "install-scripts"

  @adw-7 @regression
  Scenario: supplyChainAccepts entry with a different alertType does NOT suppress the supply-chain finding
    Given a fixture Node repository at "fixtures/socket-alert-wrong-alerttype" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package in that manifest
    And the repository's .depaudit.yml has a `supplyChainAccepts` entry for that (package, version) with `alertType` set to "typosquat"
    When I run "depaudit scan fixtures/socket-alert-wrong-alerttype"
    Then the exit code is non-zero
    And stdout contains at least one finding line whose finding-ID is the supply-chain alert type "install-scripts"

  @adw-7 @regression
  Scenario: supplyChainAccepts entry with a different version does NOT suppress the supply-chain finding
    Given a fixture Node repository at "fixtures/socket-alert-wrong-version" whose manifest pins a package at version "1.2.3"
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for that package at version "1.2.3"
    And the repository's .depaudit.yml has a `supplyChainAccepts` entry for that package at version "0.9.0" with the same alertType
    When I run "depaudit scan fixtures/socket-alert-wrong-version"
    Then the exit code is non-zero
    And stdout contains at least one finding line whose finding-ID is the supply-chain alert type "install-scripts"

  # ─── Severity threshold applies to Socket findings ──────────────────────────

  @adw-7 @regression
  Scenario: Severity threshold `high` drops a MEDIUM-severity Socket finding from the new bucket
    Given a fixture Node repository at "fixtures/socket-alert-below-threshold" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert at severity "MEDIUM" for a package in that manifest
    And the repository's .depaudit.yml sets `policy.severityThreshold` to "high"
    When I run "depaudit scan fixtures/socket-alert-below-threshold"
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-7
  Scenario: Severity threshold `high` still reports a HIGH-severity Socket finding
    Given a fixture Node repository at "fixtures/socket-alert-at-threshold" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert at severity "HIGH" for a package in that manifest
    And the repository's .depaudit.yml sets `policy.severityThreshold` to "high"
    When I run "depaudit scan fixtures/socket-alert-at-threshold"
    Then the exit code is non-zero
    And stdout contains at least one finding line whose finding-ID is the supply-chain alert type "install-scripts"

  # ─── Finding-line format ────────────────────────────────────────────────────

  @adw-7
  Scenario: Supply-chain finding line format is package, version, finding-ID, severity
    Given a fixture Node repository at "fixtures/socket-alert-format" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package in that manifest
    When I run "depaudit scan fixtures/socket-alert-format"
    Then the exit code is non-zero
    And stdout contains exactly one finding line
    And the finding line matches the pattern "<package> <version> <finding-id> <severity>"
    And each finding line contains a package name, a version, a finding-ID, and a severity

  # ─── Polyglot batching ──────────────────────────────────────────────────────

  @adw-7
  Scenario: Supply-chain findings across a polyglot repo are merged into one scan result
    Given a fixture repository at "fixtures/socket-polyglot-alerts" with the following manifests:
      | path             | ecosystem |
      | package.json     | npm       |
      | requirements.txt | pip       |
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package declared in "package.json" and a "typosquat" alert for a package declared in "requirements.txt"
    When I run "depaudit scan fixtures/socket-polyglot-alerts"
    Then the exit code is non-zero
    And stdout contains at least one finding line whose finding-ID is the supply-chain alert type "install-scripts"
    And stdout contains at least one finding line whose finding-ID is the supply-chain alert type "typosquat"
