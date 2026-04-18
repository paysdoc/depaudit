@adw-4
Feature: depaudit lint — standalone validation of osv-scanner.toml
  As a maintainer
  I want `depaudit lint` to be a standalone subcommand I can wire into a pre-commit hook
  So that bad edits to the CVE acceptance register (`osv-scanner.toml`) are caught before they land,
  with parse errors pointing me at the exact line and column so I can fix them quickly

  Background:
    Given the `depaudit` CLI is installed and on PATH

  @adw-4 @regression
  Scenario: Clean osv-scanner.toml exits 0
    Given a fixture Node repository at "fixtures/toml-clean-ignore" whose osv-scanner.toml has one valid `[[IgnoredVulns]]` entry
    When I run "depaudit lint fixtures/toml-clean-ignore"
    Then the exit code is 0

  @adw-4 @regression
  Scenario: Missing osv-scanner.toml is treated as clean
    Given a fixture Node repository at "fixtures/clean-npm" whose manifests have no known CVEs
    And the repository has no osv-scanner.toml
    When I run "depaudit lint fixtures/clean-npm"
    Then the exit code is 0

  @adw-4 @regression
  Scenario: Malformed TOML fails with a parse error that points at the failing line and column
    Given a fixture Node repository at "fixtures/toml-malformed" whose osv-scanner.toml contains a TOML syntax error
    When I run "depaudit lint fixtures/toml-malformed"
    Then the exit code is non-zero
    And stderr mentions the file name "osv-scanner.toml"
    And stderr mentions the line number of the parse error
    And stderr mentions the column number of the parse error

  @adw-4 @regression
  Scenario: ignoreUntil in the past is a fatal lint error
    Given a fixture Node repository at "fixtures/toml-expired-ignore" whose osv-scanner.toml has an `[[IgnoredVulns]]` entry with `ignoreUntil` set 7 days in the past
    When I run "depaudit lint fixtures/toml-expired-ignore"
    Then the exit code is non-zero
    And stderr mentions "ignoreUntil"
    And stderr indicates that the date is in the past

  @adw-4 @regression
  Scenario: ignoreUntil more than 90 days from today is a fatal lint error
    Given a fixture Node repository at "fixtures/toml-overcap-ignore" whose osv-scanner.toml has an `[[IgnoredVulns]]` entry with `ignoreUntil` set 120 days in the future
    When I run "depaudit lint fixtures/toml-overcap-ignore"
    Then the exit code is non-zero
    And stderr mentions "ignoreUntil"
    And stderr mentions the 90-day cap

  @adw-4 @regression
  Scenario: ignoreUntil exactly at the 90-day boundary is allowed
    Given a fixture Node repository at "fixtures/toml-boundary-ignore" whose osv-scanner.toml has an `[[IgnoredVulns]]` entry with `ignoreUntil` set exactly 90 days from today
    When I run "depaudit lint fixtures/toml-boundary-ignore"
    Then the exit code is 0

  @adw-4 @regression
  Scenario: reason shorter than 20 characters is a fatal lint error
    Given a fixture Node repository at "fixtures/toml-short-reason" whose osv-scanner.toml has an `[[IgnoredVulns]]` entry with a `reason` of 10 characters
    When I run "depaudit lint fixtures/toml-short-reason"
    Then the exit code is non-zero
    And stderr mentions "reason"
    And stderr mentions the 20-character minimum

  @adw-4 @regression
  Scenario: reason exactly 20 characters long is allowed
    Given a fixture Node repository at "fixtures/toml-boundary-reason" whose osv-scanner.toml has an `[[IgnoredVulns]]` entry with a `reason` of exactly 20 characters
    When I run "depaudit lint fixtures/toml-boundary-reason"
    Then the exit code is 0

  @adw-4 @regression
  Scenario: Duplicate [[IgnoredVulns]] entries produce a warning, not a fatal error
    Given a fixture Node repository at "fixtures/toml-duplicate-ignore" whose osv-scanner.toml has two `[[IgnoredVulns]]` entries with the same `id`
    When I run "depaudit lint fixtures/toml-duplicate-ignore"
    Then the exit code is 0
    And stderr mentions "duplicate"
    And stderr mentions the duplicated id

  @adw-4
  Scenario: Multiple lint errors are all reported in a single run
    Given a fixture Node repository at "fixtures/toml-multi-error" whose osv-scanner.toml has an `[[IgnoredVulns]]` entry with `ignoreUntil` in the past and a second `[[IgnoredVulns]]` entry with a `reason` shorter than 20 characters
    When I run "depaudit lint fixtures/toml-multi-error"
    Then the exit code is non-zero
    And stderr mentions "ignoreUntil"
    And stderr mentions "reason"

  @adw-4
  Scenario: Omitting the path argument lints the current working directory
    Given a fixture Node repository at "fixtures/toml-clean-ignore" whose osv-scanner.toml has one valid `[[IgnoredVulns]]` entry
    And the current working directory is "fixtures/toml-clean-ignore"
    When I run "depaudit lint" with no path argument
    Then the exit code is 0

  @adw-4
  Scenario: Non-existent path fails with a clear error
    When I run "depaudit lint fixtures/does-not-exist"
    Then the exit code is non-zero
    And stderr mentions that the path does not exist
