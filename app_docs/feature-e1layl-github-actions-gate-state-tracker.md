# GitHub Actions depaudit-gate.yml + PR comment + StateTracker

## Overview

Delivers the CI gate integration for depaudit: a `templates/depaudit-gate.yml` GitHub Actions workflow template bundled with the npm package, a `StateTracker` module for deterministic PR-comment deduplication, a `GhPrCommentClient` wrapping the `gh` CLI, and a `depaudit post-pr-comment` subcommand that composes them. Every target repo onboarded by `depaudit setup` gets a working gate that fails the Actions check on gate failure and posts a single updated-in-place PR comment.

## Responsibilities

- `templates/depaudit-gate.yml` installs the published package (`npm install -g @paysdoc/depaudit`), runs `depaudit scan`, and posts/updates a PR comment via `depaudit post-pr-comment`, all inside one job
- `decideCommentAction(comments, newBody)` in `src/modules/stateTracker.ts` walks the PR's comment list for the first comment containing the marker `<!-- depaudit-gate-comment -->`; returns `{ kind: "update", commentId, body }` if found, else `{ kind: "create", body }`
- `readPriorState(comments)` inspects the same marker comment for `"depaudit gate: PASS"` / `"depaudit gate: FAIL"` text, exported for a future Slack first-failure-dedupe slice (not yet consumed by `postPrCommentCommand`)
- `GhPrCommentClient` (`listPrComments`, `createPrComment`, `updatePrComment`) wraps the `gh` CLI with an injectable `execFile`, mirroring the `OsvScannerAdapter` pattern; the comment body is delivered via a temp file (`--field body=@<path>`) since `promisify(execFile)` doesn't expose stdin
- `postPrCommentCommand` is the composition root for the `post-pr-comment` subcommand: resolves PR number from `--pr` or `GITHUB_EVENT_PATH`, resolves repo from `--repo` or `GITHUB_REPOSITORY`, and calls `decideCommentAction` + the client

## Contracts & Invariants

- Exit codes for `post-pr-comment`: `0` success (posted or updated), `1` `gh` API failure (`GhApiError`), `2` invalid arguments (missing body file, missing repo, or missing PR number — never silently resolved to 0)
- The workflow's "Propagate scan exit code" step is separate from the scan step so `post-pr-comment` always runs (`if: always()`) while the job still fails when the scan fails; exit-code threading is `set +e` → capture `$?` → `GITHUB_OUTPUT` → `exit ${{ steps.scan.outputs.exit_code }}`
- If multiple marker-bearing comments exist on a PR (legacy state), the first one found wins and the rest are orphaned
- The install step names the published package explicitly (`@paysdoc/depaudit`, not the unscoped `depaudit`, which 404s on the registry) and is intentionally unpinned — it always pulls `latest`
- `GH_TOKEN` auth is implicit: the workflow passes `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` as an env var and the `gh` CLI picks it up automatically; `ghPrCommentClient.ts` never reads it directly

## Configuration

| Flag / Env | Description | Default |
|---|---|---|
| `--body-file` | Path to markdown body file | required |
| `--pr` | PR number | `GITHUB_EVENT_PATH` → `.pull_request.number` |
| `--repo` | `owner/repo` string | `GITHUB_REPOSITORY` |
| `GH_TOKEN` | GitHub token for `gh` auth | set by Actions automatically |
| `GITHUB_REPOSITORY` | `owner/repo` of the current repo | set by Actions automatically |
| `GITHUB_EVENT_PATH` | Path to the Actions event JSON | set by Actions automatically |

`permissions: pull-requests: write` is required in the workflow for `GITHUB_TOKEN` to post/edit PR comments without a PAT.

## Gotchas

- The install step in the shipped template must track the currently published package name — it was renamed from unscoped `depaudit` to `@paysdoc/depaudit`; a stale template ships a gate whose first step 404s on every PR in every repo bootstrapped by `depaudit setup`. `src/modules/__tests__/depauditGateYml.test.ts` and the `@adw-10 @regression` scenario in `features/depaudit_gate_workflow.feature` both pin this literal and must move together with the template
- SARIF is not populated — no `codeql-action/upload-sarif` step appears in the template
- `lts/*` is used for the Node version in the workflow, so it auto-tracks the current LTS line rather than a pinned major
- The marker `<!-- depaudit-gate-comment -->` is deliberately obscure to minimise collision with unrelated PR comments; any comment whose body happens to contain it is treated as the prior gate comment
