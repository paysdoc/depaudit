@adw-10
Feature: depaudit — packaged depaudit-gate.yml workflow template
  As a maintainer onboarding a target repo
  I want `DepauditSetupCommand` to drop a valid, ready-to-run `.github/workflows/depaudit-gate.yml`
  So that the CI Gate starts enforcing on day one without manual YAML authoring,
  with the packaged template installing `depaudit` globally, running `depaudit scan`,
  capturing its markdown output, and posting/updating the PR comment via the `gh` CLI —
  and deliberately NOT uploading SARIF (the in-repo Acceptance Register is the single source of truth)

  Background:
    Given the packaged `depaudit-gate.yml` workflow template ships inside the depaudit package

  # ─── File existence and YAML validity ──────────────────────────────────────

  @adw-10 @regression
  Scenario: The workflow template fixture exists at the packaged path
    When I resolve the path of the packaged `depaudit-gate.yml` template
    Then the packaged `depaudit-gate.yml` file exists on disk

  @adw-10 @regression
  Scenario: The workflow template parses as valid YAML
    When I read the packaged `depaudit-gate.yml` template
    Then the template parses as valid YAML with no errors

  @adw-10 @regression
  Scenario: The workflow template parses as a valid GitHub Actions workflow
    When I read the packaged `depaudit-gate.yml` template
    Then the parsed workflow has a top-level `on` trigger block
    And the parsed workflow has a top-level `jobs` block with at least one job

  # ─── Triggers and permissions ──────────────────────────────────────────────

  @adw-10 @regression
  Scenario: The workflow triggers on pull_request events
    When I read the packaged `depaudit-gate.yml` template
    Then the workflow's `on` trigger includes `pull_request`

  @adw-10 @regression
  Scenario: The workflow grants pull-requests write permission so the PR comment can be posted
    When I read the packaged `depaudit-gate.yml` template
    Then the workflow's `permissions` block grants `pull-requests: write`

  @adw-10
  Scenario: The workflow grants contents read permission so the repo can be checked out
    When I read the packaged `depaudit-gate.yml` template
    Then the workflow's `permissions` block grants `contents: read`

  # ─── Job structure ─────────────────────────────────────────────────────────

  @adw-10 @regression
  Scenario: The workflow runs on a GitHub-hosted ubuntu runner
    When I read the packaged `depaudit-gate.yml` template
    Then the depaudit-gate job's `runs-on` value starts with "ubuntu-"

  @adw-10 @regression
  Scenario: The workflow checks out the repository under test
    When I read the packaged `depaudit-gate.yml` template
    Then the depaudit-gate job has a step that uses "actions/checkout"

  @adw-10 @regression
  Scenario: The workflow sets up Node.js before installing depaudit
    When I read the packaged `depaudit-gate.yml` template
    Then the depaudit-gate job has a step that uses "actions/setup-node"

  # ─── Install, scan, capture markdown ──────────────────────────────────────

  @adw-10 @regression
  Scenario: The workflow installs depaudit globally via npm install -g
    When I read the packaged `depaudit-gate.yml` template
    Then at least one `run` step in the depaudit-gate job contains "npm install -g depaudit"

  @adw-10 @regression
  Scenario: The workflow runs `depaudit scan` against the repository
    When I read the packaged `depaudit-gate.yml` template
    Then at least one `run` step in the depaudit-gate job contains "depaudit scan"

  @adw-10 @regression
  Scenario: The workflow captures the `depaudit scan` markdown output for reuse by the comment step
    When I read the packaged `depaudit-gate.yml` template
    Then at least one `run` step in the depaudit-gate job redirects `depaudit scan` stdout into a file

  # ─── Failure propagation (scan non-zero → job failed) ──────────────────────

  @adw-10 @regression
  Scenario: The workflow propagates the `depaudit scan` non-zero exit code to the Actions check
    When I read the packaged `depaudit-gate.yml` template
    Then the `depaudit scan` step does not swallow its exit code
    And the depaudit-gate job fails when `depaudit scan` exits non-zero

  @adw-10 @regression
  Scenario: The comment-posting step runs even when the scan fails, so contributors see the failure reason
    When I read the packaged `depaudit-gate.yml` template
    Then the PR-comment step runs under an `if: always()` (or equivalent) condition

  # ─── gh CLI: post or update a PR comment ───────────────────────────────────

  @adw-10 @regression
  Scenario: The workflow posts the PR comment using the `gh` CLI
    When I read the packaged `depaudit-gate.yml` template
    Then at least one `run` step in the depaudit-gate job invokes the `gh` CLI

  @adw-10 @regression
  Scenario: The workflow passes the captured markdown as the comment body
    When I read the packaged `depaudit-gate.yml` template
    Then the PR-comment step reads the captured markdown file as the comment body source

  @adw-10 @regression
  Scenario: The workflow passes GITHUB_TOKEN to the `gh` CLI step
    When I read the packaged `depaudit-gate.yml` template
    Then the PR-comment step's environment includes a GITHUB_TOKEN secret reference

  # ─── Secrets wired (SOCKET_API_TOKEN, SLACK_WEBHOOK_URL) ───────────────────

  @adw-10 @regression
  Scenario: The `depaudit scan` step forwards SOCKET_API_TOKEN from the repo's secrets
    When I read the packaged `depaudit-gate.yml` template
    Then the `depaudit scan` step's environment includes a SOCKET_API_TOKEN secret reference

  @adw-10
  Scenario: The workflow references SLACK_WEBHOOK_URL so first-failure Slack notification can fire
    When I read the packaged `depaudit-gate.yml` template
    Then the workflow references a SLACK_WEBHOOK_URL secret

  # ─── Explicitly NOT SARIF / Code Scanning (user story 32) ──────────────────

  @adw-10 @regression
  Scenario: The workflow does NOT upload SARIF to GitHub Code Scanning (user story 32)
    When I read the packaged `depaudit-gate.yml` template
    Then the workflow does not contain a step that uses "github/codeql-action/upload-sarif"
    And the workflow does not contain a step that uses "actions/upload-sarif"

  @adw-10
  Scenario: The workflow does NOT request security-events write permission (SARIF gate not used)
    When I read the packaged `depaudit-gate.yml` template
    Then the workflow's `permissions` block does NOT grant `security-events: write`

  # ─── Trigger-branch / release-model agnosticism (user story 2) ─────────────

  @adw-10 @regression
  Scenario: The workflow fires on PRs regardless of whether the production branch is "main" or "dev→main"
    When I read the packaged `depaudit-gate.yml` template
    Then the workflow's `on.pull_request` block does not restrict to a single hard-coded target branch

  # ─── DepauditSetupCommand copies the template into target repos ────────────

  @adw-10
  Scenario: DepauditSetupCommand copies the packaged template to .github/workflows/depaudit-gate.yml in the target repo
    Given a fixture Node repository at "fixtures/gate-setup-copies-workflow" with no existing `.github/workflows/` directory
    When DepauditSetupCommand runs against "fixtures/gate-setup-copies-workflow"
    Then the file ".github/workflows/depaudit-gate.yml" exists in "fixtures/gate-setup-copies-workflow"
    And the file ".github/workflows/depaudit-gate.yml" in "fixtures/gate-setup-copies-workflow" is byte-identical to the packaged template
