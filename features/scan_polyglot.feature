@adw-6
Feature: depaudit scan — polyglot ecosystem support (pip, gomod, cargo, maven, gem, composer)
  As a maintainer of a polyglot repository
  I want `depaudit scan` to discover every supported manifest type — `requirements.txt`, `pyproject.toml`,
  `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, `composer.json` — alongside `package.json`
  So that a single scan produces one merged result for every ecosystem in my tree,
  with `OsvScannerAdapter` emitting the correct ecosystem per manifest and findings attributed
  to their originating manifest

  Background:
    Given the `osv-scanner` binary is installed and on PATH
    And the `depaudit` CLI is installed and on PATH

  @adw-6 @regression
  Scenario Outline: Discover and scan a <ecosystem> manifest (<manifest>) with a known CVE
    Given a fixture repository at "<fixture>" whose "<manifest>" pins a package with a known OSV CVE
    When I run "depaudit scan --format text <fixture>"
    Then the exit code is non-zero
    And stdout contains at least one finding line
    And each finding line contains a package name, a version, a finding-ID, and a severity

    Examples:
      | ecosystem | manifest         | fixture                       |
      | pip       | requirements.txt | fixtures/vulnerable-pip       |
      | pip       | pyproject.toml   | fixtures/vulnerable-pyproject |
      | gomod     | go.mod           | fixtures/vulnerable-gomod     |
      | cargo     | Cargo.toml       | fixtures/vulnerable-cargo     |
      | maven     | pom.xml          | fixtures/vulnerable-maven     |
      | gem       | Gemfile          | fixtures/vulnerable-gem       |
      | composer  | composer.json    | fixtures/vulnerable-composer  |

  @adw-6 @regression
  Scenario Outline: Clean <ecosystem> repository exits 0 with no finding lines
    Given a fixture repository at "<fixture>" whose "<manifest>" has no known CVEs
    When I run "depaudit scan <fixture>"
    Then the exit code is 0
    And stdout contains no finding lines

    Examples:
      | ecosystem | manifest         | fixture                 |
      | pip       | requirements.txt | fixtures/clean-pip      |
      | gomod     | go.mod           | fixtures/clean-gomod    |
      | cargo     | Cargo.toml       | fixtures/clean-cargo    |

  @adw-6 @regression
  Scenario Outline: ManifestDiscoverer skips <build_dir> build directories
    Given a fixture repository at "<fixture>" with the following files:
      | path                                  | description                           |
      | <root_manifest>                       | clean root manifest, no CVEs          |
      | <build_dir>/nested/<nested_manifest>  | nested manifest pinning a known CVE   |
    When I run "depaudit scan <fixture>"
    Then the exit code is 0
    And stdout contains no finding lines

    Examples:
      | build_dir   | fixture                   | root_manifest    | nested_manifest  |
      | vendor      | fixtures/with-vendor-dir  | go.mod           | go.mod           |
      | target      | fixtures/with-target-dir  | Cargo.toml       | Cargo.toml       |
      | .venv       | fixtures/with-venv-dir    | requirements.txt | requirements.txt |
      | __pycache__ | fixtures/with-pycache-dir | requirements.txt | requirements.txt |

  @adw-6 @regression
  Scenario: ManifestDiscoverer still respects .gitignore in a polyglot repository
    Given a fixture repository at "fixtures/polyglot-with-gitignore" with the following files:
      | path                        | description                             |
      | go.mod                      | clean root manifest, no CVEs            |
      | .gitignore                  | contains the line `third_party/`        |
      | third_party/legacy/go.mod   | manifest pinning a known CVE            |
    When I run "depaudit scan fixtures/polyglot-with-gitignore"
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-6 @regression
  Scenario: Polyglot monorepo — findings from npm, gomod, and pip are merged into one scan result
    Given a fixture repository at "fixtures/polyglot-monorepo" with the following manifests:
      | path             | ecosystem |
      | package.json     | npm       |
      | go.mod           | gomod     |
      | requirements.txt | pip       |
    And each listed manifest pins a package with a known OSV CVE
    When I run "depaudit scan --format text fixtures/polyglot-monorepo"
    Then the exit code is non-zero
    And stdout contains at least one finding line whose package name is declared in "package.json"
    And stdout contains at least one finding line whose package name is declared in "go.mod"
    And stdout contains at least one finding line whose package name is declared in "requirements.txt"

  @adw-6 @regression
  Scenario: Polyglot monorepo — only manifests with a CVE contribute finding lines
    Given a fixture repository at "fixtures/polyglot-partial-findings" with the following manifests:
      | path             | ecosystem |
      | package.json     | npm       |
      | go.mod           | gomod     |
      | requirements.txt | pip       |
    And "requirements.txt" pins a package with a known OSV CVE
    And "package.json" and "go.mod" have no known CVEs
    When I run "depaudit scan --format text fixtures/polyglot-partial-findings"
    Then the exit code is non-zero
    And stdout contains at least one finding line whose package name is declared in "requirements.txt"
    And no finding line's package name is declared in "package.json"
    And no finding line's package name is declared in "go.mod"

  @adw-6 @regression
  Scenario: Polyglot monorepo with nested manifests at multiple depths is fully scanned
    Given a fixture repository at "fixtures/polyglot-nested" with the following manifests:
      | path                             | ecosystem |
      | package.json                     | npm       |
      | services/api/go.mod              | gomod     |
      | services/worker/requirements.txt | pip       |
    And "services/api/go.mod" pins a package with a known OSV CVE
    And "services/worker/requirements.txt" pins a package with a known OSV CVE
    And "package.json" has no known CVEs
    When I run "depaudit scan --format text fixtures/polyglot-nested"
    Then the exit code is non-zero
    And stdout contains at least one finding line whose package name is declared in "services/api/go.mod"
    And stdout contains at least one finding line whose package name is declared in "services/worker/requirements.txt"

  @adw-6
  Scenario: Clean polyglot monorepo exits 0 with no finding lines
    Given a fixture repository at "fixtures/polyglot-clean" with the following manifests:
      | path             | ecosystem |
      | package.json     | npm       |
      | go.mod           | gomod     |
      | requirements.txt | pip       |
    And no listed manifest pins a package with a known OSV CVE
    When I run "depaudit scan fixtures/polyglot-clean"
    Then the exit code is 0
    And stdout contains no finding lines

  @adw-6
  Scenario: pyproject.toml and requirements.txt in the same directory are both discovered
    Given a fixture repository at "fixtures/pip-dual-manifest" with the following files:
      | path             | description                                         |
      | pyproject.toml   | clean manifest, no CVEs                             |
      | requirements.txt | manifest pinning a package with a known OSV CVE     |
    When I run "depaudit scan --format text fixtures/pip-dual-manifest"
    Then the exit code is non-zero
    And stdout contains at least one finding line whose package name is declared in "requirements.txt"

  @adw-6
  Scenario: Repository with no supported manifests exits 0 cleanly
    Given a fixture repository at "fixtures/no-manifests" containing only non-manifest files
    When I run "depaudit scan fixtures/no-manifests"
    Then the exit code is 0
    And stdout contains no finding lines
