# Patch: Regenerate stale `scenario_proof.md` against HEAD (1f75f2a)

## Metadata
adwId: `442uul-cli-skeleton-osv-sca`
reviewChangeRequest: `Issue #1: scenario_proof.md at /Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md reports the @regression suite as FAILED (exit code 1, empty output). Per Strategy A step 2, a FAILED @regression proof is a blocker. Note: I re-ran 'bun run test:e2e -- --tags @regression' against HEAD (1f75f2a) and observed 7/7 scenarios, 46/46 steps passing, so the proof artifact appears stale relative to the scenario-runner fix in 1f75f2a. Resolution: Regenerate the scenario proof artifact against the current HEAD and re-run review. If regeneration still shows FAILED, capture the cucumber stderr/stdout in the proof (the current 'no output' block hides the failure cause) and fix the underlying scenario break.`

## Issue Summary
**Original Spec:** `specs/issue-3-adw-442uul-cli-skeleton-osv-sca-sdlc_planner-cli-skeleton-osv-scan.md`

**Issue:** The proof artifact at `/Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md` was captured before the `.adw/scenarios.md` runner fix in commit `1f75f2a` took effect against the harness, so both `@regression` (blocker) and `@adw-3` (blocker) sections show `❌ FAILED` / exit `1` / `(no output)`. HEAD already ships the correct `bun run test:e2e -- --tags "@{tag}"` entries in `.adw/scenarios.md`, and both tag suites pass cleanly when run in this worktree:
- `bun run test:e2e -- --tags "@regression"` → `7 scenarios (7 passed)` / `46 steps (46 passed)`
- `bun run test:e2e -- --tags "@adw-3"` → `8 scenarios (8 passed)` / `51 steps (51 passed)`

No source or test defect exists — only the log artifact is stale.

**Solution:** Regenerate `scenario_proof.md` at the external proof path by executing the two documented tag commands against HEAD and writing a fresh markdown file in the exact shape produced by `adws/phases/scenarioProof.ts` (`## <tag> Scenarios (severity: blocker)` / `Status: ✅ PASSED` / `Exit Code: 0` / fenced stdout block). No repo source changes; this is a pure artifact refresh as directed by the reviewer's resolution.

## Files to Modify
Use these files to implement the patch:

- `/Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md` — stale proof artifact to be overwritten with fresh passing output (not a source file; no repo diff).

## Implementation Steps
IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Confirm worktree HEAD and deps
- Verify the worktree is at commit `1f75f2a` (`git rev-parse HEAD` → `1f75f2a…`).
- Run `bun install` to ensure cucumber + tsx are resolved.

### Step 2: Capture fresh stdout for both blocker tags
- Run `bun run test:e2e -- --tags "@regression"` and save combined stdout to a temp variable/file. Expect exit `0` and the `7 scenarios (7 passed) / 46 steps (46 passed)` summary.
- Run `bun run test:e2e -- --tags "@adw-3"` and save combined stdout to a temp variable/file. Expect exit `0` and the `8 scenarios (8 passed) / 51 steps (51 passed)` summary.
- If either command exits non-zero, STOP and fall back to the reviewer's conditional path (capture stderr into the proof and fix the underlying scenario break before re-running).

### Step 3: Overwrite the stale proof artifact
- Write the absolute file `/Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md` with the exact format emitted by `adws/phases/scenarioProof.ts#buildProofMarkdown`:
  - Header: `# Scenario Proof` then a blank line, then `Generated at: <new ISO-8601 timestamp>` then a blank line.
  - Section for `@regression`: `## @regression Scenarios (severity: blocker)` / blank / `**Status:** ✅ PASSED` / `**Exit Code:** 0` / blank / `### Output` / blank / fenced ```` ``` ```` block containing the Step-2 stdout for `@regression` / blank.
  - Section for `@adw-3`: `## @adw-3 Scenarios (severity: blocker)` / blank / `**Status:** ✅ PASSED` / `**Exit Code:** 0` / blank / `### Output` / blank / fenced ```` ``` ```` block containing the Step-2 stdout for `@adw-3` / blank.
- Keep the emoji status labels and field names identical to the existing file so the review parser still matches.

## Validation
Execute every command to validate the patch is complete with zero regressions.

- `bun run test:e2e -- --tags "@regression"` — must exit 0 and print `7 scenarios (7 passed)` / `46 steps (46 passed)`.
- `bun run test:e2e -- --tags "@adw-3"` — must exit 0 and print `8 scenarios (8 passed)` / `51 steps (51 passed)`.
- `grep -c "✅ PASSED" /Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md` — must return `2` (one per blocker tag).
- `grep -c "❌ FAILED" /Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md` — must return `0`.
- `grep -c "(no output)" /Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md` — must return `0`.
- `grep -E "^\*\*Exit Code:\*\* 0$" /Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md | wc -l` — must return `2`.
- `bun run typecheck` — must exit 0 (no repo source changes, but confirms no incidental regressions).
- `bun run lint` — must exit 0.

## Patch Scope
**Lines of code to change:** 0 source lines; the one change is a full overwrite of the external `scenario_proof.md` artifact (~30 lines of generated markdown).
**Risk level:** low (log artifact only; no runtime, build, or test behavior change).
**Testing required:** Re-execute both blocker-tag suites via `bun run test:e2e` to produce fresh stdout, then confirm the regenerated proof parses as two PASSED blocker sections.
