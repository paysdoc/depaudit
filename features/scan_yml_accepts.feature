@adw-5
Feature: depaudit scan — lint pre-flight and classification against .depaudit.yml
  As a maintainer
  I want `depaudit scan` to load `.depaudit.yml` alongside `osv-scanner.toml` and run lint pre-flight across both
  So that malformed or expired entries in `.depaudit.yml` abort the scan with a clear error,
  and so that `FindingMatcher`'s four-way classification (`new`, `accepted`, `whitelisted`, `expired-accept`)
  produces the right CLI-observable outcome for every finding in my tree

  Background:
    Given the `osv-scanner` binary is installed and on PATH
    And the `depaudit` CLI is installed and on PATH

  @adw-5 @regression
  Scenario: Scan succeeds when .depaudit.yml is well-formed and has no matching supplyChainAccepts
    Given a fixture Node repository at "fixtures/vulnerable-npm-yml-clean" whose manifest pins a package with a known OSV CVE
    And the repository's .depaudit.yml has version 1, default policy, and empty `commonAndFine` and `supplyChainAccepts`
    When I run "depaudit scan fixtures/vulnerable-npm-yml-clean"
    Then the exit code is non-zero
    And stdout contains at least one finding line

  @adw-5 @regression
  Scenario: Scan aborts when lint fails on malformed .depaudit.yml, surfacing line and column
    Given a fixture Node repository at "fixtures/vulnerable-npm-yml-malformed" whose manifest pins a package with a known OSV CVE
    And the repository's .depaudit.yml contains a YAML syntax error
    When I run "depaudit scan fixtures/vulnerable-npm-yml-malformed"
    Then the exit code is non-zero
    And stderr mentions the file name ".depaudit.yml"
    And stderr mentions the line number of the parse error
    And stdout contains no finding lines

  @adw-5 @regression
  Scenario: Scan aborts when .depaudit.yml has an expired supplyChainAccepts entry — four-way classification surfaces `expired-accept`
    Given a fixture Node repository at "fixtures/vulnerable-npm-yml-expired-sca" whose manifest pins a package with a known OSV CVE
    And the repository's .depaudit.yml has a `supplyChainAccepts` entry with `expires` set 7 days in the past
    When I run "depaudit scan fixtures/vulnerable-npm-yml-expired-sca"
    Then the exit code is non-zero
    And stderr mentions "expires"
    And stderr indicates that the date is in the past
    And stdout contains no finding lines

  @adw-5 @regression
  Scenario: Scan aborts when .depaudit.yml has an expired commonAndFine entry
    Given a fixture Node repository at "fixtures/vulnerable-npm-yml-expired-caf" whose manifest pins a package with a known OSV CVE
    And the repository's .depaudit.yml has a `commonAndFine` entry with `expires` set 7 days in the past
    When I run "depaudit scan fixtures/vulnerable-npm-yml-expired-caf"
    Then the exit code is non-zero
    And stderr mentions "expires"
    And stderr indicates that the date is in the past
    And stdout contains no finding lines

  @adw-5 @regression
  Scenario: Scan aborts when .depaudit.yml has a commonAndFine entry beyond the 365-day cap
    Given a fixture Node repository at "fixtures/vulnerable-npm-yml-overcap-caf" whose manifest pins a package with a known OSV CVE
    And the repository's .depaudit.yml has a `commonAndFine` entry with `expires` set 400 days in the future
    When I run "depaudit scan fixtures/vulnerable-npm-yml-overcap-caf"
    Then the exit code is non-zero
    And stderr mentions "expires"
    And stderr mentions the 365-day cap
    And stdout contains no finding lines

  @adw-5 @regression
  Scenario: OSV finding still reports when .depaudit.yml is valid but contains unrelated supplyChainAccepts entries — four-way classification surfaces `new`
    Given a fixture Node repository at "fixtures/vulnerable-npm-yml-unrelated-sca" whose manifest pins a package with a known OSV CVE
    And the repository's .depaudit.yml has a valid `supplyChainAccepts` entry for a different package
    When I run "depaudit scan fixtures/vulnerable-npm-yml-unrelated-sca"
    Then the exit code is non-zero
    And stdout contains at least one finding line

  @adw-5 @regression
  Scenario: OSV finding suppressed via osv-scanner.toml still passes even when .depaudit.yml is populated — four-way classification surfaces `accepted`
    Given a fixture Node repository at "fixtures/vulnerable-npm-yml-and-toml-accept" whose manifest pins a package with a known OSV CVE
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for that CVE's id with a valid `ignoreUntil` and a `reason` of at least 20 characters
    And the repository's .depaudit.yml has version 1, default policy, and empty `commonAndFine` and `supplyChainAccepts`
    When I run "depaudit scan fixtures/vulnerable-npm-yml-and-toml-accept"
    Then the exit code is 0
    And stdout contains no finding lines
