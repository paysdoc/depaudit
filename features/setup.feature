@adw-12
Feature: depaudit setup — bootstrap a target repo end-to-end
  As a maintainer onboarding a repository to depaudit
  I want `depaudit setup` to detect my ecosystems, scaffold the workflow + config files,
  update `.gitignore`, run the first scan, baseline existing findings, and commit (or open a PR)
  So that a freshly-cloned repo becomes a depaudit-guarded repo in a single command
  with no residual setup steps beyond wiring the two repository secrets

  Background:
    Given the `osv-scanner` binary is installed and on PATH
    And the `depaudit` CLI is installed and on PATH
    And a mock `gh` CLI is on PATH that records its invocations and serves a fake remote branch list
    And a mock `git` CLI is on PATH that records its invocations and serves a fake repo state

  # ─── Happy path: freshly-cloned repo, no prior depaudit state ──────────────

  @adw-12 @regression
  Scenario: Setup succeeds in a freshly-cloned Node repo with no prior depaudit state
    Given a fixture Node repository at "fixtures/setup-fresh-npm" whose manifests have no known CVEs
    And the fixture repo has no `.github/workflows/depaudit-gate.yml`
    And the fixture repo has no `osv-scanner.toml`
    And the fixture repo has no `.depaudit.yml`
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-fresh-npm"
    Then the exit code is 0
    And the file "fixtures/setup-fresh-npm/.github/workflows/depaudit-gate.yml" exists
    And the file "fixtures/setup-fresh-npm/osv-scanner.toml" exists
    And the file "fixtures/setup-fresh-npm/.depaudit.yml" exists

  # ─── Ecosystem detection drives .depaudit.yml scaffolding ──────────────────

  @adw-12 @regression
  Scenario: Setup populates .depaudit.yml ecosystems from detected manifests in a polyglot repo
    Given a fixture repository at "fixtures/setup-polyglot" with the following manifests:
      | path             | ecosystem |
      | package.json     | npm       |
      | go.mod           | gomod     |
      | requirements.txt | pip       |
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-polyglot"
    Then the exit code is 0
    And the scaffolded "fixtures/setup-polyglot/.depaudit.yml" sets `policy.ecosystems` to a list containing "npm", "gomod", and "pip"

  @adw-12 @regression
  Scenario: Setup scaffolds .depaudit.yml with version 1 and the default policy
    Given a fixture Node repository at "fixtures/setup-default-policy" whose manifests have no known CVEs
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-default-policy"
    Then the scaffolded "fixtures/setup-default-policy/.depaudit.yml" sets `version` to 1
    And the scaffolded "fixtures/setup-default-policy/.depaudit.yml" sets `policy.severityThreshold` to "medium"
    And the scaffolded "fixtures/setup-default-policy/.depaudit.yml" sets `policy.maxAcceptDays` to 90
    And the scaffolded "fixtures/setup-default-policy/.depaudit.yml" sets `policy.maxCommonAndFineDays` to 365

  @adw-12 @regression
  Scenario: Setup scaffolds osv-scanner.toml with no IgnoredVulns entries when the repo is clean
    Given a fixture Node repository at "fixtures/setup-clean-toml" whose manifests have no known CVEs
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-clean-toml"
    Then the scaffolded "fixtures/setup-clean-toml/osv-scanner.toml" contains no `[[IgnoredVulns]]` entries
    And the scaffolded "fixtures/setup-clean-toml/osv-scanner.toml" parses as valid TOML

  # ─── Trigger-branch resolution (main if it exists, else default) ───────────

  @adw-12 @regression
  Scenario: Trigger branch resolves to "main" when the remote has a "main" branch
    Given a fixture Node repository at "fixtures/setup-branch-main" whose manifests have no known CVEs
    And the mock `gh` CLI reports that the remote has branches "main" and "dev" with default branch "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-branch-main"
    Then the exit code is 0
    And the scaffolded "fixtures/setup-branch-main/.github/workflows/depaudit-gate.yml" restricts `on.pull_request.branches` to "main"

  @adw-12 @regression
  Scenario: Trigger branch falls back to the default branch when "main" is absent
    Given a fixture Node repository at "fixtures/setup-branch-master" whose manifests have no known CVEs
    And the mock `gh` CLI reports that the remote has branches "master" with default branch "master"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-branch-master"
    Then the exit code is 0
    And the scaffolded "fixtures/setup-branch-master/.github/workflows/depaudit-gate.yml" restricts `on.pull_request.branches` to "master"

  @adw-12 @regression
  Scenario: Trigger branch resolves to a non-main default when the remote has "trunk" as default
    Given a fixture Node repository at "fixtures/setup-branch-trunk" whose manifests have no known CVEs
    And the mock `gh` CLI reports that the remote has branches "trunk" with default branch "trunk"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-branch-trunk"
    Then the scaffolded "fixtures/setup-branch-trunk/.github/workflows/depaudit-gate.yml" restricts `on.pull_request.branches` to "trunk"

  @adw-12
  Scenario: Trigger branch prefers "main" over the remote's advertised default when both exist
    Given a fixture Node repository at "fixtures/setup-branch-main-over-default" whose manifests have no known CVEs
    And the mock `gh` CLI reports that the remote has branches "main" and "develop" with default branch "develop"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-branch-main-over-default"
    Then the scaffolded "fixtures/setup-branch-main-over-default/.github/workflows/depaudit-gate.yml" restricts `on.pull_request.branches` to "main"

  # ─── Scaffolded workflow matches the packaged template (Slack block included)

  @adw-12 @regression
  Scenario: Scaffolded workflow preserves the SLACK_WEBHOOK_URL env on the post-pr-comment step
    Given a fixture Node repository at "fixtures/setup-slack-block" whose manifests have no known CVEs
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-slack-block"
    Then the scaffolded "fixtures/setup-slack-block/.github/workflows/depaudit-gate.yml" post-pr-comment step includes a SLACK_WEBHOOK_URL secret reference

  @adw-12 @regression
  Scenario: Scaffolded workflow preserves the SOCKET_API_TOKEN env on the scan step
    Given a fixture Node repository at "fixtures/setup-socket-env" whose manifests have no known CVEs
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-socket-env"
    Then the scaffolded "fixtures/setup-socket-env/.github/workflows/depaudit-gate.yml" scan step includes a SOCKET_API_TOKEN secret reference

  @adw-12 @regression
  Scenario: Scaffolded workflow parses as valid YAML after branch-pinning mutation
    Given a fixture Node repository at "fixtures/setup-valid-yaml" whose manifests have no known CVEs
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-valid-yaml"
    Then the scaffolded "fixtures/setup-valid-yaml/.github/workflows/depaudit-gate.yml" parses as valid YAML with no errors

  # ─── .gitignore handling ───────────────────────────────────────────────────

  @adw-12 @regression
  Scenario: Setup appends .depaudit/findings.json to an existing .gitignore
    Given a fixture Node repository at "fixtures/setup-gitignore-existing" whose manifests have no known CVEs
    And the fixture repo's ".gitignore" exists and contains "node_modules/"
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-gitignore-existing"
    Then the file "fixtures/setup-gitignore-existing/.gitignore" contains a line ".depaudit/findings.json"
    And the file "fixtures/setup-gitignore-existing/.gitignore" still contains a line "node_modules/"

  @adw-12 @regression
  Scenario: Setup creates a new .gitignore when none exists and writes the findings.json entry
    Given a fixture Node repository at "fixtures/setup-gitignore-absent" whose manifests have no known CVEs
    And the fixture repo has no ".gitignore"
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-gitignore-absent"
    Then the file "fixtures/setup-gitignore-absent/.gitignore" exists
    And the file "fixtures/setup-gitignore-absent/.gitignore" contains a line ".depaudit/findings.json"

  @adw-12 @regression
  Scenario: Setup is idempotent on .gitignore — running twice does not duplicate the findings.json entry
    Given a fixture Node repository at "fixtures/setup-gitignore-preexisting-entry" whose manifests have no known CVEs
    And the fixture repo's ".gitignore" already contains a line ".depaudit/findings.json"
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-gitignore-preexisting-entry"
    Then the file "fixtures/setup-gitignore-preexisting-entry/.gitignore" contains exactly one line ".depaudit/findings.json"

  # ─── First-scan execution ─────────────────────────────────────────────────

  @adw-12 @regression
  Scenario: Setup writes .depaudit/findings.json from its first scan
    Given a fixture Node repository at "fixtures/setup-first-scan" whose manifest pins a package with a known MEDIUM-severity OSV finding
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-first-scan"
    Then the file "fixtures/setup-first-scan/.depaudit/findings.json" exists
    And the JSON file "fixtures/setup-first-scan/.depaudit/findings.json" contains at least one finding entry

  # ─── Commit-vs-PR branching (acceptance-criteria integration tests) ────────

  @adw-12 @regression
  Scenario: Integration — feature-branch path commits directly to the current branch
    Given a fixture Node repository at "fixtures/setup-feature-branch-path" whose manifest pins a package with a known MEDIUM-severity OSV finding
    And the mock `gh` CLI reports that the remote has branches "main" with default branch "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-feature-branch-path"
    Then the exit code is 0
    And the mock `git` CLI received a "commit" invocation on branch "feature/adopt-depaudit"
    And the mock `git` CLI did not receive any "checkout -b depaudit-setup" invocation
    And the mock `gh` CLI did not receive any "pr create" invocation

  @adw-12 @regression
  Scenario: Integration — prod-branch path creates the depaudit-setup branch and opens a PR
    Given a fixture Node repository at "fixtures/setup-prod-branch-path" whose manifest pins a package with a known MEDIUM-severity OSV finding
    And the mock `gh` CLI reports that the remote has branches "main" with default branch "main"
    And the fixture repo's current branch is "main"
    When I run "depaudit setup" in "fixtures/setup-prod-branch-path"
    Then the exit code is 0
    And the mock `git` CLI received a "checkout -b depaudit-setup" invocation
    And the mock `git` CLI received a "push" invocation for branch "depaudit-setup"
    And the mock `gh` CLI received a "pr create" invocation whose base branch is "main"

  # ─── Baseline ties to acceptance criteria (full spec in setup_baseline.feature)

  @adw-12 @regression
  Scenario: Setup baselines a MEDIUM-severity CVE finding into osv-scanner.toml
    Given a fixture Node repository at "fixtures/setup-baseline-medium-cve" whose manifest pins a package with a known MEDIUM-severity OSV finding
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-baseline-medium-cve"
    Then the exit code is 0
    And the scaffolded "fixtures/setup-baseline-medium-cve/osv-scanner.toml" contains at least one `[[IgnoredVulns]]` entry whose id matches that finding
    And the scaffolded "fixtures/setup-baseline-medium-cve/osv-scanner.toml"'s baselined entry has `reason` equal to "baselined at install"
    And the scaffolded "fixtures/setup-baseline-medium-cve/osv-scanner.toml"'s baselined entry has `ignoreUntil` equal to today plus 90 days

  # ─── Post-setup: next scan is green ────────────────────────────────────────

  @adw-12 @regression
  Scenario: After setup, re-running `depaudit scan` on the same repo exits 0
    Given a fixture Node repository at "fixtures/setup-then-scan-green" whose manifest pins a package with a known MEDIUM-severity OSV finding
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-then-scan-green"
    And I run "depaudit scan fixtures/setup-then-scan-green"
    Then the exit code is 0
    And stdout contains no finding lines

  # ─── Pre-existing state handling ──────────────────────────────────────────

  @adw-12 @regression
  Scenario: Setup aborts when `.depaudit.yml` already exists (refuses to clobber)
    Given a fixture Node repository at "fixtures/setup-preexisting-yml" whose manifests have no known CVEs
    And the fixture repo has a pre-existing "fixtures/setup-preexisting-yml/.depaudit.yml"
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-preexisting-yml"
    Then the exit code is non-zero
    And stderr mentions ".depaudit.yml"
    And stderr mentions "already exists"

  @adw-12
  Scenario: Setup aborts when `.github/workflows/depaudit-gate.yml` already exists
    Given a fixture Node repository at "fixtures/setup-preexisting-workflow" whose manifests have no known CVEs
    And the fixture repo has a pre-existing "fixtures/setup-preexisting-workflow/.github/workflows/depaudit-gate.yml"
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-preexisting-workflow"
    Then the exit code is non-zero
    And stderr mentions "depaudit-gate.yml"
    And stderr mentions "already exists"

  # ─── Out of scope: secrets ────────────────────────────────────────────────

  @adw-12
  Scenario: Setup does NOT set repository secrets (secrets are ADW's adwInit job)
    Given a fixture Node repository at "fixtures/setup-no-secret-calls" whose manifests have no known CVEs
    And the mock `gh` CLI reports that the remote has branches "main"
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-no-secret-calls"
    Then the exit code is 0
    And the mock `gh` CLI did not receive any "secret set" invocation

  # ─── Non-zero exit paths ──────────────────────────────────────────────────

  @adw-12
  Scenario: Setup aborts with a clear error when the CWD is not a git repository
    Given a fixture directory at "fixtures/setup-not-a-repo" that is not a git repository
    When I run "depaudit setup" in "fixtures/setup-not-a-repo"
    Then the exit code is non-zero
    And stderr mentions "git"

  @adw-12
  Scenario: Setup aborts when the remote branch list cannot be fetched via `gh`
    Given a fixture Node repository at "fixtures/setup-gh-fails" whose manifests have no known CVEs
    And the mock `gh` CLI exits non-zero with stderr "gh: authentication required" on every invocation
    And the fixture repo's current branch is "feature/adopt-depaudit"
    When I run "depaudit setup" in "fixtures/setup-gh-fails"
    Then the exit code is non-zero
    And stderr mentions "gh"
