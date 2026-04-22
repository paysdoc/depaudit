# SlackReporter + StateTracker pass→fail transition dedupe

**ADW ID:** 2sm4zt-slackreporter-first
**Date:** 2026-04-22
**Issue:** #11

## Overview

This slice closes the Slack first-failure notification path for the depaudit PR gate. It introduces `SlackReporter` — a deep module that POSTs a minimal text payload to the `SLACK_WEBHOOK_URL` Incoming Webhook — and extends `StateTracker` with two pure helpers: `outcomeFromBody` (parses the current body's PASS/FAIL outcome) and `computeTransition` (returns `shouldFireSlack` + a telemetry label). These are composed in `postPrCommentCommand` so that Slack fires exactly once per `none→fail` or `pass→fail` push on a given PR, and silently skips on every other transition. The entire Slack path is fail-soft: a missing URL, a 5xx response, a timeout, or any unexpected error never bumps the gate's exit code.

## What Was Built

**New files:**
- `src/modules/slackReporter.ts` — `postSlackNotification(text, options)` with injectable `fetch`, fail-soft on all error paths
- `src/modules/__tests__/slackReporter.test.ts` — 11 unit tests covering env-var no-op, payload shape, all fail-soft paths
- `features/support/mockSlackServer.ts` — local HTTP mock that records every incoming request (method, headers, body)
- `features/step_definitions/slack_reporter_steps.ts` — step definitions for all `@adw-11` scenarios in `slack_reporter.feature`
- `app_docs/feature-2sm4zt-slack-reporter-state-tracker-transitions.md` — this file

**Modified files:**
- `src/types/prComment.ts` — added `CurrentOutcome` and `SlackTransition` types
- `src/modules/stateTracker.ts` — added `outcomeFromBody` and `computeTransition` exports
- `src/modules/__tests__/stateTracker.test.ts` — 14 new tests (7 `outcomeFromBody` + 7 `computeTransition`)
- `src/commands/postPrCommentCommand.ts` — added `slackReporter` injection, Slack wire-up after comment action, fail-soft try/catch
- `src/commands/__tests__/postPrCommentCommand.test.ts` — 10 new Slack notification integration tests
- `features/support/world.ts` — added `slackMock`, `savedSlackUrl`, `transition` fields
- `features/step_definitions/state_tracker_steps.ts` — added `computeTransition` step definitions
- `templates/depaudit-gate.yml` — added `SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}` to post-pr-comment step

## Technical Implementation

### Files Modified

**`src/types/prComment.ts`**
- `CurrentOutcome = "pass" | "fail"` — typed outcome for the body about to be posted
- `SlackTransition { shouldFireSlack: boolean; label: ... }` — result of `computeTransition`

**`src/modules/stateTracker.ts`**
- `outcomeFromBody(body)` — returns `"pass"` if body contains `"depaudit gate: PASS"`, `"fail"` if it contains `"depaudit gate: FAIL"`, `null` otherwise. PASS takes precedence when both strings appear (conservative bias against false fires).
- `computeTransition(prior, current)` — returns `shouldFireSlack: true` only when `current === "fail" && prior !== "fail"`. Labels: `first-fail`, `pass-to-fail`, `fail-to-fail`, `pass-to-pass`, `fail-to-pass`, `first-pass`.

**`src/commands/postPrCommentCommand.ts`**
- Added `slackReporter` optional injection to `PostPrCommentOptions` (defaults to `{ postSlackNotification }`)
- After the comment is posted/updated:
  1. `readPriorState(comments)` — resolves the prior outcome from the already-fetched comment list
  2. `outcomeFromBody(body)` — parses the outgoing body
  3. `computeTransition(prior, current)` — determines whether to fire
  4. If `shouldFireSlack`, calls `postSlackNotification` with `"depaudit-gate failed on PR #N: https://github.com/owner/repo/pull/N"`
  5. Writes a single stdout breadcrumb regardless of outcome
  6. Wrapped in a defensive `try/catch` — any Slack-side exception is caught and logged to stdout; exit code is never affected

**`templates/depaudit-gate.yml`**
- Added `SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}` to the `Post or update PR comment` step's `env:` block. The secret is optional — if unset in the repo, the CLI silently skips Slack.

### Files Added

- **`src/modules/slackReporter.ts`** — HTTP POST to Slack Incoming Webhook with AbortController-driven timeout, fail-soft on all error paths, injectable `fetch` for testing
- **`src/modules/__tests__/slackReporter.test.ts`** — unit tests with `vi.fn()` fetch mocks
- **`features/support/mockSlackServer.ts`** — node:http mock server that records `{method, headers, body}` for each request
- **`features/step_definitions/slack_reporter_steps.ts`** — step definitions for all `@adw-11` scenarios

### Key Changes

#### SlackReporter (`src/modules/slackReporter.ts`)

The function resolves `SLACK_WEBHOOK_URL` from `options.webhookUrl ?? process.env["SLACK_WEBHOOK_URL"]`. If the resolved URL is unset, empty, or whitespace-only, it returns `{ posted: false, reason: "no SLACK_WEBHOOK_URL configured" }` immediately without making any HTTP call. This is the "silent no-op" contract the feature requires.

On a usable URL, it POSTs `{ "text": "..." }` as `application/json` with an `AbortSignal` timeout (default 5 000 ms, overridable via `options.timeoutMs` or the `SLACK_REQUEST_TIMEOUT_MS` env var). Every error path — non-2xx response, `AbortError` (timeout), `TypeError` (network) — returns a `SlackPostResult` with `posted: false` and a descriptive `reason`. The function never throws.

#### StateTracker extensions (`src/modules/stateTracker.ts`)

`outcomeFromBody` uses the same `"depaudit gate: PASS"` / `"depaudit gate: FAIL"` string matching that `readPriorState` uses on the prior comment, keeping the convention symmetric with `MarkdownReporter`'s output format. Returning `null` for unrecognised bodies means corrupted or manually-crafted bodies skip Slack rather than synthesising a false transition.

`computeTransition` is a pure 3×2 decision table. The `label` field exists for telemetry and logging: stdout breadcrumbs say `"slack: skipped (sustained fail-to-fail; no fail-edge transition)"` rather than raw state tuples.

#### `postPrCommentCommand` integration

The Slack section runs **after** the PR comment is posted/updated, inside its own `try/catch`. This ordering ensures a Slack outage cannot delay the PR comment that contributors see. The exit-code contract (`0` success, `1` gh failure, `2` invalid args) is preserved unconditionally.

## How to Use

```sh
# In a repo with SLACK_WEBHOOK_URL set as a GitHub Actions secret, the workflow does this automatically.
# To test locally:
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T0/B0/your-secret \
  depaudit post-pr-comment --body-file=depaudit-comment.md
```

Stdout breadcrumbs:
```
posted new depaudit gate comment (id: 12345)
slack: posted first-fail notification for PR #42 (transition: first-fail)
```
```
updated depaudit gate comment (id: 12345)
slack: skipped (fail-to-fail; no fail-edge transition)
```
```
updated depaudit gate comment (id: 12345)
slack: skipped (no SLACK_WEBHOOK_URL configured)
```

## Configuration

| Env var | Description | Default |
|---|---|---|
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL. Unset or empty → Slack silently disabled. | (unset → no-op) |
| `SLACK_REQUEST_TIMEOUT_MS` | Per-request timeout in ms. BDD-only; not documented in README. | 5000 |

## Testing

```sh
bun test                                        # unit tests (stateTracker, slackReporter, postPrCommentCommand)
bun run test:e2e -- --tags "@adw-11"            # BDD scenarios (state_tracker.feature + slack_reporter.feature)
bun run test:e2e -- --tags "@adw-10"            # regression: issue #10 scenarios unchanged
bun run test:e2e -- --tags "@regression"        # full regression suite
```

## Notes

**Why fail-soft (not fail-loud)?** Slack is observability, not gating. The PR comment and the scan exit code are the authoritative signals. A Slack outage must never block a merge. `postSlackNotification` captures all error paths internally; the `postPrCommentCommand` wraps the entire Slack block in a defensive `try/catch` as a second layer.

**Why no retries?** Slack Incoming Webhooks are best-effort by design. Retrying during an active outage only burns CI wall-clock time; one POST per run is already the right granularity. A future slice can add retries with backoff if metrics show meaningful loss.

**Why does `outcomeFromBody` return `null` instead of defaulting?** Corrupted or manually-crafted bodies (e.g., `depaudit post-pr-comment --body-file=arbitrary.md`) should skip Slack rather than synthesising a false transition. The `null` return forces the caller to make an explicit decision.

**Why does `SlackTransition.label` exist?** Three reasons: (a) stdout breadcrumbs are more actionable (`"sustained fail-to-fail"` vs raw state); (b) a future Prometheus counter (`gate_transition_total`) can read the label without re-deriving the transition; (c) the unit-test surface is uniform — every cell of the 3×2 matrix asserts both `shouldFireSlack` AND `label`, catching mis-labelling regressions.

**User Story 28 — partial coverage.** This slice handles the *consumer* side: if `SLACK_WEBHOOK_URL` is set in the repo's Actions secrets, Slack fires. The *propagation* side — `adwInit.tsx` calling `gh secret set SLACK_WEBHOOK_URL` to push the URL from ADW's `.env` to each target repo — lands in ADW slice 16 (`adws/` repo).

**`SLACK_REQUEST_TIMEOUT_MS` is BDD-only.** It exists solely to keep the "Slack webhook that never responds" BDD scenario fast (~300ms instead of 5000ms). Same pattern as `SOCKET_REQUEST_TIMEOUT_MS` in `socketApiClient.ts`. Not documented in README or `.env.sample`.

**Marker false-positive carry-over.** `StateTracker` matches any comment containing `<!-- depaudit-gate-comment -->`. A contributor copy-pasting that marker string into a PR comment would have it treated as a prior gate comment, potentially suppressing or triggering Slack. The deliberately-unusual marker string minimises collision; a future slice can tighten the match (e.g., require `user.login === "github-actions[bot]"`).
