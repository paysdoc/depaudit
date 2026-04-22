@adw-8
Feature: depaudit scan — JsonReporter writes classified findings to .depaudit/findings.json
  As the /depaudit-triage skill (and other downstream consumers)
  I want every `depaudit scan` to write its classified findings to the deterministic
  path `.depaudit/findings.json` as canonical JSON
  So that the triage skill can read a stable, schema-versioned snapshot of the scan,
  including which finding sources were available and how each finding was classified,
  without re-running the scan or parsing CLI stdout

  Background:
    Given the `osv-scanner` binary is installed and on PATH
    And the `depaudit` CLI is installed and on PATH

  # ─── File creation at deterministic path ────────────────────────────────────

  @adw-8 @regression
  Scenario: A clean scan writes .depaudit/findings.json with an empty findings array
    Given a fixture Node repository at "fixtures/json-clean" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/json-clean"
    Then the exit code is 0
    And the file ".depaudit/findings.json" exists in "fixtures/json-clean"
    And ".depaudit/findings.json" in "fixtures/json-clean" is valid JSON
    And ".depaudit/findings.json" in "fixtures/json-clean" has a top-level array field "findings" with 0 entries
    And ".depaudit/findings.json" in "fixtures/json-clean" has a top-level object field "sourceAvailability" with `osv` set to true and `socket` set to true

  @adw-8 @regression
  Scenario: The .depaudit/ directory is created when it does not already exist
    Given a fixture Node repository at "fixtures/json-no-dir" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the directory ".depaudit/" does not exist in "fixtures/json-no-dir"
    When I run "depaudit scan fixtures/json-no-dir"
    Then the exit code is 0
    And the directory ".depaudit/" exists in "fixtures/json-no-dir"
    And the file ".depaudit/findings.json" exists in "fixtures/json-no-dir"

  @adw-8 @regression
  Scenario: An existing .depaudit/findings.json is overwritten on the next scan, not appended
    Given a fixture Node repository at "fixtures/json-overwrite" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And ".depaudit/findings.json" in "fixtures/json-overwrite" already contains a stale findings array with 5 entries
    When I run "depaudit scan fixtures/json-overwrite"
    Then the exit code is 0
    And ".depaudit/findings.json" in "fixtures/json-overwrite" has a top-level array field "findings" with 0 entries

  # ─── Per-finding schema fields (from issue body) ────────────────────────────

  @adw-8 @regression
  Scenario: A new CVE finding entry carries every required schema field
    Given a fixture Node repository at "fixtures/json-cve-schema" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/json-cve-schema"
    Then the exit code is non-zero
    And ".depaudit/findings.json" in "fixtures/json-cve-schema" is valid JSON
    And every entry in ".depaudit/findings.json" `findings` array has the fields `package`, `version`, `ecosystem`, `manifestPath`, `findingId`, `severity`, `classification`, `source`
    And ".depaudit/findings.json" in "fixtures/json-cve-schema" contains at least one entry whose `source` is "osv"

  @adw-8 @regression
  Scenario: A new Socket supply-chain finding entry carries every required schema field
    Given a fixture Node repository at "fixtures/json-sca-schema" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package in that manifest
    When I run "depaudit scan fixtures/json-sca-schema"
    Then the exit code is non-zero
    And ".depaudit/findings.json" in "fixtures/json-sca-schema" is valid JSON
    And every entry in ".depaudit/findings.json" `findings` array has the fields `package`, `version`, `ecosystem`, `manifestPath`, `findingId`, `severity`, `classification`, `source`
    And ".depaudit/findings.json" in "fixtures/json-sca-schema" contains at least one entry whose `source` is "socket" and `findingId` is "install-scripts"

  @adw-8
  Scenario: Each entry's `manifestPath` is the path of the manifest the finding originated from
    Given a fixture Node repository at "fixtures/json-manifest-path" whose manifest at "package.json" pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/json-manifest-path"
    Then the exit code is non-zero
    And ".depaudit/findings.json" in "fixtures/json-manifest-path" contains at least one entry whose `manifestPath` ends with "package.json"

  @adw-8
  Scenario: Each entry's `ecosystem` matches the manifest ecosystem
    Given a fixture repository at "fixtures/json-ecosystem-pip" whose "requirements.txt" pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/json-ecosystem-pip"
    Then the exit code is non-zero
    And ".depaudit/findings.json" in "fixtures/json-ecosystem-pip" contains at least one entry whose `ecosystem` is "pip"

  # ─── All four FindingMatcher classification categories surface ──────────────

  @adw-8 @regression
  Scenario: Classification "new" surfaces in .depaudit/findings.json for an un-accepted CVE
    Given a fixture Node repository at "fixtures/json-class-new" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/json-class-new"
    Then the exit code is non-zero
    And ".depaudit/findings.json" in "fixtures/json-class-new" contains at least one entry whose `classification` is "new"

  @adw-8 @regression
  Scenario: Classification "accepted" surfaces for a CVE matched by a valid [[IgnoredVulns]] entry
    Given a fixture Node repository at "fixtures/json-class-accepted" whose manifest pins a package with a known OSV CVE
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for that CVE's id with a valid `ignoreUntil` and a `reason` of at least 20 characters
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/json-class-accepted"
    Then the exit code is 0
    And ".depaudit/findings.json" in "fixtures/json-class-accepted" contains at least one entry whose `classification` is "accepted" and `source` is "osv"

  @adw-8 @regression
  Scenario: Classification "whitelisted" surfaces for a Socket alert matched by a valid commonAndFine entry
    Given a fixture Node repository at "fixtures/json-class-whitelisted" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a package in that manifest
    And the repository's .depaudit.yml has a `commonAndFine` entry matching that (package, alertType) tuple with a valid expiry
    When I run "depaudit scan fixtures/json-class-whitelisted"
    Then the exit code is 0
    And ".depaudit/findings.json" in "fixtures/json-class-whitelisted" contains at least one entry whose `classification` is "whitelisted" and `source` is "socket"

  @adw-8 @regression
  Scenario: Classification "expired-accept" surfaces for a CVE matched by an expired [[IgnoredVulns]] entry
    Given a fixture Node repository at "fixtures/json-class-expired" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the repository's osv-scanner.toml has an `[[IgnoredVulns]]` entry for that CVE's id whose `ignoreUntil` lint-passes but is treated as expired by FindingMatcher at scan time
    When I run "depaudit scan fixtures/json-class-expired"
    Then the exit code is non-zero
    And ".depaudit/findings.json" in "fixtures/json-class-expired" contains at least one entry whose `classification` is "expired-accept"

  # ─── sourceAvailability reflects the run's actual fail-open state ───────────

  @adw-8 @regression
  Scenario: sourceAvailability marks `socket` false when Socket times out
    Given a fixture Node repository at "fixtures/json-socket-timeout" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that never responds within the client timeout
    When I run "depaudit scan fixtures/json-socket-timeout"
    Then the exit code is non-zero
    And ".depaudit/findings.json" in "fixtures/json-socket-timeout" has a top-level object field "sourceAvailability" with `osv` set to true and `socket` set to false

  @adw-8 @regression
  Scenario: sourceAvailability marks `socket` false when Socket returns HTTP 503
    Given a fixture Node repository at "fixtures/json-socket-503" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 503 for every request
    When I run "depaudit scan fixtures/json-socket-503"
    Then the exit code is 0
    And ".depaudit/findings.json" in "fixtures/json-socket-503" has a top-level object field "sourceAvailability" with `osv` set to true and `socket` set to false

  @adw-8 @regression
  Scenario: sourceAvailability marks `socket` false when Socket returns HTTP 429
    Given a fixture Node repository at "fixtures/json-socket-429" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that returns HTTP 429 for every request
    When I run "depaudit scan fixtures/json-socket-429"
    Then the exit code is 0
    And ".depaudit/findings.json" in "fixtures/json-socket-429" has a top-level object field "sourceAvailability" with `osv` set to true and `socket` set to false

  @adw-8 @regression
  Scenario: sourceAvailability marks both `osv` and `socket` true on a fully successful scan
    Given a fixture Node repository at "fixtures/json-both-up" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/json-both-up"
    Then the exit code is 0
    And ".depaudit/findings.json" in "fixtures/json-both-up" has a top-level object field "sourceAvailability" with `osv` set to true and `socket` set to true

  @adw-8 @regression
  Scenario: sourceAvailability marks `osv` false when the OSV scan fails catastrophically
    Given a fixture Node repository at "fixtures/json-osv-fails" whose OSV scan fails catastrophically
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/json-osv-fails"
    Then the exit code is non-zero
    And the file ".depaudit/findings.json" exists in "fixtures/json-osv-fails"
    And ".depaudit/findings.json" in "fixtures/json-osv-fails" has a top-level object field "sourceAvailability" with `osv` set to false

  # ─── .gitignore warning behavior (issue: warn to stdout, never fatal) ───────

  @adw-8 @regression
  Scenario: A warning is printed to stdout when .depaudit/findings.json is not gitignored
    Given a fixture Node repository at "fixtures/json-no-gitignore" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the repository has no .gitignore entry covering ".depaudit/findings.json"
    When I run "depaudit scan fixtures/json-no-gitignore"
    Then the exit code is 0
    And stdout mentions "gitignore"
    And stdout mentions ".depaudit/findings.json"
    And the file ".depaudit/findings.json" exists in "fixtures/json-no-gitignore"

  @adw-8 @regression
  Scenario: No gitignore warning is printed when ".depaudit/" is in .gitignore (parent-directory match)
    Given a fixture Node repository at "fixtures/json-gitignore-dir" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the repository's .gitignore contains the line ".depaudit/"
    When I run "depaudit scan fixtures/json-gitignore-dir"
    Then the exit code is 0
    And stdout does not mention "gitignore"

  @adw-8
  Scenario: No gitignore warning is printed when ".depaudit/findings.json" is the explicit gitignore line
    Given a fixture Node repository at "fixtures/json-gitignore-file" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the repository's .gitignore contains the line ".depaudit/findings.json"
    When I run "depaudit scan fixtures/json-gitignore-file"
    Then the exit code is 0
    And stdout does not mention "gitignore"

  @adw-8 @regression
  Scenario: The gitignore warning is non-fatal and the scan proceeds normally
    Given a fixture Node repository at "fixtures/json-gitignore-warn-nonfatal" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the repository has no .gitignore entry covering ".depaudit/findings.json"
    When I run "depaudit scan fixtures/json-gitignore-warn-nonfatal"
    Then the exit code is non-zero
    And stdout mentions "gitignore"
    And the file ".depaudit/findings.json" exists in "fixtures/json-gitignore-warn-nonfatal"

  @adw-8
  Scenario: The gitignore warning step does not modify the .gitignore file
    Given a fixture Node repository at "fixtures/json-gitignore-no-mutation" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the repository has no .gitignore entry covering ".depaudit/findings.json"
    When I capture the content of .gitignore in "fixtures/json-gitignore-no-mutation"
    And I run "depaudit scan fixtures/json-gitignore-no-mutation"
    Then the exit code is 0
    And the .gitignore content in "fixtures/json-gitignore-no-mutation" is byte-identical to the captured content

  @adw-8
  Scenario: A repository with no .gitignore at all still produces the warning without crashing
    Given a fixture Node repository at "fixtures/json-no-gitignore-file" whose manifests have no known CVEs
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    And the repository has no .gitignore file
    When I run "depaudit scan fixtures/json-no-gitignore-file"
    Then the exit code is 0
    And stdout mentions "gitignore"
    And the file ".depaudit/findings.json" exists in "fixtures/json-no-gitignore-file"

  # ─── Polyglot and mixed-source scans round-trip into a single JSON file ─────

  @adw-8
  Scenario: A polyglot scan emits one findings.json containing every ecosystem's findings
    Given a fixture repository at "fixtures/json-polyglot" with the following manifests:
      | path             | ecosystem |
      | package.json     | npm       |
      | requirements.txt | pip       |
    And each listed manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with no alerts for every package
    When I run "depaudit scan fixtures/json-polyglot"
    Then the exit code is non-zero
    And ".depaudit/findings.json" in "fixtures/json-polyglot" contains at least one entry whose `ecosystem` is "npm"
    And ".depaudit/findings.json" in "fixtures/json-polyglot" contains at least one entry whose `ecosystem` is "pip"

  @adw-8
  Scenario: A scan with both a CVE and a Socket alert emits both in findings.json with the right `source` values
    Given a fixture Node repository at "fixtures/json-mixed-sources" whose manifest pins a package with a known OSV CVE
    And SOCKET_API_TOKEN is set to a valid test value
    And a mock Socket API that responds with an "install-scripts" alert for a different package declared in that manifest
    When I run "depaudit scan fixtures/json-mixed-sources"
    Then the exit code is non-zero
    And ".depaudit/findings.json" in "fixtures/json-mixed-sources" contains at least one entry whose `source` is "osv"
    And ".depaudit/findings.json" in "fixtures/json-mixed-sources" contains at least one entry whose `source` is "socket" and `findingId` is "install-scripts"
