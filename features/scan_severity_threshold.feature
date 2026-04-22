@adw-5
Feature: depaudit scan — severity threshold filter on the "new" bucket
  As a maintainer
  I want to configure `policy.severityThreshold` in `.depaudit.yml`
  So that findings below the configured severity are dropped from the "new" bucket
  and only findings at or above my threshold can fail the gate

  Background:
    Given the `osv-scanner` binary is installed and on PATH
    And the `depaudit` CLI is installed and on PATH

  @adw-5 @regression
  Scenario: Default severityThreshold of `medium` is applied when .depaudit.yml is absent
    Given a fixture Node repository at "fixtures/low-finding-npm" whose manifest pins a package with a known LOW-severity OSV finding
    And the repository has no .depaudit.yml
    When I run "depaudit scan fixtures/low-finding-npm"
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-5 @regression
  Scenario: Default severityThreshold of `medium` is applied when .depaudit.yml omits policy
    Given a fixture Node repository at "fixtures/low-finding-default-yml" whose manifest pins a package with a known LOW-severity OSV finding
    And the repository's .depaudit.yml has version 1 and no `policy` block
    When I run "depaudit scan fixtures/low-finding-default-yml"
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-5 @regression
  Scenario: Default threshold still reports a MEDIUM finding
    Given a fixture Node repository at "fixtures/medium-finding-npm" whose manifest pins a package with a known MEDIUM-severity OSV finding
    And the repository has no .depaudit.yml
    When I run "depaudit scan fixtures/medium-finding-npm"
    Then the exit code is non-zero
    And stdout contains at least one finding line

  @adw-5 @regression
  Scenario: Threshold `high` drops a MEDIUM finding from the new bucket
    Given a fixture Node repository at "fixtures/medium-finding-threshold-high" whose manifest pins a package with a known MEDIUM-severity OSV finding
    And the repository's .depaudit.yml sets `policy.severityThreshold` to "high"
    When I run "depaudit scan fixtures/medium-finding-threshold-high"
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-5 @regression
  Scenario: Threshold `high` still reports a HIGH finding
    Given a fixture Node repository at "fixtures/high-finding-threshold-high" whose manifest pins a package with a known HIGH-severity OSV finding
    And the repository's .depaudit.yml sets `policy.severityThreshold` to "high"
    When I run "depaudit scan fixtures/high-finding-threshold-high"
    Then the exit code is non-zero
    And stdout contains at least one finding line

  @adw-5 @regression
  Scenario: Threshold `critical` drops a HIGH finding from the new bucket
    Given a fixture Node repository at "fixtures/high-finding-threshold-critical" whose manifest pins a package with a known HIGH-severity OSV finding
    And the repository's .depaudit.yml sets `policy.severityThreshold` to "critical"
    When I run "depaudit scan fixtures/high-finding-threshold-critical"
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-5 @regression
  Scenario: Threshold `critical` still reports a CRITICAL finding
    Given a fixture Node repository at "fixtures/critical-finding-threshold-critical" whose manifest pins a package with a known CRITICAL-severity OSV finding
    And the repository's .depaudit.yml sets `policy.severityThreshold` to "critical"
    When I run "depaudit scan fixtures/critical-finding-threshold-critical"
    Then the exit code is non-zero
    And stdout contains at least one finding line

  @adw-5 @regression
  Scenario: Finding AT the threshold severity is reported (inclusive boundary)
    Given a fixture Node repository at "fixtures/medium-finding-threshold-medium" whose manifest pins a package with a known MEDIUM-severity OSV finding
    And the repository's .depaudit.yml sets `policy.severityThreshold` to "medium"
    When I run "depaudit scan fixtures/medium-finding-threshold-medium"
    Then the exit code is non-zero
    And stdout contains at least one finding line

  @adw-5 @regression
  Scenario: Invalid severityThreshold enum value aborts scan via lint pre-flight
    Given a fixture Node repository at "fixtures/threshold-invalid-enum" whose manifest pins a package with a known OSV CVE
    And the repository's .depaudit.yml sets `policy.severityThreshold` to "low"
    When I run "depaudit scan fixtures/threshold-invalid-enum"
    Then the exit code is non-zero
    And stderr mentions "severityThreshold"
    And stdout contains no finding lines

  @adw-5
  Scenario: Threshold filters the new bucket before stdout output when mixed severities are present
    Given a fixture Node repository at "fixtures/mixed-severity-threshold-high" that produces one MEDIUM-severity OSV finding and one HIGH-severity OSV finding
    And the repository's .depaudit.yml sets `policy.severityThreshold` to "high"
    When I run "depaudit scan --format text fixtures/mixed-severity-threshold-high"
    Then the exit code is non-zero
    And stdout contains exactly one finding line
    And the finding line contains the severity "HIGH"
