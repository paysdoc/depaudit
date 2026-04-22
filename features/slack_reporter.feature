@adw-11
Feature: depaudit — SlackReporter fires once per PR-level pass→fail transition
  As a maintainer of one or more ADW-managed repositories
  I want a low-volume Slack ping the first time a PR fails the gate, and silence on
  every subsequent fail push of the same PR, with a fresh ping only if the PR bounces
  pass→fail again
  So that I can intervene on expired-accept flips I'm expected to handle myself
  without being paged by contributor-driven fail churn — and so that a missing
  `SLACK_WEBHOOK_URL` secret silently disables Slack instead of breaking the gate

  Background:
    Given the `depaudit` CLI is installed and on PATH
    And a mock `gh` CLI is on PATH that records its invocations and serves a fake PR comment list
    And a mock Slack Incoming Webhook server that records incoming HTTP requests

  # ─── Env-var gating (silent no-op when SLACK_WEBHOOK_URL is absent) ────────

  @adw-11 @regression
  Scenario: Missing SLACK_WEBHOOK_URL silently disables Slack even on a first-fail transition
    Given the SLACK_WEBHOOK_URL environment variable is unset
    And the mock `gh` CLI returns an empty comment list for PR 42
    And a markdown body representing a FAIL outcome is supplied as input
    When depaudit reconciles the PR comment and notifies Slack for PR 42
    Then the mock Slack webhook received 0 requests
    And the depaudit invocation exits zero

  @adw-11 @regression
  Scenario: Empty SLACK_WEBHOOK_URL silently disables Slack even on a first-fail transition
    Given SLACK_WEBHOOK_URL is set to the empty string
    And the mock `gh` CLI returns an empty comment list for PR 42
    And a markdown body representing a FAIL outcome is supplied as input
    When depaudit reconciles the PR comment and notifies Slack for PR 42
    Then the mock Slack webhook received 0 requests
    And the depaudit invocation exits zero

  # ─── First-failure-only dedupe (the core product promise) ──────────────────

  @adw-11 @regression
  Scenario: First fail on a PR with no prior gate comment posts to Slack exactly once
    Given SLACK_WEBHOOK_URL is set to the mock Slack webhook URL
    And the mock `gh` CLI returns an empty comment list for PR 42
    And a markdown body representing a FAIL outcome is supplied as input
    When depaudit reconciles the PR comment and notifies Slack for PR 42
    Then the mock Slack webhook received exactly 1 request

  @adw-11 @regression
  Scenario: Subsequent fail push on a PR that already shows a FAIL gate comment does not re-fire Slack
    Given SLACK_WEBHOOK_URL is set to the mock Slack webhook URL
    And the mock `gh` CLI returns a comment list for PR 42 containing one comment whose body includes "<!-- depaudit-gate-comment -->" and a header "depaudit gate: FAIL"
    And a markdown body representing a FAIL outcome is supplied as input
    When depaudit reconciles the PR comment and notifies Slack for PR 42
    Then the mock Slack webhook received 0 requests

  @adw-11 @regression
  Scenario: pass→fail transition re-fires Slack after a previously-passing PR starts failing again
    Given SLACK_WEBHOOK_URL is set to the mock Slack webhook URL
    And the mock `gh` CLI returns a comment list for PR 42 containing one comment whose body includes "<!-- depaudit-gate-comment -->" and a header "depaudit gate: PASS"
    And a markdown body representing a FAIL outcome is supplied as input
    When depaudit reconciles the PR comment and notifies Slack for PR 42
    Then the mock Slack webhook received exactly 1 request

  @adw-11 @regression
  Scenario: Current-pass scan never fires Slack regardless of prior state
    Given SLACK_WEBHOOK_URL is set to the mock Slack webhook URL
    And the mock `gh` CLI returns a comment list for PR 42 containing one comment whose body includes "<!-- depaudit-gate-comment -->" and a header "depaudit gate: FAIL"
    And a markdown body representing a PASS outcome is supplied as input
    When depaudit reconciles the PR comment and notifies Slack for PR 42
    Then the mock Slack webhook received 0 requests

  @adw-11
  Scenario: fail→pass transition does not fire Slack (we only notify on the fail edge)
    Given SLACK_WEBHOOK_URL is set to the mock Slack webhook URL
    And the mock `gh` CLI returns a comment list for PR 42 containing one comment whose body includes "<!-- depaudit-gate-comment -->" and a header "depaudit gate: FAIL"
    And a markdown body representing a PASS outcome is supplied as input
    When depaudit reconciles the PR comment and notifies Slack for PR 42
    Then the mock Slack webhook received 0 requests

  # ─── Dedupe invariant across multiple runs on the same PR ──────────────────

  @adw-11 @regression
  Scenario: Three sequential fail runs on the same PR produce exactly one Slack request
    Given SLACK_WEBHOOK_URL is set to the mock Slack webhook URL
    And the mock `gh` CLI starts with an empty comment list for PR 42
    And the mock `gh` CLI persists its post/edit mutations across invocations
    And a markdown body representing a FAIL outcome is supplied as input
    When depaudit reconciles the PR comment and notifies Slack for PR 42
    And depaudit reconciles the PR comment and notifies Slack for PR 42
    And depaudit reconciles the PR comment and notifies Slack for PR 42
    Then the mock Slack webhook received exactly 1 request

  @adw-11
  Scenario: fail → fail → pass → fail across four runs produces exactly two Slack requests
    Given SLACK_WEBHOOK_URL is set to the mock Slack webhook URL
    And the mock `gh` CLI starts with an empty comment list for PR 42
    And the mock `gh` CLI persists its post/edit mutations across invocations
    When depaudit reconciles the PR comment and notifies Slack for PR 42 with a FAIL body
    And depaudit reconciles the PR comment and notifies Slack for PR 42 with a FAIL body
    And depaudit reconciles the PR comment and notifies Slack for PR 42 with a PASS body
    And depaudit reconciles the PR comment and notifies Slack for PR 42 with a FAIL body
    Then the mock Slack webhook received exactly 2 requests

  # ─── HTTP contract of the Slack POST (payload shape and transport) ────────

  @adw-11 @regression
  Scenario: Slack payload is a single-field JSON object with a top-level `text` string
    Given SLACK_WEBHOOK_URL is set to the mock Slack webhook URL
    And the mock `gh` CLI returns an empty comment list for PR 42
    And a markdown body representing a FAIL outcome is supplied as input
    When depaudit reconciles the PR comment and notifies Slack for PR 42
    Then the last Slack request body parses as JSON
    And the last Slack request JSON has a top-level string field `text`

  @adw-11 @regression
  Scenario: Slack payload text identifies the PR number and includes a link to the PR
    Given SLACK_WEBHOOK_URL is set to the mock Slack webhook URL
    And the mock `gh` CLI returns an empty comment list for PR 42
    And a markdown body representing a FAIL outcome is supplied as input
    When depaudit reconciles the PR comment and notifies Slack for PR 42
    Then the last Slack request `text` field contains "PR #42"
    And the last Slack request `text` field contains a GitHub PR URL ending in "/pull/42"

  @adw-11 @regression
  Scenario: Slack request uses HTTP POST with a JSON content-type
    Given SLACK_WEBHOOK_URL is set to the mock Slack webhook URL
    And the mock `gh` CLI returns an empty comment list for PR 42
    And a markdown body representing a FAIL outcome is supplied as input
    When depaudit reconciles the PR comment and notifies Slack for PR 42
    Then the last Slack request used HTTP method "POST"
    And the last Slack request Content-Type starts with "application/json"

  # ─── Fail-open on webhook errors (Slack outage must not fail the gate) ────

  @adw-11 @regression
  Scenario: Slack webhook returning 5xx does not fail the depaudit invocation
    Given SLACK_WEBHOOK_URL is set to a mock Slack webhook that responds with 503 on every request
    And the mock `gh` CLI returns an empty comment list for PR 42
    And a markdown body representing a FAIL outcome is supplied as input
    When depaudit reconciles the PR comment and notifies Slack for PR 42
    Then the depaudit invocation exits zero

  @adw-11
  Scenario: Slack webhook timeout does not fail the depaudit invocation
    Given SLACK_WEBHOOK_URL is set to a mock Slack webhook that never responds
    And the mock `gh` CLI returns an empty comment list for PR 42
    And a markdown body representing a FAIL outcome is supplied as input
    When depaudit reconciles the PR comment and notifies Slack for PR 42
    Then the depaudit invocation exits zero
