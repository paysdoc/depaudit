@adw-10
Feature: depaudit — StateTracker PR-comment dedupe and pass/fail state detection
  As a contributor iterating on a PR
  I want the depaudit-gate workflow to update a single PR comment across every push
  So that my PR page doesn't accumulate one "depaudit gate: FAIL" comment per commit —
  StateTracker reads the existing PR comments, identifies the prior depaudit comment by
  its `<!-- depaudit-gate-comment -->` HTML marker, detects the prior pass/fail state,
  and chooses between posting a new comment (first run) and editing the existing one
  (every subsequent run on the same PR)

  Background:
    Given the `depaudit` CLI is installed and on PATH
    And a mock `gh` CLI is on PATH that records its invocations and serves a fake PR comment list

  # ─── Post-new vs update-in-place (core comment dedupe) ─────────────────────

  @adw-10 @regression
  Scenario: First run on a PR with no prior comments posts a new comment via `gh pr comment`
    Given the mock `gh` CLI returns an empty comment list for PR 42
    And a markdown body containing the marker "<!-- depaudit-gate-comment -->" is supplied as input
    When StateTracker reconciles the PR comment for PR 42
    Then the mock `gh` CLI received exactly one "pr comment" POST invocation
    And the mock `gh` CLI did not receive any comment-edit invocation

  @adw-10 @regression
  Scenario: Second run on the same PR edits the existing comment in place (no new comment)
    Given the mock `gh` CLI returns a comment list for PR 42 containing one comment whose body includes "<!-- depaudit-gate-comment -->"
    And a markdown body containing the marker "<!-- depaudit-gate-comment -->" is supplied as input
    When StateTracker reconciles the PR comment for PR 42
    Then the mock `gh` CLI received exactly one comment-edit invocation targeting the marker-bearing comment
    And the mock `gh` CLI did not receive any "pr comment" POST invocation

  @adw-10 @regression
  Scenario: The HTML marker is present in every body that StateTracker writes
    Given the mock `gh` CLI returns an empty comment list for PR 42
    And a markdown body containing the marker "<!-- depaudit-gate-comment -->" is supplied as input
    When StateTracker reconciles the PR comment for PR 42
    Then the body sent to the mock `gh` CLI contains the marker "<!-- depaudit-gate-comment -->"

  # ─── Marker-based identification (ignore unrelated comments) ───────────────

  @adw-10 @regression
  Scenario: Prior comments without the marker are ignored (StateTracker still posts new)
    Given the mock `gh` CLI returns a comment list for PR 42 containing two comments, neither of which includes "<!-- depaudit-gate-comment -->"
    And a markdown body containing the marker "<!-- depaudit-gate-comment -->" is supplied as input
    When StateTracker reconciles the PR comment for PR 42
    Then the mock `gh` CLI received exactly one "pr comment" POST invocation
    And the mock `gh` CLI did not receive any comment-edit invocation

  @adw-10 @regression
  Scenario: Only the marker-bearing comment is edited when both marker and non-marker comments exist
    Given the mock `gh` CLI returns a comment list for PR 42 containing one non-depaudit comment followed by one comment whose body includes "<!-- depaudit-gate-comment -->"
    And a markdown body containing the marker "<!-- depaudit-gate-comment -->" is supplied as input
    When StateTracker reconciles the PR comment for PR 42
    Then the mock `gh` CLI received exactly one comment-edit invocation targeting the marker-bearing comment
    And the mock `gh` CLI did not touch the non-depaudit comment

  @adw-10
  Scenario: When multiple marker-bearing comments exist, StateTracker edits the oldest and leaves the rest alone
    Given the mock `gh` CLI returns a comment list for PR 42 containing two comments each whose body includes "<!-- depaudit-gate-comment -->"
    And a markdown body containing the marker "<!-- depaudit-gate-comment -->" is supplied as input
    When StateTracker reconciles the PR comment for PR 42
    Then the mock `gh` CLI received exactly one comment-edit invocation targeting the oldest marker-bearing comment
    And the mock `gh` CLI did not receive any "pr comment" POST invocation

  # ─── Dedupe invariant: many runs → exactly one comment (user story 9) ──────

  @adw-10 @regression
  Scenario: Three sequential workflow runs on the same PR produce exactly one marker-bearing comment
    Given the mock `gh` CLI starts with an empty comment list for PR 42
    And the mock `gh` CLI persists its post/edit mutations across invocations
    And a markdown body containing the marker "<!-- depaudit-gate-comment -->" is supplied as input
    When StateTracker reconciles the PR comment for PR 42
    And StateTracker reconciles the PR comment for PR 42
    And StateTracker reconciles the PR comment for PR 42
    Then the mock `gh` CLI's final PR 42 comment list contains exactly one comment whose body includes "<!-- depaudit-gate-comment -->"

  # ─── Pass/fail state detection from prior comment body ────────────────────

  @adw-10 @regression
  Scenario: StateTracker detects a prior PASS state when the prior comment body contains "depaudit gate: PASS"
    Given the mock `gh` CLI returns a comment list for PR 42 containing one comment whose body includes "<!-- depaudit-gate-comment -->" and a header "depaudit gate: PASS"
    When StateTracker reads the prior PR state for PR 42
    Then the prior state reports `priorOutcome` as "pass"

  @adw-10 @regression
  Scenario: StateTracker detects a prior FAIL state when the prior comment body contains "depaudit gate: FAIL"
    Given the mock `gh` CLI returns a comment list for PR 42 containing one comment whose body includes "<!-- depaudit-gate-comment -->" and a header "depaudit gate: FAIL"
    When StateTracker reads the prior PR state for PR 42
    Then the prior state reports `priorOutcome` as "fail"

  @adw-10 @regression
  Scenario: StateTracker reports `priorOutcome` as "none" when no marker-bearing comment exists
    Given the mock `gh` CLI returns an empty comment list for PR 42
    When StateTracker reads the prior PR state for PR 42
    Then the prior state reports `priorOutcome` as "none"

  @adw-10
  Scenario: Pass→Fail transition is flagged as a first-failure transition
    Given the mock `gh` CLI returns a comment list for PR 42 containing one marker-bearing comment whose header says "depaudit gate: PASS"
    And the current scan outcome is "fail"
    When StateTracker computes the state transition for PR 42
    Then the transition is flagged as a first-failure transition
    And the transition's `shouldNotifySlack` flag is true

  @adw-10
  Scenario: Fail→Fail transition is NOT flagged as a first-failure transition (Slack stays quiet)
    Given the mock `gh` CLI returns a comment list for PR 42 containing one marker-bearing comment whose header says "depaudit gate: FAIL"
    And the current scan outcome is "fail"
    When StateTracker computes the state transition for PR 42
    Then the transition is not flagged as a first-failure transition
    And the transition's `shouldNotifySlack` flag is false

  @adw-10
  Scenario: Fail→Pass transition is not flagged as a first-failure transition
    Given the mock `gh` CLI returns a comment list for PR 42 containing one marker-bearing comment whose header says "depaudit gate: FAIL"
    And the current scan outcome is "pass"
    When StateTracker computes the state transition for PR 42
    Then the transition is not flagged as a first-failure transition
    And the transition's `shouldNotifySlack` flag is false

  # ─── Error propagation (gh CLI unreachable / auth failures) ────────────────

  @adw-10 @regression
  Scenario: `gh` CLI invocation failure on list-comments aborts with a clear error (no silent comment-posting)
    Given the mock `gh` CLI exits non-zero with stderr "gh: authentication required" on every list-comments invocation
    And a markdown body containing the marker "<!-- depaudit-gate-comment -->" is supplied as input
    When StateTracker reconciles the PR comment for PR 42
    Then the StateTracker invocation exits non-zero
    And stderr mentions "gh"
    And the mock `gh` CLI did not receive any "pr comment" POST invocation
    And the mock `gh` CLI did not receive any comment-edit invocation

  @adw-10
  Scenario: `gh` CLI invocation failure on post/edit surfaces as a non-zero exit from StateTracker
    Given the mock `gh` CLI returns an empty comment list for PR 42
    And the mock `gh` CLI exits non-zero with stderr "gh: API rate limit" on any "pr comment" POST invocation
    And a markdown body containing the marker "<!-- depaudit-gate-comment -->" is supplied as input
    When StateTracker reconciles the PR comment for PR 42
    Then the StateTracker invocation exits non-zero
    And stderr mentions "gh"

  # ─── Trigger-branch agnosticism (user story 2) ─────────────────────────────

  @adw-10
  Scenario: StateTracker works on a PR whose base branch is "main"
    Given the mock `gh` CLI returns an empty comment list for PR 42 whose base branch is "main"
    And a markdown body containing the marker "<!-- depaudit-gate-comment -->" is supplied as input
    When StateTracker reconciles the PR comment for PR 42
    Then the mock `gh` CLI received exactly one "pr comment" POST invocation

  @adw-10
  Scenario: StateTracker works on a PR whose base branch is a non-main trigger branch (dev→main release model)
    Given the mock `gh` CLI returns an empty comment list for PR 42 whose base branch is "dev"
    And a markdown body containing the marker "<!-- depaudit-gate-comment -->" is supplied as input
    When StateTracker reconciles the PR comment for PR 42
    Then the mock `gh` CLI received exactly one "pr comment" POST invocation

  # ─── Markdown body preservation (user story 8: remediation is visible) ─────

  @adw-10 @regression
  Scenario: StateTracker preserves the markdown body byte-for-byte (no re-formatting of MarkdownReporter output)
    Given the mock `gh` CLI returns an empty comment list for PR 42
    And a markdown body "<!-- depaudit-gate-comment -->\n\n## depaudit gate: FAIL\n\n- new: 1\n" is supplied as input
    When StateTracker reconciles the PR comment for PR 42
    Then the body sent to the mock `gh` CLI is byte-identical to the supplied markdown body

  # ─── Input validation ─────────────────────────────────────────────────────

  @adw-10
  Scenario: StateTracker refuses to post a body that is missing the HTML marker
    Given the mock `gh` CLI returns an empty comment list for PR 42
    And a markdown body that does NOT contain the marker "<!-- depaudit-gate-comment -->" is supplied as input
    When StateTracker reconciles the PR comment for PR 42
    Then the StateTracker invocation exits non-zero
    And stderr mentions "marker"
    And the mock `gh` CLI did not receive any "pr comment" POST invocation
    And the mock `gh` CLI did not receive any comment-edit invocation
