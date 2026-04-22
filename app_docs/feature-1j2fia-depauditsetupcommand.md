# DepauditSetupCommand + Baseline + CommitOrPrExecutor

**ADW ID:** 1j2fia-depauditsetupcommand
**Date:** 2026-04-23
**Specification:** specs/issue-12-adw-1j2fia-depauditsetupcommand-sdlc_planner-setup-command-baseline-commit-executor.md

## Overview

This slice delivers `depaudit setup`, the bootstrap command that turns an unmanaged repository into one that runs the depaudit gate on every PR. A single invocation resolves the trigger branch, scaffolds all required artifacts, baselines every existing finding with a 90-day acceptance, and commits the result (or opens a PR if already on the trigger branch). It activates every previously-shipped module for the first time via a single CLI entry point.

## What Was Built

- **`depaudit setup [path]` CLI subcommand** — wired into `src/cli.ts`; default path is `process.cwd()`
- **`DepauditSetupCommand`** — composition root orchestrating the full bootstrap sequence
- **`CommitOrPrExecutor`** — deep module wrapping the commit-vs-PR decision based on current branch vs trigger branch
- **`gitRemoteResolver`** — deep module resolving `owner/name` from `git remote get-url origin` and the trigger branch via `gh api`
- **`templateInstaller`** — helper that copies `templates/depaudit-gate.yml` into the target repo with a trigger-branch `on.pull_request.branches` mutation and a generated-at header comment
- **Baseline writers** — `appendDepauditYmlBaseline` and `appendOsvScannerTomlBaseline` added to `configWriter.ts`
- **BDD feature files** — `features/setup.feature`, `features/setup_baseline.feature`, `features/commit_or_pr_executor.feature` with step definitions in `features/step_definitions/setup_command_steps.ts`
- **`mockGitBinary.ts`** — new `git` shim for BDD scenarios, complementing the existing `mockGhBinary.ts`
- **Unit + integration tests** for all four new modules

## Technical Implementation

### Files Modified

- `src/cli.ts`: Added `setup` to `USAGE` string and `else if (subcommand === "setup")` dispatch branch using dynamic import
- `src/modules/configWriter.ts`: Extended with `appendDepauditYmlBaseline` (YAML CST append) and `appendOsvScannerTomlBaseline` (TOML block append at EOF)
- `features/support/mockGhBinary.ts`: Added state fields for `branches/main` 200/404, `default_branch`, and `gh pr create` URL responses
- `features/support/world.ts`: Added `gitMock`, `setupFixturePath`, `setupResolvedBranch` fields
- `features/step_definitions/scan_steps.ts`: Minor extensions to support setup invocation

### Files Added

- `src/commands/depauditSetupCommand.ts`: Composition root; exports `runDepauditSetupCommand(options): Promise<number>`
- `src/commands/__tests__/depauditSetupCommand.test.ts`: Integration tests for feature-branch and trigger-branch paths
- `src/modules/commitOrPrExecutor.ts`: Deep module; exports `execute()`, `CommitOrPrAction`, `CommitOrPrExecutorError`
- `src/modules/__tests__/commitOrPrExecutor.test.ts`: Unit tests covering both paths, branch-collision suffix, failure-stage attribution
- `src/modules/gitRemoteResolver.ts`: Deep module; exports `resolveRepo`, `resolveTriggerBranch`, `branchExistsOnRemote`, `GitRemoteError`
- `src/modules/__tests__/gitRemoteResolver.test.ts`: Unit tests for SSH/HTTPS URL parsing and branch resolution fallback
- `src/modules/templateInstaller.ts`: Helper; exports `installGateWorkflow(repoRoot, triggerBranch, options)`
- `src/modules/__tests__/templateInstaller.test.ts`: Tests for happy path, idempotent re-run, conflict-on-diverged-content
- `src/modules/__tests__/configWriter.test.ts`: Extended with baseline append + idempotency tests
- `features/setup.feature`: BDD scenarios for scaffold, gitignore, polyglot detection, idempotency
- `features/setup_baseline.feature`: BDD scenarios for CVE and supply-chain baseline writes
- `features/commit_or_pr_executor.feature`: BDD scenarios for commit vs PR path and branch-collision suffix
- `features/step_definitions/setup_command_steps.ts`: Step definitions for all three feature files
- `features/support/mockGitBinary.ts`: Git shim binary for deterministic BDD subprocess calls
- ~50 fixture directories under `fixtures/` (setup-* and baseline-*)

### Key Changes

- **Bootstrap sequence** (`depauditSetupCommand.ts`): `.git` check → `resolveRepo` → `discoverManifests` → `resolveTriggerBranch` → `installGateWorkflow` → scaffold `osv-scanner.toml` / `.depaudit.yml` → `.gitignore` append → `runScanCommand` → baseline writers → `commitOrPrExecute` → stdout summary
- **Trigger-branch resolution**: `gh api repos/<owner>/<repo>/branches/main` — if 200, returns `"main"`; if 404, falls back to `gh api repos/<owner>/<repo> --jq .default_branch`
- **Baseline filter**: only findings classified as `"new"` become baseline entries; `accepted`, `whitelisted`, and `expired-accept` findings are skipped or surfaced in stdout
- **Commit-or-PR decision**: `currentBranch !== triggerBranch` → direct commit; `currentBranch === triggerBranch` → checkout `depaudit-setup` branch (with `-2`, `-3` suffix on remote collision), push, `gh pr create`
- **`appendOsvScannerTomlBaseline`** appends `[[IgnoredVulns]]` TOML blocks with `id`, `ignoreUntil = today+90d`, `reason = "baselined at install"`; **`appendDepauditYmlBaseline`** appends `supplyChainAccepts` YAML map entries; both are idempotent

## How to Use

### Non-ADW (manual) adoption

1. Install the CLI: `npm install -g depaudit`
2. Clone your target repository and `cd` into it
3. Run: `depaudit setup` (or `depaudit setup /path/to/repo`)
4. Review the stdout summary for trigger branch, scaffolded files, and baseline counts
5. If on the trigger branch, a `depaudit-setup` PR is opened automatically — review and merge it
6. Set GitHub Actions secrets manually:
   ```
   gh secret set SOCKET_API_TOKEN --body "$SOCKET_API_TOKEN"
   gh secret set SLACK_WEBHOOK_URL --body "$SLACK_WEBHOOK_URL"
   ```

### ADW adoption

ADW's `adwInit.tsx` (slice 16) shells out to `depaudit setup` and propagates secrets automatically; no manual steps required beyond approving the generated PR.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `cwd` | `process.cwd()` | Path to the target git repository |
| `now` | `new Date()` | Date used for baseline `expires` (+90d) and workflow header timestamp |
| `execFile` | `promisify(childProcess.execFile)` | Injectable for testing; wraps all `git` and `gh` subprocess calls |
| `runScan` | `runScanCommand` | Injectable for testing; performs the first-scan baseline step |

Baseline expiry is hard-coded at **90 days** from the run date. The reason string is hard-coded to `"baselined at install"` per PRD `:162`.

## Testing

```bash
# Unit + integration tests
bun test

# BDD: new setup scenarios only
bun run test:e2e -- --tags "@adw-12"

# BDD: full regression suite
bun run test:e2e -- --tags "@regression"

# Manual smoke test
node dist/cli.js setup fixtures/setup-first-scan
```

## Notes

- **Secrets are out of scope.** `SOCKET_API_TOKEN` / `SLACK_WEBHOOK_URL` are not set by `depaudit setup`; ADW slice 16 handles propagation for ADW repos. Non-ADW adopters run `gh secret set` manually.
- **No rollback on partial failure.** If `git push` succeeds but `gh pr create` fails, the pushed branch remains so the user can re-open the PR by hand.
- **`--no-verify` is never passed.** Pre-commit hooks are honoured; if a hook fails, `CommitOrPrExecutorError("commit")` is raised and the command exits 1.
- **Idempotency is the safety net.** Re-running setup on an already-configured repo is safe: scaffolded files are not overwritten; baseline appends skip existing entries; `.gitignore` is left byte-identical.
- **`expired-accept` findings are surfaced, not re-baselined.** Silently extending an expired acceptance would defeat the 90-day decay design. The stdout summary lists expired entries for manual review.
- **The packaged template stays branch-agnostic.** Only the scaffolded copy in the target repo has `on.pull_request.branches` set; `templates/depaudit-gate.yml` is unchanged so existing BDD assertions on the template continue to pass.
