@adw-5
Feature: depaudit lint — schema validation of .depaudit.yml
  As a maintainer
  I want `depaudit lint` to enforce the full `.depaudit.yml` schema
  So that bad edits to depaudit's master config (`version`, `policy`, `commonAndFine`, `supplyChainAccepts`)
  are caught before they land with the same pre-commit discipline that already applies to `osv-scanner.toml`

  Background:
    Given the `depaudit` CLI is installed and on PATH

  @adw-5 @regression
  Scenario: Clean .depaudit.yml with version, policy, and empty registers exits 0
    Given a fixture Node repository at "fixtures/yml-clean" whose .depaudit.yml has version 1, default policy, and empty `commonAndFine` and `supplyChainAccepts`
    When I run "depaudit lint fixtures/yml-clean"
    Then the exit code is 0

  @adw-5 @regression
  Scenario: Missing .depaudit.yml is treated as clean
    Given a fixture Node repository at "fixtures/clean-npm" whose manifests have no known CVEs
    And the repository has no .depaudit.yml
    When I run "depaudit lint fixtures/clean-npm"
    Then the exit code is 0

  @adw-5 @regression
  Scenario: Malformed YAML fails with a parse error that points at the failing line and column
    Given a fixture Node repository at "fixtures/yml-malformed" whose .depaudit.yml contains a YAML syntax error
    When I run "depaudit lint fixtures/yml-malformed"
    Then the exit code is non-zero
    And stderr mentions the file name ".depaudit.yml"
    And stderr mentions the line number of the parse error
    And stderr mentions the column number of the parse error

  @adw-5 @regression
  Scenario: Missing required `version` field is a fatal lint error
    Given a fixture Node repository at "fixtures/yml-missing-version" whose .depaudit.yml omits the `version` field
    When I run "depaudit lint fixtures/yml-missing-version"
    Then the exit code is non-zero
    And stderr mentions "version"

  @adw-5 @regression
  Scenario: Unsupported schema `version` halts with migration guidance
    Given a fixture Node repository at "fixtures/yml-bad-version" whose .depaudit.yml has `version: 999`
    When I run "depaudit lint fixtures/yml-bad-version"
    Then the exit code is non-zero
    And stderr mentions "version"
    And stderr mentions "migration"

  @adw-5 @regression
  Scenario: severityThreshold default is `medium` when `policy` is omitted
    Given a fixture Node repository at "fixtures/yml-default-policy" whose .depaudit.yml has version 1 and no `policy` block
    When I run "depaudit lint fixtures/yml-default-policy"
    Then the exit code is 0

  @adw-5 @regression
  Scenario: severityThreshold accepts `medium`
    Given a fixture Node repository at "fixtures/yml-threshold-medium" whose .depaudit.yml sets `policy.severityThreshold` to "medium"
    When I run "depaudit lint fixtures/yml-threshold-medium"
    Then the exit code is 0

  @adw-5 @regression
  Scenario: severityThreshold accepts `high`
    Given a fixture Node repository at "fixtures/yml-threshold-high" whose .depaudit.yml sets `policy.severityThreshold` to "high"
    When I run "depaudit lint fixtures/yml-threshold-high"
    Then the exit code is 0

  @adw-5 @regression
  Scenario: severityThreshold accepts `critical`
    Given a fixture Node repository at "fixtures/yml-threshold-critical" whose .depaudit.yml sets `policy.severityThreshold` to "critical"
    When I run "depaudit lint fixtures/yml-threshold-critical"
    Then the exit code is 0

  @adw-5 @regression
  Scenario: severityThreshold rejects `low` as out-of-enum
    Given a fixture Node repository at "fixtures/yml-threshold-low" whose .depaudit.yml sets `policy.severityThreshold` to "low"
    When I run "depaudit lint fixtures/yml-threshold-low"
    Then the exit code is non-zero
    And stderr mentions "severityThreshold"
    And stderr mentions "medium"
    And stderr mentions "high"
    And stderr mentions "critical"

  @adw-5 @regression
  Scenario: severityThreshold rejects an arbitrary string as out-of-enum
    Given a fixture Node repository at "fixtures/yml-threshold-bogus" whose .depaudit.yml sets `policy.severityThreshold` to "catastrophic"
    When I run "depaudit lint fixtures/yml-threshold-bogus"
    Then the exit code is non-zero
    And stderr mentions "severityThreshold"

  @adw-5 @regression
  Scenario: supplyChainAccepts entry with `expires` more than 90 days from today is a fatal lint error
    Given a fixture Node repository at "fixtures/yml-sca-overcap" whose .depaudit.yml has a `supplyChainAccepts` entry with `expires` set 120 days in the future
    When I run "depaudit lint fixtures/yml-sca-overcap"
    Then the exit code is non-zero
    And stderr mentions "expires"
    And stderr mentions the 90-day cap

  @adw-5 @regression
  Scenario: supplyChainAccepts entry with `expires` exactly at the 90-day boundary is allowed
    Given a fixture Node repository at "fixtures/yml-sca-boundary" whose .depaudit.yml has a `supplyChainAccepts` entry with `expires` set exactly 90 days from today
    When I run "depaudit lint fixtures/yml-sca-boundary"
    Then the exit code is 0

  @adw-5 @regression
  Scenario: supplyChainAccepts entry with `expires` in the past is a fatal lint error
    Given a fixture Node repository at "fixtures/yml-sca-expired" whose .depaudit.yml has a `supplyChainAccepts` entry with `expires` set 7 days in the past
    When I run "depaudit lint fixtures/yml-sca-expired"
    Then the exit code is non-zero
    And stderr mentions "expires"
    And stderr indicates that the date is in the past

  @adw-5 @regression
  Scenario: supplyChainAccepts entry with `reason` shorter than 20 characters is a fatal lint error
    Given a fixture Node repository at "fixtures/yml-sca-short-reason" whose .depaudit.yml has a `supplyChainAccepts` entry with a `reason` of 10 characters
    When I run "depaudit lint fixtures/yml-sca-short-reason"
    Then the exit code is non-zero
    And stderr mentions "reason"
    And stderr mentions the 20-character minimum

  @adw-5 @regression
  Scenario: supplyChainAccepts entry with `reason` of exactly 20 characters is allowed
    Given a fixture Node repository at "fixtures/yml-sca-boundary-reason" whose .depaudit.yml has a `supplyChainAccepts` entry with a `reason` of exactly 20 characters
    When I run "depaudit lint fixtures/yml-sca-boundary-reason"
    Then the exit code is 0

  @adw-5 @regression
  Scenario: Duplicate supplyChainAccepts entries on the same (package, version, alertType) produce a warning, not a fatal error
    Given a fixture Node repository at "fixtures/yml-sca-duplicate" whose .depaudit.yml has two `supplyChainAccepts` entries with the same `(package, version, alertType)` tuple
    When I run "depaudit lint fixtures/yml-sca-duplicate"
    Then the exit code is 0
    And stderr mentions "duplicate"

  @adw-5 @regression
  Scenario: commonAndFine entry with `expires` more than 365 days from today is a fatal lint error
    Given a fixture Node repository at "fixtures/yml-caf-overcap" whose .depaudit.yml has a `commonAndFine` entry with `expires` set 400 days in the future
    When I run "depaudit lint fixtures/yml-caf-overcap"
    Then the exit code is non-zero
    And stderr mentions "expires"
    And stderr mentions the 365-day cap

  @adw-5 @regression
  Scenario: commonAndFine entry with `expires` exactly at the 365-day boundary is allowed
    Given a fixture Node repository at "fixtures/yml-caf-boundary" whose .depaudit.yml has a `commonAndFine` entry with `expires` set exactly 365 days from today
    When I run "depaudit lint fixtures/yml-caf-boundary"
    Then the exit code is 0

  @adw-5 @regression
  Scenario: commonAndFine entry with `expires` in the past is a fatal lint error
    Given a fixture Node repository at "fixtures/yml-caf-expired" whose .depaudit.yml has a `commonAndFine` entry with `expires` set 7 days in the past
    When I run "depaudit lint fixtures/yml-caf-expired"
    Then the exit code is non-zero
    And stderr mentions "expires"
    And stderr indicates that the date is in the past

  @adw-5 @regression
  Scenario: ecosystems set to "auto" is accepted
    Given a fixture Node repository at "fixtures/yml-ecosystems-auto" whose .depaudit.yml sets `policy.ecosystems` to "auto"
    When I run "depaudit lint fixtures/yml-ecosystems-auto"
    Then the exit code is 0

  @adw-5 @regression
  Scenario: ecosystems list containing an unknown value is a fatal lint error
    Given a fixture Node repository at "fixtures/yml-ecosystems-bogus" whose .depaudit.yml sets `policy.ecosystems` to a list containing an unknown ecosystem "foo"
    When I run "depaudit lint fixtures/yml-ecosystems-bogus"
    Then the exit code is non-zero
    And stderr mentions "ecosystems"
    And stderr mentions "foo"

  @adw-5
  Scenario: supplyChainAccepts entry missing the required `reason` field is a fatal lint error
    Given a fixture Node repository at "fixtures/yml-sca-missing-reason" whose .depaudit.yml has a `supplyChainAccepts` entry with no `reason` field
    When I run "depaudit lint fixtures/yml-sca-missing-reason"
    Then the exit code is non-zero
    And stderr mentions "reason"

  @adw-5
  Scenario: Multiple YAML lint errors are all reported in a single run
    Given a fixture Node repository at "fixtures/yml-multi-error" whose .depaudit.yml has an invalid `severityThreshold` enum value and a `supplyChainAccepts` entry with a `reason` shorter than 20 characters
    When I run "depaudit lint fixtures/yml-multi-error"
    Then the exit code is non-zero
    And stderr mentions "severityThreshold"
    And stderr mentions "reason"

  @adw-5
  Scenario: Both osv-scanner.toml and .depaudit.yml errors are reported together
    Given a fixture Node repository at "fixtures/yml-and-toml-errors" whose osv-scanner.toml has an `[[IgnoredVulns]]` entry with `ignoreUntil` in the past and whose .depaudit.yml has a `supplyChainAccepts` entry with `expires` in the past
    When I run "depaudit lint fixtures/yml-and-toml-errors"
    Then the exit code is non-zero
    And stderr mentions the file name "osv-scanner.toml"
    And stderr mentions the file name ".depaudit.yml"
