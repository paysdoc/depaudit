# Feature: SlackReporter (first-failure-per-PR via StateTracker)

## Metadata
issueNumber: `11`
adwId: `2sm4zt-slackreporter-first`
issueJson: `{"number":11,"title":"SlackReporter (first-failure-per-PR via StateTracker)","body":"## Parent PRD\n\n`specs/prd/depaudit.md`\n\n## What to build\n\nAdds `SlackReporter` — posts minimal-text payload (`\"depaudit-gate failed on PR #N: <link>\"`) via `curl`-equivalent HTTP POST to the Incoming Webhook URL held in `SLACK_WEBHOOK_URL`. Fires exactly once per PR-level pass→fail transition, coordinated via `StateTracker` (extended with \"prior scan outcome\" in the gate comment state).\n\n## Acceptance criteria\n\n- [ ] `SlackReporter` posts JSON payload `{ \"text\": \"...\" }` to `SLACK_WEBHOOK_URL`.\n- [ ] Silently no-op if the env var is missing.\n- [ ] `StateTracker` detects pass→fail transition by reading the prior comment's outcome and comparing to the current scan.\n- [ ] Fires once on first fail; does not fire again on subsequent fail pushes.\n- [ ] Fires again if PR goes fail→pass→fail across pushes.\n- [ ] Unit tests for `SlackReporter` (mocked HTTP) and transition detection.\n\n## Blocked by\n\n- Blocked by #10\n\n## User stories addressed\n\n- User story 10\n- User story 28 (partial; cross-repo token propagation lands in ADW slice 16)\n","state":"OPEN","author":"paysdoc","labels":[],"createdAt":"2026-04-17T13:24:43Z","comments":[],"actionableComment":null}`

## Feature Description

This slice closes the last open piece of the PR-comment + Slack first-failure feedback loop introduced in PRD `:188–191`. Issue #10 landed `StateTracker.readPriorState` — the pure read-side that resolves `priorOutcome ∈ {pass, fail, none}` from the marker-bearing PR comment's body. It also wired the `depaudit post-pr-comment` subcommand that updates the PR comment in place. What's missing is the *write side* of the maintainer-facing notification path:

1. **`SlackReporter`** — a deep module that POSTs a minimal text payload (`{ "text": "depaudit-gate failed on PR #<N>: <link>" }`) to the Incoming Webhook URL held in `SLACK_WEBHOOK_URL`. The webhook URL is a per-repo GitHub Actions secret populated by `adw_init` (PRD `:184`); a missing or empty value silently disables Slack so contributors who run `depaudit scan` locally without a webhook configured don't see breakage. HTTP failures (5xx, timeout, network) also fail-soft — Slack is observability, not gating, and a Slack outage must never break the gate (PRD `:191` describes Slack as a side-channel notification, not a checkpoint).

2. **`StateTracker.computeTransition`** — a pure transition function that takes `priorOutcome` (from `readPriorState`) and `currentOutcome` (parsed from the body that's about to be posted) and returns whether the current push is a "fail-edge" transition worth firing Slack for. The rule is exactly the issue's criterion: fire when `currentOutcome === "fail"` AND `priorOutcome !== "fail"`. Three states map to "fire" (`none → fail`, `pass → fail`); three states map to "skip" (`fail → fail`, `pass → pass`, `fail → pass`, `none → pass`). The function name `computeTransition` (not `decideSlackAction`) is chosen to keep the module's public surface domain-focused — Slack is the *only* current consumer but a future telemetry consumer (e.g., a `gate_transition_total` Prometheus counter) could read the same transition without renaming.

3. **`StateTracker.outcomeFromBody`** — a sibling pure function that mirrors `readPriorState`'s body-classification logic but operates on the *new* body about to be posted (rather than walking a comment list). Returns `"pass" | "fail" | null`. Factoring this out keeps `computeTransition` driven by typed state, not raw markdown — and lets the wire-up code in `postPrCommentCommand` read the outgoing body's outcome with the exact same parser the prior comment used.

4. **Integration in `postPrCommentCommand`** — the existing composition root already lists comments and resolves `decideCommentAction`. This slice adds two more reads from the same comment list — `readPriorState` for the prior outcome — and three new wire-ups: parse the outgoing body's outcome via `outcomeFromBody`, compute `computeTransition(prior, current)`, and call `SlackReporter.postSlackNotification(text)` when the transition reports `shouldFireSlack === true`. Slack delivery is non-fatal: a fail-soft `posted: false` result is logged to stdout (`slack: skipped (no SLACK_WEBHOOK_URL set)` / `slack: webhook returned 503; skipped`) but never bumps the exit code, so the existing `0 / 1 / 2` exit-code contract (issue #10 plan, "Exit-code contract") is preserved.

5. **Tests + BDD** — feature files `features/state_tracker.feature` (transition scenarios, lines 144–190) and `features/slack_reporter.feature` (full SlackReporter integration, all `@adw-11`) already exist on this branch as scaffolding from the alignment-agent run that landed `state_tracker.feature` for #10. Step definitions for `@adw-11` do not yet exist — the implementation lands them alongside the new helpers. New unit tests cover (a) `SlackReporter.postSlackNotification` against a mocked `fetch` (payload shape, missing-env no-op, fail-open on HTTP error), (b) `computeTransition` and `outcomeFromBody` purity + every state-transition cell, and (c) extended `postPrCommentCommand` integration tests asserting Slack is fired/skipped according to the priorState × currentOutcome matrix.

User Story 10 (PRD `:43`) — "low-volume Slack notification the first time a given PR fails the gate" — is fully satisfied by this slice. User Story 28 (PRD `:79`) — "all my Slack notifications flow through a single channel sourced from ADW's `.env`" — is *partially* satisfied: the per-repo secret consumption lands here, but the cross-repo token propagation via `gh secret set` from ADW's `.env` is `adw_init`'s concern (PRD `:184`) and ships in ADW slice 16 (the `adws/` repo). This slice's responsibility ends at "if the secret is configured, a fail-edge fires; if not, a fail-edge is silent."

## User Story

As a maintainer of one or more ADW-managed repositories
I want a low-volume Slack ping the first time a PR fails the depaudit gate, and silence on every subsequent fail push of the same PR, with a fresh ping only if the PR bounces pass→fail again
So that I can intervene on expired-accept flips I'm expected to handle myself without being paged by contributor-driven fail churn

As a contributor running `depaudit scan` locally without a Slack webhook configured
I want the absence of `SLACK_WEBHOOK_URL` to silently disable the Slack side-channel
So that my local runs and CI runs in repos that don't yet have a Slack integration both succeed without surprises

As a maintainer whose Slack workspace is briefly unreachable during a CI run
I want a Slack POST failure (5xx, timeout, network) to fail-soft and never bump the gate's exit code
So that a Slack outage never blocks a merge that the scan itself approved (or worse — a gate failure that should already have been visible via the PR comment)

## Problem Statement

Concretely, the gaps this slice closes are:

1. **No `SlackReporter` module exists.** `src/modules/` has the issue #10 deep modules (`stateTracker`, `ghPrCommentClient`, etc.) and the upstream Reporters (`markdownReporter`, `jsonReporter`), but no Slack-side reporter. PRD `:204` lists `SlackReporter` as a concrete sibling of `MarkdownReporter` / `JsonReporter`; PRD `:247` mandates "mocked HTTP, asserting first-failure-only behavior given a `StateTracker`". Without it, User Story 10 ("low-volume Slack notification the first time a PR fails the gate") is unmet.

2. **No `computeTransition` function on `StateTracker`.** Issue #10 deliberately deferred Slack-side dedupe to this slice (per the issue #10 plan Notes section: *"…first-failure Slack dedupe is intentionally deferred to a later slice (likely tied to `SlackReporter`). The module file is named to accept future additions (`decideSlackAction`, `computeTransition`, etc.) without a rename."*). The pre-existing `state_tracker.feature` already carries `@adw-11` transition scenarios at lines 149–190 referring to a `StateTracker evaluates a transition from prior outcome "X" to current outcome "Y"` step that has no implementation.

3. **No `outcomeFromBody` parser.** `readPriorState` reads the *prior* comment body's outcome by string-matching `depaudit gate: PASS|FAIL`; the *current* outcome — i.e., the outcome of the body about to be posted in the current run — needs the same parse. Re-implementing the parse inline in `postPrCommentCommand` would duplicate logic that's already a single point of correctness in `stateTracker.ts`.

4. **No SlackReporter env-var contract.** The issue's acceptance criterion requires "Silently no-op if the env var is missing." The PRD does not specify whether an *empty-string* `SLACK_WEBHOOK_URL` (a common Actions-secret-not-set state) should be treated as "missing" — this slice formalises that empty-string and unset are both "no-op". Both states are tested in BDD.

5. **No fail-soft policy for the Slack POST.** The PRD describes Slack as a side-channel; the workflow template gates the merge via the scan's exit code (issue #10), not via Slack delivery. But there is no documented fail-soft contract for `SlackReporter` and no integration test asserting the gate doesn't break on a Slack outage. `slack_reporter.feature` lines 134–147 already specify "Slack webhook returning 5xx does not fail the depaudit invocation" and "Slack webhook timeout does not fail the depaudit invocation" as `@adw-11` scenarios — they need a step-definition implementation.

6. **`postPrCommentCommand` does not yet call `readPriorState`.** It only calls `decideCommentAction` (issue #10, `src/commands/postPrCommentCommand.ts:87`). Slack-firing requires the prior outcome, which the same `listPrComments` result already carries — adding a second pass over `comments` is essentially free. But the wire-up doesn't exist.

7. **No mock Slack HTTP server in the BDD harness.** `features/support/mockSocketServer.ts` exists for `@adw-7`; `features/support/mockGhBinary.ts` exists for `@adw-10`. There is no `features/support/mockSlackServer.ts` for `@adw-11`. Without it, the `slack_reporter.feature` scenarios (lines 11–147) cannot run.

8. **No `slack_reporter_steps.ts` step-definitions file.** `features/step_definitions/state_tracker_steps.ts` covers `@adw-10`; the new `@adw-11`-tagged scenarios need their own step file (or extension of `state_tracker_steps.ts`). Cross-referencing with the alignment-agent's existing scenarios, the right move is a separate `slack_reporter_steps.ts` to keep concerns split; the additional `@adw-11` transition steps in `state_tracker.feature` (lines 144–190) belong with the existing `state_tracker_steps.ts` (StateTracker pure-logic exercises) rather than the new file.

9. **No Slack URL handling in the dev environment.** `.env.sample` already documents `SLACK_WEBHOOK_URL` (line 9), but no code path reads it yet. The reader needs a `process.env.SLACK_WEBHOOK_URL` access wrapped to honor the "empty is missing" rule, with an injectable override for tests.

10. **No documentation page.** Every prior slice has an `app_docs/feature-<adwId>-<name>.md` summary referenced from `.adw/conditional_docs.md`. Without one for this slice, future maintainers (and the `/depaudit-triage` skill) have no condition-driven entry point for Slack-related questions.

## Solution Statement

Introduce two new pieces of code (one new module + one new types entry), extend two existing files, add unit tests + step definitions, and write the doc page. Carefully keep the pure logic (`computeTransition`, `outcomeFromBody`) in `stateTracker.ts` and funnel all I/O (HTTP fetch) through `slackReporter.ts` with an injectable `fetch`. The composition stays in `postPrCommentCommand.ts`.

### New module: `src/modules/slackReporter.ts`

Mirrors the `socketApiClient.ts` injectable-`fetch` pattern (no shell-out — Slack Incoming Webhooks accept a plain HTTP POST):

```ts
export type FetchFn = typeof globalThis.fetch;

export interface SlackReporterOptions {
  /** Override fetch (test injection). Defaults to globalThis.fetch. */
  fetch?: FetchFn;
  /** Override webhook URL (test injection). Defaults to process.env.SLACK_WEBHOOK_URL. */
  webhookUrl?: string;
  /** Per-request timeout in ms (default: 5000). */
  timeoutMs?: number;
}

export interface SlackPostResult {
  posted: boolean;
  /** Human-readable reason when posted=false (e.g. "no SLACK_WEBHOOK_URL", "webhook returned 503"). */
  reason?: string;
}

export async function postSlackNotification(
  text: string,
  options: SlackReporterOptions = {}
): Promise<SlackPostResult>;
```

Behaviour:

1. Resolve webhook URL: `options.webhookUrl ?? process.env.SLACK_WEBHOOK_URL`. If unset OR empty string OR whitespace-only, return `{ posted: false, reason: "no SLACK_WEBHOOK_URL" }` immediately. **No HTTP call.**
2. Resolve fetch: `options.fetch ?? globalThis.fetch`.
3. Resolve timeout: `options.timeoutMs ?? 5000`.
4. POST `{ text }` as JSON body, `Content-Type: application/json`, with an `AbortSignal` driven by the timeout.
5. **Fail-soft on any error**: network/timeout/non-2xx all return `{ posted: false, reason: "<descriptive reason>" }`. Never throws to the caller. (Slack POST exceptions are caught and the error message is preserved in `reason`.)
6. On 2xx, return `{ posted: true }`.

Why fail-soft (and not fail-loud the way `SocketAuthError` does for Socket): Slack is observability. The PRD treats it as "the maintainer learns about a fail-edge transition," not "the gate refuses to merge." A noisy Slack outage that breaks gates would create the worst of both worlds — alert fatigue *and* gating regressions.

Why no retries: Slack Incoming Webhooks are "best-effort, fire-and-forget" by design (see Slack's webhooks docs). Re-trying a 5xx during an active outage spawns one POST per CI run anyway; spending budget on retries inside a single run is not worth the wall-clock. A future slice can add retries if metrics show it matters.

### New StateTracker exports: `computeTransition`, `outcomeFromBody`

Append to `src/modules/stateTracker.ts`:

```ts
export type CurrentOutcome = "pass" | "fail";

export interface SlackTransition {
  /** True iff this push is a fail-edge transition (priorOutcome !== "fail" AND currentOutcome === "fail"). */
  shouldFireSlack: boolean;
  /** Convenience label for telemetry/logging — not a discriminator the caller branches on. */
  label:
    | "first-fail"          // none → fail
    | "pass-to-fail"        // pass → fail
    | "fail-to-fail"        // fail → fail (sustained)
    | "pass-to-pass"        // pass → pass (sustained)
    | "fail-to-pass"        // fail → pass (recovery)
    | "first-pass";         // none → pass
}

export function computeTransition(
  prior: PriorOutcome,
  current: CurrentOutcome
): SlackTransition {
  // Fire iff this push is a fail-edge transition.
  const shouldFireSlack = current === "fail" && prior !== "fail";
  let label: SlackTransition["label"];
  if (current === "fail") {
    label = prior === "none" ? "first-fail" : prior === "pass" ? "pass-to-fail" : "fail-to-fail";
  } else {
    label = prior === "none" ? "first-pass" : prior === "pass" ? "pass-to-pass" : "fail-to-pass";
  }
  return { shouldFireSlack, label };
}

export function outcomeFromBody(body: string): CurrentOutcome | null {
  // Match the same convention readPriorState uses on the prior comment body.
  if (body.includes("depaudit gate: PASS")) return "pass";
  if (body.includes("depaudit gate: FAIL")) return "fail";
  return null;
}
```

Notes on the design:

- `SlackTransition.label` is a documented enum, not a discriminated union — the only consumer in this slice branches on `shouldFireSlack`. The label exists so future stdout logging / telemetry can say `"slack: skipped (sustained fail-to-fail)"` instead of `"slack: skipped (priorOutcome=fail, currentOutcome=fail)"`. Cheap to add now; expensive to retro-fit later.
- `outcomeFromBody` returns `null` (not a default) for bodies without a recognisable header. The integration in `postPrCommentCommand` treats `null` as "skip Slack" — we don't synthesise an outcome from absence; that's the caller's job to handle if it ever matters. (In practice, every body MarkdownReporter emits has a header; the null path covers manual `depaudit post-pr-comment --body-file=arbitrary.md` invocations.)
- Both functions are pure. No I/O. No mutation of inputs.

Existing `decideCommentAction` and `readPriorState` are unchanged.

### Extended types: `src/types/prComment.ts`

Append the new transition types to the existing file. No breaking changes:

```ts
// (existing PrComment, PrCoordinates, CommentAction, PriorOutcome, PriorState types are unchanged)

/** Outcome of the *current* scan, parsed from the body about to be posted. */
export type CurrentOutcome = "pass" | "fail";

/** Result of computeTransition — describes whether this push is a fail-edge worth a Slack ping. */
export interface SlackTransition {
  shouldFireSlack: boolean;
  label:
    | "first-fail"
    | "pass-to-fail"
    | "fail-to-fail"
    | "pass-to-pass"
    | "fail-to-pass"
    | "first-pass";
}
```

Re-exporting these from the types file (rather than declaring them inline in `stateTracker.ts`) keeps the type module the single source of shape declarations, matching `PrComment`, `PriorOutcome`, etc.

### Extended composition: `src/commands/postPrCommentCommand.ts`

Add Slack-firing after the comment action is dispatched. Flow becomes:

```
1. Read body from --body-file
2. Resolve repo + prNumber (existing)
3. List PR comments (existing)
4. decideCommentAction(comments, body) → action
5. readPriorState(comments) → priorState                       [NEW]
6. outcomeFromBody(body) → currentOutcome | null               [NEW]
7. Apply action (create/update PR comment) (existing)
8. If currentOutcome !== null:                                  [NEW]
     transition = computeTransition(priorState.priorOutcome, currentOutcome)
     If transition.shouldFireSlack:
       text = `depaudit-gate failed on PR #${prNumber}: https://github.com/${repo}/pull/${prNumber}`
       result = await slackReporter.postSlackNotification(text)
       if result.posted: stdout `slack: posted first-fail notification for PR #N`
       else: stdout `slack: skipped (${result.reason})`
   Else:
     stdout `slack: skipped (no recognisable PASS/FAIL header in body)`
9. Return the same exit code as today (0 success / 1 gh failure / 2 invalid args).
   Slack outcome NEVER affects exit code. (Documented in Notes.)
```

Wire the new dependency through `PostPrCommentOptions`:

```ts
export interface PostPrCommentOptions {
  bodyFile: string;
  repo?: string;
  prNumber?: number;
  ghClient?: { listPrComments; createPrComment; updatePrComment };
  slackReporter?: {
    postSlackNotification: typeof postSlackNotification;
  };
}
```

Default `slackReporter` is `{ postSlackNotification }` from `../modules/slackReporter.js`. Tests inject a mock that records calls.

### Mock Slack HTTP server: `features/support/mockSlackServer.ts`

Mirror `mockSocketServer.ts` but parameterise:

- `body` to return on success (default: `"ok"`)
- `status` (default: 200)
- `delay` (for timeout-test scenarios)
- `transientKind` (`"500" | "timeout"` only — Slack doesn't 401 us; the URL is the secret)
- `failuresBeforeSuccess` (for retry tests, future-proofing — this slice doesn't retry, so this is unused but keeps the pattern uniform)

Returns:

```ts
export interface MockSlackHandle {
  url: string;
  stop(): Promise<void>;
  hitCount(): number;
  /** Request log: method, headers, body — for assertion in step defs. */
  requests(): Array<{ method: string; headers: Record<string, string>; body: string }>;
}
export function startMockSlackServer(config?: MockSlackConfig): Promise<MockSlackHandle>;
```

The request log is what the BDD `Then` steps use to assert "the last Slack request body parses as JSON" / "the last Slack request `text` field contains 'PR #42'" / "the last Slack request used HTTP method 'POST'" (slack_reporter.feature lines 110, 119, 128).

### New step definitions: `features/step_definitions/slack_reporter_steps.ts`

`@adw-11`-tagged. Handles the scenarios in `slack_reporter.feature`. Reuses `mockGhBinary` from `@adw-10` (`features/support/mockGhBinary.ts`) — no new gh-mock needed; just wire the Slack mock alongside.

`Before` hook tagged `@adw-11`:
- Set up `world.ghMock` (reuse) and `world.slackMock` (new field on `DepauditWorld`).
- Save `world.savedSlackUrl = process.env.SLACK_WEBHOOK_URL` for restoration.

`After` hook tagged `@adw-11`:
- Stop both mocks.
- Restore `world.savedSlackUrl`.

Step definitions implementing the existing scenarios:

- `Given a mock Slack Incoming Webhook server that records incoming HTTP requests` → start `mockSlackServer`.
- `Given the SLACK_WEBHOOK_URL environment variable is unset` → `delete process.env.SLACK_WEBHOOK_URL`.
- `Given SLACK_WEBHOOK_URL is set to the empty string` → `process.env.SLACK_WEBHOOK_URL = ""`.
- `Given SLACK_WEBHOOK_URL is set to the mock Slack webhook URL` → `process.env.SLACK_WEBHOOK_URL = world.slackMock.url`.
- `Given SLACK_WEBHOOK_URL is set to a mock Slack webhook that responds with 503 on every request` → start a separate mock with `status: 503` and set the env var.
- `Given SLACK_WEBHOOK_URL is set to a mock Slack webhook that never responds` → start with `transientKind: "timeout"` and `failuresBeforeSuccess: Infinity`.
- `Given a markdown body representing a {string} outcome is supplied as input` → write a temp body file with `<!-- depaudit-gate-comment -->\n## depaudit gate: PASS|FAIL\n- new: 0|1\n`.
- `When depaudit reconciles the PR comment and notifies Slack for PR 42` → run `depaudit post-pr-comment --body-file=<body>` against the mocked gh + Slack envs.
- `When depaudit reconciles the PR comment and notifies Slack for PR 42 with a {string} body` → variant that writes a fresh body file mid-scenario before each invocation.
- `Then the mock Slack webhook received {int} requests` → assert `world.slackMock.hitCount()`.
- `Then the mock Slack webhook received exactly {int} request(s)` → same; cucumber pluralisation tolerated.
- `Then the depaudit invocation exits zero` → `world.result.exitCode === 0`.
- `Then the last Slack request body parses as JSON` → JSON.parse last request body.
- `Then the last Slack request JSON has a top-level string field {word}` → assert `typeof parsed[fieldName] === "string"`.
- `Then the last Slack request {word} field contains {string}` → substring match.
- `Then the last Slack request {word} field contains a GitHub PR URL ending in {string}` → matches `/^https:\/\/github\.com\/.+\/pull\/\d+$/` and ends with the suffix.
- `Then the last Slack request used HTTP method {string}` → assert.
- `Then the last Slack request Content-Type starts with {string}` → assert header prefix match.

### Extended step definitions for transition scenarios in `state_tracker_steps.ts`

The transition scenarios at `state_tracker.feature:144–190` are already tagged `@adw-11` and need new steps in `state_tracker_steps.ts`:

- `When StateTracker evaluates a transition from prior outcome {string} to current outcome {string}` → call `computeTransition` from the compiled dist module; store result in `world.transition`.
- `Then the transition reports that a Slack notification should fire` → assert `world.transition.shouldFireSlack === true`.
- `Then the transition reports that a Slack notification should NOT fire` → assert `world.transition.shouldFireSlack === false`.

The `Before<DepauditWorld>({ tags: "@adw-10 or @adw-11" }, ...)` hook should be widened to clear `world.transition` between scenarios. (Actually, existing `Before` is `tags: "@adw-10"`. Add a parallel `Before({ tags: "@adw-11" }, ...)` to keep the two hook scopes independent.)

### Unit tests

**`src/modules/__tests__/slackReporter.test.ts`** (NEW). Mock `fetch` directly (vi.fn returning a `Response`). Coverage:

1. Returns `{ posted: false, reason: ~/SLACK_WEBHOOK_URL/ }` when `SLACK_WEBHOOK_URL` is unset; **does not call fetch**.
2. Returns `{ posted: false, reason: ~/SLACK_WEBHOOK_URL/ }` when `SLACK_WEBHOOK_URL` is empty string; **does not call fetch**.
3. Returns `{ posted: false, reason: ~/SLACK_WEBHOOK_URL/ }` when `SLACK_WEBHOOK_URL` is whitespace-only; **does not call fetch**.
4. Returns `{ posted: true }` on a 200 response; calls fetch exactly once with the right URL, body `JSON.stringify({ text })`, header `content-type: application/json`, method `POST`.
5. Returns `{ posted: false, reason: ~/503/ }` on a 503 response; does not throw.
6. Returns `{ posted: false, reason: ~/timeout/i or AbortError/i }` on AbortError (timeout); does not throw.
7. Returns `{ posted: false, reason: ~/network/i or TypeError/ }` on fetch throwing TypeError (network failure); does not throw.
8. Honours `options.webhookUrl` over `process.env.SLACK_WEBHOOK_URL` when both are set.
9. Honours `options.fetch` over `globalThis.fetch`.
10. The body sent to fetch is exactly `JSON.stringify({ text: <input> })` byte-for-byte (no extra fields, no whitespace).
11. Honours `options.timeoutMs` (default 5000) — assertable via spying on `AbortController` or by injecting a fast-timeout fetch that observes the AbortSignal's `timeoutId`.

**`src/modules/__tests__/stateTracker.test.ts`** (EXTEND existing). Add two new `describe` blocks alongside the existing `describe("decideCommentAction")` and `describe("readPriorState")`:

- `describe("outcomeFromBody")`:
  1. Body containing `"depaudit gate: PASS"` returns `"pass"`.
  2. Body containing `"depaudit gate: FAIL"` returns `"fail"`.
  3. Body containing neither returns `null`.
  4. Body containing both PASS and FAIL: PASS wins (the order matches `readPriorState` — first matched header wins).
  5. Empty body returns `null`.
  6. Body with PASS in a non-header context (e.g., `"PASS the salt"`) does NOT trigger — only `"depaudit gate: PASS"` matches.
- `describe("computeTransition")`:
  1. `prior=none, current=fail` → `{ shouldFireSlack: true, label: "first-fail" }`.
  2. `prior=pass, current=fail` → `{ shouldFireSlack: true, label: "pass-to-fail" }`.
  3. `prior=fail, current=fail` → `{ shouldFireSlack: false, label: "fail-to-fail" }`.
  4. `prior=pass, current=pass` → `{ shouldFireSlack: false, label: "pass-to-pass" }`.
  5. `prior=fail, current=pass` → `{ shouldFireSlack: false, label: "fail-to-pass" }`.
  6. `prior=none, current=pass` → `{ shouldFireSlack: false, label: "first-pass" }`.
  7. Pure: same inputs → same outputs.
  8. Does not mutate inputs (trivially true for primitives, but assert the contract).

**`src/commands/__tests__/postPrCommentCommand.test.ts`** (EXTEND). Add a new `describe("Slack notification")` block alongside the existing tests:

1. **First-fail (no prior comment, current=FAIL) fires Slack** with body that mentions `"PR #42"` and the URL `"https://github.com/<repo>/pull/42"`.
2. **Sustained fail (prior FAIL comment, current=FAIL) does NOT fire Slack.**
3. **Pass-to-fail (prior PASS comment, current=FAIL) fires Slack.**
4. **Fail-to-pass (prior FAIL comment, current=PASS) does NOT fire Slack.**
5. **Sustained pass (prior PASS, current=PASS) does NOT fire Slack.**
6. **None-to-pass (no prior, current=PASS) does NOT fire Slack.**
7. **Multi-run: 5 sequential calls fail, fail, pass, fail, fail** → exactly 2 Slack calls (run 1 first-fail, run 4 pass-to-fail).
8. **Body without recognisable header** (`outcomeFromBody → null`) skips Slack with stdout reason `"slack: skipped (no recognisable PASS/FAIL header in body)"`.
9. **Slack returns `{ posted: false, reason: "..." }`** does not affect the exit code (still 0); stdout shows the reason.
10. **Slack throws** never reaches the caller (the contract says fail-soft inside `postSlackNotification`); but if it did, exit code stays 0 and stderr captures the leak. Asserts the exit-code invariant.

All Slack-side assertions use a `slackReporter` injection that records calls, mirroring `makeMockGhClient`.

### `app_docs/feature-2sm4zt-slack-reporter-state-tracker-transitions.md`

House-style summary in the same shape as `app_docs/feature-e1layl-github-actions-gate-state-tracker.md`. Sections: Overview, What Was Built, Technical Implementation (Files Modified / Key Changes), How to Use, Configuration, Testing, Notes. The Notes section explicitly calls out:
- Why fail-soft (not fail-loud) — Slack is observability, not gating.
- Why `outcomeFromBody` returns `null` instead of defaulting (corrupted bodies should skip Slack, not synthesise a false transition).
- Why no retries — Slack Incoming Webhooks are best-effort; per-run retries don't help during a Slack outage.
- Why `SlackTransition.label` exists despite `shouldFireSlack` being the only branch the caller takes (telemetry / future-proofing).
- The cross-repo token propagation deferral to ADW slice 16 (User Story 28 partial coverage).

### `.adw/conditional_docs.md`

Append:

```
- [app_docs/feature-2sm4zt-slack-reporter-state-tracker-transitions.md](../app_docs/feature-2sm4zt-slack-reporter-state-tracker-transitions.md) — When working with `SlackReporter`, `postSlackNotification`, the `SLACK_WEBHOOK_URL` env var, `StateTracker.computeTransition`, `StateTracker.outcomeFromBody`, the `SlackTransition` type, the fail-soft Slack contract, or first-failure-per-PR dedupe; when troubleshooting Slack notifications firing too often, not firing at all, or affecting the gate's exit code; when extending the workflow to add a separate `slack-notify` subcommand or to retry the Slack POST.
```

## Relevant Files

Use these files to implement the feature:

- `specs/prd/depaudit.md` — parent PRD. Lines `:43` (User Story 10 — first-failure Slack), `:79` (User Story 28 — cross-repo Slack secret), `:120` (workflow scaffolded by setup; "fires Slack on first-failure transition"), `:184` (`adwInit.tsx` propagates `SLACK_WEBHOOK_URL` from ADW's `.env`), `:188–192` (PR comment + Slack design — "Slack fires exactly once per pass→fail state transition on a given PR. Payload is minimal text…"), `:202` (StateTracker module contract — "tracks PR-level state across scan runs (for comment dedupe and first-failure Slack dedupe)"), `:204` (Reporter composes MarkdownReporter, JsonReporter, SlackReporter), `:247` (Tier 1 mocked-HTTP coverage for SlackReporter), `:280` (StateTracker fires Slack notification once per PR transition).
- `README.md` — project overview; `SLACK_WEBHOOK_URL` is already documented in the env-var table.
- `UBIQUITOUS_LANGUAGE.md` — line 46 names `StateTracker` ("tracks PR-level state for comment deduplication and first-failure Slack notification"); line 48 places `SlackReporter` inside the composite `Reporter`. This slice realises both.
- `.env.sample` — line 9 documents `SLACK_WEBHOOK_URL`. No edit needed.
- `package.json` — already has `"files": ["dist", "templates"]` from issue #10. No edit needed.
- `tsconfig.json` — already configured; no change.
- `src/cli.ts` — `post-pr-comment` subcommand is already wired (issue #10). No new subcommand introduced. Slack-firing piggybacks on the existing subcommand's composition root; the CLI surface is unchanged.
- `src/commands/postPrCommentCommand.ts` — composition root from issue #10. **EXTEND**: add `readPriorState` call, `outcomeFromBody` call, `computeTransition` call, conditional `slackReporter.postSlackNotification` call. New `slackReporter` field on `PostPrCommentOptions` for test injection. Exit-code contract preserved.
- `src/commands/__tests__/postPrCommentCommand.test.ts` — **EXTEND** with the 10-scenario `describe("Slack notification")` block.
- `src/modules/stateTracker.ts` — pure module from issue #10. **EXTEND**: add `computeTransition`, `outcomeFromBody`. No edits to existing `decideCommentAction` / `readPriorState`.
- `src/modules/__tests__/stateTracker.test.ts` — pure-logic test file from issue #10. **EXTEND** with two new `describe` blocks (`outcomeFromBody`, `computeTransition`).
- `src/modules/socketApiClient.ts` — canonical injectable-`fetch` reference (lines 1–10, 102–211). `slackReporter.ts` mirrors the pattern (`FetchFn` type alias, `options.fetch ?? globalThis.fetch`, AbortController-driven timeout).
- `src/modules/__tests__/socketApiClient.test.ts` — canonical `mockFetch` test idiom (lines 29–40). `slackReporter.test.ts` lifts the pattern.
- `src/modules/markdownReporter.ts` — already emits `## depaudit gate: PASS|FAIL` headers (`src/modules/markdownReporter.ts:57`). `outcomeFromBody` in `stateTracker.ts` parses the same string MarkdownReporter writes — keeping the convention symmetric.
- `src/types/markdownReport.ts` — line 3 defines `MARKDOWN_COMMENT_MARKER`. `readPriorState` already imports it; nothing new from this slice.
- `src/types/prComment.ts` — types from issue #10. **EXTEND** with `CurrentOutcome` and `SlackTransition` types.
- `src/modules/ghPrCommentClient.ts` — unchanged. The Slack path does not need any gh extension.
- `features/state_tracker.feature` — already carries the `@adw-11` transition scenarios at lines 144–190 (created by alignment-agent for #11). No file edits expected.
- `features/slack_reporter.feature` — already carries the full `@adw-11` SlackReporter integration at lines 11–147 (created by alignment-agent for #11). No file edits expected.
- `features/step_definitions/state_tracker_steps.ts` — `@adw-10` step file. **EXTEND** with the three new transition steps used by `state_tracker.feature:149–190`.
- `features/support/world.ts` — `DepauditWorld` from issue #10. **EXTEND** with `slackMock?`, `transition?`, `savedSlackUrl?` fields.
- `features/support/mockSocketServer.ts` — canonical spawned-HTTP-mock pattern (lines 23–88). `mockSlackServer.ts` lifts the pattern.
- `features/support/mockGhBinary.ts` — `@adw-10` mock; reused unchanged in `@adw-11` scenarios.
- `features/step_definitions/scan_steps.ts` — `runDepaudit` helper (`:97–139`). Not directly used by `slack_reporter_steps.ts` (the new step file builds its own `runDepaudit` variant that prepends both the gh-mock binDir AND the Slack URL env var); the helper reads only Socket envs today, so reusing it for Slack tests would muddy concerns. The new step file's helper is named `runPostPrCommentWithSlack`.
- `app_docs/feature-e1layl-github-actions-gate-state-tracker.md` — house-style reference for the new `app_docs/feature-2sm4zt-slack-reporter-state-tracker-transitions.md`.
- `.adw/project.md` — confirms deep-module layout, Bun tooling, Vitest runner; no `## Unit Tests:` marker (override documented in Notes below).
- `.adw/commands.md` — validation commands (`bun run lint`, `bun run typecheck`, `bun test`, `bun run build`, `bun run test:e2e`).
- `.adw/conditional_docs.md` — **EXTEND** with the new entry pointing at the new app_docs file.
- `.adw/review_proof.md` — item 5 ("For changes to `OsvScannerAdapter` or `SocketApiClient`: confirm mock boundary tests cover the new behavior") applies by analogy: `SlackReporter` is a sibling HTTP-boundary module and gets the same standard. Documented in Notes.
- `specs/issue-10-adw-e1layl-github-actions-depau-sdlc_planner-github-actions-gate-state-tracker.md` — sister-slice plan; format, depth, and task ordering precedent (StateTracker, GhPrCommentClient, postPrCommentCommand patterns).

### New Files

- `src/modules/slackReporter.ts` — deep module: `postSlackNotification(text, options)`, `SlackReporterOptions`, `SlackPostResult`, `FetchFn`. Injectable `fetch` + `webhookUrl`. Fail-soft on every error path.
- `src/modules/__tests__/slackReporter.test.ts` — 11 unit tests covering env-var no-op, payload shape, fail-soft on every error path, option overrides.
- `features/support/mockSlackServer.ts` — spawned local HTTP server that records every incoming request (method, headers, body). Mirror of `mockSocketServer.ts` but with a `requests()` accessor for body-content assertions.
- `features/step_definitions/slack_reporter_steps.ts` — step definitions for the `@adw-11` scenarios in `slack_reporter.feature`.
- `app_docs/feature-2sm4zt-slack-reporter-state-tracker-transitions.md` — implementation summary in the house style of `app_docs/feature-e1layl-github-actions-gate-state-tracker.md`.

## Implementation Plan

### Phase 1: Pure StateTracker extensions

Land the pure additions to `StateTracker` first, with full unit-test coverage. Nothing in this phase touches HTTP, env vars, or BDD.

- Extend `src/types/prComment.ts` with `CurrentOutcome` and `SlackTransition` types.
- Extend `src/modules/stateTracker.ts` with `computeTransition` and `outcomeFromBody` (importing the new types).
- Extend `src/modules/__tests__/stateTracker.test.ts` with the two new `describe` blocks (transition matrix + body-parsing edge cases).

### Phase 2: SlackReporter HTTP boundary

Build the I/O layer in isolation, with mocked-`fetch` coverage. Validates the env-var no-op contract and fail-soft policy before any composition.

- Create `src/modules/slackReporter.ts` with `postSlackNotification`, `FetchFn`, `SlackReporterOptions`, `SlackPostResult`.
- Create `src/modules/__tests__/slackReporter.test.ts` covering all 11 unit-test scenarios.

### Phase 3: Composition wire-up in `postPrCommentCommand`

Compose StateTracker's transition logic with SlackReporter's HTTP boundary inside the existing `post-pr-comment` subcommand. Preserve the exit-code contract.

- Extend `src/commands/postPrCommentCommand.ts`: add `slackReporter` to `PostPrCommentOptions`, call `readPriorState`, `outcomeFromBody`, `computeTransition`, and `postSlackNotification` per the documented flow. Add stdout breadcrumbs (`slack: posted ...` / `slack: skipped (...)`).
- Extend `src/commands/__tests__/postPrCommentCommand.test.ts` with the `describe("Slack notification")` block (10 scenarios).

### Phase 4: BDD harness — mock Slack server + step definitions

Build the e2e harness for the `@adw-11` scenarios that already exist in `state_tracker.feature` and `slack_reporter.feature`.

- Create `features/support/mockSlackServer.ts` with `startMockSlackServer`, `MockSlackHandle`, request log accessor.
- Extend `features/support/world.ts` with `slackMock`, `transition`, `savedSlackUrl` fields.
- Extend `features/step_definitions/state_tracker_steps.ts` with the three new transition step definitions (and a `Before({ tags: "@adw-11" }, ...)` hook to clear `world.transition`).
- Create `features/step_definitions/slack_reporter_steps.ts` covering every `Given/When/Then` referenced by `slack_reporter.feature`.

### Phase 5: Documentation + validation

- Write `app_docs/feature-2sm4zt-slack-reporter-state-tracker-transitions.md` in the house style.
- Append the `.adw/conditional_docs.md` entry.
- Run the full validation suite (`bun run lint`, `bun run typecheck`, `bun test`, `bun run build`, `bun run test:e2e --tags "@adw-11"`, `bun run test:e2e --tags "@regression"`, `bun run test:e2e --tags "@adw-10"`, `bun run test:e2e`).

## Step by Step Tasks

Execute every step in order, top to bottom.

### Task 1 — Extend `src/types/prComment.ts` with transition types

- Append to `src/types/prComment.ts` (do NOT touch existing exports):
  ```ts
  /** Outcome of the *current* scan, parsed from the body about to be posted. */
  export type CurrentOutcome = "pass" | "fail";

  /** Result of computeTransition — describes whether this push is a fail-edge worth a Slack ping. */
  export interface SlackTransition {
    /** True iff this push is a fail-edge transition (priorOutcome !== "fail" AND currentOutcome === "fail"). */
    shouldFireSlack: boolean;
    /** Label for telemetry/logging; not a discriminator. */
    label:
      | "first-fail"
      | "pass-to-fail"
      | "fail-to-fail"
      | "pass-to-pass"
      | "fail-to-pass"
      | "first-pass";
  }
  ```
- No behaviour change. Existing `PrComment`, `PrCoordinates`, `CommentAction`, `PriorOutcome`, `PriorState` are untouched.

### Task 2 — Extend `src/modules/stateTracker.ts` with `outcomeFromBody` + `computeTransition`

- Imports add: `CurrentOutcome`, `SlackTransition` from `../types/prComment.js`.
- Append to the file (after `readPriorState`):
  ```ts
  export function outcomeFromBody(body: string): CurrentOutcome | null {
    if (body.includes("depaudit gate: PASS")) return "pass";
    if (body.includes("depaudit gate: FAIL")) return "fail";
    return null;
  }

  export function computeTransition(
    prior: PriorOutcome,
    current: CurrentOutcome
  ): SlackTransition {
    const shouldFireSlack = current === "fail" && prior !== "fail";
    let label: SlackTransition["label"];
    if (current === "fail") {
      label =
        prior === "none" ? "first-fail" :
        prior === "pass" ? "pass-to-fail" :
                           "fail-to-fail";
    } else {
      label =
        prior === "none" ? "first-pass" :
        prior === "pass" ? "pass-to-pass" :
                           "fail-to-pass";
    }
    return { shouldFireSlack, label };
  }
  ```
- No I/O. No mutation of inputs. Both functions pure.
- The PASS-takes-precedence-over-FAIL ordering in `outcomeFromBody` matches `readPriorState` (issue #10): both check PASS first, then FAIL. A body containing both strings (rare but possible if a contributor copy-pastes) returns `"pass"` for the current outcome, which biases toward NOT firing Slack — the safer side of the trade-off.

### Task 3 — Extend `src/modules/__tests__/stateTracker.test.ts`

- Add two new `describe` blocks alongside the existing `describe("decideCommentAction")` and `describe("readPriorState")` (preserve all existing tests verbatim):
  ```ts
  import { outcomeFromBody, computeTransition } from "../stateTracker.js";

  describe("outcomeFromBody", () => {
    it("returns 'pass' for body containing 'depaudit gate: PASS'", () => { ... });
    it("returns 'fail' for body containing 'depaudit gate: FAIL'", () => { ... });
    it("returns null for body containing neither header", () => { ... });
    it("returns 'pass' when both PASS and FAIL appear (PASS wins per readPriorState convention)", () => { ... });
    it("returns null for empty string", () => { ... });
    it("does not match 'PASS' outside the 'depaudit gate: ' prefix", () => {
      expect(outcomeFromBody("PASS the salt around")).toBe(null);
    });
    it("matches case-sensitively (lowercase 'depaudit gate: pass' returns null)", () => {
      expect(outcomeFromBody("depaudit gate: pass")).toBe(null);
    });
  });

  describe("computeTransition", () => {
    it("none + fail → first-fail; should fire", () => { ... });
    it("pass + fail → pass-to-fail; should fire", () => { ... });
    it("fail + fail → fail-to-fail; should NOT fire", () => { ... });
    it("pass + pass → pass-to-pass; should NOT fire", () => { ... });
    it("fail + pass → fail-to-pass; should NOT fire", () => { ... });
    it("none + pass → first-pass; should NOT fire", () => { ... });
    it("is pure — same inputs → same outputs", () => { ... });
  });
  ```
- All assertions are explicit (no snapshots). Each case asserts both `shouldFireSlack` and `label`.

### Task 4 — Create `src/modules/slackReporter.ts`

- New file.
- Imports: none beyond `globalThis.fetch` (no third-party deps; no `node:` modules — pure HTTP via the runtime fetch).
- Skeleton:
  ```ts
  export type FetchFn = typeof globalThis.fetch;

  export interface SlackReporterOptions {
    fetch?: FetchFn;
    webhookUrl?: string;
    timeoutMs?: number;
  }

  export interface SlackPostResult {
    posted: boolean;
    reason?: string;
  }

  const DEFAULT_TIMEOUT_MS = 5000;

  function isUsableWebhookUrl(url: string | undefined): url is string {
    return typeof url === "string" && url.trim().length > 0;
  }

  export async function postSlackNotification(
    text: string,
    options: SlackReporterOptions = {}
  ): Promise<SlackPostResult> {
    const url = options.webhookUrl ?? process.env["SLACK_WEBHOOK_URL"];
    if (!isUsableWebhookUrl(url)) {
      return { posted: false, reason: "no SLACK_WEBHOOK_URL configured" };
    }
    const fetchFn = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return { posted: false, reason: `webhook returned ${response.status}` };
      }
      return { posted: true };
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e.name === "AbortError") {
        return { posted: false, reason: `webhook request timed out after ${timeoutMs}ms` };
      }
      return { posted: false, reason: `webhook request failed: ${e.message ?? String(err)}` };
    } finally {
      clearTimeout(timer);
    }
  }
  ```
- `isUsableWebhookUrl` collapses unset/empty/whitespace-only into the same "no webhook" response so the BDD `unset` and `empty string` scenarios both return the same `posted: false` result without HTTP I/O.
- The function NEVER throws to the caller; every error path returns a `SlackPostResult` with `posted: false` and a descriptive `reason`. This is the fail-soft contract the integration depends on.

### Task 5 — Create `src/modules/__tests__/slackReporter.test.ts`

- New file.
- Imports: `describe, it, expect, vi, beforeEach, afterEach` from vitest; `postSlackNotification, type FetchFn` from `../slackReporter.js`.
- Helper at the top:
  ```ts
  function mockFetch(response: { status?: number; statusText?: string; ok?: boolean }): FetchFn {
    return vi.fn(async () => {
      const status = response.status ?? 200;
      const ok = response.ok ?? (status >= 200 && status < 300);
      return new Response("ok", { status, statusText: response.statusText ?? "" }) as unknown as Response;
    }) as unknown as FetchFn;
  }
  ```
- `beforeEach` / `afterEach`: save/restore `process.env.SLACK_WEBHOOK_URL` so tests don't leak.
- 11 scenarios listed above (Phase 2 / Solution Statement). Notable assertions:
  - For the "calls fetch exactly once with the right body" test, capture the fetch arguments via `vi.fn()` and assert `JSON.parse((calls[0][1] as RequestInit).body as string).text === "hello"`.
  - For the timeout test, inject a `fetch` that returns `new Promise(() => {})` (never resolves) AND inject a small `timeoutMs: 50` to make the AbortError fire fast. Assert reason mentions `"timed out"`.
  - For the network-error test, inject a fetch that throws `new TypeError("fetch failed")`. Assert reason mentions `"failed"`.
- All 11 tests must pass deterministically without real network access.

### Task 6 — Extend `src/commands/postPrCommentCommand.ts`

- Imports add:
  ```ts
  import {
    decideCommentAction,
    readPriorState,
    outcomeFromBody,
    computeTransition,
  } from "../modules/stateTracker.js";
  import { postSlackNotification } from "../modules/slackReporter.js";
  ```
- Extend `PostPrCommentOptions`:
  ```ts
  export interface PostPrCommentOptions {
    bodyFile: string;
    repo?: string;
    prNumber?: number;
    ghClient?: {
      listPrComments: typeof listPrComments;
      createPrComment: typeof createPrComment;
      updatePrComment: typeof updatePrComment;
    };
    slackReporter?: {
      postSlackNotification: typeof postSlackNotification;
    };
  }
  ```
- After the existing comment-action dispatch (currently `src/commands/postPrCommentCommand.ts:101`) and before the final `return 0`, insert:
  ```ts
  const slack = options.slackReporter ?? { postSlackNotification };

  const priorState = readPriorState(comments);
  const currentOutcome = outcomeFromBody(body);
  if (currentOutcome === null) {
    process.stdout.write(
      "slack: skipped (no recognisable PASS/FAIL header in body)\n"
    );
  } else {
    const transition = computeTransition(priorState.priorOutcome, currentOutcome);
    if (transition.shouldFireSlack) {
      const text = `depaudit-gate failed on PR #${prNumber}: https://github.com/${repo}/pull/${prNumber}`;
      const result = await slack.postSlackNotification(text);
      if (result.posted) {
        process.stdout.write(
          `slack: posted first-fail notification for PR #${prNumber} (transition: ${transition.label})\n`
        );
      } else {
        process.stdout.write(
          `slack: skipped (${result.reason ?? "unknown reason"})\n`
        );
      }
    } else {
      process.stdout.write(
        `slack: skipped (${transition.label}; no fail-edge transition)\n`
      );
    }
  }

  return 0;
  ```
- The Slack section runs **after** the comment is posted/updated. Rationale: the contributor sees the PR comment immediately; the maintainer sees Slack on top. Reverse ordering would let a Slack outage delay the PR comment update, which is the wrong trade-off.
- Slack outcome NEVER affects the exit code. Even if `slack.postSlackNotification` throws (which it shouldn't per the fail-soft contract — but defence-in-depth), the existing function-level `try/catch` around the comment action does NOT extend to this section. If the caller's `slackReporter` injection somehow throws, it propagates up, but the contract says it doesn't. Add a defensive `try/catch` *only* around the slack block:
  ```ts
  try {
    // (the slack block above)
  } catch (err: unknown) {
    process.stdout.write(`slack: skipped (unexpected error: ${(err as Error).message})\n`);
  }
  ```
  This is the one place the plan tolerates a try/catch that swallows — because Slack is observability and the gate's exit code must not be perturbed by any Slack-side bug.

### Task 7 — Extend `src/commands/__tests__/postPrCommentCommand.test.ts`

- Add a new `describe("Slack notification")` block. Helper:
  ```ts
  function makeMockSlackReporter(behaviour?: { posted?: boolean; reason?: string; throws?: Error }) {
    const calls: Array<{ text: string }> = [];
    return {
      calls,
      reporter: {
        async postSlackNotification(text: string) {
          calls.push({ text });
          if (behaviour?.throws) throw behaviour.throws;
          return {
            posted: behaviour?.posted ?? true,
            ...(behaviour?.reason ? { reason: behaviour.reason } : {}),
          };
        },
      },
    };
  }
  ```
- Body-builder helper:
  ```ts
  const FAIL_BODY = `${MARKER}\n## depaudit gate: FAIL\n- new: 1\n`;
  const PASS_BODY = `${MARKER}\n## depaudit gate: PASS\n- new: 0\n`;
  async function writeBody(file: string, body: string): Promise<void> {
    await writeFile(file, body, "utf8");
  }
  ```
- Scenarios (use the existing tempDir/bodyFile setup):
  1. **First-fail**: empty comment list, FAIL_BODY → 1 Slack call; text contains `"PR #42"` AND `"https://github.com/paysdoc/test-repo/pull/42"`.
  2. **Sustained fail**: comment list with `id: 1, body: FAIL_BODY`, FAIL_BODY → 0 Slack calls.
  3. **Pass-to-fail**: comment list with `id: 1, body: PASS_BODY`, FAIL_BODY → 1 Slack call.
  4. **Fail-to-pass**: comment list with `id: 1, body: FAIL_BODY`, PASS_BODY → 0 Slack calls.
  5. **Sustained pass**: comment list with `id: 1, body: PASS_BODY`, PASS_BODY → 0 Slack calls.
  6. **None-to-pass**: empty comment list, PASS_BODY → 0 Slack calls.
  7. **Multi-run** (5 successive calls): seed empty list, run with `[FAIL, FAIL, PASS, FAIL, FAIL]` bodies (rewriting bodyFile between runs) → exactly 2 Slack calls. Asserts both fire-points: run 1 (`first-fail`) and run 4 (`pass-to-fail`).
  8. **Body without recognisable header**: bodyFile content `"some random markdown"` → 0 Slack calls; stdout includes `"no recognisable PASS/FAIL header"`.
  9. **Slack returns non-posted**: inject `slackReporter` returning `{ posted: false, reason: "webhook returned 503" }`. Assertion: exit code is 0; Slack was called; stdout includes `"slack: skipped (webhook returned 503)"`.
  10. **Slack throws**: inject `slackReporter` throwing `new Error("boom")`. Assertion: exit code is 0; stdout includes `"slack: skipped (unexpected error: boom)"`.
- All scenarios use `makeMockGhClient` from the existing tests and the new `makeMockSlackReporter`.

### Task 8 — Create `features/support/mockSlackServer.ts`

- New file. Mirror of `mockSocketServer.ts`. Skeleton:
  ```ts
  import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
  import type { AddressInfo } from "node:net";

  export interface MockSlackConfig {
    body?: string;
    status?: number;
    delay?: number;
    transientKind?: "500" | "timeout";
    failuresBeforeSuccess?: number;
  }

  export interface MockSlackRequest {
    method: string;
    headers: Record<string, string>;
    body: string;
  }

  export interface MockSlackHandle {
    url: string;
    stop(): Promise<void>;
    hitCount(): number;
    requests(): MockSlackRequest[];
  }

  export async function startMockSlackServer(config: MockSlackConfig = {}): Promise<MockSlackHandle> {
    let hits = 0;
    const requests: MockSlackRequest[] = [];
    const {
      body = "ok",
      status = 200,
      delay = 0,
      transientKind = "500",
      failuresBeforeSuccess = 0,
    } = config;

    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      hits++;
      let bodyChunks = "";
      req.on("data", (chunk: Buffer) => { bodyChunks += chunk.toString(); });
      req.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : (v ?? "");
        }
        requests.push({ method: req.method ?? "", headers, body: bodyChunks });

        const respond = () => {
          const isTransient = hits <= failuresBeforeSuccess;
          if (isTransient && transientKind === "timeout") return; // hang
          if (isTransient && transientKind === "500") {
            res.writeHead(503, { "Content-Type": "text/plain" });
            res.end("service unavailable");
            return;
          }
          res.writeHead(status, { "Content-Type": "text/plain" });
          res.end(body);
        };
        if (delay > 0) setTimeout(respond, delay); else respond();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;

    return {
      url: `http://127.0.0.1:${port}`,
      stop: () => new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
      hitCount: () => hits,
      requests: () => [...requests],
    };
  }
  ```
- The `requests()` accessor returns a copy — callers may not mutate the live log.
- Body capture is via `req.on("data" / "end")` — Slack POSTs are small (~100 bytes) so no streaming gymnastics needed.

### Task 9 — Extend `features/support/world.ts`

- Add three new fields to `DepauditWorld`:
  ```ts
  /** Mock Slack webhook server handle (@adw-11) */
  slackMock?: import("./mockSlackServer.js").MockSlackHandle;
  /** Saved SLACK_WEBHOOK_URL for restore in After hook (@adw-11) */
  savedSlackUrl?: string | undefined;
  /** Computed transition result (@adw-11 transition scenarios in state_tracker.feature) */
  transition?: import("../../src/types/prComment.js").SlackTransition;
  ```
- No other edits.

### Task 10 — Extend `features/step_definitions/state_tracker_steps.ts` with transition steps

- Imports add:
  ```ts
  import { startMockSlackServer } from "../support/mockSlackServer.js";
  ```
  (Optional — only if any `@adw-11` transition step needs the Slack mock; the pure-transition steps in `state_tracker.feature:144–190` do NOT need the Slack mock, so this import may not be required there.)
- Add a `Before` hook for `@adw-11` to clear `world.transition`:
  ```ts
  Before<DepauditWorld>({ tags: "@adw-11" }, function (this: DepauditWorld) {
    this.transition = undefined;
  });
  ```
- Add three step definitions:
  ```ts
  When<DepauditWorld>(
    "StateTracker evaluates a transition from prior outcome {string} to current outcome {string}",
    async function (this: DepauditWorld, priorStr: string, currentStr: string) {
      // Validate inputs
      if (!["pass", "fail", "none"].includes(priorStr)) {
        throw new Error(`invalid prior outcome '${priorStr}'`);
      }
      if (!["pass", "fail"].includes(currentStr)) {
        throw new Error(`invalid current outcome '${currentStr}'`);
      }
      const { computeTransition } = (await import(
        `${PROJECT_ROOT}/dist/modules/stateTracker.js?t=${Date.now()}`
      )) as {
        computeTransition: (
          prior: "pass" | "fail" | "none",
          current: "pass" | "fail"
        ) => { shouldFireSlack: boolean; label: string };
      };
      this.transition = computeTransition(
        priorStr as "pass" | "fail" | "none",
        currentStr as "pass" | "fail"
      ) as import("../../src/types/prComment.js").SlackTransition;
    }
  );

  Then<DepauditWorld>(
    "the transition reports that a Slack notification should fire",
    function (this: DepauditWorld) {
      assert.equal(this.transition?.shouldFireSlack, true,
        `expected shouldFireSlack=true, got ${this.transition?.shouldFireSlack} (label=${this.transition?.label})`);
    }
  );

  Then<DepauditWorld>(
    "the transition reports that a Slack notification should NOT fire",
    function (this: DepauditWorld) {
      assert.equal(this.transition?.shouldFireSlack, false,
        `expected shouldFireSlack=false, got ${this.transition?.shouldFireSlack} (label=${this.transition?.label})`);
    }
  );
  ```
- The dynamic `import()` with `?t=${Date.now()}` cache-busts the import the same way `state_tracker_steps.ts:241` already does for `readPriorState`.

### Task 11 — Create `features/step_definitions/slack_reporter_steps.ts`

- New file.
- Imports: `Given`, `When`, `Then`, `Before`, `After` from `@cucumber/cucumber`; `mkdtemp`, `writeFile`, `rm` from `node:fs/promises`; `join` from `node:path`; `tmpdir` from `node:os`; `execFile` from `node:child_process`; `promisify` from `node:util`; `assert` from `node:assert/strict`; `DepauditWorld, PROJECT_ROOT, CLI_PATH` from `../support/world.js`; `startMockGhBinary` from `../support/mockGhBinary.js`; `startMockSlackServer` from `../support/mockSlackServer.js`.
- Constants:
  ```ts
  const MARKER = "<!-- depaudit-gate-comment -->";
  const DEFAULT_REPO = "paysdoc/depaudit-fixture";
  ```
- `Before<DepauditWorld>({ tags: "@adw-11" }, ...)`:
  ```ts
  Before<DepauditWorld>({ tags: "@adw-11" }, function (this: DepauditWorld) {
    this.savedSlackUrl = process.env["SLACK_WEBHOOK_URL"];
    this.slackMock = undefined;
    this.ghMock = undefined;
    this.bodyFilePath = undefined;
    this.transition = undefined;
  });
  ```
- `After<DepauditWorld>({ tags: "@adw-11" }, ...)`:
  ```ts
  After<DepauditWorld>({ tags: "@adw-11" }, async function (this: DepauditWorld) {
    await this.slackMock?.stop();
    await this.ghMock?.stop();
    if (this.bodyFilePath) {
      try { await rm(this.bodyFilePath); } catch {}
    }
    if (this.savedSlackUrl === undefined) {
      delete process.env["SLACK_WEBHOOK_URL"];
    } else {
      process.env["SLACK_WEBHOOK_URL"] = this.savedSlackUrl;
    }
  });
  ```
- Helper `runPostPrCommentWithSlack`:
  ```ts
  async function runPostPrCommentWithSlack(world: DepauditWorld): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (world.ghMock) {
      env["PATH"] = `${world.ghMock.binDir}:${env["PATH"] ?? ""}`;
    }
    env["GITHUB_REPOSITORY"] = DEFAULT_REPO;
    env["GH_TOKEN"] = "mock-token";
    // Forward SLACK_WEBHOOK_URL state to the child process exactly as set on the world's process.env
    if (process.env["SLACK_WEBHOOK_URL"] !== undefined) {
      env["SLACK_WEBHOOK_URL"] = process.env["SLACK_WEBHOOK_URL"];
    } else {
      delete env["SLACK_WEBHOOK_URL"];
    }
    const eventDir = await mkdtemp(join(tmpdir(), "depaudit-event-"));
    const eventFile = join(eventDir, "event.json");
    await writeFile(eventFile, JSON.stringify({ pull_request: { number: 42 } }), "utf8");
    env["GITHUB_EVENT_PATH"] = eventFile;

    const execFileAsync = promisify(execFile);
    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    try {
      const r = await execFileAsync("node",
        [CLI_PATH, "post-pr-comment", `--body-file=${world.bodyFilePath}`],
        { env });
      stdout = r.stdout; stderr = r.stderr;
    } catch (err: unknown) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string };
      exitCode = typeof e.code === "number" ? e.code : 1;
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
    } finally {
      try { await rm(eventDir, { recursive: true }); } catch {}
    }
    world.result = { exitCode, stdout, stderr };
  }
  ```
- Step definitions (matching the wording in `slack_reporter.feature` exactly — verify each phrase against the feature file):

  Background steps:
  - `Given the `depaudit` CLI is installed and on PATH` → already defined in `scan_steps.ts` (no-op assertion). Re-using it.
  - `Given a mock `gh` CLI is on PATH that records its invocations and serves a fake PR comment list` → already defined in `state_tracker_steps.ts:38`. Re-using it.
  - `Given a mock Slack Incoming Webhook server that records incoming HTTP requests`:
    ```ts
    Given<DepauditWorld>(
      "a mock Slack Incoming Webhook server that records incoming HTTP requests",
      async function (this: DepauditWorld) {
        this.slackMock = await startMockSlackServer({ status: 200, body: "ok" });
      }
    );
    ```

  SLACK_WEBHOOK_URL env-var setup:
  - `Given the SLACK_WEBHOOK_URL environment variable is unset`:
    ```ts
    Given<DepauditWorld>(
      "the SLACK_WEBHOOK_URL environment variable is unset",
      function () { delete process.env["SLACK_WEBHOOK_URL"]; }
    );
    ```
  - `Given SLACK_WEBHOOK_URL is set to the empty string`:
    ```ts
    Given<DepauditWorld>(
      "SLACK_WEBHOOK_URL is set to the empty string",
      function () { process.env["SLACK_WEBHOOK_URL"] = ""; }
    );
    ```
  - `Given SLACK_WEBHOOK_URL is set to the mock Slack webhook URL`:
    ```ts
    Given<DepauditWorld>(
      "SLACK_WEBHOOK_URL is set to the mock Slack webhook URL",
      function (this: DepauditWorld) {
        process.env["SLACK_WEBHOOK_URL"] = this.slackMock!.url;
      }
    );
    ```
  - `Given SLACK_WEBHOOK_URL is set to a mock Slack webhook that responds with 503 on every request`:
    ```ts
    Given<DepauditWorld>(
      "SLACK_WEBHOOK_URL is set to a mock Slack webhook that responds with 503 on every request",
      async function (this: DepauditWorld) {
        await this.slackMock?.stop();
        this.slackMock = await startMockSlackServer({ status: 503, body: "down" });
        process.env["SLACK_WEBHOOK_URL"] = this.slackMock.url;
      }
    );
    ```
  - `Given SLACK_WEBHOOK_URL is set to a mock Slack webhook that never responds`:
    ```ts
    Given<DepauditWorld>(
      "SLACK_WEBHOOK_URL is set to a mock Slack webhook that never responds",
      async function (this: DepauditWorld) {
        await this.slackMock?.stop();
        this.slackMock = await startMockSlackServer({
          transientKind: "timeout",
          failuresBeforeSuccess: Number.MAX_SAFE_INTEGER,
        });
        process.env["SLACK_WEBHOOK_URL"] = this.slackMock.url;
      }
    );
    ```
    Note: the postSlackNotification timeout default is 5000ms — these scenarios will hang for 5s before failing soft. To keep BDD fast, the helper sets a per-call override via env var, OR the slack mock returns an immediate connection-reset. The cheap approach: ship a `SLACK_REQUEST_TIMEOUT_MS` env var on `slackReporter.ts` (parsed once at module load) so BDD steps can drop the timeout to 200ms. Add this env var read to Task 4.

  Body-file setup (gh-mock state already configured by re-using `@adw-10` steps):
  - `Given a markdown body representing a {string} outcome is supplied as input` ({string} = "FAIL" or "PASS"):
    ```ts
    Given<DepauditWorld>(
      "a markdown body representing a {string} outcome is supplied as input",
      async function (this: DepauditWorld, outcome: string) {
        const tempDir = await mkdtemp(join(tmpdir(), "depaudit-body-"));
        this.bodyFilePath = join(tempDir, "body.md");
        const header = outcome.toUpperCase() === "PASS" ? "PASS" : "FAIL";
        await writeFile(this.bodyFilePath,
          `${MARKER}\n## depaudit gate: ${header}\n- new: ${header === "FAIL" ? 1 : 0}\n`,
          "utf8");
      }
    );
    ```

  Reuse the existing `@adw-10` `gh` mock-state steps:
  - `Given the mock `gh` CLI returns an empty comment list for PR 42` — already defined.
  - `Given the mock `gh` CLI returns a comment list for PR 42 containing one comment whose body includes {string} and a header {string}` — already defined.
  - `Given the mock `gh` CLI starts with an empty comment list for PR 42` — already defined.
  - `Given the mock `gh` CLI persists its post/edit mutations across invocations` — already defined.

  When-steps:
  - `When depaudit reconciles the PR comment and notifies Slack for PR 42`:
    ```ts
    When<DepauditWorld>(
      "depaudit reconciles the PR comment and notifies Slack for PR 42",
      async function (this: DepauditWorld) { await runPostPrCommentWithSlack(this); }
    );
    ```
  - `When depaudit reconciles the PR comment and notifies Slack for PR 42 with a {string} body` ({string} = "FAIL" or "PASS"):
    ```ts
    When<DepauditWorld>(
      "depaudit reconciles the PR comment and notifies Slack for PR 42 with a {string} body",
      async function (this: DepauditWorld, outcome: string) {
        // Rewrite the body file in place
        const header = outcome.toUpperCase() === "PASS" ? "PASS" : "FAIL";
        if (!this.bodyFilePath) {
          const tempDir = await mkdtemp(join(tmpdir(), "depaudit-body-"));
          this.bodyFilePath = join(tempDir, "body.md");
        }
        await writeFile(this.bodyFilePath,
          `${MARKER}\n## depaudit gate: ${header}\n- new: ${header === "FAIL" ? 1 : 0}\n`,
          "utf8");
        await runPostPrCommentWithSlack(this);
      }
    );
    ```

  Then-steps:
  - `Then the mock Slack webhook received {int} requests`:
    ```ts
    Then<DepauditWorld>(
      "the mock Slack webhook received {int} requests",
      function (this: DepauditWorld, n: number) {
        assert.equal(this.slackMock?.hitCount(), n);
      }
    );
    ```
  - `Then the mock Slack webhook received exactly {int} request(s)`:
    ```ts
    // Cucumber matches the optional plural via word-boundary in {int}; if not, register both:
    Then<DepauditWorld>(
      "the mock Slack webhook received exactly {int} request",
      function (this: DepauditWorld, n: number) { assert.equal(this.slackMock?.hitCount(), n); }
    );
    Then<DepauditWorld>(
      "the mock Slack webhook received exactly {int} requests",
      function (this: DepauditWorld, n: number) { assert.equal(this.slackMock?.hitCount(), n); }
    );
    ```
  - `Then the depaudit invocation exits zero`:
    ```ts
    Then<DepauditWorld>(
      "the depaudit invocation exits zero",
      function (this: DepauditWorld) { assert.equal(this.result?.exitCode, 0); }
    );
    ```
  - `Then the last Slack request body parses as JSON`:
    ```ts
    Then<DepauditWorld>(
      "the last Slack request body parses as JSON",
      function (this: DepauditWorld) {
        const reqs = this.slackMock!.requests();
        const last = reqs[reqs.length - 1]!;
        assert.doesNotThrow(() => JSON.parse(last.body));
      }
    );
    ```
  - `Then the last Slack request JSON has a top-level string field {word}`:
    ```ts
    Then<DepauditWorld>(
      "the last Slack request JSON has a top-level string field {word}",
      function (this: DepauditWorld, fieldName: string) {
        const reqs = this.slackMock!.requests();
        const last = reqs[reqs.length - 1]!;
        const parsed = JSON.parse(last.body) as Record<string, unknown>;
        assert.equal(typeof parsed[fieldName], "string");
      }
    );
    ```
  - `Then the last Slack request {word} field contains {string}`:
    ```ts
    Then<DepauditWorld>(
      "the last Slack request {word} field contains {string}",
      function (this: DepauditWorld, fieldName: string, expected: string) {
        const reqs = this.slackMock!.requests();
        const last = reqs[reqs.length - 1]!;
        const parsed = JSON.parse(last.body) as Record<string, string>;
        assert.ok(
          parsed[fieldName]?.includes(expected),
          `expected ${fieldName} to contain '${expected}', got '${parsed[fieldName]}'`
        );
      }
    );
    ```
  - `Then the last Slack request {word} field contains a GitHub PR URL ending in {string}`:
    ```ts
    Then<DepauditWorld>(
      "the last Slack request {word} field contains a GitHub PR URL ending in {string}",
      function (this: DepauditWorld, fieldName: string, suffix: string) {
        const reqs = this.slackMock!.requests();
        const last = reqs[reqs.length - 1]!;
        const parsed = JSON.parse(last.body) as Record<string, string>;
        const text = parsed[fieldName] ?? "";
        const urlMatch = text.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
        assert.ok(urlMatch, `expected a github.com PR URL in '${text}'`);
        assert.ok(urlMatch[0].endsWith(suffix), `expected URL to end with '${suffix}', got '${urlMatch[0]}'`);
      }
    );
    ```
  - `Then the last Slack request used HTTP method {string}`:
    ```ts
    Then<DepauditWorld>(
      "the last Slack request used HTTP method {string}",
      function (this: DepauditWorld, method: string) {
        const reqs = this.slackMock!.requests();
        assert.equal(reqs[reqs.length - 1]!.method, method);
      }
    );
    ```
  - `Then the last Slack request Content-Type starts with {string}`:
    ```ts
    Then<DepauditWorld>(
      "the last Slack request Content-Type starts with {string}",
      function (this: DepauditWorld, prefix: string) {
        const reqs = this.slackMock!.requests();
        const ct = reqs[reqs.length - 1]!.headers["content-type"] ?? "";
        assert.ok(ct.startsWith(prefix), `expected Content-Type to start with '${prefix}', got '${ct}'`);
      }
    );
    ```

- For the timeout scenario to complete fast, add the env-var override `SLACK_REQUEST_TIMEOUT_MS` to `slackReporter.ts` (Task 4). The scenario sets it to 200ms before invocation; the mock's hang triggers an AbortError ~200ms later. Document this in `app_docs`.

### Task 12 — Wire timeout-override env var in `slackReporter.ts`

- Update Task 4's resolver to honour an env-var fallback:
  ```ts
  const DEFAULT_TIMEOUT_MS =
    parseInt(process.env["SLACK_REQUEST_TIMEOUT_MS"] ?? "", 10) || 5000;
  ```
- Move the constant lookup to module-load time (matches the `socketApiClient.ts:38` pattern). Document in `app_docs` that this is BDD-only and not user-facing (the README does not advertise it).
- Add a unit test in `slackReporter.test.ts` (extending Task 5) asserting the env-var override is honored: set `SLACK_REQUEST_TIMEOUT_MS=99` → spy on AbortController, assert the timeout was 99ms.

### Task 13 — Write `app_docs/feature-2sm4zt-slack-reporter-state-tracker-transitions.md`

- House style mirroring `app_docs/feature-e1layl-github-actions-gate-state-tracker.md`. Required sections (each filled out with the slice's specifics):
  - **Overview** — 1 paragraph: SlackReporter, computeTransition/outcomeFromBody, integration into post-pr-comment, fail-soft contract.
  - **What Was Built** — bulleted list of all new + modified files (5 new + 4 modified per the Task list).
  - **Technical Implementation**
    - Files Modified — 4 files with bullet-level detail.
    - Files Added — 4 files with one-line description each.
    - Key Changes — three subheadings:
      - `SlackReporter (src/modules/slackReporter.ts)` — env-var no-op, fail-soft, payload shape, timeout.
      - `StateTracker extensions (src/modules/stateTracker.ts)` — `computeTransition` rule, `outcomeFromBody` parser, why label exists.
      - `postPrCommentCommand integration (src/commands/postPrCommentCommand.ts)` — flow diagram, exit-code preservation, defensive try/catch around the slack block.
  - **How to Use** — example: `SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T0/B0/secret depaudit post-pr-comment --body-file=out.md`. Stdout breadcrumbs example.
  - **Configuration**
    | Env var | Description | Default |
    |---|---|---|
    | `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL | (unset → no-op) |
    | `SLACK_REQUEST_TIMEOUT_MS` | Per-request timeout (BDD only) | 5000 |
  - **Testing** — `bun test` for unit; `bun run test:e2e -- --tags "@adw-11"` for BDD.
  - **Notes** — fail-soft rationale, no-retry rationale, label-for-telemetry rationale, User Story 28 partial-coverage note, marker false-positive carry-over from issue #10.

### Task 14 — Append `.adw/conditional_docs.md` entry

- Append the entry documented in the Solution Statement (above) to the end of `.adw/conditional_docs.md`. No re-ordering of existing entries.

### Task 15 — Run the validation suite

Execute every command in the **Validation Commands** section. All must pass with zero regressions.

## Testing Strategy

### Unit Tests

`.adw/project.md` does not carry a `## Unit Tests: enabled` marker. This plan includes unit-test tasks as a documented override, matching the precedent set by issues #3, #4, #5, #6, #7, #8, #9, #10, and #13. Justifications, in priority order:

1. **The issue explicitly mandates SlackReporter unit tests** with mocked HTTP as an acceptance criterion ("Unit tests for `SlackReporter` (mocked HTTP) and transition detection").
2. **`SlackReporter` is an HTTP-boundary module**. PRD `:247` classifies all such modules as Tier 1 with mocked HTTP. Without unit coverage, the boundary becomes a silent failure surface.
3. **`.adw/review_proof.md:5`** requires mock-boundary tests for any module wrapping a subprocess or HTTP call. SlackReporter is such a module by analogy.
4. **`StateTracker.computeTransition` and `outcomeFromBody`** are pure decision functions whose correctness is the entire feature contract — every cell of the 3×2 transition matrix needs a test.
5. **The integration in `postPrCommentCommand`** needs a regression net so future changes (e.g., issue #16's cross-repo token propagation) can land without re-introducing first-failure-fires-twice or sustained-fail-fires-again bugs.

Unit tests to build:

- **`src/modules/__tests__/slackReporter.test.ts`** — env-var unset / empty / whitespace, payload-shape, fail-soft on 5xx / 4xx / timeout / network-error, options-override of webhookUrl + fetch, timeout env-var override.
- **`src/modules/__tests__/stateTracker.test.ts`** (extend) — six new `outcomeFromBody` scenarios + seven new `computeTransition` scenarios.
- **`src/commands/__tests__/postPrCommentCommand.test.ts`** (extend) — ten new Slack-integration scenarios in a `describe("Slack notification")` block.

### Edge Cases

- **`SLACK_WEBHOOK_URL` is the literal empty string**. Treated as missing (no HTTP call). Covered by Task 5 scenario 2 + `slack_reporter.feature:28–34`.
- **`SLACK_WEBHOOK_URL` is whitespace only** (a common copy-paste accident from a half-set GH secret). Treated as missing. Covered by Task 5 scenario 3.
- **Body without recognisable PASS/FAIL header** (e.g., a manual `depaudit post-pr-comment --body-file=arbitrary.md` invocation). `outcomeFromBody` returns `null`; Slack is skipped with a clear stdout breadcrumb. Covered by Task 7 scenario 8.
- **Multiple marker-bearing prior comments** (bug-legacy state from a previous buggy run). `readPriorState` reads the FIRST one's outcome (issue #10 contract). Slack transition is computed against that first one's outcome — the orphans are ignored.
- **Slack returns 5xx**. `postSlackNotification` fail-soft returns `{ posted: false, reason: "webhook returned 503" }`. `postPrCommentCommand` writes a stdout breadcrumb; exit code stays 0. Covered by Task 5 scenario 5 + `slack_reporter.feature:134–139`.
- **Slack times out**. Same fail-soft path; reason mentions `"timed out"`. Covered by Task 5 scenario 6 + `slack_reporter.feature:142–147`.
- **Slack throws synchronously** (e.g., a programming bug in a future SlackReporter change). Defensive try/catch in `postPrCommentCommand` catches and writes `slack: skipped (unexpected error: ...)`. Exit code stays 0. Covered by Task 7 scenario 10.
- **Body and prior comment both contain `depaudit gate: PASS` and `depaudit gate: FAIL`** (rare; e.g., if MarkdownReporter ever emits both headers). `outcomeFromBody` and `readPriorState` both pick PASS first. Conservative bias toward "skip Slack". Covered by Task 3 scenario 4.
- **Multi-PR concurrency** — two CI runs on different PRs hitting the Slack webhook in parallel. Each run reads its own PR's prior comment; `priorState` is per-PR. No shared state. The mock harness sequences runs but the implementation is reentrant.
- **Five sustained fail pushes**. First fires; runs 2–5 are silent. Covered by Task 7 scenario 7 + `slack_reporter.feature:81–89`.
- **`fail → fail → pass → fail`** sequence. Exactly two fires (run 1 + run 4). Covered by Task 7 scenario 7 + `slack_reporter.feature:91–100` + `state_tracker.feature:181–190`.
- **`SLACK_REQUEST_TIMEOUT_MS` env var set to a non-numeric string** ("foo"). `parseInt` returns `NaN`; `NaN || 5000` evaluates to 5000 (default). No crash. Documented in `app_docs` Notes.
- **PR URL with `repo` containing slashes** (e.g. `gh-organization/sub-org/repo`). The constructed URL `https://github.com/${repo}/pull/${prNumber}` would break GitHub's path; but `GITHUB_REPOSITORY` is always `owner/repo` per Actions docs. We do not validate; we trust the env. (A future patch could URL-encode each segment; this slice does not.)
- **`prNumber` is not a positive integer** (e.g., 0 or negative). Already guarded upstream in `postPrCommentCommand` (issue #10) — Slack section is unreachable on invalid PR.

## Acceptance Criteria

- [ ] `src/modules/slackReporter.ts` exports `postSlackNotification(text, options)` returning `Promise<SlackPostResult>`, with `FetchFn` and `SlackReporterOptions` types.
- [ ] `postSlackNotification` returns `{ posted: false, reason: "no SLACK_WEBHOOK_URL configured" }` (or close synonym) and does NOT call `fetch` when `SLACK_WEBHOOK_URL` is unset, empty string, or whitespace-only.
- [ ] `postSlackNotification` POSTs `Content-Type: application/json` body `JSON.stringify({ text })` to the configured webhook URL when set.
- [ ] `postSlackNotification` returns `{ posted: false, reason: ... }` (NEVER throws) on 5xx, 4xx (other than 2xx), AbortError (timeout), or any network error.
- [ ] `postSlackNotification` returns `{ posted: true }` on a 2xx response.
- [ ] `postSlackNotification` honours `options.webhookUrl`, `options.fetch`, `options.timeoutMs` overrides.
- [ ] `postSlackNotification` honours `SLACK_REQUEST_TIMEOUT_MS` env var (BDD-only, undocumented in README).
- [ ] `src/types/prComment.ts` exports `CurrentOutcome` and `SlackTransition` types with the documented shape.
- [ ] `src/modules/stateTracker.ts` exports `computeTransition(prior, current): SlackTransition` returning `shouldFireSlack: true` iff `current === "fail" && prior !== "fail"`.
- [ ] `src/modules/stateTracker.ts` exports `outcomeFromBody(body): CurrentOutcome | null` returning `"pass"` if body contains `"depaudit gate: PASS"`, `"fail"` if body contains `"depaudit gate: FAIL"`, else `null`. PASS takes precedence when both appear.
- [ ] Existing `decideCommentAction` and `readPriorState` are not modified.
- [ ] `src/commands/postPrCommentCommand.ts` accepts an optional `slackReporter` injection in `PostPrCommentOptions`, defaulting to `{ postSlackNotification }`.
- [ ] `postPrCommentCommand` calls Slack ONLY when `outcomeFromBody(body) !== null` AND `computeTransition(prior, current).shouldFireSlack === true`.
- [ ] Slack post failure (any kind) does NOT change the exit code from `postPrCommentCommand` (still 0 on success, 1 on gh failure, 2 on invalid args).
- [ ] `postPrCommentCommand` writes a single stdout breadcrumb summarising the Slack outcome (`slack: posted ...` / `slack: skipped (...)`).
- [ ] Slack POST text is exactly `depaudit-gate failed on PR #${prNumber}: https://github.com/${repo}/pull/${prNumber}`.
- [ ] `features/support/mockSlackServer.ts` exports `startMockSlackServer` and `MockSlackHandle` with `url`, `stop`, `hitCount`, `requests` accessors.
- [ ] `features/support/world.ts` carries `slackMock`, `transition`, `savedSlackUrl` fields.
- [ ] `features/step_definitions/state_tracker_steps.ts` defines the new transition steps; existing `@adw-10` steps are unchanged.
- [ ] `features/step_definitions/slack_reporter_steps.ts` covers every step referenced by `slack_reporter.feature` lines 11–147.
- [ ] `app_docs/feature-2sm4zt-slack-reporter-state-tracker-transitions.md` exists in the house style.
- [ ] `.adw/conditional_docs.md` carries an entry pointing at the new app_docs file.
- [ ] `bun run lint`, `bun run typecheck`, `bun run build`, `bun test` all pass with zero new warnings or errors.
- [ ] `bun run test:e2e -- --tags "@adw-11"` passes all `@adw-11` scenarios in `state_tracker.feature` (lines 144–190) and `slack_reporter.feature` (entire file).
- [ ] `bun run test:e2e -- --tags "@adw-10"` continues to pass — no regression in the issue #10 PR-comment dedupe scenarios.
- [ ] `bun run test:e2e -- --tags "@regression"` passes — every prior `@regression` scenario continues to pass; new `@adw-11 @regression` scenarios pass alongside.
- [ ] `bun run test:e2e` — the full Cucumber suite passes end-to-end.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `bun install` — ensure dependencies resolved. No new runtime dependencies expected (`fetch` is a runtime built-in; the mock Slack server uses `node:http`).
- `bun run lint` — lint the entire codebase; zero warnings.
- `bun run typecheck` — TypeScript strict mode must pass across the new `src/modules/slackReporter.ts`, the extended `src/types/prComment.ts`, the extended `src/modules/stateTracker.ts`, and the extended `src/commands/postPrCommentCommand.ts`.
- `bun test` — full Vitest suite including the new `slackReporter.test.ts` and the extended `stateTracker.test.ts` + `postPrCommentCommand.test.ts`. Zero failures.
- `bun run build` — emits `dist/modules/slackReporter.js`, `dist/types/prComment.js` (with new types), `dist/modules/stateTracker.js` (with new exports), `dist/commands/postPrCommentCommand.js` (with Slack wire-up).
- `bun run test:e2e -- --tags "@adw-11"` — new BDD scenarios pass end-to-end.
- `bun run test:e2e -- --tags "@adw-10"` — issue #10 PR-comment dedupe scenarios continue to pass.
- `bun run test:e2e -- --tags "@regression"` — every prior `@regression` scenario continues to pass; new `@adw-11 @regression` scenarios pass alongside.
- `bun run test:e2e -- --tags "@adw-9"` — MarkdownReporter behaviour is unchanged; sister-slice scenarios untouched.
- `bun run test:e2e` — final smoke test of the full Cucumber suite.

Sanity checks (optional but recommended):

- Manually run `bun run build && SLACK_WEBHOOK_URL= node dist/cli.js post-pr-comment --body-file=fixtures/gh-body/depaudit-comment.md --repo=paysdoc/foo --pr=1` against the existing PR-mock harness (or a recorded `gh` mock) and assert the stdout breadcrumb says `slack: skipped (no SLACK_WEBHOOK_URL configured)`.
- Manually run with `SLACK_WEBHOOK_URL` pointing at a local HTTP echo server (e.g., `nc -l 8000`) and assert the request shape (POST, JSON body) at the wire level.

## Notes

- **Unit tests override.** `.adw/project.md` lacks `## Unit Tests: enabled`. This plan includes unit + integration tests because the issue's acceptance criteria explicitly demand them ("Unit tests for `SlackReporter` (mocked HTTP) and transition detection.") AND `.adw/review_proof.md:5` requires mock-boundary tests for any subprocess- or HTTP-wrapping module. Same precedent as issues #3–#10 and #13.
- **Slack is observability, not gating.** A Slack outage MUST NOT break the gate. Hence: fail-soft on every error path inside `postSlackNotification`; defensive try/catch around the Slack block in `postPrCommentCommand`; no Slack-side condition ever influences the exit code. This is enforced by integration test #9 in Task 7 and by `slack_reporter.feature:134–147`.
- **No retries.** Slack Incoming Webhooks are best-effort; per-run retries don't help during a Slack outage and burn wall-clock CI time. A future slice can add retries (with backoff) if metrics show cross-run loss is non-trivial. The `failuresBeforeSuccess` parameter on `mockSlackServer` is exposed for consistency with `mockSocketServer` but unused by current scenarios.
- **PASS-precedence in `outcomeFromBody`.** When a body contains both `depaudit gate: PASS` and `depaudit gate: FAIL` headers (a corrupted body), the parser returns `"pass"`. This biases toward NOT firing Slack — the conservative side of the trade-off. (A spurious skip is recoverable on the next push; a spurious fire wakes the maintainer at 3 AM.)
- **`SlackTransition.label` exists despite `shouldFireSlack` being the only branch.** Reasons: (a) telemetry/logging clarity (`slack: skipped (sustained fail-to-fail)` is more actionable than `slack: skipped (priorOutcome=fail, currentOutcome=fail)`); (b) future consumers (e.g., a `gate_transition_total` Prometheus counter) can read the label without re-deriving the transition; (c) the unit-test surface stays uniform — every cell of the 3×2 matrix asserts both `shouldFireSlack` AND `label`, which catches accidental mis-labelling regressions for free.
- **`SLACK_REQUEST_TIMEOUT_MS` is BDD-only.** The README and `.env.sample` do NOT document it. It exists solely to keep the BDD timeout-failure scenarios fast (200ms instead of 5000ms). Same pattern as `SOCKET_REQUEST_TIMEOUT_MS` (`socketApiClient.ts:38`).
- **User Story 28 — partial coverage.** The issue body explicitly notes: "User story 28 (partial; cross-repo token propagation lands in ADW slice 16)". This slice handles the *consumer* side: if `SLACK_WEBHOOK_URL` is set, Slack fires. The *propagation* side — `adwInit.tsx` calling `gh secret set SLACK_WEBHOOK_URL` from ADW's `.env` to each target repo's GitHub Actions secrets — lands in ADW slice 16, in the `adws/` repo. This slice's contract ends at "if the secret is configured, a fail-edge fires; if not, a fail-edge is silent."
- **Marker false-positive carry-over.** `StateTracker` treats any comment containing `<!-- depaudit-gate-comment -->` as the prior depaudit gate comment (issue #10 design). A contributor pasting that literal string into a PR comment would have their comment overwritten on the next gate run AND their fake "gate: PASS" header would influence the Slack transition. The marker is deliberately weird-looking to minimise collision; a future slice can tighten the match (e.g., require comment author = `github-actions[bot]`).
- **Workflow template is unchanged.** `templates/depaudit-gate.yml` already passes `GH_TOKEN` and `SOCKET_API_TOKEN`; adding `SLACK_WEBHOOK_URL` would require an env-var line in the "Post or update PR comment" step. **However**, the issue body explicitly ties the env var to the existing `post-pr-comment` step (no new subcommand). Editing the template to forward `SLACK_WEBHOOK_URL` is a one-line change that is scoped to *issue #11*: add `SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}` to the `env:` block of the post-pr-comment step. This is a tiny edit but materially required for the gate to fire Slack from CI. Document the edit in Task 6 or as a sub-task of Task 13. **Resolution**: add this template edit explicitly as a sub-step of Task 6 (the composition root extension):
  - Edit `templates/depaudit-gate.yml`, lines 41–45 (the "Post or update PR comment" step) to add `SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}` under `env:` alongside `GH_TOKEN`. This is one line of YAML change.
  - Update the existing `features/depaudit_gate_workflow.feature` if any scenario asserts the env-var list (none does currently — the BDD only asserts `GITHUB_TOKEN` is referenced; nothing about SLACK_WEBHOOK_URL — so no scenario updates required).
  - Update the existing `src/modules/__tests__/depauditGateYml.test.ts` if it asserts the env-var list (re-check during implementation).
- **No new dependencies.** SlackReporter uses the runtime `fetch` (Node 18+); the mock server uses `node:http`. No `bun add` step required.
- **Conditional_docs entry must NOT replace the issue #10 entry.** The issue #10 entry stays put; this slice appends a new entry below it.
