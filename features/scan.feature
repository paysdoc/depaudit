@adw-3
Feature: depaudit scan — CLI skeleton and OSV-Scanner CVE scan (npm, stdout)
  As a maintainer
  I want `depaudit scan <path>` to discover every package.json in a Node repo and emit CVE findings to stdout
  So that I can see vulnerabilities in my Node dependency tree from a single command,
  without yet needing config files, a gate, or a PR comment

  Background:
    Given the `osv-scanner` binary is installed and on PATH
    And the `depaudit` CLI is installed and on PATH

  @adw-3 @regression
  Scenario: Clean Node repo exits 0 with no finding lines
    Given a fixture Node repository at "fixtures/clean-npm" whose manifests have no known CVEs
    When I run "depaudit scan fixtures/clean-npm"
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-3 @regression
  Scenario: Node repo with a known CVE exits non-zero and prints the finding to stdout
    Given a fixture Node repository at "fixtures/vulnerable-npm" whose manifest pins a package with a known OSV CVE
    When I run "depaudit scan fixtures/vulnerable-npm"
    Then the exit code is non-zero
    And stdout contains at least one finding line
    And each finding line contains a package name, a version, a finding-ID, and a severity

  @adw-3 @regression
  Scenario: Finding line format is package, version, finding-ID, severity
    Given a fixture Node repository at "fixtures/one-finding-npm" that produces exactly one OSV finding
    When I run "depaudit scan fixtures/one-finding-npm"
    Then stdout contains exactly one finding line
    And the finding line matches the pattern "<package> <version> <finding-id> <severity>"

  @adw-3 @regression
  Scenario: ManifestDiscoverer skips node_modules/
    Given a fixture Node repository at "fixtures/with-node-modules" with the following files:
      | path                                | description                            |
      | package.json                        | clean root manifest, no CVEs           |
      | node_modules/vuln-pkg/package.json  | nested manifest pinning a known CVE    |
    When I run "depaudit scan fixtures/with-node-modules"
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-3 @regression
  Scenario: ManifestDiscoverer respects .gitignore entries
    Given a fixture Node repository at "fixtures/with-gitignore" with the following files:
      | path                         | description                             |
      | package.json                 | clean root manifest, no CVEs            |
      | .gitignore                   | contains the line `vendor/`             |
      | vendor/legacy/package.json   | manifest pinning a known CVE            |
    When I run "depaudit scan fixtures/with-gitignore"
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-3 @regression
  Scenario: Monorepo — every package.json in the tree is scanned
    Given a fixture Node repository at "fixtures/monorepo-npm" with package.json files at:
      | path                      |
      | package.json              |
      | packages/a/package.json   |
      | packages/b/package.json   |
    And "packages/a/package.json" pins a package with a known OSV CVE
    And "package.json" and "packages/b/package.json" have no known CVEs
    When I run "depaudit scan fixtures/monorepo-npm"
    Then the exit code is non-zero
    And stdout contains a finding line whose package name matches a dependency declared in "packages/a/package.json"

  @adw-3 @regression
  Scenario: Omitting the path argument scans the current working directory
    Given a fixture Node repository at "fixtures/clean-npm" whose manifests have no known CVEs
    And the current working directory is "fixtures/clean-npm"
    When I run "depaudit scan" with no path argument
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-3
  Scenario: Non-existent path fails with a clear error
    When I run "depaudit scan fixtures/does-not-exist"
    Then the exit code is non-zero
    And stderr mentions that the path does not exist
