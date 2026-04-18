@adw-4
Feature: depaudit scan — lint-first policy and CVE acceptance suppression
  As a maintainer
  I want `depaudit scan` to run `lint` first and honor valid `[[IgnoredVulns]]` entries
  So that findings I have consciously accepted (with a reason and a bounded expiry) are excluded from the gate,
  and so that malformed acceptance entries abort the scan before they cause a silent misclassification

  Background:
    Given the `osv-scanner` binary is installed and on PATH
    And the `depaudit` CLI is installed and on PATH

  @adw-4 @regression
  Scenario: Finding whose id matches a valid [[IgnoredVulns]] entry is suppressed
    Given a fixture Node repository at "fixtures/vulnerable-npm-accepted" whose manifest pins a package with a known OSV CVE
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for that CVE's id with a valid `ignoreUntil` and a `reason` of at least 20 characters
    When I run "depaudit scan fixtures/vulnerable-npm-accepted"
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-4 @regression
  Scenario: Finding whose id does not match any [[IgnoredVulns]] entry is still reported
    Given a fixture Node repository at "fixtures/vulnerable-npm-unrelated-accept" whose manifest pins a package with a known OSV CVE
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry whose id does NOT match that CVE
    When I run "depaudit scan fixtures/vulnerable-npm-unrelated-accept"
    Then the exit code is non-zero
    And stdout contains at least one finding line

  @adw-4 @regression
  Scenario: Scan aborts when lint fails on an expired ignoreUntil, surfacing the lint error
    Given a fixture Node repository at "fixtures/vulnerable-npm-bad-accept" whose manifest pins a package with a known OSV CVE
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry with `ignoreUntil` set 7 days in the past
    When I run "depaudit scan fixtures/vulnerable-npm-bad-accept"
    Then the exit code is non-zero
    And stderr mentions "ignoreUntil"
    And stderr indicates that the date is in the past
    And stdout contains no finding lines

  @adw-4 @regression
  Scenario: Scan aborts when lint fails on malformed TOML, surfacing line and column
    Given a fixture Node repository at "fixtures/vulnerable-npm-malformed-toml" whose manifest pins a package with a known OSV CVE
    And the repository's osv-scanner.toml contains a TOML syntax error
    When I run "depaudit scan fixtures/vulnerable-npm-malformed-toml"
    Then the exit code is non-zero
    And stderr mentions the file name "osv-scanner.toml"
    And stderr mentions the line number of the parse error
    And stdout contains no finding lines

  @adw-4
  Scenario: Scan still runs when lint only produces warnings (duplicate entries)
    Given a fixture Node repository at "fixtures/vulnerable-npm-duplicate-accept" whose manifest pins a package with a known OSV CVE
    And the repository's osv-scanner.toml has two `[[IgnoredVulns]]` entries with the same `id` that both match that CVE
    When I run "depaudit scan fixtures/vulnerable-npm-duplicate-accept"
    Then the exit code is 0
    And stdout contains no finding lines
    And stderr mentions "duplicate"
