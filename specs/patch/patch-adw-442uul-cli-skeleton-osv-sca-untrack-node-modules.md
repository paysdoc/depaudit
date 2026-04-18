# Patch: Untrack accidentally-committed node_modules/ from branch history

## Metadata
adwId: `442uul-cli-skeleton-osv-sca`
reviewChangeRequest: `Issue #2: Commit 141909c tracked 4,724 files under node_modules/ on this branch (not present on main). Although .gitignore now lists node_modules/, the files were added before the ignore rule applied and remain in the tree. This pollutes the PR diff, inflates clones, and will cause noisy merge conflicts. The plan's Step-by-Step tasks explicitly required git status to not list node_modules as untracked, but the fix used here was to commit them instead of ignoring them. Resolution: Run git rm -r --cached node_modules on the branch, commit the removal, and force-push the branch (coordinate with the author before force-pushing). Verify git ls-files | grep ^node_modules/ returns nothing before re-review.`

## Issue Summary
**Original Spec:** `specs/issue-3-adw-442uul-cli-skeleton-osv-sca-sdlc_planner-cli-skeleton-osv-scan.md`
**Issue:** Commit `141909c` added 4,724 files under `node_modules/` to the branch tree. `.gitignore` now lists `node_modules/`, but the rule only prevents future additions — files already tracked stay tracked. The planner's step-by-step task "Verify `git status` no longer lists `node_modules/` as untracked" was satisfied incorrectly: the author committed the files instead of ignoring them, inverting the intent of the acceptance criterion "`git status` does not report `node_modules/` as untracked". The polluted tree inflates clone size, dominates the PR diff, and guarantees merge conflicts against `main` (which has no such files).
**Solution:** Untrack the entire `node_modules/` subtree with `git rm -r --cached node_modules` (keeps the files on disk, removes them from the index), commit the removal on the feature branch, then force-push after confirming with the branch author. `.gitignore` already contains the `node_modules/` rule, so no file edits are required — this is a pure git-history correction.

## Files to Modify
Use these files to implement the patch:

- No source files change. The only change is to the git index / tree — specifically, the removal of all 4,724 paths under `node_modules/` from tracking. `.gitignore` already contains `node_modules/` and does not need edits.

## Implementation Steps
IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Confirm the current working tree is clean before rewriting history
- Run `git status --short` and verify there are no staged or unstaged changes other than expected in-flight work. A dirty tree at this point would get mixed into the removal commit.
- Run `git ls-files | grep -c '^node_modules/'` and record the count (expected: `4724`). This is the baseline that Validation step 1 will assert went to zero.
- Confirm current branch is `feature-issue-3-cli-skeleton-osv-scanner` via `git rev-parse --abbrev-ref HEAD`. Do not proceed if on `main` or any other branch.

### Step 2: Untrack the node_modules/ subtree
- Run `git rm -r --cached node_modules`. The `--cached` flag removes entries from the index while leaving the files in the working tree intact, so `bun install`-produced dependencies remain usable for local dev and subsequent validation commands.
- Do not pass `-f` / `--force`; the untrack should succeed cleanly because `.gitignore` already lists `node_modules/` and the files are tracked-but-ignored.

### Step 3: Commit the removal
- Stage the index changes (already staged by `git rm`).
- Commit with message body exactly:
  ```
  chore: untrack node_modules/ mistakenly committed in 141909c

  .gitignore already lists node_modules/, but 4,724 files were added
  before the rule took effect. git rm --cached removes them from the
  index without touching the working tree.
  ```
- Use a standard commit (not `--amend`) so the correction is a distinct, reviewable entry in the branch history. Do not skip hooks.

### Step 4: Verify and force-push
- Run `git ls-files | grep '^node_modules/'` — must print nothing. This is the re-review gate named in the review-change-request.
- Run `git diff --stat main...HEAD -- node_modules | tail -1` — must show zero insertions for `node_modules/` paths.
- Coordinate with the branch author before force-pushing (the branch is a shared feature branch; an uncoordinated force-push can clobber their local work). Once confirmed, run `git push --force-with-lease origin feature-issue-3-cli-skeleton-osv-scanner`. `--force-with-lease` (not `--force`) ensures the push fails if someone else has pushed in the meantime, protecting concurrent work.

## Validation
Execute every command to validate the patch is complete with zero regressions.

- `git ls-files | grep '^node_modules/' | wc -l` — must print `0`. Primary success gate from the review-change-request.
- `git diff --stat main...HEAD | grep -c 'node_modules/'` — must print `0`. Confirms the PR diff no longer contains `node_modules/` entries.
- `bun install` — must resolve and install cleanly. Confirms the working-tree `node_modules/` (now untracked) is still functional for local development and for the validation commands below.
- `bun run typecheck` — must exit 0. Confirms the untrack did not accidentally affect source compilation.
- `bun run build` — must exit 0 and produce `dist/cli.js`. From the original spec's Validation Commands.
- `bun test` — must exit 0 with all unit tests passing. From the original spec's Validation Commands; confirms no regression in `ManifestDiscoverer` or `OsvScannerAdapter` suites after the history correction.

## Patch Scope
**Lines of code to change:** 0 source lines; removes ~1,117,000+ lines across 4,724 tracked `node_modules/` files from the index.
**Risk level:** low — `git rm --cached` is fully reversible via `git reset`, leaves the working tree untouched, and `.gitignore` already prevents re-addition. The only elevated-risk action is the force-push, which is gated by author coordination and `--force-with-lease`.
**Testing required:** re-run the original spec's validation commands (`bun install`, `bun run typecheck`, `bun run build`, `bun test`) to confirm the untrack did not break the pipeline; plus the two `git ls-files` / `git diff --stat` gates that directly assert the fix.
