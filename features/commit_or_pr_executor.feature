@adw-12
Feature: depaudit — CommitOrPrExecutor hybrid commit vs branch-and-PR policy
  As the module that finalises a `depaudit setup` run
  I want `CommitOrPrExecutor` to commit directly when I'm on a feature branch
  and to create a `depaudit-setup` branch + push + open a PR when I'm on the resolved production branch
  So that the setup step never bypasses the gate it is installing,
  with all `git` and `gh` side-effects driven through injectable `execFile` boundaries
  that the tests can mock

  Background:
    Given a mock `git` CLI is on PATH that records its invocations and serves a fake repo state
    And a mock `gh` CLI is on PATH that records its invocations and serves a fake remote state

  # ─── Decision branch: current branch ≠ resolved prod branch → direct commit

  @adw-12 @regression
  Scenario: On a feature branch, CommitOrPrExecutor stages scaffolded files and commits on the current branch
    Given the current branch is "feature/adopt-depaudit"
    And the resolved production branch is "main"
    And the set of files to commit is:
      | path                                   |
      | .github/workflows/depaudit-gate.yml    |
      | osv-scanner.toml                       |
      | .depaudit.yml                          |
      | .gitignore                             |
    When CommitOrPrExecutor finalises the setup
    Then the mock `git` CLI received an "add" invocation for every listed path
    And the mock `git` CLI received exactly one "commit" invocation on branch "feature/adopt-depaudit"
    And the mock `git` CLI did not receive any "checkout -b" invocation
    And the mock `gh` CLI did not receive any "pr create" invocation

  @adw-12 @regression
  Scenario: On a feature branch, the commit message identifies depaudit setup
    Given the current branch is "feature/adopt-depaudit"
    And the resolved production branch is "main"
    When CommitOrPrExecutor finalises the setup
    Then the mock `git` CLI's "commit" invocation passed a message mentioning "depaudit setup"

  @adw-12 @regression
  Scenario: On a feature branch, CommitOrPrExecutor does not push or open a PR
    Given the current branch is "feature/adopt-depaudit"
    And the resolved production branch is "main"
    When CommitOrPrExecutor finalises the setup
    Then the mock `git` CLI did not receive any "push" invocation
    And the mock `gh` CLI did not receive any "pr create" invocation

  # ─── Decision branch: current branch == resolved prod branch → branch + PR

  @adw-12 @regression
  Scenario: On the production branch, CommitOrPrExecutor creates the `depaudit-setup` branch, pushes, and opens a PR
    Given the current branch is "main"
    And the resolved production branch is "main"
    When CommitOrPrExecutor finalises the setup
    Then the mock `git` CLI received a "checkout -b depaudit-setup" invocation
    And the mock `git` CLI received exactly one "commit" invocation on branch "depaudit-setup"
    And the mock `git` CLI received a "push" invocation for branch "depaudit-setup"
    And the mock `gh` CLI received exactly one "pr create" invocation
    And the mock `gh` CLI's "pr create" invocation targets base branch "main"

  @adw-12 @regression
  Scenario: On the production branch, the opened PR's title identifies depaudit setup
    Given the current branch is "main"
    And the resolved production branch is "main"
    When CommitOrPrExecutor finalises the setup
    Then the mock `gh` CLI's "pr create" invocation passed a title mentioning "depaudit setup"

  @adw-12 @regression
  Scenario: On the production branch, the opened PR's head branch is "depaudit-setup"
    Given the current branch is "main"
    And the resolved production branch is "main"
    When CommitOrPrExecutor finalises the setup
    Then the mock `gh` CLI's "pr create" invocation uses head branch "depaudit-setup"

  @adw-12 @regression
  Scenario: On the production branch with a non-main prod branch (dev→main model), the PR base is the resolved prod branch
    Given the current branch is "dev"
    And the resolved production branch is "dev"
    When CommitOrPrExecutor finalises the setup
    Then the mock `gh` CLI received exactly one "pr create" invocation
    And the mock `gh` CLI's "pr create" invocation targets base branch "dev"

  # ─── Branch-decision invariants ───────────────────────────────────────────

  @adw-12 @regression
  Scenario: A branch whose name is a prefix of the prod branch is still treated as a feature branch
    Given the current branch is "mai"
    And the resolved production branch is "main"
    When CommitOrPrExecutor finalises the setup
    Then the mock `git` CLI received exactly one "commit" invocation on branch "mai"
    And the mock `gh` CLI did not receive any "pr create" invocation

  @adw-12 @regression
  Scenario: Branch comparison is case-sensitive — "Main" is NOT the prod branch "main"
    Given the current branch is "Main"
    And the resolved production branch is "main"
    When CommitOrPrExecutor finalises the setup
    Then the mock `git` CLI received exactly one "commit" invocation on branch "Main"
    And the mock `gh` CLI did not receive any "pr create" invocation

  # ─── Error paths: git failures ────────────────────────────────────────────

  @adw-12 @regression
  Scenario: `git add` failure surfaces as a non-zero exit from CommitOrPrExecutor
    Given the current branch is "feature/adopt-depaudit"
    And the resolved production branch is "main"
    And the mock `git` CLI exits non-zero with stderr "git: pathspec did not match" on any "add" invocation
    When CommitOrPrExecutor finalises the setup
    Then the CommitOrPrExecutor invocation exits non-zero
    And stderr mentions "git"

  @adw-12 @regression
  Scenario: `git commit` failure surfaces as a non-zero exit from CommitOrPrExecutor
    Given the current branch is "feature/adopt-depaudit"
    And the resolved production branch is "main"
    And the mock `git` CLI exits non-zero with stderr "git: nothing to commit" on any "commit" invocation
    When CommitOrPrExecutor finalises the setup
    Then the CommitOrPrExecutor invocation exits non-zero
    And stderr mentions "git"

  @adw-12 @regression
  Scenario: `git checkout -b` failure on the prod-branch path surfaces non-zero (no push, no PR)
    Given the current branch is "main"
    And the resolved production branch is "main"
    And the mock `git` CLI exits non-zero with stderr "fatal: branch already exists" on any "checkout -b" invocation
    When CommitOrPrExecutor finalises the setup
    Then the CommitOrPrExecutor invocation exits non-zero
    And the mock `git` CLI did not receive any "push" invocation
    And the mock `gh` CLI did not receive any "pr create" invocation

  @adw-12 @regression
  Scenario: `git push` failure on the prod-branch path surfaces non-zero (PR not opened)
    Given the current branch is "main"
    And the resolved production branch is "main"
    And the mock `git` CLI exits non-zero with stderr "fatal: unable to access remote" on any "push" invocation
    When CommitOrPrExecutor finalises the setup
    Then the CommitOrPrExecutor invocation exits non-zero
    And the mock `gh` CLI did not receive any "pr create" invocation

  @adw-12 @regression
  Scenario: `gh pr create` failure on the prod-branch path surfaces non-zero (branch was still created and pushed)
    Given the current branch is "main"
    And the resolved production branch is "main"
    And the mock `gh` CLI exits non-zero with stderr "gh: API rate limit" on any "pr create" invocation
    When CommitOrPrExecutor finalises the setup
    Then the CommitOrPrExecutor invocation exits non-zero
    And the mock `git` CLI received a "checkout -b depaudit-setup" invocation
    And the mock `git` CLI received a "push" invocation for branch "depaudit-setup"

  # ─── Current-branch detection ─────────────────────────────────────────────

  @adw-12 @regression
  Scenario: CommitOrPrExecutor reads the current branch from `git branch --show-current`
    Given the mock `git` CLI reports "feature/adopt-depaudit" as the current branch
    And the resolved production branch is "main"
    When CommitOrPrExecutor finalises the setup
    Then the mock `git` CLI received a "branch --show-current" invocation

  @adw-12
  Scenario: CommitOrPrExecutor aborts when `git branch --show-current` fails
    Given the mock `git` CLI exits non-zero with stderr "fatal: not a git repository" on any "branch --show-current" invocation
    And the resolved production branch is "main"
    When CommitOrPrExecutor finalises the setup
    Then the CommitOrPrExecutor invocation exits non-zero
    And stderr mentions "git"
    And the mock `git` CLI did not receive any "commit" invocation

  # ─── Signed commits / environment passthrough (contributor-visible behavior)

  @adw-12
  Scenario: CommitOrPrExecutor does not add `--no-verify` to its commit invocation
    Given the current branch is "feature/adopt-depaudit"
    And the resolved production branch is "main"
    When CommitOrPrExecutor finalises the setup
    Then the mock `git` CLI's "commit" invocation does not include "--no-verify"
