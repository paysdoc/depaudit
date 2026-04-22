# Feature: GitHub Actions depaudit-gate.yml + PR comment + StateTracker

## Metadata
issueNumber: `10`
adwId: `e1layl-github-actions-depau`
issueJson: `{"number":10,"title":"GitHub Actions depaudit-gate.yml + PR comment + StateTracker","body":"## Parent PRD\n\n`specs/prd/depaudit.md`\n\n## What to build\n\nScaffolds the `.github/workflows/depaudit-gate.yml` template (published as a fixture inside the package; `DepauditSetupCommand` later copies it into target repos). The workflow installs `depaudit` via `npm install -g`, runs `depaudit scan`, and posts a PR comment using the `gh` CLI.\n\nAdds `StateTracker` — reads the existing PR comment (identified by the `<!-- depaudit-gate-comment -->` marker), detects pass/fail state, and decides whether to post-new vs update-in-place. Implements in-place updates so a PR with many pushes accumulates one comment, not many.\n\n## Acceptance criteria\n\n- [ ] `depaudit-gate.yml` template exists and is syntactically valid GitHub Actions.\n- [ ] Workflow installs depaudit, runs scan, captures markdown output.\n- [ ] `StateTracker` identifies the prior comment by marker and either creates or edits it.\n- [ ] PR comment includes the hidden marker (`<!-- depaudit-gate-comment -->`).\n- [ ] Fail exit code propagates to Actions (check fails when scan fails).\n- [ ] Integration test: harness runs the workflow logic against a mocked PR API, asserts single-comment behavior under multiple runs.\n- [ ] `StateTracker` unit tests (mocked comment list).\n\n## Blocked by\n\n- Blocked by #9\n\n## User stories addressed\n\n- User story 1\n- User story 2\n- User story 8\n- User story 9\n- User story 32\n","state":"OPEN","author":"paysdoc","labels":[],"createdAt":"2026-04-17T13:24:42Z","comments":[],"actionableComment":null}`

## Feature Description

Target repositories that adopt depaudit need two things that don't yet exist in this codebase:

1. A checked-in GitHub Actions workflow that actually *runs* the gate on every PR — installs `depaudit`, invokes `depaudit scan`, captures the markdown output introduced by issue #9, and surfaces pass/fail to GitHub's PR checks. Without this, depaudit is a CLI users can run locally but never reaches CI; User Story 1 (a CI gate that fails merges into the production branch when above-threshold findings exist) and User Story 2 (same gate regardless of `main`-vs-`dev→main` branching style) stay unmet.

2. A deterministic, in-place PR comment that stays as **one** comment across every push to the same PR — not a new comment on every workflow run. The PR body becomes unreadable when each push spawns its own gate-comment; without the dedupe logic, User Story 9 (contributors see a single evolving comment, not many) stays unmet, and User Story 8 (contributor sees exactly which package/version/finding introduced the failure plus a suggested action) is merely partially met — the markdown content is already there (issue #9), but contributors have to hunt for the *latest* comment on a PR that's accumulated five of them.

This slice introduces both pieces:

- **A `templates/depaudit-gate.yml` workflow** (pre-release fixture bundled with the npm package). The workflow triggers on `pull_request`, installs Node LTS, installs depaudit globally via `npm install -g depaudit`, runs `depaudit scan` capturing its markdown stdout to a file, invokes a new `depaudit post-pr-comment` subcommand that manages the PR comment, and exits with the scan's original exit code so Actions correctly shows the PR check as failed when the gate fails. The workflow itself is just a fixture file in this slice — `DepauditSetupCommand` (issue #11) will later copy it from `templates/` into each target repo's `.github/workflows/`. To keep the fixture directly exercisable, a companion unit test parses the YAML, asserts the required jobs/steps are present, and asserts `on: pull_request` is configured.

- **A `StateTracker` deep module** — pure logic that performs two distinct reads over an incoming PR comment list: (a) *detects the pass/fail state* carried by the prior depaudit-gate comment (if any) by looking for a `depaudit gate: PASS` / `depaudit gate: FAIL` header in the marker-bearing comment's body, and (b) *decides whether to post-new vs update-in-place* by finding the first comment whose body contains the `<!-- depaudit-gate-comment -->` marker. Identifies the depaudit comment by that same marker (already in every `MarkdownReporter` emission since issue #9). Stateless per-call; state comes in via the comment list argument. Unit-tested with mocked comment lists across empty / one-marker / multi-marker / many-marker-free permutations as well as PASS-header / FAIL-header / no-header permutations.

- **A `GhPrCommentClient` deep module** — thin boundary over the `gh` CLI. `listPrComments`, `createPrComment`, `updatePrComment`. Mockable via an injectable `execFile` function, same pattern as `OsvScannerAdapter`. Takes GitHub coordinates (repo, PR number) and the markdown body; returns structured results (list of `PrComment`, created comment ID) so `StateTracker`'s pure output can drive it.

- **A `depaudit post-pr-comment` subcommand** — composition root. Reads the markdown body from `--body-file`, resolves GitHub coordinates from `--repo` / `--pr` flags or from `GITHUB_REPOSITORY` / the `pull_request` event JSON at `GITHUB_EVENT_PATH`, calls `GhPrCommentClient.listPrComments`, passes the result through `StateTracker.decideCommentAction`, and invokes `createPrComment` or `updatePrComment` based on the decision. Exits `0` on success, `1` on any gh failure, `2` on invalid arguments. Importantly, the subcommand's exit code is **independent** of the gate outcome — the workflow separately threads the scan's exit code back so Actions correctly marks the check as failed.

The net effect: every target repo onboarded by `DepauditSetupCommand` (issue #11 onward) immediately has a working gate that (a) fails the Actions check on gate failure, (b) posts a single, updated-in-place PR comment carrying the full markdown from issue #9, and (c) supports User Stories 1, 2, 8, 9 as documented deliverables. User Story 32 (SARIF deliberately NOT populated) is explicitly honoured by omission — the workflow never invokes `github/codeql-action` or any SARIF upload step.

## User Story

As a maintainer of a repo that uses depaudit
I want `depaudit setup` to drop a working `.github/workflows/depaudit-gate.yml` into my repo
So that every PR automatically runs the gate, fails the Actions check when new or expired findings exist, and posts a single, always-up-to-date PR comment showing the result — without me authoring the workflow or the comment-update logic myself.

As a contributor pushing to a PR
I want the depaudit gate comment to update in place on each push
So that my PR stays readable as a single evolving gate-comment, not a graveyard of historical ones.

As a maintainer debugging a gate run
I want the Actions check's pass/fail to reflect the scan's exit code exactly
So that GitHub's branch protection rules key off the correct check state and don't silently green-light a failed scan because the workflow accidentally exited 0.

## Problem Statement

Concretely, the gaps this slice closes are:

1. **No `.github/workflows/depaudit-gate.yml` template exists anywhere in the repo.** PRD `:120` documents that one is scaffolded by `DepauditSetupCommand`: *"Pinned to the resolved trigger branch … Installs depaudit via `npm install -g`, runs `depaudit scan`, posts/updates the PR comment, fires Slack on first-failure transition."* No YAML file matching that description lives under `templates/`, `src/`, `fixtures/`, or the `.github/workflows/` of this repo. Issue #11 (`DepauditSetupCommand`) is already unblocked by #10 per the issue dependency graph, so #10 is the slice that must land the template.

2. **No PR-comment-management code exists.** `src/modules/markdownReporter.ts` already renders the markdown body (including the `<!-- depaudit-gate-comment -->` marker at `src/types/markdownReport.ts:3`), but nothing consumes it to POST/PATCH GitHub. User Story 9 ("update a single comment on my PR (not post a new one each time I push)") is currently unreachable.

3. **No `StateTracker` module exists.** PRD `:202` names it: *"tracks PR-level state across scan runs (for comment dedupe and first-failure Slack dedupe); operates on PR state (comment presence, prior scan outcome)."* PRD `:239` puts it at Tier 1 ("state-transition assertions"). No code in `src/modules/` maps to this name. Without it, there's no pure, unit-testable locus for the comment-dedupe logic.

4. **No `gh` CLI boundary.** The PRD's CI design (line `:120`, `:191`) shells to `gh` for comment posting AND for `gh secret set` (in the setup slice). No existing module wraps `gh`; the adjacent shell-out pattern in `src/modules/osvScannerAdapter.ts` is the right template but hasn't been extended to GitHub API calls yet.

5. **No CLI surface for comment posting.** `src/cli.ts` currently knows `scan` and `lint` only. A workflow that shells to `depaudit post-pr-comment` needs that subcommand to exist. The alternative — pure-shell `gh api` + `jq` inside the workflow — keeps the comment-dedupe logic untested (BDD-ing a bash-embedded pipeline is high-friction and skips the unit-level assertions the issue asks for).

6. **No exit-code propagation discipline between `depaudit scan` and the Actions check.** The workflow must run the scan, capture stdout to a file, *then* invoke the comment poster, *then* exit with the scan's original exit code. A naïve `depaudit scan && depaudit post-pr-comment` short-circuits on the scan failure and never posts the comment; a naïve `depaudit scan; depaudit post-pr-comment` discards the scan exit code. The standard `set -o pipefail` + intermediate variable capture is the right shape but needs to be written down in the template.

7. **No integration-test harness for the workflow logic.** The issue's acceptance criterion requires: *"Integration test: harness runs the workflow logic against a mocked PR API, asserts single-comment behavior under multiple runs."* Today, there's no mocked-`gh` test scaffold in this codebase (there is a mocked HTTP `startMockSocketServer` in `features/support/mockSocketServer.ts`, but no `gh` binary mock). Without a harness, the single-comment invariant is asserted only in CI against real GitHub, which is both slow and unreviewable locally.

8. **No YAML validation for the template.** A bundled YAML fixture that silently breaks because of a typo (indentation, key spelling, missing `jobs:`, unknown action version) is worse than no fixture — it produces a broken gate on every repo that installs depaudit. The template needs at minimum a parse-and-structure assertion so a typo is caught at `bun test` time.

## Solution Statement

Introduce four new pieces of code + one template file + BDD coverage, organised to keep the pure logic (`StateTracker`) unit-testable in isolation and to funnel all I/O (gh CLI calls) through a single injectable boundary (`GhPrCommentClient`):

- **New `templates/depaudit-gate.yml`** — the GitHub Actions workflow template. Published as a package asset via a new `"files": ["dist", "templates"]` entry in `package.json`. The template is generic — no per-repo substitution (the production branch name isn't baked in at this slice; issue #11 will drop in a generated copy that *does* pin the trigger branch via `${{ github.event.pull_request.base.ref }}` or by rewriting the template during scaffold). For this slice, the template triggers on `pull_request` and uses `${{ github.base_ref }}` / `${{ github.event.pull_request.base.ref }}` dynamically rather than pinning a branch, keeping it runnable on any target repo the moment it's copied. Shape:

  ```yaml
  name: depaudit-gate
  on:
    pull_request:
      types: [opened, synchronize, reopened]
  permissions:
    contents: read
    pull-requests: write
  jobs:
    gate:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: lts/*
        - name: Install osv-scanner
          run: |
            curl -sSfL https://raw.githubusercontent.com/google/osv-scanner/main/install.sh | sh -s -- -b "$HOME/.local/bin"
            echo "$HOME/.local/bin" >> "$GITHUB_PATH"
        - name: Install depaudit
          run: npm install -g depaudit
        - name: Run depaudit scan
          id: scan
          env:
            SOCKET_API_TOKEN: ${{ secrets.SOCKET_API_TOKEN }}
          run: |
            set +e
            depaudit scan > depaudit-comment.md
            echo "exit_code=$?" >> "$GITHUB_OUTPUT"
            set -e
        - name: Post or update PR comment
          if: always() && github.event_name == 'pull_request'
          env:
            GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          run: depaudit post-pr-comment --body-file=depaudit-comment.md
        - name: Propagate scan exit code
          if: always()
          run: exit ${{ steps.scan.outputs.exit_code }}
  ```

  Key design choices:
  - `if: always()` on the post step ensures the comment still updates on scan failure.
  - The separate "propagate exit code" step ensures the workflow fails when the scan fails, independent of whether the comment post succeeded.
  - `permissions: pull-requests: write` grants the `GITHUB_TOKEN` the right scope to post comments without requiring a PAT.
  - OSV-Scanner is installed via the official install script (documented at osv-scanner's README); this slice doesn't cache it (future optimisation).
  - The template uses action versions pinned to major (`@v4`) — not SHA-pinned — matching the standard for GitHub-owned actions (the PRD doesn't demand SHA pins).

- **New `src/types/prComment.ts`** — minimal types:
  ```ts
  export interface PrComment {
    id: number;
    body: string;
    user?: { login: string };
  }
  export type CommentAction =
    | { kind: "create"; body: string }
    | { kind: "update"; commentId: number; body: string };
  ```
  `CommentAction` is a discriminated union so the caller pattern-matches on `.kind`. No `"skip"` variant — every call posts or updates; the slice doesn't introduce a "no-change, do nothing" path (that's a future optimisation if comment-body equality becomes expensive to compute).

- **New `src/modules/stateTracker.ts`** — pure module exporting:
  ```ts
  export function decideCommentAction(
    comments: PrComment[],
    newBody: string
  ): CommentAction;
  ```
  Behaviour:
  1. Walk `comments` in order; find the first whose `body` contains `MARKDOWN_COMMENT_MARKER` (imported from `../types/markdownReport.js`).
  2. If found, return `{ kind: "update", commentId: found.id, body: newBody }`.
  3. Otherwise, return `{ kind: "create", body: newBody }`.
  4. If multiple comments carry the marker (e.g., a prior buggy run created two), return an update action for the FIRST one — the second will be left orphaned. Document this in a `// NB:` comment and in the unit tests; cleanup of extra marker-bearing comments is a future concern.
  5. No I/O. No mutation of inputs. Frozen input returns are not mutated.

  The `StateTracker` module exports two pure functions today — `decideCommentAction` (post-new vs update-in-place) and `readPriorState` (detect the prior scan's pass/fail from the existing comment body). Together they cover the issue's "detects pass/fail state, and decides whether to post-new vs update-in-place" mandate. The PRD's broader "tracks PR-level state across scan runs" vision (including *first-failure Slack dedupe* — i.e., computing pass→fail transitions and deciding whether to fire a Slack notification) is intentionally deferred to a later slice (likely tied to `SlackReporter`). The module file is named to accept future additions (`decideSlackAction`, `computeTransition`, etc.) without a rename.

- **New `src/modules/ghPrCommentClient.ts`** — deep module that wraps `gh`. Same injectable-execFile pattern as `OsvScannerAdapter`:

  ```ts
  export type ExecFileFn = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

  export interface GhPrCommentClientOptions {
    execFile?: ExecFileFn;
  }

  export interface PrCoordinates {
    repo: string;        // "owner/repo"
    prNumber: number;
  }

  export async function listPrComments(coords: PrCoordinates, options?: GhPrCommentClientOptions): Promise<PrComment[]>;
  export async function createPrComment(coords: PrCoordinates, body: string, options?: GhPrCommentClientOptions): Promise<{ id: number }>;
  export async function updatePrComment(coords: { repo: string; commentId: number }, body: string, options?: GhPrCommentClientOptions): Promise<void>;
  ```

  Implementation details:
  - `listPrComments` → `gh api repos/{repo}/issues/{prNumber}/comments --paginate`. Parse the JSON array, map each element to `{ id, body, user: { login } }`. Throw if gh fails (non-zero exit) with a clear `GhApiError` — the `post-pr-comment` composition root catches and returns exit code 1.
  - `createPrComment` → `gh api repos/{repo}/issues/{prNumber}/comments --method POST --field body=@- --jq '{id}'` with the body passed via stdin (via `execFile` options — see note below on `execFile` vs. `spawn`). Returns the created comment's id.
  - `updatePrComment` → `gh api repos/{repo}/issues/comments/{commentId} --method PATCH --field body=@-` with body on stdin.
  - **Stdin constraint:** `promisify(execFile)` does not expose stdin. Use `spawn` directly for the create/update calls (or write the body to a temp file and pass `--field body=@/tmp/body.md`). Simpler: write body to a temp file, pass `--field body=@<tempfile>`, unlink after. This keeps the `ExecFileFn` interface uniform and testable. Document this choice; tests assert the temp file is cleaned up.
  - Error class: `export class GhApiError extends Error { constructor(message: string, public readonly exitCode: number) { super(message); this.name = "GhApiError"; } }` — consumer can distinguish gh-failed-nonzero-exit from our own logic errors.
  - Pagination: `--paginate` flag on `gh api` handles this natively (emits a single concatenated JSON array when the output is a JSON array). Rely on that rather than rolling our own pagination.

- **New `src/commands/postPrCommentCommand.ts`** — composition root:

  ```ts
  export interface PostPrCommentOptions {
    bodyFile: string;
    repo?: string;         // defaults to GITHUB_REPOSITORY env var
    prNumber?: number;     // defaults to parse of GITHUB_EVENT_PATH's pull_request.number
    ghClient?: {
      listPrComments: typeof listPrComments;
      createPrComment: typeof createPrComment;
      updatePrComment: typeof updatePrComment;
    };
  }

  export async function runPostPrCommentCommand(options: PostPrCommentOptions): Promise<number>;
  ```

  Behaviour:
  1. Resolve the body: `await readFile(options.bodyFile, "utf8")`. Empty file → error out with exit 2 (misconfigured invocation).
  2. Resolve the repo: `options.repo ?? process.env.GITHUB_REPOSITORY`. Missing → error out with exit 2.
  3. Resolve the PR number: `options.prNumber ?? parseFromGithubEvent()`. `parseFromGithubEvent` reads `process.env.GITHUB_EVENT_PATH`, JSON-parses the file, returns `json.pull_request.number`. Missing or not a pull_request event → error out with exit 2.
  4. Call `listPrComments({ repo, prNumber })`. On `GhApiError`, write the message to stderr and return exit 1.
  5. Call `stateTracker.decideCommentAction(comments, body)`.
  6. Dispatch:
     - `action.kind === "create"` → `createPrComment({ repo, prNumber }, action.body)`
     - `action.kind === "update"` → `updatePrComment({ repo, commentId: action.commentId }, action.body)`
  7. On success, write a single stdout line documenting what happened: `posted new depaudit gate comment` or `updated depaudit gate comment (id: N)`. Return exit 0.
  8. Any other unhandled error → stderr, return exit 1.

  Importantly, `ghClient` is injectable so integration tests can drive the composition root with a mock without shelling to a real `gh` binary.

- **Extend `src/cli.ts`** with the `post-pr-comment` subcommand:
  - New `parseArgs` option: `body-file: { type: "string" }`, `pr: { type: "string" }`, `repo: { type: "string" }`.
  - In the subcommand switch, add `else if (subcommand === "post-pr-comment") { ... }` after the existing `scan` and `lint` branches.
  - The `--pr` flag parses as a number; non-numeric → error out with exit 2.
  - Update the USAGE string to document the new subcommand and flags.
  - The existing `--format` flag remains scoped to `scan` — `post-pr-comment` ignores it.

- **Unit tests:**
  - **`src/modules/__tests__/stateTracker.test.ts`** — pure logic, mocked comment lists. Scenarios: empty list, one marker-bearing comment returns update action with that id, many comments with marker-bearing in the middle, comments with marker elsewhere in the body (not just prefix), comments without marker all return create action, multiple marker-bearing comments return update action for first, body passthrough integrity (identical input → identical output bytes), no input mutation.
  - **`src/modules/__tests__/ghPrCommentClient.test.ts`** — mocked `execFile`. Scenarios: list returns the right shape from a realistic `gh api` JSON blob, create posts to the right endpoint with body on disk/stdin, update patches the right endpoint with the right body, list throws `GhApiError` on non-zero exit, create/update throws `GhApiError` on non-zero exit, body temp file is cleaned up after success and after error.
  - **`src/commands/__tests__/postPrCommentCommand.test.ts`** — integration-style with mocked `ghClient` passed in. Scenarios: first run with empty comment list → calls `createPrComment`; second run with one marker-bearing comment → calls `updatePrComment` with the prior id; five runs on the same PR → exactly one `create` + four `update` calls; missing GITHUB_REPOSITORY exits 2; missing PR number exits 2; gh errors propagate as exit 1; body file missing exits 2.
  - **`src/templates/__tests__/depauditGateYml.test.ts`** (OR a sibling test under `src/modules/__tests__/` — see Task 9 for placement) — parses `templates/depaudit-gate.yml` via the `yaml` package, asserts: top-level keys `name`, `on`, `permissions`, `jobs`; `on.pull_request.types` contains `opened`, `synchronize`, `reopened`; `jobs.gate.runs-on` is `ubuntu-latest`; steps include an `actions/setup-node` uses, an `npm install -g depaudit` run, a scan step writing to `depaudit-comment.md`, a post-pr-comment step with `if: always()`, an exit-code propagation step with `if: always()`. Non-semantic (spacing, key ordering) is not asserted.

- **BDD coverage (`features/post_pr_comment.feature`, tag `@adw-10`)** — exercises the `post-pr-comment` subcommand end-to-end with a mocked `gh` binary on `PATH`:
  - Creates a temp directory with a fake `gh` script that accepts commands and returns scripted JSON responses.
  - Scenario 1: first run against an empty comment list — asserts one POST call to the create endpoint.
  - Scenario 2: second run against a list containing a marker-bearing comment — asserts one PATCH call to the update endpoint.
  - Scenario 3: five consecutive runs against an evolving mock state — asserts exactly one create + four updates.
  - Scenario 4: workflow template parses as valid YAML and is tagged `@adw-10` too (so it runs as part of the slice's regression net).
  - Scenario 5: `post-pr-comment` with missing `--body-file` exits 2.
  - Scenario 6: `post-pr-comment` on a non-pull-request event (e.g., push) exits 2.

- **Package publish manifest:** Add `"files": ["dist", "templates"]` to `package.json` so the template travels with `npm install -g depaudit`. Without this, consumers install depaudit but `DepauditSetupCommand` (issue #11) has nothing to copy.

- **Documentation:** New `app_docs/feature-e1layl-github-actions-gate-state-tracker.md` in the house style of `app_docs/feature-xgupjx-markdown-reporter.md`. Append a conditional_docs entry to `.adw/conditional_docs.md`.

## Relevant Files

Use these files to implement the feature:

- `specs/prd/depaudit.md` — parent PRD. Lines `:120` (workflow scaffolded by DepauditSetupCommand), `:190-192` (PR comment identified by HTML marker, updated in place; Slack fire-once semantics), `:202` (StateTracker module contract), `:239` (Tier 1 unit test coverage for StateTracker), User Story 1 (CI gate fails PRs), User Story 2 (main vs dev→main), User Story 8 (contributor sees which package/version/id caused the failure), User Story 9 (single comment, update in place), User Story 32 (SARIF explicitly NOT used).
- `README.md` — project overview; confirms pre-release status and the CLI-distribution model (`npm install -g`).
- `UBIQUITOUS_LANGUAGE.md` — lines 46-48 name `StateTracker`, `Reporter`, `CommitOrPrExecutor` as deep modules; this slice lands `StateTracker`.
- `package.json` — npm publish manifest. Currently no `files` array; add `"files": ["dist", "templates"]` so the workflow YAML ships with the package. `bin.depaudit` already points at `./dist/cli.js` — the `post-pr-comment` subcommand rides the same binary.
- `tsconfig.json` — `rootDir: "./src"` means `templates/` is NOT compiled; no change needed, but the runtime code that will load the template (`DepauditSetupCommand` in issue #11) will resolve `templates/` relative to `import.meta.url`. This slice only creates the template; it does not yet load it.
- `src/cli.ts` — CLI composition root. Extend the `parseArgs` options (`body-file`, `pr`, `repo`) and add a new branch in the subcommand switch (currently line `:60`) for `post-pr-comment`. Update the USAGE string.
- `src/commands/scanCommand.ts` — composition-root reference; `post-pr-comment` follows the same pattern (thin function signature, dependency injection points for testing, top-level error handling via exit codes).
- `src/commands/lintCommand.ts` — simpler composition-root reference; `post-pr-comment` is closer to this shape (I/O + error mapping, no long pipeline).
- `src/modules/osvScannerAdapter.ts` — canonical `execFile` injection pattern (lines 1-12). `ghPrCommentClient` mirrors this pattern exactly: `ExecFileFn` type, `defaultExecFile = promisify(childProcess.execFile)`, `options?.execFile ?? defaultExecFile`.
- `src/modules/socketApiClient.ts` — canonical fail-open / retry / error-class pattern. `GhApiError` models after `SocketAuthError` (lines 26-31). Comment-posting does NOT fail open, however: a gh failure returns a non-zero exit from the command. Rationale: comment posting is a pure observability concern and the scan's own exit code is the gate signal; but we still want the workflow to surface a posting failure as a non-zero exit so users notice the comment isn't landing.
- `src/modules/markdownReporter.ts` — not modified. Already emits `MARKDOWN_COMMENT_MARKER` in every output; `StateTracker` uses the same constant to find the prior comment.
- `src/types/markdownReport.ts` — line 3 defines `MARKDOWN_COMMENT_MARKER = "<!-- depaudit-gate-comment -->" as const`. `StateTracker` imports it; no change.
- `src/types/finding.ts`, `src/types/scanResult.ts`, `src/types/depauditConfig.ts` — domain types that are NOT extended by this slice. Listed only to make clear the feature does not touch them.
- `src/modules/__tests__/osvScannerAdapter.test.ts` — mocked-`execFile` test idiom. `ghPrCommentClient.test.ts` lifts the pattern.
- `src/modules/__tests__/socketApiClient.test.ts` — error-class test idiom. `ghPrCommentClient.test.ts` reuses the shape for `GhApiError`.
- `src/modules/__tests__/jsonReporter.test.ts` — fixture-driven test idiom (not directly replicated but confirms Vitest + temp-dir setup).
- `features/support/world.ts` — `DepauditWorld` already carries `result`, `cwd`, `fixturePath`, `writtenFiles`. Extend with a `ghMock?: { binDir: string; callLog: GhCall[]; stop: () => Promise<void> }` field for the mocked `gh` binary used by `@adw-10` scenarios. Pattern mirrors the `fakeOsvBinDir` field already on the world (line 42).
- `features/support/mockSocketServer.ts` — spawned-HTTP mock pattern. A sibling `features/support/mockGhBinary.ts` is introduced for the `gh` CLI mock.
- `features/step_definitions/scan_steps.ts` — `runDepaudit` helper (`:97`). `post-pr-comment` scenarios reuse it with a different subcommand.
- `features/scan_markdown_reporter.feature` — companion feature file. This slice's feature lives at `features/post_pr_comment.feature`.
- `app_docs/feature-xgupjx-markdown-reporter.md` — house-style reference for the new `app_docs/feature-e1layl-github-actions-gate-state-tracker.md`.
- `.adw/project.md` — confirms deep-module layout, Bun tooling, Vitest runner.
- `.adw/commands.md` — validation commands (`bun run lint`, `bun run typecheck`, `bun run build`, `bun test`, `bun run test:e2e`).
- `.adw/conditional_docs.md` — append the new entry for `app_docs/feature-e1layl-github-actions-gate-state-tracker.md`.
- `.adw/review_proof.md` — item 5 calls out "For changes to `OsvScannerAdapter` or `SocketApiClient`: confirm mock boundary tests cover the new behavior." `GhPrCommentClient` is a sibling mock-boundary module; the same standard applies.
- `specs/issue-9-adw-xgupjx-markdownreporter-std-sdlc_planner-markdown-reporter-stdout-pr-comments.md` — sister-slice plan; format, depth, and task ordering precedent.

### New Files

- `templates/depaudit-gate.yml` — the GitHub Actions workflow template bundled with the npm package. First YAML file outside `fixtures/` / test fixtures in this repo.
- `src/types/prComment.ts` — `PrComment`, `CommentAction`, `PrCoordinates` types.
- `src/modules/stateTracker.ts` — pure comment-dedupe logic (`decideCommentAction`).
- `src/modules/ghPrCommentClient.ts` — deep module wrapping `gh` (`listPrComments`, `createPrComment`, `updatePrComment`, `GhApiError`, `ExecFileFn` type).
- `src/commands/postPrCommentCommand.ts` — composition root for the `post-pr-comment` subcommand (`runPostPrCommentCommand`, `PostPrCommentOptions`).
- `src/modules/__tests__/stateTracker.test.ts` — unit tests for `decideCommentAction` (mocked comment list).
- `src/modules/__tests__/ghPrCommentClient.test.ts` — unit tests with mocked `execFile`.
- `src/modules/__tests__/depauditGateYml.test.ts` — parses `templates/depaudit-gate.yml` via the `yaml` package and asserts structural invariants.
- `src/commands/__tests__/postPrCommentCommand.test.ts` — integration-style tests with injected mock ghClient, asserting single-comment-across-many-runs behaviour.
- `features/post_pr_comment.feature` — BDD feature tagged `@adw-10`.
- `features/step_definitions/post_pr_comment_steps.ts` — step definitions for `@adw-10`.
- `features/support/mockGhBinary.ts` — spawns a fake `gh` script under a temp dir and returns `{ binDir, callLog, stop }`. The script logs every `gh` invocation to a JSON file and returns canned responses based on the first positional argument.
- `fixtures/gh-*/` — per-BDD-scenario fixtures carrying a `package.json`, optional mocked comment-list JSON seed, and `.gitignore`. The mock `gh` binary reads the seed on each invocation.
- `app_docs/feature-e1layl-github-actions-gate-state-tracker.md` — implementation summary in the house style.

## Implementation Plan

### Phase 1: Foundation

Define the domain types and the pure `StateTracker` logic. Nothing in this phase requires a `gh` binary, a running Actions runner, or the workflow template.

- Create `src/types/prComment.ts` with `PrComment`, `CommentAction`, `PrCoordinates`.
- Create `src/modules/stateTracker.ts` with `decideCommentAction(comments, newBody): CommentAction`.
- Unit-test `stateTracker` in full (`src/modules/__tests__/stateTracker.test.ts`).

### Phase 2: `gh` boundary and composition root

Build the I/O layer, then wire the composition root that composes `StateTracker` with the `gh` layer.

- Create `src/modules/ghPrCommentClient.ts` with `listPrComments`, `createPrComment`, `updatePrComment`, `GhApiError`, injectable `execFile`.
- Unit-test `ghPrCommentClient` with mocked `execFile` covering the happy path, error path, pagination passthrough, temp-file lifecycle for body delivery.
- Create `src/commands/postPrCommentCommand.ts` with `runPostPrCommentCommand(options)`.
- Integration-test `postPrCommentCommand` with an injected mock `ghClient`, asserting single-create-plus-N-updates across repeated invocations.

### Phase 3: CLI subcommand, workflow template, BDD, docs

Expose the composition root as a CLI subcommand, author the workflow template that consumes it, and build the end-to-end BDD coverage.

- Extend `src/cli.ts` with the `post-pr-comment` subcommand, flag parsing, USAGE update.
- Create `templates/depaudit-gate.yml` with the workflow shape documented in the Solution Statement.
- Update `package.json`'s `files` array to include `templates`.
- Unit-test the template with `src/modules/__tests__/depauditGateYml.test.ts` (parse + structural assertions).
- Create the BDD harness: `features/support/mockGhBinary.ts` (spawned shell script acting as `gh`).
- Author `features/post_pr_comment.feature` and `features/step_definitions/post_pr_comment_steps.ts`.
- Create the `fixtures/gh-*/` fixtures referenced by the feature file.
- Write `app_docs/feature-e1layl-github-actions-gate-state-tracker.md` and append the conditional_docs entry.
- Run the full validation suite.

## Step by Step Tasks

Execute every step in order, top to bottom.

### Task 1 — Define `PrComment` + `CommentAction` + `PriorState` types

- Create `src/types/prComment.ts`:
  ```ts
  export interface PrComment {
    id: number;
    body: string;
    user?: { login: string };
  }

  export interface PrCoordinates {
    repo: string;        // "owner/repo"
    prNumber: number;
  }

  export type CommentAction =
    | { kind: "create"; body: string }
    | { kind: "update"; commentId: number; body: string };

  export type PriorOutcome = "pass" | "fail" | "none";

  export interface PriorState {
    priorOutcome: PriorOutcome;
    commentId?: number;  // set when a marker-bearing comment exists, regardless of outcome
  }
  ```
- No behaviour. Pure type export.
- `PriorOutcome` is `"pass" | "fail" | "none"`. `"none"` covers both "no marker-bearing comment" and "marker-bearing comment without a recognisable PASS/FAIL header" (e.g., a prior buggy run wrote a comment with the marker but an unreadable header); conflating the two keeps the caller logic simple and is safe because downstream decisions in this slice only branch on "prior state exists" — future slices that need finer granularity can split the type.

### Task 2 — Implement `src/modules/stateTracker.ts`

- New file.
- Imports: `PrComment`, `CommentAction`, `PriorState` from `../types/prComment.js`; `MARKDOWN_COMMENT_MARKER` from `../types/markdownReport.js`.
- Two pure exports:
  ```ts
  export function decideCommentAction(
    comments: PrComment[],
    newBody: string
  ): CommentAction {
    // Find the first comment that carries the depaudit-gate marker.
    // If multiple exist (e.g., from a prior buggy run), update the first and
    // leave the rest orphaned — cleanup is out of scope for this slice.
    const existing = comments.find((c) => c.body.includes(MARKDOWN_COMMENT_MARKER));
    if (existing) {
      return { kind: "update", commentId: existing.id, body: newBody };
    }
    return { kind: "create", body: newBody };
  }

  export function readPriorState(comments: PrComment[]): PriorState {
    // Find the first depaudit-gate comment; then classify its body by the
    // "depaudit gate: PASS" / "depaudit gate: FAIL" header that MarkdownReporter
    // always writes (see src/modules/markdownReporter.ts).
    const existing = comments.find((c) => c.body.includes(MARKDOWN_COMMENT_MARKER));
    if (!existing) return { priorOutcome: "none" };
    if (existing.body.includes("depaudit gate: PASS")) {
      return { priorOutcome: "pass", commentId: existing.id };
    }
    if (existing.body.includes("depaudit gate: FAIL")) {
      return { priorOutcome: "fail", commentId: existing.id };
    }
    // Marker-bearing but no recognisable header — treat as "none" but preserve
    // the commentId so the caller can still dedupe the update.
    return { priorOutcome: "none", commentId: existing.id };
  }
  ```
- No I/O. No mutation of inputs.
- `readPriorState` and `decideCommentAction` share the same marker-lookup logic but are kept as separate exports because their callers compose them independently: the comment-posting composition root only calls `decideCommentAction`; a future Slack-dedupe composition root will call `readPriorState` without needing an action decision. Factoring out a private `findGateComment(comments)` helper is a valid refactor as the second caller lands; in this slice the duplication is cheap and keeps each function trivially inspectable.

### Task 3 — Unit-test `stateTracker`

- New file: `src/modules/__tests__/stateTracker.test.ts`.
- Vitest. Two `describe` blocks — one per exported function.
- `describe("decideCommentAction")` scenarios:
  1. Empty comment list returns a `"create"` action with the passed body verbatim.
  2. One marker-bearing comment returns an `"update"` action with that comment's id.
  3. Marker appears mid-body (not at line 0) — still found.
  4. Multiple marker-bearing comments (e.g., from a prior buggy run) — returns `"update"` for the FIRST one.
  5. Many comments without the marker return `"create"`.
  6. Mixed list with one marker-bearing and five non-marker comments returns `"update"` for the marker-bearing one regardless of position.
  7. The returned `body` field equals the `newBody` argument byte-for-byte.
  8. Calling the function twice with the same inputs returns equal outputs (purity).
  9. Input `comments` array is not mutated (assert via deep-clone comparison pre/post).
- `describe("readPriorState")` scenarios:
  1. Empty comment list returns `{ priorOutcome: "none" }` (no `commentId`).
  2. Marker-bearing comment whose body contains `depaudit gate: PASS` returns `{ priorOutcome: "pass", commentId: <id> }`.
  3. Marker-bearing comment whose body contains `depaudit gate: FAIL` returns `{ priorOutcome: "fail", commentId: <id> }`.
  4. Marker-bearing comment with neither PASS nor FAIL header returns `{ priorOutcome: "none", commentId: <id> }` (commentId is preserved so future callers can still dedupe).
  5. Multiple marker-bearing comments — the FIRST one's header decides the outcome; the others are ignored.
  6. Comments without the marker are skipped even if they happen to contain `depaudit gate: PASS` (e.g., a human contributor pasted that string).
  7. Calling the function twice with the same inputs returns equal outputs (purity).
  8. Input `comments` array is not mutated (deep-clone comparison pre/post).
- Snapshot tests are not used here — both functions are short deterministic decisions; explicit assertions are clearer.

### Task 4 — Implement `src/modules/ghPrCommentClient.ts`

- New file.
- Imports: `promisify` from `node:util`, `childProcess` from `node:child_process`, `writeFile`, `mkdtemp`, `rm` from `node:fs/promises`, `join` from `node:path`, `tmpdir` from `node:os`; `PrComment`, `PrCoordinates` from `../types/prComment.js`.
- Exports:
  ```ts
  export type ExecFileFn = (
    file: string,
    args: readonly string[]
  ) => Promise<{ stdout: string; stderr: string }>;

  const defaultExecFile: ExecFileFn = promisify(childProcess.execFile) as ExecFileFn;

  export interface GhPrCommentClientOptions {
    execFile?: ExecFileFn;
  }

  export class GhApiError extends Error {
    constructor(message: string, public readonly exitCode: number) {
      super(message);
      this.name = "GhApiError";
    }
  }

  export async function listPrComments(
    coords: PrCoordinates,
    options: GhPrCommentClientOptions = {}
  ): Promise<PrComment[]>;

  export async function createPrComment(
    coords: PrCoordinates,
    body: string,
    options: GhPrCommentClientOptions = {}
  ): Promise<{ id: number }>;

  export async function updatePrComment(
    coords: { repo: string; commentId: number },
    body: string,
    options: GhPrCommentClientOptions = {}
  ): Promise<void>;
  ```
- `listPrComments` implementation:
  1. `const exec = options.execFile ?? defaultExecFile;`
  2. `const { stdout } = await exec("gh", ["api", `repos/${coords.repo}/issues/${coords.prNumber}/comments`, "--paginate"]);`
  3. Catch any thrown error, wrap as `new GhApiError("gh api listPrComments failed: " + (err as Error).message, (err as { code?: number }).code ?? 1)` and rethrow.
  4. Parse stdout as JSON; throw `GhApiError` on malformed JSON.
  5. Map each element to `{ id: Number(el.id), body: String(el.body ?? ""), user: el.user ? { login: String(el.user.login ?? "") } : undefined }`.
- `createPrComment` implementation:
  1. Write `body` to a temp file under `tmpdir()/depaudit-gh-body-<rand>/body.md` via `mkdtemp` + `writeFile`.
  2. Exec `gh api repos/{repo}/issues/{prNumber}/comments --method POST --field body=@<tempfile> --jq '{id: .id}'`.
  3. Parse stdout as JSON, return `{ id: Number(json.id) }`.
  4. Cleanup: `try { await rm(tempDir, { recursive: true }); } catch {}` in a `finally`.
  5. Wrap any error in `GhApiError`.
- `updatePrComment` implementation:
  1. Same temp-file body delivery.
  2. Exec `gh api repos/{repo}/issues/comments/{commentId} --method PATCH --field body=@<tempfile>`.
  3. Cleanup temp dir.
  4. Return void. `GhApiError` on non-zero exit.
- The module never reads `GITHUB_TOKEN` / `GH_TOKEN` directly — `gh` handles auth via its own env-var convention (`GH_TOKEN` takes precedence over `GITHUB_TOKEN`).

### Task 5 — Unit-test `ghPrCommentClient`

- New file: `src/modules/__tests__/ghPrCommentClient.test.ts`.
- Mocked `execFile` via the `ExecFileFn` injection; temp-file behaviour asserted via spying on the `fs/promises` module (Vitest `vi.mock` or by injecting a custom writer — simpler path: drive the real fs and then assert the temp dir is gone after the call).
- Scenarios:
  1. `listPrComments` with a realistic `gh api` JSON response (array of 3 comments with ids and bodies) returns the mapped `PrComment[]`.
  2. `listPrComments` with empty array response returns `[]`.
  3. `listPrComments` when `execFile` rejects throws `GhApiError` with a helpful message.
  4. `listPrComments` when stdout is malformed JSON throws `GhApiError`.
  5. `createPrComment` with a minimal `{ id: 99 }` stdout returns `{ id: 99 }`.
  6. `createPrComment` writes the body to a temp file and passes `--field body=@<path>` in the args (assert via spying on the `execFile` args).
  7. `createPrComment` removes the temp dir after success.
  8. `createPrComment` removes the temp dir after `execFile` error.
  9. `updatePrComment` exercises the same argv/temp-file flow.
  10. `GhApiError` carries the exit code when `execFile` rejects with `{ code: 4 }`.

### Task 6 — Implement `src/commands/postPrCommentCommand.ts`

- New file.
- Imports: `readFile` from `node:fs/promises`; `PrCoordinates` from `../types/prComment.js`; `listPrComments`, `createPrComment`, `updatePrComment`, `GhApiError` from `../modules/ghPrCommentClient.js`; `decideCommentAction` from `../modules/stateTracker.js`.
- Interface:
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
  }

  export async function runPostPrCommentCommand(
    options: PostPrCommentOptions
  ): Promise<number>;
  ```
- Flow (return-code table in the plan narrative):
  1. `const body = await readFile(options.bodyFile, "utf8")`. If `readFile` throws (ENOENT, EACCES), write `error: could not read body file '<path>'` to stderr, return 2.
  2. If `body` is empty (length 0), write `error: body file is empty` to stderr, return 2.
  3. Resolve repo: `options.repo ?? process.env.GITHUB_REPOSITORY`. If missing, write `error: repository not set — pass --repo or set GITHUB_REPOSITORY` to stderr, return 2.
  4. Resolve PR number: `options.prNumber ?? await resolvePrNumberFromEvent()`. Helper:
     ```ts
     async function resolvePrNumberFromEvent(): Promise<number | null> {
       const path = process.env.GITHUB_EVENT_PATH;
       if (!path) return null;
       try {
         const raw = await readFile(path, "utf8");
         const json = JSON.parse(raw) as { pull_request?: { number?: number }; number?: number };
         const n = json.pull_request?.number ?? json.number;
         return typeof n === "number" ? n : null;
       } catch {
         return null;
       }
     }
     ```
     (Fallback to `json.number` because `issue_comment` / `pull_request` events differ in shape.) If `null`, write `error: PR number not set — pass --pr or run in a pull_request Actions event` to stderr, return 2.
  5. `const client = options.ghClient ?? { listPrComments, createPrComment, updatePrComment };`
  6. `let comments: PrComment[];`
     `try { comments = await client.listPrComments({ repo, prNumber }); }`
     `catch (err: unknown) { if (err instanceof GhApiError) { ... return 1; } throw err; }`
  7. `const action = decideCommentAction(comments, body);`
  8. `try { if (action.kind === "create") { const { id } = await client.createPrComment({ repo, prNumber }, action.body); process.stdout.write(`posted new depaudit gate comment (id: ${id})\n`); } else { await client.updatePrComment({ repo, commentId: action.commentId }, action.body); process.stdout.write(`updated depaudit gate comment (id: ${action.commentId})\n`); } } catch (err) { ... return 1; }`
  9. `return 0;`
- Unhandled errors (non-`GhApiError`) propagate to the CLI top-level which maps them to exit 2 with a stderr message — matching the existing `scan` path.

### Task 7 — Integration-test `postPrCommentCommand`

- New file: `src/commands/__tests__/postPrCommentCommand.test.ts`.
- No directory `src/commands/__tests__/` exists yet — create it.
- Tests use an injected `ghClient` that records every call and returns scripted responses.
- Helper:
  ```ts
  function makeMockGhClient(initialComments: PrComment[] = []) {
    const state = { comments: [...initialComments], nextId: 100 };
    const log: Array<{ op: string; args: unknown }> = [];
    return {
      state,
      log,
      client: {
        async listPrComments(coords: PrCoordinates) {
          log.push({ op: "list", args: coords });
          return [...state.comments];
        },
        async createPrComment(coords: PrCoordinates, body: string) {
          log.push({ op: "create", args: { coords, body } });
          const id = state.nextId++;
          state.comments.push({ id, body });
          return { id };
        },
        async updatePrComment(coords: { repo: string; commentId: number }, body: string) {
          log.push({ op: "update", args: { coords, body } });
          const idx = state.comments.findIndex((c) => c.id === coords.commentId);
          if (idx !== -1) state.comments[idx] = { ...state.comments[idx], body };
        },
      },
    };
  }
  ```
- Write a body file via `mkdtemp` + `writeFile` in each test. Use Vitest `beforeEach` / `afterEach` for cleanup.
- Scenarios:
  1. **First run with empty comment list** — calls `listPrComments` once, then `createPrComment` once. `updatePrComment` not called. Returns 0. Stdout mentions `posted new depaudit gate comment`.
  2. **Second run with one marker-bearing comment** — one `list`, then `update` against the prior id. No `create`. Returns 0.
  3. **Five consecutive runs on the same PR** (re-using the same mock state across calls) — one `create` in run 1, four `update`s in runs 2–5, each targeting the SAME `commentId`. After five runs: `state.comments.length === 1`. (Acceptance criterion: single-comment behaviour under multiple runs.)
  4. **Missing `GITHUB_REPOSITORY`** (env var unset, no `--repo`) — returns 2; stderr mentions `GITHUB_REPOSITORY`.
  5. **Missing PR number** (no `--pr`, no `GITHUB_EVENT_PATH`) — returns 2; stderr mentions `pull_request`.
  6. **`listPrComments` throws `GhApiError`** — returns 1; stderr mentions the gh error. `createPrComment` / `updatePrComment` NOT called.
  7. **`createPrComment` throws `GhApiError`** — returns 1; stderr mentions the error.
  8. **Body file missing** — returns 2; stderr mentions the body file path.
  9. **Body file empty** — returns 2; stderr mentions `empty`.
  10. **PR number resolved from `GITHUB_EVENT_PATH`** — write a synthetic event JSON (`{"pull_request":{"number":42}}`) to a temp file, set `GITHUB_EVENT_PATH` for the test, and assert the listPrComments call uses `prNumber: 42`.

### Task 8 — Extend `src/cli.ts` with the `post-pr-comment` subcommand

- Add to the `options` map in `parseArgs` (`:30`):
  ```ts
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    format: { type: "string", short: "f" },
    "body-file": { type: "string" },
    pr: { type: "string" },
    repo: { type: "string" },
  },
  ```
- Update the USAGE string:
  ```
  Commands:
    scan [path]            Scan a Node repository for CVE findings (default path: cwd)
    lint [path]            Lint osv-scanner.toml (default path: cwd)
    post-pr-comment        Post or update a depaudit gate comment on a PR

  Options:
    -h, --help             Print this help message and exit
    -v, --version          Print the version and exit
    -f, --format           Output format for stdout (markdown|text; default: markdown)
        --body-file        Path to the markdown body (post-pr-comment)
        --pr               PR number (post-pr-comment; defaults to pull_request event)
        --repo             GitHub repo as owner/name (post-pr-comment; defaults to GITHUB_REPOSITORY)
  ```
- Extend the `values` TS type annotation to include the new string fields.
- Add the new subcommand branch after `else if (subcommand === "lint")`:
  ```ts
  } else if (subcommand === "post-pr-comment") {
    const bodyFile = values["body-file"];
    if (!bodyFile) {
      process.stderr.write(`error: --body-file is required\n\n${USAGE}`);
      process.exit(2);
    }
    let prNumber: number | undefined;
    if (values.pr) {
      const n = Number(values.pr);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        process.stderr.write(`error: --pr must be an integer, got '${values.pr}'\n\n${USAGE}`);
        process.exit(2);
      }
      prNumber = n;
    }
    try {
      const { runPostPrCommentCommand } = await import("./commands/postPrCommentCommand.js");
      const code = await runPostPrCommentCommand({ bodyFile, repo: values.repo, prNumber });
      process.exit(code);
    } catch (err: unknown) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      process.exit(2);
    }
  }
  ```
  Using a dynamic `import()` keeps the existing `scan` startup unchanged — the `post-pr-comment` code path is loaded lazily when the subcommand is invoked.

### Task 9 — Create `templates/depaudit-gate.yml`

- Create `templates/` at the repo root.
- File contents as documented in the Solution Statement. Final formatting follows GitHub Actions YAML conventions:
  ```yaml
  name: depaudit-gate

  on:
    pull_request:
      types: [opened, synchronize, reopened]

  permissions:
    contents: read
    pull-requests: write

  jobs:
    gate:
      runs-on: ubuntu-latest
      steps:
        - name: Checkout repository
          uses: actions/checkout@v4

        - name: Set up Node.js
          uses: actions/setup-node@v4
          with:
            node-version: lts/*

        - name: Install osv-scanner
          run: |
            curl -sSfL https://raw.githubusercontent.com/google/osv-scanner/main/install.sh | sh -s -- -b "$HOME/.local/bin"
            echo "$HOME/.local/bin" >> "$GITHUB_PATH"

        - name: Install depaudit
          run: npm install -g depaudit

        - name: Run depaudit scan
          id: scan
          env:
            SOCKET_API_TOKEN: ${{ secrets.SOCKET_API_TOKEN }}
          run: |
            set +e
            depaudit scan > depaudit-comment.md
            echo "exit_code=$?" >> "$GITHUB_OUTPUT"
            set -e

        - name: Post or update PR comment
          if: always() && github.event_name == 'pull_request'
          env:
            GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          run: depaudit post-pr-comment --body-file=depaudit-comment.md

        - name: Propagate scan exit code
          if: always()
          run: exit ${{ steps.scan.outputs.exit_code }}
  ```
- The template uses `lts/*` to auto-track the current LTS line. A future slice may pin.
- No conditional `on: push` trigger in this slice — `pull_request` is sufficient to cover User Stories 1, 2, 8, 9. `push` coverage for Slack first-failure dedupe is a concern for the Slack slice (future), not this one.

### Task 10 — Update `package.json` `files` array

- Add:
  ```json
  "files": [
    "dist",
    "templates"
  ]
  ```
- Confirm no existing `files` key is being overwritten (current `package.json` has none).
- Run `bun install` afterward — no lockfile change expected, but the sanity check catches accidental breakage.

### Task 11 — Unit-test the workflow template

- New file: `src/modules/__tests__/depauditGateYml.test.ts`.
- Imports: `readFile` from `node:fs/promises`; `resolve`, `dirname` from `node:path`; `fileURLToPath` from `node:url`; `parse` from `yaml`; `describe`, `it`, `expect` from `vitest`.
- Resolve the template path relative to `import.meta.url`: navigate up from `src/modules/__tests__/` to `<repo-root>/templates/depaudit-gate.yml`.
- Tests:
  1. File parses as valid YAML (no thrown error from `yaml.parse`).
  2. Top-level keys include `name`, `on`, `permissions`, `jobs`.
  3. `on.pull_request.types` is `["opened", "synchronize", "reopened"]`.
  4. `permissions.pull-requests` is `"write"`.
  5. `jobs.gate.runs-on` is `"ubuntu-latest"`.
  6. `jobs.gate.steps` contains a step with `uses: "actions/checkout@v4"`.
  7. `jobs.gate.steps` contains a step with `uses: "actions/setup-node@v4"`.
  8. A step runs `npm install -g depaudit`.
  9. A step runs `depaudit scan` with stdout redirection to `depaudit-comment.md`.
  10. A step runs `depaudit post-pr-comment --body-file=depaudit-comment.md` with `if: always() && github.event_name == 'pull_request'`.
  11. A final step has `if: always()` and runs `exit ${{ steps.scan.outputs.exit_code }}`.
- These assertions cover "syntactically valid GitHub Actions" + "workflow installs depaudit, runs scan, captures markdown output" + "fail exit code propagates" acceptance criteria.
- The test does NOT validate GitHub Actions schema deeply (that would require `actionlint` or similar as a new dependency); structural assertions on the parsed tree are sufficient for the slice.

### Task 12 — Build the BDD `gh` mock harness

- New file: `features/support/mockGhBinary.ts`.
- Spawns a temp directory, writes a small shell script named `gh` that:
  1. Reads the full argv.
  2. Appends `{ ts, argv }` to `$MOCK_GH_LOG_FILE`.
  3. Reads `$MOCK_GH_STATE_FILE` (JSON) to find canned responses:
     - `{ listResponse: PrComment[], createResponse: { id: number }, updateOk: true, exitOverride?: number }`
  4. Based on argv pattern, returns the right response to stdout:
     - `gh api repos/.../issues/<pr>/comments --paginate` → `listResponse` as JSON.
     - `gh api repos/.../issues/<pr>/comments --method POST --field body=@<file>` → `createResponse`.
     - `gh api repos/.../issues/comments/<id> --method PATCH --field body=@<file>` → empty body, exit 0.
  5. Exits with `exitOverride ?? 0`.
- Export:
  ```ts
  export interface MockGhHandle {
    binDir: string;         // directory to prepend to PATH
    logFile: string;        // JSON lines of calls
    stateFile: string;      // JSON state consumed on each call
    readLog(): Promise<Array<{ argv: string[] }>>;
    stop(): Promise<void>;  // cleans the temp dir
  }
  export async function startMockGhBinary(initial: {
    listResponse?: PrComment[];
    createResponse?: { id: number };
    updateOk?: boolean;
    exitOverride?: number;
  }): Promise<MockGhHandle>;
  ```
- The mock supports mutating state between invocations: the test calls `writeFileSync` on `stateFile` to update `listResponse` between runs, simulating the comment being created on run 1 and persisting into run 2's list.

### Task 13 — Extend `DepauditWorld` and add `@adw-10` step definitions

- Extend `features/support/world.ts`:
  ```ts
  /** Mocked gh binary for @adw-10 scenarios */
  ghMock?: import("./mockGhBinary.js").MockGhHandle;
  /** Body file for post-pr-comment (@adw-10) */
  bodyFilePath?: string;
  ```
- New file: `features/step_definitions/post_pr_comment_steps.ts`.
- `Before`/`After` hooks tagged `@adw-10`:
  - `Before`: initialise `ghMock` to undefined, `bodyFilePath` to undefined.
  - `After`: call `ghMock?.stop()`, unlink the body file.
- Step definitions (wording must match the feature file — see Task 14):
  - `Given a mock gh CLI on PATH that returns an empty PR comment list`
  - `Given a mock gh CLI on PATH that returns a PR comment list containing a depaudit-gate comment with id {int}`
  - `Given a body file containing markdown with the depaudit-gate marker`
  - `Given the environment variable GITHUB_REPOSITORY is set to {string}`
  - `Given the environment variable GITHUB_EVENT_PATH points to a pull_request event for PR number {int}`
  - `When I run "depaudit post-pr-comment --body-file=<body>"` — reuse `runDepaudit` with PATH prepended for the mock.
  - `When I run depaudit post-pr-comment {int} more times in succession`
  - `Then the mock gh CLI was called with a POST to the comments endpoint`
  - `Then the mock gh CLI was called with a PATCH to comment id {int}`
  - `Then the mock gh CLI's PATCH/POST balance is {int} POST and {int} PATCH`
  - `Then stdout mentions posting or updating the depaudit gate comment`
- The `runDepaudit` helper needs a small extension (or a new helper `runDepauditWithGhMock`) that prepends the mock bin dir to PATH in the spawned env. Follow the `fakeOsvBinDir` pattern already present in `world.ts:42` and `scan_steps.ts:119-122`.

### Task 14 — Author `features/post_pr_comment.feature`

- New file tagged `@adw-10`. Scenarios (all @regression unless noted):

  ```
  @adw-10
  Feature: depaudit post-pr-comment — posts and updates the PR gate comment idempotently
    As a contributor iterating on a PR
    I want every push to update the same PR comment
    So that my PR surface shows one evolving gate comment, not many

    Background:
      Given the `depaudit` CLI is installed and on PATH

    @adw-10 @regression
    Scenario: First run posts a new comment (no prior marker-bearing comment)
      Given a mock gh CLI on PATH that returns an empty PR comment list
      And a body file containing markdown with the depaudit-gate marker
      And the environment variable GITHUB_REPOSITORY is set to "paysdoc/depaudit-fixture"
      And the environment variable GITHUB_EVENT_PATH points to a pull_request event for PR number 42
      When I run "depaudit post-pr-comment --body-file=<body>"
      Then the exit code is 0
      And the mock gh CLI was called with a POST to the comments endpoint
      And stdout mentions posting or updating the depaudit gate comment

    @adw-10 @regression
    Scenario: Second run updates the prior comment in place
      Given a mock gh CLI on PATH that returns a PR comment list containing a depaudit-gate comment with id 777
      And a body file containing markdown with the depaudit-gate marker
      And the environment variable GITHUB_REPOSITORY is set to "paysdoc/depaudit-fixture"
      And the environment variable GITHUB_EVENT_PATH points to a pull_request event for PR number 42
      When I run "depaudit post-pr-comment --body-file=<body>"
      Then the exit code is 0
      And the mock gh CLI was called with a PATCH to comment id 777

    @adw-10 @regression
    Scenario: Five consecutive runs accumulate one comment, not five
      Given a mock gh CLI on PATH that returns an empty PR comment list
      And a body file containing markdown with the depaudit-gate marker
      And the environment variable GITHUB_REPOSITORY is set to "paysdoc/depaudit-fixture"
      And the environment variable GITHUB_EVENT_PATH points to a pull_request event for PR number 42
      When I run "depaudit post-pr-comment --body-file=<body>"
      And I run depaudit post-pr-comment 4 more times in succession
      Then the mock gh CLI's PATCH/POST balance is 1 POST and 4 PATCH

    @adw-10
    Scenario: Missing GITHUB_REPOSITORY exits 2 with a clear error
      Given a body file containing markdown with the depaudit-gate marker
      When I run "depaudit post-pr-comment --body-file=<body>"
      Then the exit code is 2
      And stderr mentions "GITHUB_REPOSITORY"

    @adw-10
    Scenario: Missing PR number on a non-pull_request event exits 2
      Given a body file containing markdown with the depaudit-gate marker
      And the environment variable GITHUB_REPOSITORY is set to "paysdoc/depaudit-fixture"
      When I run "depaudit post-pr-comment --body-file=<body>"
      Then the exit code is 2
      And stderr mentions "pull_request"

    @adw-10
    Scenario: --body-file flag is required
      When I run "depaudit post-pr-comment"
      Then the exit code is 2
      And stderr mentions "body-file"
  ```

- Scenario step wordings above are illustrative — the scenario_writer agent should finalise exact wording. Step definitions must match verbatim.

### Task 15 — Create BDD fixtures

- Create the directories referenced by the feature file:
  - `fixtures/gh-empty-list/` — contains nothing the scenario depends on directly; the `gh` mock lives under the mock's temp dir, not the fixture.
  - The `<body>` placeholder in the feature file is the per-scenario body file created by the step definition into a temp dir — no checked-in fixture required.
- If the scenario_writer chooses to co-locate a checked-in body fixture (e.g., `fixtures/gh-body/depaudit-comment.md` with a representative markdown body), put it under `fixtures/gh-body/`. Minimal content:
  ```
  <!-- depaudit-gate-comment -->

  ## depaudit gate: PASS

  - new: 0
  - accepted: 0
  - whitelisted: 0
  - expired: 0
  ```
- No `package.json` / `osv-scanner.toml` is needed for `@adw-10` scenarios — they exercise the comment-post command, not the scan pipeline.

### Task 16 — Write `app_docs/feature-e1layl-github-actions-gate-state-tracker.md`

- House-style Markdown document mirroring `app_docs/feature-xgupjx-markdown-reporter.md`. Required sections:
  - **Overview** — 1-paragraph summary of what shipped: the workflow template, `StateTracker`, `GhPrCommentClient`, `post-pr-comment` subcommand.
  - **What Was Built** — bulleted list of new files.
  - **Technical Implementation** — Files Modified / Key Changes subsections with bullet-level detail on each.
  - **How to Use** — example GitHub Actions workflow snippet; example of the subcommand invocation.
  - **Configuration** — `--body-file`, `--pr`, `--repo` flags; `GITHUB_REPOSITORY`, `GITHUB_EVENT_PATH`, `GH_TOKEN` env vars.
  - **Testing** — what tests exist and how to run them.
  - **Notes** — why the template uses `lts/*` Node, why `permissions: pull-requests: write` is required, why gh auth is implicit via `GH_TOKEN`.

### Task 17 — Append the conditional_docs entry

- Append to `.adw/conditional_docs.md`:
  ```
  - [app_docs/feature-e1layl-github-actions-gate-state-tracker.md](../app_docs/feature-e1layl-github-actions-gate-state-tracker.md) — When working with the `.github/workflows/depaudit-gate.yml` template, `StateTracker`, `GhPrCommentClient`, the `depaudit post-pr-comment` subcommand, single-comment-in-place PR behaviour, or `GH_TOKEN` / `GITHUB_EVENT_PATH` resolution; when troubleshooting missing-or-duplicated gate comments; when extending the workflow to add Slack first-failure dedupe in a future slice.
  ```

### Task 18 — Run the validation suite

Execute every command in the **Validation Commands** section. All must pass with zero regressions.

## Testing Strategy

### Unit Tests

`.adw/project.md` does not carry a `## Unit Tests: enabled` marker. This plan includes unit-test tasks as a documented override, matching the precedent set by issues #3, #4, #5, #6, #7, #8, #9, and #13. Justifications for this slice, in priority order:

1. **The issue explicitly mandates `StateTracker` unit tests** with mocked comment lists as an acceptance criterion ("`StateTracker` unit tests (mocked comment list).").
2. **The issue explicitly mandates a workflow-logic integration test**: "harness runs the workflow logic against a mocked PR API, asserts single-comment behavior under multiple runs." That harness belongs at the unit/integration level — not end-to-end against live GitHub.
3. **`GhPrCommentClient` is a subprocess-boundary module**. PRD `:247` classifies all such modules as Tier 1 with mocked `execFile`. Without unit coverage, the thin boundary becomes a silent failure surface (mis-parsing gh's JSON, argv typos, temp-file leaks).
4. **`.adw/review_proof.md:5`** requires mock-boundary tests for any module wrapping a subprocess. `GhPrCommentClient` is such a module.
5. **Template structural assertions** are the cheapest possible insurance against the common pre-release failure mode "I tweaked the YAML and didn't notice the post step broke."

Unit tests to build:

- **`src/modules/__tests__/stateTracker.test.ts`** — empty list, one marker, multiple markers, marker mid-body, purity, input-immutability, body passthrough.
- **`src/modules/__tests__/ghPrCommentClient.test.ts`** — list happy/empty/error paths, create with id return, update void return, body temp-file lifecycle (success + error), argv shape for each method, `GhApiError` propagation.
- **`src/commands/__tests__/postPrCommentCommand.test.ts`** — ten scenarios in Task 7 covering the whole decision surface; the five-runs scenario is the direct answer to the issue's integration-test acceptance criterion.
- **`src/modules/__tests__/depauditGateYml.test.ts`** — eleven structural assertions on the parsed template.

### Edge Cases

- **Empty comment list.** Renderer decides `"create"`. Covered by Task 3 scenario 1.
- **One marker-bearing comment.** `"update"` with that id. Covered by Task 3 scenario 2.
- **Multiple marker-bearing comments** (bug-legacy state). Always `"update"` for the FIRST; the rest stay orphaned. Documented in `stateTracker.ts`, covered by Task 3 scenario 4.
- **Marker appears in a NON-depaudit comment** (a contributor pasted the literal string in a comment on a PR). Currently treated as a prior depaudit comment — StateTracker has no way to distinguish intent from marker presence. Documented edge case: the contributor's comment gets overwritten by the next gate run. Practical risk is negligible (the marker is intentionally weird-looking HTML) but worth a Notes entry.
- **`gh` CLI is not installed** on the runner. `execFile` rejects with ENOENT; `GhPrCommentClient` wraps as `GhApiError`; `postPrCommentCommand` returns exit 1. The workflow's next step still runs (`if: always()`) and propagates the scan's exit code. Gate status is preserved.
- **`GH_TOKEN` is missing.** `gh` returns a non-zero exit; same path as the above.
- **`gh api` returns 404** (e.g., PR was deleted between the scan and the comment step). `gh` exits non-zero; `GhApiError`; exit 1. Scan exit code still propagates.
- **Body file is empty.** `postPrCommentCommand` returns 2. The workflow's `set +e` around the scan step catches the scan's exit code separately; the post-comment step fails but the propagation step still fires. Covered by Task 7 scenario 9.
- **Body file contains only the marker** (no header, no counts). Still posts — StateTracker has no semantic understanding of the body. The user would see a near-empty comment; that is a scan-side bug (the markdown reporter always writes counts), not a post-comment bug.
- **PR has >100 comments** (GitHub pagination threshold). `gh api --paginate` concatenates all pages as a single JSON array. `GhPrCommentClient` trusts the flag. If future scale forces manual pagination, a sibling slice addresses it.
- **Comment body exceeds GitHub's 65 535-char limit**. `gh` returns a 422; `GhApiError` with exit 1. The slice does not truncate — truncation would produce a broken markdown table rendering, and the issue doesn't ask for it. A future slice may add `--max-body-chars` + a graceful trailing `[truncated]` marker.
- **Running the workflow on a `push` event** (e.g., after a merge). The `if: github.event_name == 'pull_request'` guard skips the post step. The exit-code propagation step still fires, so the Actions check surfaces pass/fail based on the scan result. This covers the "is my main branch healthy?" post-merge audit path without spamming a non-existent PR.
- **`GITHUB_EVENT_PATH` points to a valid JSON that has no `pull_request` field** (e.g., a `push` event). `resolvePrNumberFromEvent` returns null; exit 2. Guard tested by Task 7 scenario 5.
- **`--pr` flag with a non-integer value.** CLI validates and exits 2. Covered by Task 8's CLI logic.
- **Mock gh binary's state file grows across repeated runs.** Each BDD scenario starts with a fresh mock (Before hook), so cross-scenario leakage is impossible. Within a single scenario, the state file is mutated by the mock itself to simulate GitHub's server state — verified by Task 14 scenario 3 (five consecutive runs, one POST + four PATCHes).
- **The template's `npm install -g depaudit` pulls the latest version**. If a breaking CLI change lands in a later slice, the template's guarantees remain the same as long as `post-pr-comment --body-file=<path>` is preserved. Documented in Notes.

## Acceptance Criteria

- [ ] `templates/depaudit-gate.yml` exists, parses as valid YAML, and contains the documented jobs/steps structure.
- [ ] `package.json` has a `"files": ["dist", "templates"]` entry so the template ships with `npm install -g depaudit`.
- [ ] `src/types/prComment.ts` defines `PrComment`, `PrCoordinates`, `CommentAction`, `PriorOutcome`, `PriorState`.
- [ ] `src/modules/stateTracker.ts` exports a pure `decideCommentAction(comments, newBody)` returning a `CommentAction`.
- [ ] `src/modules/stateTracker.ts` exports a pure `readPriorState(comments)` that returns `{ priorOutcome: "pass" | "fail" | "none", commentId? }`, detecting the prior pass/fail state from the `depaudit gate: PASS` / `depaudit gate: FAIL` header inside the marker-bearing comment.
- [ ] `src/modules/ghPrCommentClient.ts` exports `listPrComments`, `createPrComment`, `updatePrComment`, `GhApiError`, with injectable `execFile`.
- [ ] `src/commands/postPrCommentCommand.ts` exports `runPostPrCommentCommand(options)` that resolves repo/PR from flags or env, composes StateTracker with GhPrCommentClient, returns the documented exit-code table.
- [ ] `src/cli.ts` accepts the `post-pr-comment` subcommand with `--body-file`, `--pr`, `--repo` flags and is documented in the USAGE string.
- [ ] Running `depaudit post-pr-comment --body-file=<md>` against a fresh PR posts a new comment; a second invocation against the same PR updates the prior comment in place.
- [ ] Five consecutive invocations on the same PR produce exactly one create + four updates; the PR carries exactly one depaudit gate comment at the end.
- [ ] `StateTracker` unit tests cover empty / single-marker / multi-marker / marker-free / marker-mid-body cases with mocked comment lists, and — for `readPriorState` — empty / PASS-header / FAIL-header / header-absent / multi-marker permutations.
- [ ] `GhPrCommentClient` unit tests cover happy / error / empty / pagination-passthrough / temp-file-lifecycle paths.
- [ ] `postPrCommentCommand` integration tests cover the first-run-creates, second-run-updates, five-run-balance, missing-env-vars, and body-file-validation paths.
- [ ] `depauditGateYml.test.ts` parses `templates/depaudit-gate.yml` and asserts every documented structural invariant.
- [ ] `features/post_pr_comment.feature` tagged `@adw-10` exercises the `depaudit post-pr-comment` CLI against a mocked `gh` binary.
- [ ] The workflow template's "Propagate scan exit code" step exits with the scan's original exit code, so Actions fails the check when the scan fails.
- [ ] The workflow template's "Post or update PR comment" step uses `if: always() && github.event_name == 'pull_request'` so a scan failure still posts the comment.
- [ ] `bun run lint`, `bun run typecheck`, `bun run build`, `bun test` all pass with zero new warnings or errors.
- [ ] `bun run test:e2e -- --tags "@adw-10"` passes all `@adw-10` scenarios.
- [ ] `bun run test:e2e -- --tags "@regression"` continues to pass — the new `@adw-10 @regression` scenarios join the suite with zero existing-scenario failures.
- [ ] `bun run test:e2e -- --tags "@adw-9"` continues to pass — MarkdownReporter behaviour is unchanged; this slice consumes its output but does not modify it.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `bun install` — ensure dependencies resolved. No new runtime dependencies expected (the existing `yaml` package covers the template parsing). If `yaml` is not currently a dep of the src code path (only of tests), run `bun add --dev yaml` first (it already lives in devDependencies via cucumber's transitive tree, but pulling it into direct deps is explicit about the intent).
- `bun run lint` — lint the entire codebase; zero warnings.
- `bun run typecheck` — TypeScript strict mode must pass across the new `src/types/prComment.ts`, `src/modules/stateTracker.ts`, `src/modules/ghPrCommentClient.ts`, `src/commands/postPrCommentCommand.ts`, and the extended `src/cli.ts`.
- `bun test` — full Vitest suite including the four new test files. Zero failures.
- `bun run build` — emits `dist/types/prComment.js`, `dist/modules/stateTracker.js`, `dist/modules/ghPrCommentClient.js`, `dist/commands/postPrCommentCommand.js`, and updated `dist/cli.js`.
- `bun run test:e2e -- --tags "@adw-10"` — new BDD scenarios pass end-to-end.
- `bun run test:e2e -- --tags "@regression"` — every prior `@regression` scenario continues to pass; new `@adw-10 @regression` scenarios pass alongside.
- `bun run test:e2e -- --tags "@adw-9"` — MarkdownReporter BDD scenarios unaffected.
- `bun run test:e2e` — final smoke test of the full Cucumber suite.

Sanity checks (optional but recommended):

- `node dist/cli.js post-pr-comment --help` is not implemented in this slice (the USAGE string documents the flag but `--help` is scoped to the top-level CLI). Running `node dist/cli.js post-pr-comment --body-file=./README.md` in a shell without `GITHUB_REPOSITORY` set should exit 2 with the documented stderr message.
- Manually run `bun run build && node dist/cli.js post-pr-comment` and confirm the CLI dispatches to the subcommand.

## Notes

- **No new runtime dependencies expected.** The YAML template validation piggybacks on the existing `yaml` package already used for `ConfigLoader`. `gh` is installed on all GitHub-hosted runners by default, so the workflow template assumes its presence without an install step.
- **Unit tests override.** `.adw/project.md` lacks `## Unit Tests: enabled`. This plan includes unit + integration tests because the issue's acceptance criteria explicitly demand them AND `.adw/review_proof.md` requires mock-boundary tests for any subprocess-wrapping module. Same precedent as issues #3–#9 and #13.
- **StateTracker scope for this slice.** Issue #10 mandates two StateTracker capabilities: (a) detect prior pass/fail state from the existing comment body, and (b) decide post-new vs update-in-place. Both land here (`readPriorState` + `decideCommentAction`). The PRD's broader vision also includes "first-failure Slack dedupe" — computing pass→fail transitions and deciding whether to fire a Slack notification. Those transition-computing functions are NOT in issue #10's scope and are deferred to a later slice (likely tied to `SlackReporter`). This slice leaves room to add sibling exports (`decideSlackAction`, `computeTransition`, etc.) to the same file without a rename.
- **Template branch pinning is a future concern.** The issue/PRD reference "pinned to the resolved trigger branch." The template authored here is *generic* — it uses `${{ github.event.pull_request.base.ref }}` implicitly (via the trigger being `pull_request`) and doesn't bake a branch name. When `DepauditSetupCommand` (issue #11) copies the template into a target repo, it may optionally rewrite the `on:` block to pin `branches: [main]` or `branches: [<resolved-trigger-branch>]`. That rewrite is issue #11's concern; this slice leaves a working template that's correct by default on any repo.
- **Marker false positives.** `StateTracker` treats any comment containing `<!-- depaudit-gate-comment -->` as the prior depaudit gate comment. A contributor pasting that literal string into a PR comment will get their comment overwritten on the next gate run. The marker is deliberately weird-looking to minimise collision; if a user reports collision in practice, a future slice can tighten the match (e.g., "first-line-must-be-the-marker" or "author-must-be-the-github-actions-bot").
- **Exit-code propagation is workflow-level, not CLI-level.** `depaudit post-pr-comment` always exits with its own status (0/1/2) regardless of whether the scan passed or failed — the markdown body it posts already carries the pass/fail signal. The workflow's third step (`Propagate scan exit code`) is the only place the scan's exit code becomes the job's exit code.
- **SARIF is explicitly NOT populated.** User Story 32 calls this out; the workflow template contains zero `github/codeql-action` or `upload-sarif` steps. Honoured by omission.
- **Publishing the template.** `package.json`'s `"files"` array is the npm publish manifest. Forgetting to include `templates` would silently break `DepauditSetupCommand` (issue #11) when it tries to copy a file that's not in the installed package. A regression test for this (e.g., `npm pack --dry-run | grep templates/depaudit-gate.yml`) is out of scope for this slice but a worthwhile future check.
- **Coverage mapping.** User Story 1 (CI gate fails merges): satisfied by the workflow + exit-code propagation step. User Story 2 (gate works regardless of `main` vs `dev→main`): satisfied by the trigger being `pull_request` (which fires regardless of base branch name). User Story 8 (contributor sees which package/version/id + suggested action): already satisfied by issue #9's MarkdownReporter output; this slice makes the output reach the PR comment. User Story 9 (single comment updated in place): satisfied by `StateTracker` + `GhPrCommentClient.updatePrComment`. User Story 32 (no SARIF): satisfied by explicit non-inclusion of SARIF upload steps.
